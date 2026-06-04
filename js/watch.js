/**
 * 基金「可申购」监控模块
 *
 * 职责：管理用户的监控名单（要盯着「能不能买」的基金代码），查询实时申购状态，
 * 并把名单同步到 GitHub 仓库的 watchlist.json —— 供云端 GitHub Actions 每 6 小时
 * 读取、判断、邮件提醒。本模块只负责「名单 + 状态 + 同步」，发邮件由云端脚本完成。
 *
 * 数据流：网页输入代码 → 本地 localStorage → syncToGitHub 写入仓库 watchlist.json
 *        → 云端任务读取并监控。
 *
 * @author funds-web
 */
(function (global) {
  "use strict";

  const KEY_WATCHLIST = "fw_watchlist"; // 监控名单：string[] 基金代码

  // 申购状态「不可买」关键词：命中任一即视为当前买不了
  // 反之（开放申购、限大额等）视为「能买」—— 与云端 check.py 保持一致
  const BLOCK_KEYWORDS = ["暂停", "封闭", "停止", "未开放", "终止"];

  /* ---------- 名单管理（localStorage） ---------- */

  function getList() {
    try {
      const raw = localStorage.getItem(KEY_WATCHLIST);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.error("读取监控名单失败：", e);
      return [];
    }
  }

  function saveList(list) {
    localStorage.setItem(KEY_WATCHLIST, JSON.stringify(list || []));
  }

  /**
   * 添加监控代码（去重 + 6 位数字校验）
   * @returns {boolean} 是否实际新增
   */
  function addCode(code) {
    code = String(code || "").trim();
    if (!/^\d{6}$/.test(code)) return false;
    const list = getList();
    if (list.indexOf(code) >= 0) return false;
    list.push(code);
    saveList(list);
    return true;
  }

  function removeCode(code) {
    saveList(getList().filter((c) => c !== code));
  }

  /* ---------- 状态判定与查询 ---------- */

  /**
   * 按申购状态文本判断是否「能买」
   * @param {string} sgzt 申购状态（如 开放申购 / 限大额 / 暂停申购）
   * @returns {boolean}
   */
  function isBuyable(sgzt) {
    if (!sgzt) return false;
    return !BLOCK_KEYWORDS.some((k) => sgzt.indexOf(k) >= 0);
  }

  /**
   * 批量查询监控名单中各基金的实时申购状态（网页打开时即时展示用）
   * @param {string[]} codes 基金代码数组
   * @returns {Promise<Array>} [{ code, name, sgzt, sgztMark, buy, buyable }]
   */
  async function checkStatus(codes) {
    const results = await Promise.all(
      codes.map((c) => global.FundApi.getBasicInfo(c))
    );
    return codes.map((code, i) => {
      const d = results[i];
      if (!d) {
        return { code, name: "(查询失败)", sgzt: "", sgztMark: "", buyable: false };
      }
      return {
        code: d.code,
        name: d.name,
        sgzt: d.sgzt,
        sgztMark: d.sgztMark,
        buy: d.buy,
        buyable: isBuyable(d.sgzt),
      };
    });
  }

  /* ---------- GitHub 同步 ---------- */

  /**
   * 把监控名单同步到 GitHub 仓库的 watchlist.json
   *
   * 使用 GitHub Contents API：先 GET 现有文件拿 sha（已存在才需要），再 PUT 覆盖。
   * owner/repo/token 从用户配置（FundStorage.getConfig）读取；token 仅存浏览器本地。
   *
   * @param {string[]} list 监控代码数组
   * @returns {Promise<{ok:boolean, message:string}>}
   */
  async function syncToGitHub(list) {
    const cfg = global.FundStorage.getConfig();
    const owner = (cfg.ghOwner || "").trim();
    const repo = (cfg.ghRepo || "").trim();
    const token = (cfg.ghToken || "").trim();
    if (!owner || !repo || !token) {
      return { ok: false, message: "请先在「云端同步设置」填写 GitHub 用户名 / 仓库 / Token" };
    }

    const api =
      "https://api.github.com/repos/" + owner + "/" + repo + "/contents/watchlist.json";
    const headers = {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
    };

    // watchlist.json 内容：带更新时间，便于云端/人工排查
    const payload = {
      codes: list,
      updatedAt: new Date().toISOString(),
    };
    // GitHub Contents API 要求内容为 base64；用 unescape(encodeURIComponent) 处理 UTF-8
    const contentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));

    try {
      // 取已有文件的 sha（不存在则 404，首次创建无需 sha）
      let sha;
      const getRes = await fetch(api, { headers });
      if (getRes.ok) {
        const cur = await getRes.json();
        sha = cur.sha;
      } else if (getRes.status !== 404) {
        const t = await getRes.text();
        return { ok: false, message: "读取仓库失败(" + getRes.status + ")：" + t.slice(0, 120) };
      }

      const body = {
        message: "chore: update watchlist via web (" + list.length + " funds)",
        content: contentB64,
      };
      if (sha) body.sha = sha;

      const putRes = await fetch(api, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (putRes.ok) {
        return { ok: true, message: "已同步 " + list.length + " 只到云端" };
      }
      const t = await putRes.text();
      return { ok: false, message: "同步失败(" + putRes.status + ")：" + t.slice(0, 160) };
    } catch (e) {
      return { ok: false, message: "网络错误：" + e.message };
    }
  }

  /**
   * 触发云端工作流，立即查询指定基金并发邮件告知是否可买
   *
   * 调用 GitHub Actions 的 workflow_dispatch：浏览器无法直接发邮件，故「点火」云端
   * 任务跑一次（约 1 分钟内到邮箱）。需要 Token 具备 Actions 读写权限。
   *
   * @param {string} code 6 位基金代码
   * @returns {Promise<{ok:boolean, message:string}>}
   */
  async function triggerCheck(code) {
    const cfg = global.FundStorage.getConfig();
    const owner = (cfg.ghOwner || "").trim();
    const repo = (cfg.ghRepo || "").trim();
    const token = (cfg.ghToken || "").trim();
    if (!owner || !repo || !token) {
      return { ok: false, message: "未配置云端同步，暂无法发邮件（请先在「云端同步设置」配置并部署）" };
    }
    // 工作流文件名固定 monitor.yml；分支用 main
    const url =
      "https://api.github.com/repos/" +
      owner +
      "/" +
      repo +
      "/actions/workflows/monitor.yml/dispatches";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: { notify_code: code } }),
      });
      if (res.status === 204) {
        return { ok: true, message: "已请求云端发送邮件，约 1 分钟内到达 📧" };
      }
      const t = await res.text();
      return { ok: false, message: "触发失败(" + res.status + ")：" + t.slice(0, 140) };
    } catch (e) {
      return { ok: false, message: "网络错误：" + e.message };
    }
  }

  global.FundWatch = {
    getList,
    saveList,
    addCode,
    removeCode,
    isBuyable,
    checkStatus,
    syncToGitHub,
    triggerCheck,
  };
})(window);
