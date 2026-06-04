/**
 * 基金名称匹配
 *
 * 职责：加载天天基金全量基金代码表，提供「中文名 → 基金代码」的模糊匹配能力。
 * OCR 识别出的基金名往往不完整或有错字（如尾部 A/C 份额丢失、截断省略号），
 * 故采用「包含 + 编辑距离 + 关键片段」的组合策略提高命中率，匹配不到再走网络搜索兜底。
 *
 * 数据源：http://fund.eastmoney.com/js/fundcode_search.js
 *   该文件为 application/javascript，内容形如：
 *   var r = [["000001","HXCZHH","华夏成长混合","混合型-灵活","HUAXIA..."], ...]
 *
 * @author funds-web
 */
(function (global) {
  "use strict";

  let fundTable = []; // 全量基金表：[{ code, name }]
  let loadingPromise = null;

  /**
   * 动态加载全量基金代码表（通过 <script> 注入，规避 CORS）
   * @returns {Promise<Array>} 基金表
   */
  function loadTable() {
    if (fundTable.length) return Promise.resolve(fundTable);
    if (loadingPromise) return loadingPromise;

    loadingPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://fund.eastmoney.com/js/fundcode_search.js";
      script.onload = function () {
        // 该脚本执行后会在全局定义变量 r
        const r = global.r;
        if (Array.isArray(r)) {
          fundTable = r.map((item) => ({ code: item[0], name: item[2] }));
        }
        resolve(fundTable);
      };
      script.onerror = function () {
        reject(new Error("基金代码表加载失败"));
      };
      document.body.appendChild(script);
    });
    return loadingPromise;
  }

  /**
   * 归一化基金名：去除括号备注、空白、份额无关符号，便于比较
   *
   * WHY：截图里的名字常含「(LOF)」「(QDII)」「（后端）」等括注，或被省略号截断，
   * 去掉这些噪声后比较主体名称更稳。
   *
   * @param {string} s 原始名称
   * @returns {string} 归一化后的名称
   */
  function normalize(s) {
    if (!s) return "";
    return s
      .replace(/[（(].*?[)）]/g, "") // 去除中英文括号及其内容
      .replace(/[\s·.、,，…\-—_]/g, "") // 去除空白与常见分隔符
      .trim();
  }

  /**
   * 计算两个字符串的编辑距离（Levenshtein），用于容错匹配
   * @returns {number} 距离值，越小越相似
   */
  function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    // 滚动数组优化空间
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  /**
   * 在本地全量表中模糊匹配基金名
   *
   * 策略（按优先级）：
   *  1. 归一化后完全相等
   *  2. 互相包含（处理截断/省略号场景）
   *  3. 编辑距离小于阈值（容忍 OCR 个别错字）
   *
   * @param {string} ocrName OCR 识别出的名称
   * @returns {Object|null} { code, name, score } 命中项；score 越小越好
   */
  function matchLocal(ocrName) {
    const q = normalize(ocrName);
    if (q.length < 2 || !fundTable.length) return null;

    let best = null;

    for (let i = 0; i < fundTable.length; i++) {
      const f = fundTable[i];
      const name = normalize(f.name);
      if (!name) continue;

      let score;
      if (name === q) {
        score = 0; // 完全匹配
      } else if (name.indexOf(q) >= 0 || q.indexOf(name) >= 0) {
        // 包含关系：差异越小越好，用长度差近似
        score = Math.abs(name.length - q.length) + 0.5;
      } else {
        // 仅当长度接近时才算编辑距离，避免无谓计算
        if (Math.abs(name.length - q.length) > 3) continue;
        const d = editDistance(q, name);
        if (d > 2) continue; // 超过 2 处差异认为不相关
        score = d + 1;
      }

      if (!best || score < best.score) {
        best = { code: f.code, name: f.name, score };
        if (score === 0) break; // 完全匹配可提前结束
      }
    }
    return best;
  }

  /**
   * 综合匹配：先本地，命中不佳再走网络搜索兜底
   * @param {string} ocrName OCR 名称
   * @returns {Promise<Object|null>} { code, name } 或 null
   */
  async function match(ocrName) {
    await loadTable();
    const local = matchLocal(ocrName);
    // 本地高置信（score<=1）直接采用
    if (local && local.score <= 1) {
      return { code: local.code, name: local.name };
    }

    // 网络搜索兜底
    const key = normalize(ocrName);
    if (key.length >= 2) {
      const remote = await global.FundApi.searchFund(key);
      if (remote && remote.length) {
        const top = remote[0];
        return { code: top.CODE, name: top.NAME };
      }
    }

    // 退回本地次优结果（可能有错，交由用户人工校正）
    return local ? { code: local.code, name: local.name } : null;
  }

  global.FundMatch = { loadTable, normalize, matchLocal, match };
})(window);
