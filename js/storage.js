/**
 * 本地存储封装
 *
 * 职责：替代 Chrome 扩展中的 chrome.storage.sync，使用浏览器 localStorage
 * 持久化用户的自选基金列表及配置。网页版无扩展运行环境，故全部本地存储。
 *
 * @author funds-web
 */
(function (global) {
  "use strict";

  // 存储键名常量，避免散落硬编码
  const KEY_FUND_LIST = "fw_fund_list"; // 自选基金列表
  const KEY_CONFIG = "fw_config"; // 用户配置

  /**
   * 读取自选基金列表
   * @returns {Array} 基金项数组，每项形如 { code, name, num, cost }
   */
  function getFundList() {
    try {
      const raw = localStorage.getItem(KEY_FUND_LIST);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      // 数据损坏时返回空列表，避免整页崩溃
      console.error("读取基金列表失败：", e);
      return [];
    }
  }

  /**
   * 保存自选基金列表
   * @param {Array} list 基金项数组
   */
  function saveFundList(list) {
    localStorage.setItem(KEY_FUND_LIST, JSON.stringify(list || []));
  }

  /**
   * 读取配置（如暗色模式、是否显示估值列等）
   * @returns {Object}
   */
  function getConfig() {
    try {
      const raw = localStorage.getItem(KEY_CONFIG);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("读取配置失败：", e);
      return {};
    }
  }

  /**
   * 保存配置（合并写入，不覆盖未提供的键）
   * @param {Object} patch 要更新的配置片段
   */
  function saveConfig(patch) {
    const cfg = Object.assign(getConfig(), patch || {});
    localStorage.setItem(KEY_CONFIG, JSON.stringify(cfg));
    return cfg;
  }

  global.FundStorage = { getFundList, saveFundList, getConfig, saveConfig };
})(window);
