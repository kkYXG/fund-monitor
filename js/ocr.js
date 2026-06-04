/**
 * 截图识别（OCR）
 *
 * 职责：使用 Tesseract.js（中文 chi_sim 模型）识别用户上传的支付宝/养基宝等
 * 基金持仓截图，逐行解析出「基金名称」与「持有额」，供主程序匹配基金代码后入库。
 *
 * 解析思路（针对持仓列表类截图）：
 *  - 每一行通常是一只基金：左侧为中文基金名，右侧/下方为金额数字
 *  - 取每行中最长的连续中文片段作为基金名
 *  - 取每行中最大的、像金额的数字（带千分位或小数）作为持有额
 *
 * 注意：纯前端 OCR 对中文密集表格准确率有限，结果必须经过人工校正，
 * 故只提取「名称 + 持有额」两个关键字段，缩小出错面。
 *
 * @author funds-web
 */
(function (global) {
  "use strict";

  /**
   * 图像预处理：放大 + 灰度 + 提对比度，显著提升 Tesseract 中文识别率
   *
   * WHY：手机持仓截图通常宽度偏小（750~1080px），且红绿涨跌色、背景渐变会干扰
   * 二值化。先按需放大到约 1600px 宽，再转灰度并拉高对比度（把中段灰度推向黑白
   * 两端），让文字边缘更锐利，OCR 准确率提升明显。不做硬阈值二值化，避免细笔画
   * 中文字（如「债」「鹏」）断裂。
   *
   * @param {string} src 图片 URL（含 ObjectURL）
   * @returns {Promise<HTMLCanvasElement>} 预处理后的画布
   */
  function preprocess(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = function () {
        // 放大到目标宽度（已足够大则保持），上限 2.5 倍避免内存过大
        const target = 1600;
        const scale = Math.min(2.5, Math.max(1, target / img.width));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        const imgData = ctx.getImageData(0, 0, w, h);
        const d = imgData.data;
        // 对比度系数：>1 增强对比；128 为中心点
        const contrast = 1.4;
        for (let i = 0; i < d.length; i += 4) {
          // 加权灰度（人眼对绿色更敏感）
          let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          // 以 128 为中心拉伸对比度
          gray = (gray - 128) * contrast + 128;
          gray = gray < 0 ? 0 : gray > 255 ? 255 : gray;
          d[i] = d[i + 1] = d[i + 2] = gray;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = src;
    });
  }

  /**
   * 对图片执行 OCR，返回原始文本
   * @param {string|File|HTMLImageElement} image 图片源（URL）
   * @param {Function} onProgress 进度回调，参数为 0~1
   * @returns {Promise<string>} 识别出的整段文本
   */
  async function recognize(image, onProgress) {
    if (!global.Tesseract) {
      throw new Error("Tesseract.js 未加载");
    }
    // 预处理失败（如非 URL 入参）则退回用原图，保证可用性
    let input = image;
    try {
      if (typeof image === "string") input = await preprocess(image);
    } catch (e) {
      input = image;
    }
    const result = await global.Tesseract.recognize(input, "chi_sim", {
      logger: (m) => {
        if (m.status === "recognizing text" && typeof onProgress === "function") {
          onProgress(m.progress);
        }
      },
      // PSM 6：假定为统一的文本块（持仓列表逐行排布），比默认自动分段更稳
      tessedit_pageseg_mode: "6",
    });
    return result.data.text || "";
  }

  /**
   * 去除汉字之间的多余空格
   *
   * WHY：Tesseract 识别中文时会在几乎每个字之间插入空格，
   * 例如「东兴 兴 福 一 年 定 开 债 券 A」。若不合并，连续汉字正则会被打碎，
   * 无法还原完整基金名。这里把「汉字 空格 汉字/字母/数字」之间的空格删掉，
   * 但保留数字与数字之间的空格（避免把两个独立数字粘连）。
   *
   * @param {string} line 单行文本
   * @returns {string} 合并后的文本
   */
  function squeezeCJK(line) {
    let s = line;
    // 反复消除「汉字(或紧邻汉字的字母/数字) + 空格 + 汉字」中的空格
    // 用循环处理连续多个空格分隔的单字
    let prev;
    do {
      prev = s;
      // 汉字 与 后面的 汉字/字母 之间的空格
      s = s.replace(/([一-龥])\s+([一-龥A-Za-z])/g, "$1$2");
      // 汉字 与 后面的 数字（如「6 个 月」「30 天」）之间的空格
      s = s.replace(/([一-龥])\s+(\d)/g, "$1$2");
      s = s.replace(/(\d)\s+([一-龥])/g, "$1$2");
    } while (s !== prev);
    return s;
  }

  // 表头/汇总/指数等非基金行的关键词，命中则整行跳过
  const LINE_BLACKLIST = [
    "基金名称",
    "账户资产",
    "账户汇总",
    "账户",
    "上证指数",
    "深证成指",
    "创业板",
    "当日收益",
    "关联板块",
    "场内穿透",
    "标普",
    "证券指数",
  ];

  /**
   * 提取一行中所有数字（金额/净值/涨跌幅都在内），保持出现顺序
   *
   * 已修复旧正则把无逗号长数字截断的问题（"2299.34"→"229"）。
   * 同时识别 ¥/￥ 以及被 OCR 误识成的「半/着/闻/¥」等货币前缀标记。
   *
   * @param {string} line 单行文本
   * @returns {Array<{value:number, raw:string, yen:boolean}>}
   */
  function extractNumbers(line) {
    // 货币符号常被 OCR 误识为 半/着/闻/十/羊 等，统一视作金额标记
    const re =
      /(¥|￥|半|着|闻|羊)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
    const out = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      const value = parseFloat(m[2].replace(/,/g, ""));
      if (!isNaN(value)) out.push({ value, raw: m[2], yen: !!m[1] });
    }
    return out;
  }

  /**
   * 从一行文本中提取基金名（已先经 squeezeCJK 合并空格）
   *
   * 基金名总是位于行首：以汉字开头，后跟连续的汉字/字母/数字/斜杠
   * （含「指数A」「A/B」「60天」「6个月」等），遇到空格即结束
   * （名称与净值/数据之间 OCR 会留空格）。取行首这一段作为名称。
   *
   * @param {string} line 已合并空格的单行文本
   * @returns {string} 基金名（可能为空）
   */
  function extractName(line) {
    const m = line.match(/^[一-龥][一-龥A-Za-z0-9\/]*/);
    return m ? m[0] : "";
  }

  /**
   * 判断整行是否应跳过（表头/汇总/指数）
   */
  function isBlacklistedLine(line) {
    return LINE_BLACKLIST.some((b) => line.indexOf(b) >= 0);
  }

  // 货币符及其常见 OCR 误识字符，用于判断「金额行」（养基宝布局）
  const CURRENCY_PREFIX = ["¥", "￥", "半", "着", "闻", "十", "羊", "丰"];

  /**
   * 判断一行是否以货币符（或其 OCR 误识字符）开头 —— 养基宝持有额行特征：
   * 「半 86,277.21 标普中国全债 +2.74%」
   */
  function startsWithCurrency(line) {
    const c = line.trim().charAt(0);
    return CURRENCY_PREFIX.indexOf(c) >= 0;
  }

  /**
   * 取一行中第一个 >=100 的数字（持有额通常是行内第一个大额数字）
   */
  function firstBigNumber(line) {
    const nums = extractNumbers(line);
    const big = nums.find((n) => n.value >= 100);
    return big ? big.value : null;
  }

  /**
   * 解析整段 OCR 文本为基金候选项数组
   *
   * 兼容两种真实截图布局（已用用户真实截图的 OCR 输出验证）：
   *
   *  A) 电脑端/支付宝列表：名称与数据同一行
   *     「东兴兴福一年定开债券A 1.4247 3,037.85 76.89 2.60% ...」
   *     第 1 个数字是估算净值(约 1.x)，其后第一个 >=100 的数是「持有额」。
   *
   *  B) 养基宝 App：名称在上行（行尾是涨跌幅/持有收益等），
   *     持有额在紧邻的下一行，且该行以 ¥（常被 OCR 误识为 半/着/闻）开头：
   *     「长盛全债指数增强A/B +0.08% +2299.34」  ← 名称行，2299 是持有收益
   *     「半 86,277.21 标普中国全债 +2.74%」      ← 此行 86,277.21 才是持有额
   *
   * 关键顺序：先判断下一行是否为「货币符开头」的金额行（布局 B），
   * 是则以下一行为准；否则再按同行净值判断（布局 A）。这样可避免把
   * 名称行里的「当日收益/持有收益」误当持有额。
   *
   * @param {string} text OCR 文本
   * @returns {Array} [{ name, amount }]
   */
  function parse(text) {
    const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // 预处理：合并汉字间空格
    const lines = rawLines.map(squeezeCJK);
    const items = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isBlacklistedLine(line)) continue;
      if (startsWithCurrency(line)) continue; // 金额行本身不作为基金名行

      const name = extractName(line);
      if (!name || name.length < 3) continue;

      let amount = null;
      const next = lines[i + 1];

      // 布局 B：下一行是货币符开头的金额行
      if (next && startsWithCurrency(next)) {
        amount = firstBigNumber(next);
        if (amount !== null) i++; // 消费掉金额行
      }

      // 布局 A：同行有「净值(0.1~10 的小数) + 持有额」
      if (amount === null) {
        const nums = extractNumbers(line);
        const navIdx = nums.findIndex(
          (n) => n.value > 0.1 && n.value < 10 && n.raw.indexOf(".") >= 0
        );
        if (navIdx >= 0) {
          for (let k = navIdx + 1; k < nums.length; k++) {
            if (nums[k].value >= 100) {
              amount = nums[k].value;
              break;
            }
          }
        }
      }

      if (amount !== null) items.push({ name, amount });
    }

    return items;
  }

  global.FundOcr = { recognize, parse, extractName, extractNumbers, squeezeCJK };
})(window);
