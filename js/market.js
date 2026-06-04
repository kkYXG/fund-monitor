/**
 * 大盘指数行情
 *
 * 职责：拉取上证指数、沪深300、深证成指、创业板指四大指数的实时行情，
 * 用于顶部行情条展示。
 *
 * 接口：qt.gtimg.cn（腾讯财经）—— `https://qt.gtimg.cn/q=s_sh000001,...`
 *   返回 GBK 文本，每行形如：
 *   v_s_sh000001="1~上证指数~000001~4072.26~-11.71~-0.29~成交量~成交额~...";
 *   字段：[3]=最新点数  [4]=涨跌点  [5]=涨跌幅(%)  [2]=代码
 *
 * WHY 换数据源：原 push2.eastmoney.com 既不返回 CORS 头，且对网页来源(Referer)
 * 做拦截，浏览器请求直接 ERR_EMPTY_RESPONSE，指数条永远空白。gtimg 返回
 * `Access-Control-Allow-Origin: *`，浏览器 fetch 可直接读取，稳定无跨域问题。
 *
 * WHY 只取数字、名称用本地占位：gtimg 返回 GBK 编码，中文名直接解码易乱码；
 * 而我们已有固定的四个指数中文名（PLACEHOLDERS），故响应里只解析价格/涨跌
 * （纯 ASCII 数字，任何编码都不会错），按代码并回占位即可。
 *
 * @author funds-web
 */
(function (global) {
  "use strict";

  // 腾讯行情代码（s_ 前缀=简要行情）。顺序与 PLACEHOLDERS 对应。
  const GTIMG_URL =
    "https://qt.gtimg.cn/q=s_sh000001,s_sh000300,s_sz399001,s_sz399006";

  // 固定占位：未取到数据前也先把四个指数名撑出来，保证行情条常驻显示
  const PLACEHOLDERS = [
    { code: "000001", name: "上证指数", price: null, change: null, changeRate: null },
    { code: "000300", name: "沪深300", price: null, change: null, changeRate: null },
    { code: "399001", name: "深证成指", price: null, change: null, changeRate: null },
    { code: "399006", name: "创业板指", price: null, change: null, changeRate: null },
  ];

  /**
   * 获取四大指数实时行情
   * @returns {Promise<Array>} [{ code, name, price, change, changeRate }]，失败时返回 []
   */
  async function getIndices() {
    try {
      const res = await fetch(GTIMG_URL + "&_=" + Date.now());
      // gtimg 为 GBK 编码；数字是 ASCII，用 GBK 解码保证万无一失
      const buf = await res.arrayBuffer();
      const text = new TextDecoder("gbk").decode(buf);

      // 解析每行 v_s_xxx="...~..." → 以代码为键存价格/涨跌
      const map = {};
      text.split(";").forEach((line) => {
        const m = line.match(/="([^"]*)"/);
        if (!m) return;
        const p = m[1].split("~");
        if (p.length < 6) return;
        map[p[2]] = {
          price: parseFloat(p[3]), // 最新点数
          change: parseFloat(p[4]), // 涨跌点
          changeRate: parseFloat(p[5]), // 涨跌幅 %
        };
      });

      // 按固定占位顺序并回数据，中文名用占位，保证顺序与名称稳定
      const list = PLACEHOLDERS.map((ph) => {
        const d = map[ph.code];
        return d
          ? {
              code: ph.code,
              name: ph.name,
              price: d.price,
              change: d.change,
              changeRate: d.changeRate,
            }
          : { ...ph };
      });
      // 至少有一个指数解析成功才算有效，否则交由调用方保留占位
      return list.some((x) => x.price != null) ? list : [];
    } catch (e) {
      console.error("指数行情获取失败：", e);
      return [];
    }
  }

  global.FundMarket = { getIndices, PLACEHOLDERS };
})(window);
