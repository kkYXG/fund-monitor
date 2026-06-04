/**
 * 主应用
 *
 * 职责：Vue3 根组件。负责自选基金列表的渲染、增删改、实时数据刷新，
 * 以及截图 OCR 识别 → 人工校正 → 批量入库的完整交互流程。
 *
 * 字段计算（与原扩展一致）：
 *   持有额   = 估算净值(或净值) × 份额
 *   持有收益 = (净值 − 成本价) × 份额        （无成本价时为 0）
 *   持有收益率 = (净值 − 成本价) / 成本价 × 100%
 *   估算收益 = (估算净值 − 净值) × 份额
 *   涨跌幅   = 估算涨跌幅 gszzl（盘中）或日涨跌幅 NAVCHGRT（已收盘）
 *
 * @author funds-web
 */
const { createApp, reactive, computed, onMounted, toRefs } = Vue;

createApp({
  setup() {
    const state = reactive({
      funds: [], // 列表项：{ code, name, num, cost, dwjz, gsz, gszzl, gztime, navchgrt }
      loading: false,
      // 手动添加
      showAdd: false,
      searchKey: "",
      searchResults: [],
      // OCR
      showOcr: false,
      ocrProgress: 0,
      ocrRunning: false,
      reviewRows: [], // OCR 校正行：{ name, amount, code, matched, dwjz }
      dragover: false,
      indices: [], // 大盘指数行情
      paused: false, // 暂停自动更新
      // 列表视图切换：funds=自选基金 / watch=监控列表
      activeTab: "funds",
      // 可买监控
      showWatch: false,
      watchInput: "",
      watchList: [], // [{ code, name, sgzt, sgztMark, buyable }]
      watchLoading: false,
      watchSyncing: false,
      syncMsg: "",
      syncOk: false,
      // GitHub 同步配置（持久化到 FundStorage 配置）
      ghOwner: "",
      ghRepo: "",
      ghToken: "",
    });

    /* ---------- 数值格式化 ---------- */
    function fmt(n, digits = 2) {
      if (n === null || n === undefined || isNaN(n)) return "--";
      return Number(n).toLocaleString("zh-CN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    }

    /* ---------- 单项派生计算 ---------- */
    // 当前用于计算的净值：盘中优先用估算净值 gsz，否则用昨日净值 dwjz
    function curNav(f) {
      return f.gsz ? Number(f.gsz) : Number(f.dwjz) || 0;
    }
    function holdAmount(f) {
      return curNav(f) * (Number(f.num) || 0);
    }
    function holdProfit(f) {
      if (!f.cost) return 0;
      return (Number(f.dwjz) - Number(f.cost)) * (Number(f.num) || 0);
    }
    function holdProfitRate(f) {
      if (!f.cost || Number(f.cost) === 0) return 0;
      return ((Number(f.dwjz) - Number(f.cost)) / Number(f.cost)) * 100;
    }
    // 估算收益 = (估算净值 − 昨日净值) × 份额
    function estProfit(f) {
      if (!f.gsz) return 0;
      return (Number(f.gsz) - Number(f.dwjz)) * (Number(f.num) || 0);
    }
    function changeRate(f) {
      // 盘中有估算涨跌幅用估算，否则用日涨跌幅
      const v = f.gszzl !== null && f.gszzl !== undefined ? f.gszzl : f.navchgrt;
      return v === null || v === undefined ? null : Number(v);
    }

    /* ---------- 汇总：总资产 / 当日估算收益 ---------- */
    const totalAmount = computed(() =>
      state.funds.reduce((s, f) => s + holdAmount(f), 0)
    );
    const totalEstProfit = computed(() =>
      state.funds.reduce((s, f) => s + estProfit(f), 0)
    );
    // 持有收益合计（(净值−成本)×份额 之和）
    const totalHoldProfit = computed(() =>
      state.funds.reduce((s, f) => s + holdProfit(f), 0)
    );
    // 日收益率 = 当日估算收益 / (总资产 − 当日估算收益)
    const totalEstProfitRate = computed(() => {
      const base = totalAmount.value - totalEstProfit.value;
      return base > 0 ? (totalEstProfit.value / base) * 100 : 0;
    });
    // 持有收益率 = 持有收益 / 成本合计
    const totalHoldProfitRate = computed(() => {
      const cost = state.funds.reduce(
        (s, f) => s + (Number(f.cost) || 0) * (Number(f.num) || 0),
        0
      );
      return cost > 0 ? (totalHoldProfit.value / cost) * 100 : 0;
    });

    /* ---------- 数据加载 ---------- */
    /**
     * 拉取大盘指数行情（顶部行情条）
     */
    async function loadIndices() {
      const data = await FundMarket.getIndices();
      if (data.length) {
        // 按固定占位顺序合并，保证四个指数顺序稳定、名称不丢；
        // 某个指数偶发缺失时退回其占位（只更新拿到的那几个）。
        state.indices = FundMarket.PLACEHOLDERS.map((p) => {
          const hit = data.find((d) => d.code === p.code);
          return hit ? hit : { ...p };
        });
      }
      // data 为空（网络/接口异常）时保留现有占位，不清空 —— 行情条始终显示
    }

    /**
     * 拉取列表中所有基金的净值 + 实时估值并合并进 state
     */
    async function refresh() {
      // 顶部指数与基金列表都刷新；指数不依赖自选基金，独立加载
      loadIndices();
      if (!state.funds.length) return;
      state.loading = true;
      try {
        const codes = state.funds.map((f) => f.code);

        // 第一步：批量净值（单请求，约 0.1s）。拿到后立即写入并渲染，
        // 表格用昨日净值先把「持有额/持有收益」画出来，避免空等估值。
        const infoMap = await FundApi.getFundInfo(codes);
        state.funds.forEach((f) => {
          const info = infoMap[f.code];
          if (info) {
            f.name = f.name || info.SHORTNAME;
            f.dwjz = info.NAV;
            f.navchgrt = info.NAVCHGRT;
          }
        });

        // 第二步：并发取实时估值（按 fundcode 分发的单一回调，5s 超时），
        // 回来后补上「估算净值/估算涨跌幅/估算收益」。首屏已渲染，这步只做增量更新。
        const estMap = await FundApi.getEstimates(codes);
        state.funds.forEach((f) => {
          const est = estMap[f.code];
          if (est) {
            // 估值接口的 dwjz 更可靠，优先采用
            f.dwjz = est.dwjz || f.dwjz;
            f.gsz = est.gsz;
            f.gszzl = est.gszzl;
            f.gztime = est.gztime;
          }
        });
        persist();
      } catch (e) {
        console.error("刷新失败：", e);
        alert("数据刷新失败，请检查网络后重试");
      } finally {
        state.loading = false;
      }
    }

    function persist() {
      // 仅持久化用户数据字段，行情数据下次刷新重新拉取
      FundStorage.saveFundList(
        state.funds.map((f) => ({
          code: f.code,
          name: f.name,
          num: f.num,
          cost: f.cost,
        }))
      );
    }

    /* ---------- 手动添加 ---------- */
    let searchTimer = null;
    function onSearchInput() {
      clearTimeout(searchTimer);
      const key = state.searchKey.trim();
      if (!key) {
        state.searchResults = [];
        return;
      }
      // 防抖，避免每次按键都打接口
      searchTimer = setTimeout(async () => {
        state.searchResults = await FundApi.searchFund(key);
      }, 300);
    }
    function addFund(code, name) {
      if (state.funds.some((f) => f.code === code)) {
        alert("该基金已在列表中");
        return;
      }
      state.funds.push({
        code,
        name,
        num: 0,
        cost: 0,
        dwjz: null,
        gsz: null,
        gszzl: null,
        gztime: null,
        navchgrt: null,
      });
      persist();
      state.showAdd = false;
      state.searchKey = "";
      state.searchResults = [];
      refresh();
    }
    function removeFund(code) {
      if (!confirm("确定删除该基金？")) return;
      state.funds = state.funds.filter((f) => f.code !== code);
      persist();
    }
    /**
     * 一键清空当前自选基金列表
     *
     * 二次确认后清空内存列表并同步持久化（localStorage），避免误操作。
     * 仅清自选列表，不影响行情/指数等其它数据。
     */
    function clearAll() {
      if (!state.funds.length) return;
      if (!confirm("确定清空全部 " + state.funds.length + " 只自选基金？此操作不可恢复。")) {
        return;
      }
      state.funds = [];
      persist();
    }

    /* ---------- 可买监控 ---------- */
    /**
     * 切换列表视图（自选基金 / 监控列表）。切到监控时载入配置并刷新一次状态。
     * @param {string} tab 'funds' | 'watch'
     */
    function switchTab(tab) {
      state.activeTab = tab;
      if (tab === "watch") {
        state.syncMsg = "";
        // 载入已保存的 GitHub 配置到表单
        const cfg = FundStorage.getConfig();
        state.ghOwner = cfg.ghOwner || "";
        state.ghRepo = cfg.ghRepo || "";
        state.ghToken = cfg.ghToken || "";
        refreshWatchStatus();
      }
    }

    /**
     * 添加一个监控代码（6 位校验 + 去重），随后查状态并自动同步云端
     */
    async function addWatch() {
      const code = state.watchInput.trim();
      if (!/^\d{6}$/.test(code)) {
        alert("请输入 6 位基金代码");
        return;
      }
      if (!FundWatch.addCode(code)) {
        alert("该代码已在监控列表中");
        return;
      }
      state.watchInput = "";
      state.watchList.push({ code, name: "", sgzt: "", sgztMark: "", buyable: false });
      // 先把名单同步到云端，再触发云端立即查这只并发邮件
      await autoSync();
      refreshWatchStatus();
      state.syncMsg = "正在请求云端发送邮件…";
      const r = await FundWatch.triggerCheck(code);
      state.syncOk = r.ok;
      state.syncMsg = r.message;
    }

    function removeWatch(code) {
      FundWatch.removeCode(code);
      state.watchList = state.watchList.filter((w) => w.code !== code);
      autoSync();
    }

    /**
     * 批量查询监控列表中各基金的实时申购状态
     */
    async function refreshWatchStatus() {
      const codes = FundWatch.getList();
      // 名单可能在别处变化，以存储为准重建
      if (codes.length !== state.watchList.length) {
        state.watchList = codes.map((c) => {
          const old = state.watchList.find((w) => w.code === c);
          return old || { code: c, name: "", sgzt: "", sgztMark: "", buyable: false };
        });
      }
      if (!codes.length) return;
      state.watchLoading = true;
      try {
        const rows = await FundWatch.checkStatus(codes);
        state.watchList = rows;
      } catch (e) {
        console.error("查询监控状态失败：", e);
      } finally {
        state.watchLoading = false;
      }
    }

    /** 保存 GitHub 同步配置到本地 */
    function saveGhConfig() {
      FundStorage.saveConfig({
        ghOwner: state.ghOwner.trim(),
        ghRepo: state.ghRepo.trim(),
        ghToken: state.ghToken.trim(),
      });
      state.syncOk = true;
      state.syncMsg = "设置已保存到本机";
    }

    /** 手动「测试 / 立即同步」名单到 GitHub */
    async function syncWatch() {
      saveGhConfig();
      state.watchSyncing = true;
      state.syncMsg = "";
      try {
        const res = await FundWatch.syncToGitHub(FundWatch.getList());
        state.syncOk = res.ok;
        state.syncMsg = res.message;
      } finally {
        state.watchSyncing = false;
      }
    }

    /**
     * 名单变更后静默同步：仅当已配置好 GitHub 时尝试，失败只提示不打断操作
     */
    async function autoSync() {
      const cfg = FundStorage.getConfig();
      if (!cfg.ghOwner || !cfg.ghRepo || !cfg.ghToken) return;
      const res = await FundWatch.syncToGitHub(FundWatch.getList());
      state.syncOk = res.ok;
      state.syncMsg = res.ok ? "已自动同步云端" : "自动同步失败：" + res.message;
    }
    /**
     * 编辑持有份额 / 成本价
     *
     * 用轻量 prompt 录入，避免再写一套表单弹窗；份额影响持有额与各类收益，
     * 成本价用于计算持有收益率。
     */
    function editHolding(f) {
      const num = prompt(
        "持有份额（" + f.name + "）：",
        f.num || 0
      );
      if (num === null) return;
      const cost = prompt("成本价（每份，可留空）：", f.cost || 0);
      f.num = isNaN(parseFloat(num)) ? 0 : parseFloat(num);
      f.cost = isNaN(parseFloat(cost)) ? 0 : parseFloat(cost);
      persist();
    }

    /* ---------- OCR 截图识别 ---------- */
    function openOcr() {
      state.showOcr = true;
      state.reviewRows = [];
      state.ocrProgress = 0;
    }
    function onDrop(e) {
      state.dragover = false;
      const file = e.dataTransfer.files[0];
      if (file) handleImage(file);
    }
    function onFilePick(e) {
      const file = e.target.files[0];
      if (file) handleImage(file);
    }
    /**
     * 全局粘贴：复制一张图片后，在页面任意位置按 Ctrl+V 即可直接识别，
     * 无需先打开弹窗或选择文件。检测到剪贴板里有图片就自动打开识别弹窗并开始。
     *
     * WHY 全局监听：用户的复制来源多样（截图工具、聊天软件、浏览器右键复制图片），
     * 直接在 window 上捕获 paste 体验最顺；仅当剪贴板含图片时才介入，纯文本粘贴不受影响。
     */
    function onPaste(e) {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.indexOf("image") === 0) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            // 自动打开识别弹窗，让用户看到进度与结果
            state.showOcr = true;
            state.reviewRows = [];
            handleImage(file);
          }
          break;
        }
      }
    }

    /**
     * 识别图片 → 解析 → 匹配基金代码 → 生成校正行
     */
    async function handleImage(file) {
      state.ocrRunning = true;
      state.ocrProgress = 0;
      state.reviewRows = [];
      try {
        const url = URL.createObjectURL(file);
        const text = await FundOcr.recognize(url, (p) => {
          state.ocrProgress = Math.round(p * 100);
        });
        URL.revokeObjectURL(url);

        const candidates = FundOcr.parse(text);
        // 预加载基金表，确保匹配可用
        await FundMatch.loadTable();

        // 逐项匹配基金代码
        const rows = [];
        for (const c of candidates) {
          const m = await FundMatch.match(c.name);
          rows.push({
            ocrName: c.name,
            name: m ? m.name : c.name,
            code: m ? m.code : "",
            amount: c.amount,
            matched: !!m,
          });
        }
        state.reviewRows = rows;
        if (!rows.length) {
          alert("未能从截图中识别出基金，请尝试更清晰的截图或手动添加");
        }
      } catch (e) {
        console.error("OCR 失败：", e);
        alert("识别失败：" + e.message);
      } finally {
        state.ocrRunning = false;
      }
    }

    /**
     * 确认校正结果，批量入库
     * 用持有额反推份额：份额 = 持有额 / 净值（净值缺失时先存份额=0，刷新后再补算）
     */
    async function confirmReview() {
      const valid = state.reviewRows.filter((r) => r.code && r.amount);
      if (!valid.length) {
        alert("没有可导入的有效基金");
        return;
      }
      // 先取这些基金的净值，用于反推份额
      const codes = valid.map((r) => r.code);
      const infoMap = await FundApi.getFundInfo(codes);

      valid.forEach((r) => {
        if (state.funds.some((f) => f.code === r.code)) return; // 跳过重复
        const info = infoMap[r.code];
        const nav = info ? parseFloat(info.NAV) : 0;
        const num = nav > 0 ? r.amount / nav : 0;
        state.funds.push({
          code: r.code,
          name: r.name,
          num: Number(num.toFixed(2)),
          cost: 0,
          dwjz: info ? info.NAV : null,
          gsz: null,
          gszzl: null,
          gztime: null,
          navchgrt: info ? info.NAVCHGRT : null,
        });
      });
      persist();
      state.showOcr = false;
      refresh();
    }

    /* ---------- 暂停/恢复自动更新 ---------- */
    let autoTimer = null;
    function startAuto() {
      stopAuto();
      // 每 60 秒自动刷新一次行情（与原扩展定时刷新行为一致）
      autoTimer = setInterval(() => {
        if (!state.paused) refresh();
      }, 60000);
    }
    function stopAuto() {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    }
    function togglePause() {
      state.paused = !state.paused;
      // 恢复时立即刷新一次，避免等待整个周期
      if (!state.paused) refresh();
    }

    /* ---------- 初始化 ---------- */
    onMounted(() => {
      // 先用占位填充指数条，保证一进页面就常驻显示四大指数（数据随后补入）
      state.indices = FundMarket.PLACEHOLDERS.map((p) => ({ ...p }));
      const saved = FundStorage.getFundList();
      state.funds = saved.map((f) => ({
        ...f,
        dwjz: null,
        gsz: null,
        gszzl: null,
        gztime: null,
        navchgrt: null,
      }));
      // 载入监控名单（仅代码，状态待打开弹窗时刷新）
      state.watchList = FundWatch.getList().map((c) => ({
        code: c,
        name: "",
        sgzt: "",
        sgztMark: "",
        buyable: false,
      }));
      // 预热基金代码表（不阻塞首屏）
      FundMatch.loadTable().catch(() => {});
      refresh();
      startAuto();
      window.addEventListener("paste", onPaste);
    });

    return {
      ...toRefs(state),
      fmt,
      curNav,
      holdAmount,
      holdProfit,
      holdProfitRate,
      estProfit,
      changeRate,
      totalAmount,
      totalEstProfit,
      totalEstProfitRate,
      totalHoldProfit,
      totalHoldProfitRate,
      togglePause,
      refresh,
      onSearchInput,
      addFund,
      removeFund,
      clearAll,
      editHolding,
      openOcr,
      onDrop,
      onFilePick,
      handleImage,
      confirmReview,
      switchTab,
      addWatch,
      removeWatch,
      refreshWatchStatus,
      saveGhConfig,
      syncWatch,
    };
  },
}).mount("#app");
