import { ETF_CODES, ETF_CONFIG } from '../lib/etf-config.js';
import { saveHoldings, getHoldings, getDates, saveLastFetch, saveFetchError, clearFetchError, getFetchErrors } from '../lib/storage.js';
import { getOrRefreshIndustryMap, lookupIndustry } from '../lib/industry.js';
import { diffHoldings } from '../lib/comparison.js';
import { syncToSheets } from '../lib/sheets.js';

const ALARM_NAME  = 'daily-etf-fetch';
const RETRY_ALARM = 'etf-fetch-retry';
const FETCH_HOUR  = 18;

// ── 安裝 / 啟動 ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => scheduleAlarm());
chrome.runtime.onStartup.addListener(() => scheduleAlarm());

// SW 被喚醒時（包含 alarm 觸發），確保排程存在
chrome.alarms.get(ALARM_NAME, alarm => {
  if (!alarm) scheduleAlarm();
});

function scheduleAlarm() {
  // 每次安裝/更新都重新設定，避免 reload 後 alarm 時間錯誤
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      when: getNextFetchTime(),
      periodInMinutes: 24 * 60
    });
    console.log(`[ETF Tracker] alarm 已設定，下次抓取: ${new Date(getNextFetchTime()).toLocaleString()}`);
  });
}

function getNextFetchTime() {
  const now = new Date();
  const next = new Date();
  next.setHours(FETCH_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return next.getTime();
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return;
    await openETFTabsForCollection(ETF_CODES, false);
  }
  if (alarm.name === RETRY_ALARM) {
    const errors = await getFetchErrors();
    const failedCodes = Object.keys(errors);
    if (failedCodes.length === 0) return;
    console.log(`[ETF Tracker] 重試 ${failedCodes.join(', ')}`);
    await openETFTabsForCollection(failedCodes, true);
  }
});

