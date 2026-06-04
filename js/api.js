/**
 * 天天基金数据访问层
 *
 * 职责：封装对天天基金（eastmoney）接口的访问。网页运行在浏览器中，
 * 部分接口无 CORS 头，故对其使用 JSONP；带 CORS 的接口直接 fetch。
 *
 * 接口清单：
 *  - 实时估值：fundgz.1234567.com.cn（JSONP，回调名固定 jsonpgz）
 *  - 基金详情/净值：fundmobapi.eastmoney.com（带 Access-Control-Allow-Origin:*，可直接 fetch）
 *  - 名称搜索兜底：fundsuggest.eastmoney.com（JSONP，callback 参数自定义）
 *
 * @author funds-web
 */
(function (global) {
  "use strict";

  // 详情接口需要一个 deviceid，固定占位即可
  const DEVICE_ID = "fundsweb000000000000000000000000";

  /**
   * 通用 JSONP 请求
   *
   * WHY：fundgz / fundsuggest 接口未返回 CORS 头，浏览器 fetch 会被同源策略拦截，
   * 通过动态 <script> 加载可绕过（脚本资源不受 CORS 限制）。
   *
   * @param {string} url 目标地址（不含 callback 参数）
   * @param {Object} opts { callbackParam:'callback', callbackName:可选固定回调名, timeout:ms }
   * @returns {Promise<any>}
   */
  function jsonp(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const callbackParam = opts.callbackParam || "callback";
      // 固定回调名（如 fundgz 的 jsonpgz）或随机生成，避免并发冲突
      const cbName =
        opts.callbackName ||
        "__fw_jsonp_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const timeout = opts.timeout || 12000;

      const script = document.createElement("script");
      let timer = null;

      // 清理：移除全局回调、脚本节点、定时器，防止内存泄漏
      function cleanup() {
        if (timer) clearTimeout(timer);
        delete global[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      global[cbName] = function (data) {
        cleanup();
        resolve(data);
      };

      script.onerror = function () {
        cleanup();
        reject(new Error("JSONP 加载失败：" + url));
      };

      timer = setTimeout(function () {
        cleanup();
        reject(new Error("JSONP 请求超时：" + url));
      }, timeout);

      const sep = url.indexOf("?") >= 0 ? "&" : "?";
      script.src = url + sep + callbackParam + "=" + cbName;
      document.body.appendChild(script);
    });
  }

  /**
   * 获取单只基金的实时估值
   * @param {string} code 6 位基金代码
   * @returns {Promise<Object|null>} { fundcode,name,jzrq,dwjz,gsz,gszzl,gztime } 或 null
   */
  function getEstimate(code) {
    const url =
      "https://fundgz.1234567.com.cn/js/" + code + ".js?rt=" + Date.now();
    // fundgz 回调名固定为 jsonpgz
    return jsonp(url, { callbackName: "jsonpgz" }).catch(() => null);
  }

  /**
   * 批量获取多只基金的实时估值（并发，但回调名共享）
   *
   * WHY：fundgz 接口的 JSONP 回调名被服务端写死为 `jsonpgz`，无法像普通 JSONP
   * 那样给每个请求生成唯一回调名。若沿用通用 jsonp() 逐只并发，21 个请求会争抢
   * 同一个 window.jsonpgz：先返回的那个解析后即把回调删除，其余请求的脚本执行时
   * 找不到 jsonpgz 而静默失败，最终各自等到超时 —— 表现为整表卡顿十余秒。
   *
   * 解决：注册【单一持久回调】jsonpgz 作为分发器，按响应体里的 fundcode 把数据
   * 派发给对应的待定请求；所有脚本并发加载，全部完成（或超时）后才移除该回调。
   *
   * @param {string[]} codes 基金代码数组
   * @returns {Promise<Object>} 以 code 为键的估值 map，缺失项为 null
   */
  function getEstimates(codes) {
    return new Promise((resolve) => {
      const result = {};
      if (!codes || !codes.length) return resolve(result);

      // 待定请求表：code -> { script, timer }
      const pending = new Map();
      let remaining = codes.length;

      // 单只完成（成功/失败/超时）的统一收尾
      function settle(code, data) {
        if (!pending.has(code)) return;
        const { script, timer } = pending.get(code);
        clearTimeout(timer);
        if (script.parentNode) script.parentNode.removeChild(script);
        pending.delete(code);
        result[code] = data;
        // 全部结束后再移除分发器，避免提前删除导致后到的响应报错
        if (--remaining === 0) {
          if (global.jsonpgz === dispatcher) delete global.jsonpgz;
          resolve(result);
        }
      }

      // fundgz 响应固定调用 jsonpgz(data)，按 data.fundcode 分发到对应请求
      function dispatcher(data) {
        if (data && data.fundcode) settle(data.fundcode, data);
      }
      global.jsonpgz = dispatcher;

      codes.forEach((code) => {
        const script = document.createElement("script");
        // 单只 5s 超时即放弃，避免个别基金拖慢整体（原 12s 太久）
        const timer = setTimeout(() => settle(code, null), 5000);
        script.onerror = () => settle(code, null);
        pending.set(code, { script, timer });
        script.src =
          "https://fundgz.1234567.com.cn/js/" + code + ".js?rt=" + Date.now();
        document.body.appendChild(script);
      });
    });
  }

  /**
   * 批量获取基金详情（净值、累计净值、日涨跌幅等）
   *
   * @param {string[]} codes 基金代码数组
   * @returns {Promise<Object>} 以 code 为键的 map，值为详情对象
   */
  async function getFundInfo(codes) {
    if (!codes || !codes.length) return {};
    const fcodes = codes.join(",");
    const url =
      "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo" +
      "?pageIndex=1&pageSize=" +
      codes.length +
      "&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=" +
      DEVICE_ID +
      "&Fcodes=" +
      fcodes;

    const res = await fetch(url);
    const json = await res.json();
    const map = {};
    if (json && json.Datas) {
      json.Datas.forEach((d) => {
        map[d.FCODE] = d;
      });
    }
    return map;
  }

  /**
   * 获取单只基金的基础信息（含申购状态，用于「可买」监控）
   *
   * 接口 FundMNBasicInformation 带 CORS 头，浏览器可直接 fetch。
   * 关键字段：SGZT=申购状态（开放申购/限大额/暂停申购/封闭期…）、
   *           SGZTMARK=状态备注、BUY=是否可购买、SHORTNAME=简称。
   *
   * @param {string} code 6 位基金代码
   * @returns {Promise<Object|null>} { code, name, sgzt, sgztMark, buy } 或 null
   */
  async function getBasicInfo(code) {
    const url =
      "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation" +
      "?plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=" +
      DEVICE_ID +
      "&FCODE=" +
      code;
    try {
      const res = await fetch(url);
      const json = await res.json();
      const d = json && json.Datas;
      if (!d || !d.FCODE) return null;
      return {
        code: d.FCODE,
        name: d.SHORTNAME || "",
        sgzt: d.SGZT || "", // 申购状态
        sgztMark: d.SGZTMARK || "", // 状态备注（如限额说明）
        buy: d.BUY === true || d.BUY === "true",
      };
    } catch (e) {
      console.error("基金基础信息获取失败：" + code, e);
      return null;
    }
  }

  /**
   * 按关键字（基金名或代码）搜索基金
   * @param {string} key 关键字
   * @returns {Promise<Array>} 命中的基金数组（含 CODE / NAME）
   */
  function searchFund(key) {
    const url =
      "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx" +
      "?m=9&key=" +
      encodeURIComponent(key);
    return jsonp(url, { callbackParam: "callback" })
      .then((res) => (res && res.Datas ? res.Datas : []))
      .catch(() => []);
  }

  global.FundApi = {
    jsonp,
    getEstimate,
    getEstimates,
    getFundInfo,
    getBasicInfo,
    searchFund,
  };
})(window);
