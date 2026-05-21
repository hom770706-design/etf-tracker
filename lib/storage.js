const KEY = {
  holdings: (code, date) => `h_${code}_${date}`,
  dates: (code) => `dates_${code}`,
  industryMap: 'industry_map',
  industryUpdated: 'industry_updated',
  lastFetch: 'last_fetch',
  fetchErrors: 'fetch_errors',
  settings: 'settings'
};

const MAX_DAYS = 90;

export async function saveHoldings(etfCode, date, stocks) {
  await chrome.storage.local.set({ [KEY.holdings(etfCode, date)]: stocks });

  const dates = await getDates(etfCode);
  if (!dates.includes(date)) {
    dates.push(date);
    dates.sort();
    if (dates.length > MAX_DAYS) {
      const expired = dates.splice(0, dates.length - MAX_DAYS);
      await chrome.storage.local.remove(expired.map(d => KEY.holdings(etfCode, d)));
    }
    await chrome.storage.local.set({ [KEY.dates(etfCode)]: dates });
  }
}

export async function getHoldings(etfCode, date) {
  const r = await chrome.storage.local.get(KEY.holdings(etfCode, date));
  return r[KEY.holdings(etfCode, date)] || [];
}

export async function getDates(etfCode) {
  const r = await chrome.storage.local.get(KEY.dates(etfCode));
  return r[KEY.dates(etfCode)] || [];
}

export async function getLatestDate(etfCode) {
  const dates = await getDates(etfCode);
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

export async function getRecentHoldings(etfCode, count = 30) {
  const dates = await getDates(etfCode);
  const recent = dates.slice(-count);
  const result = {};
  for (const date of recent) {
    result[date] = await getHoldings(etfCode, date);
  }
  return result;
}

export async function saveIndustryMap(map) {
  await chrome.storage.local.set({
    [KEY.industryMap]: map,
    [KEY.industryUpdated]: Date.now()
  });
}

export async function getIndustryMap() {
  const r = await chrome.storage.local.get([KEY.industryMap, KEY.industryUpdated]);
  return {
    map: r[KEY.industryMap] || {},
    updatedAt: r[KEY.industryUpdated] || 0
  };
}

export async function saveLastFetch(info) {
  await chrome.storage.local.set({ [KEY.lastFetch]: info });
}

export async function getLastFetch() {
  const r = await chrome.storage.local.get(KEY.lastFetch);
  return r[KEY.lastFetch] || null;
}

export async function saveFetchError(etfCode, message) {
  const r = await chrome.storage.local.get(KEY.fetchErrors);
  const errors = r[KEY.fetchErrors] || {};
  errors[etfCode] = { message, time: Date.now() };
  await chrome.storage.local.set({ [KEY.fetchErrors]: errors });
}

export async function clearFetchError(etfCode) {
  const r = await chrome.storage.local.get(KEY.fetchErrors);
  const errors = r[KEY.fetchErrors] || {};
  delete errors[etfCode];
  await chrome.storage.local.set({ [KEY.fetchErrors]: errors });
}

export async function getFetchErrors() {
  const r = await chrome.storage.local.get(KEY.fetchErrors);
  return r[KEY.fetchErrors] || {};
}

export async function getStorageStats() {
  return new Promise(resolve => {
    chrome.storage.local.getBytesInUse(null, bytes => {
      resolve({ bytesUsed: bytes, mb: (bytes / 1024 / 1024).toFixed(2) });
    });
  });
}

export async function clearAll() {
  await chrome.storage.local.clear();
}

export async function getSettings() {
  const r = await chrome.storage.local.get(KEY.settings);
  return r[KEY.settings] || {};
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [KEY.settings]: settings });
}