// ── 訊息處理 ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'fetchNow') {
    // return true → Chrome 持續保持 SW 存活直到 sendResponse 被呼叫
    openETFTabsForCollection()
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'contentScriptHoldings') {
    const { etfCode, date, stocks, url } = msg;
    handleContentScriptData(etfCode, date, stocks, url, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'saveHoldings') {
    saveHoldings(msg.code, msg.date, msg.stocks)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ── 開啟各 ETF 頁籤並等待 content script 回傳 ─────────────────────
const pendingTabs = new Map(); // tabId → { resolve, reject, etfCode }

async function openETFTabsForCollection(codesToFetch = ETF_CODES, isRetry = false) {
  const today = getTodayStr();
  const results = { date: today, success: [], failed: [] };
  console.log(`[ETF Tracker] ${isRetry ? '重試' : '開始'}抓取 ${today}，共 ${codesToFetch.length} 檔`);

  if (!isRetry) { try { await getOrRefreshIndustryMap(); } catch (_) {} }

  // 每批最多 4 個，避免同時開太多 tab 拖垮瀏覽器
  const BATCH = 4;
  for (let i = 0; i < codesToFetch.length; i += BATCH) {
    await Promise.allSettled(codesToFetch.slice(i, i + BATCH).map(code => collectViaTab(code, today, results)));
  }

  await saveLastFetch({
    time: Date.now(),
    date: today,
    success: results.success,
    failed: results.failed,
    method: 'scripting'
  });

  console.log(`[ETF Tracker] ${today} 完成: ✓${results.success.length} ✗${results.failed.length}`);

  // 有失敗且是第一次嘗試 → 2 小時後重試（限當天）
  if (!isRetry && results.failed.length > 0) {
    const retryAt = Date.now() + 2 * 60 * 60 * 1000;
    if (new Date(retryAt).toISOString().slice(0, 10) === today) {
      chrome.alarms.create(RETRY_ALARM, { when: retryAt });
      console.log(`[ETF Tracker] 排程 2 小時後重試 (${results.failed.map(f => f.code).join(', ')})`);
    }
  }

  // Google Sheets 自動同步（已設定 URL 才執行）
  try {
    const syncData = await buildEtfsData(today, results.success);
    await syncToSheets(today, syncData);
    console.log('[ETF Tracker] Google Sheets 同步完成');
  } catch (e) {
    console.warn('[ETF Tracker] Google Sheets 同步失敗:', e.message);
  }

  return results;
}

async function buildEtfsData(date, succeededCodes) {
  const industryMap = await getOrRefreshIndustryMap().catch(() => ({}));
  const addInd = stocks => stocks.map(s => ({ ...s, industry: lookupIndustry(s.code, industryMap) }));

  const etfs = {};
  for (const code of succeededCodes) {
    const dates   = await getDates(code);
    const holdings = addInd(await getHoldings(code, date));
    let added = [], removed = [], changed = [];
    if (dates.length >= 2) {
      const prev = await getHoldings(code, dates[dates.length - 2]);
      ({ added, removed, changed } = diffHoldings(prev, holdings));
      added   = addInd(added);
      removed = addInd(removed);
      changed = addInd(changed);
    }
    etfs[code] = { holdings, added, removed, changed };
  }

  // 計算重疊分析
  const stockMap = {};
  for (const [code, data] of Object.entries(etfs)) {
    for (const s of data.holdings) {
      if (!stockMap[s.code]) stockMap[s.code] = { name: s.name, industry: s.industry || '', etfs: {} };
      stockMap[s.code].etfs[code] = s.percentage;
    }
  }
  const overlap = Object.entries(stockMap)
    .filter(([, v]) => Object.keys(v.etfs).length >= 2)
    .map(([code, v]) => ({ code, ...v, count: Object.keys(v.etfs).length }))
    .sort((a, b) => b.count - a.count);

  return { etfs, overlap };
}

async function collectViaTab(etfCode, date, results) {
  const url = ETF_CONFIG[etfCode].portfolioUrls[0];
  let tab;
  let timeoutId;

  try {
    tab = await chrome.tabs.create({ url, active: false });
    console.log(`[ETF Tracker] ${etfCode} 開啟 tab ${tab.id}: ${url}`);

    // 等待 content script 回報（來自 content_scripts 自動注入 或 下方 executeScript）
    const dataPromise = new Promise((resolve, reject) => {
      pendingTabs.set(tab.id, { resolve, reject, etfCode });
      // 整體 80 秒上限（等待頁面載入 + SPA 渲染 + 資料提取）
      timeoutId = setTimeout(() => {
        pendingTabs.delete(tab.id);
        reject(new Error('80 秒內無資料'));
      }, 80000);
    });

    // 備援：頁面載入完成後再注入一次，解決 URL query string 無法匹配 content_scripts 的問題
    waitForTabComplete(tab.id, 50000)
      .then(loaded => {
        console.log(`[ETF Tracker] ${etfCode} tab ${tab.id} 載入${loaded ? '完成' : '超時'}，pendingTabs 存在: ${pendingTabs.has(tab.id)}`);
        if (!loaded || !pendingTabs.has(tab.id)) return;
        console.log(`[ETF Tracker] ${etfCode} 注入 executeScript`);
        return chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/extract.js']
        });
      })
      .then(res => { if (res) console.log(`[ETF Tracker] ${etfCode} executeScript 完成`); })
      .catch(err => console.warn(`[ETF Tracker] ${etfCode} executeScript 失敗:`, err?.message));

    await dataPromise;
    results.success.push(etfCode);
    await clearFetchError(etfCode);
  } catch (err) {
    const msg = err.message || String(err);
    results.failed.push({ code: etfCode, error: msg });
    await saveFetchError(etfCode, msg);
    console.error(`[ETF Tracker] ${etfCode} 失敗:`, msg);
  } finally {
    clearTimeout(timeoutId);
    pendingTabs.delete(tab?.id);
    try { if (tab?.id) await chrome.tabs.remove(tab.id); } catch (_) {}
  }
}

// 每秒輪詢 tab 狀態，直到 complete 或超時
async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return true;
    } catch {
      return false; // tab 已關閉
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function handleContentScriptData(etfCode, date, stocks, url, tabId) {
  const pending = tabId ? pendingTabs.get(tabId) : null;

  if (stocks.length > 0) {
    await saveHoldings(etfCode, date, stocks);
    console.log(`[ETF Tracker] ${etfCode} ← ${stocks.length} 筆 (${url})`);
    pending?.resolve(stocks);
  } else {
    pending?.reject(new Error(`content script 未解析到資料 (${url})`));
  }
}

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}
