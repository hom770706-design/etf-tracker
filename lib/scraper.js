/**
 * ETF Holdings Scraper
 * Service Worker 相容版（不使用 DOMParser）
 *
 * 抓取策略（依序嘗試）:
 *   1. TWSE ETFortune 一般投資人頁面 (www)
 *   2. TWSE ETFortune 法人頁面 (wwwc)
 *   3. 各發行商官網 (00980A 專屬)
 *
 * 回傳格式: [{ code, name, shares, percentage }]
 */

const FETCH_OPTS = {
  headers: {
    'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache'
  }
};

// ── 各 ETF 抓取 URL（按優先順序） ────────────────────────────────────
function getStrategies(code) {
  const strategies = [
    {
      name: 'TWSE-www',
      url: `https://www.twse.com.tw/zh/ETFortune/etfInfo/${code}`
    },
    {
      name: 'TWSE-wwwc',
      url: `https://wwwc.twse.com.tw/zh/ETFortune-institute/etfInfo/${code}`
    }
  ];

  if (code === '00980A') {
    strategies.push({ name: 'Nomura', url: 'https://money.nomurafunds.com.tw/etf/00980A' });
  }
  if (code === '00981A' || code === '00403A') {
    strategies.push({ name: 'President', url: `https://www.president-securities.com.tw/fund/${code}` });
  }
  if (code === '00982A') {
    strategies.push({ name: 'KGI', url: 'https://www.kgifund.com.tw/fund/00982A' });
  }

  return strategies;
}

// ── 公開入口 ──────────────────────────────────────────────────────────
export async function scrapeETF(etfCode) {
  const errors = [];

  for (const { name, url } of getStrategies(etfCode)) {
    try {
      const stocks = await fetchAndParse(url);
      if (stocks.length > 0) return stocks;
      errors.push(`${name} (${url}): 解析到 0 筆`);
    } catch (e) {
      errors.push(`${name} (${url}): ${e.message}`);
    }
  }

  throw new Error(`scrapeETF(${etfCode}) 全部策略失敗:\n${errors.join('\n')}`);
}

// ── 統一抓取與解析 ────────────────────────────────────────────────────
async function fetchAndParse(url) {
  const resp = await fetch(url, FETCH_OPTS);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const ct = resp.headers.get('content-type') || '';

  if (ct.includes('application/json')) {
    const data = await resp.json();
    return parseTWSEJsonData(data);
  }

  const html = await resp.text();

  // Step 1: 嘗試從 HTML 中找嵌入 JSON（React SSR / Next.js 常見模式）
  const fromScript = extractJsonFromHtml(html);
  if (fromScript.length > 0) return fromScript;

  // Step 2: 嘗試解析 HTML table（regex，不用 DOMParser）
  const fromTable = extractTableFromHtml(html);
  if (fromTable.length > 0) return fromTable;

  return [];
}

// ── 從 HTML script tag 中提取 JSON（Regex，無 DOMParser）────────────
function extractJsonFromHtml(html) {
  // 1. 先嘗試已知的 key 名稱
  const keyPatterns = [
    'portfolioData', 'holdings', 'fundPortfolio', 'stockList',
    'portfolio', 'stockHoldings', 'components'
  ];

  for (const key of keyPatterns) {
    const re = new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]{20,200000}?\\])`, '');
    const m = html.match(re);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const stocks = parseTWSEJsonData(data);
        if (stocks.length > 0) return stocks;
      } catch (_) {}
    }
  }

  // 2. 嘗試 __NEXT_DATA__ (Next.js)
  const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const stocks = findStocksInObject(nextData);
      if (stocks.length > 0) return stocks;
    } catch (_) {}
  }

  // 3. 嘗試 window.__INITIAL_STATE__ / window.__NUXT__
  const windowPatterns = [
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]{20,500000}?})\s*;?\s*(?:<\/script>|$)/,
    /window\.__NUXT__\s*=\s*({[\s\S]{20,500000}?})\s*;?\s*(?:<\/script>|$)/,
    /window\.initialState\s*=\s*({[\s\S]{20,500000}?})\s*;?\s*(?:<\/script>|$)/
  ];

  for (const pattern of windowPatterns) {
    const m = html.match(pattern);
    if (m) {
      try {
        const obj = JSON.parse(m[1]);
        const stocks = findStocksInObject(obj);
        if (stocks.length > 0) return stocks;
      } catch (_) {}
    }
  }

  return [];
}

// 遞迴搜尋物件中的持股陣列
function findStocksInObject(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return [];

  if (Array.isArray(obj) && obj.length >= 3) {
    try {
      const sample = obj[0];
      // 判斷是否像是持股資料（有 code/stockCode 且為4位數字）
      if (sample && typeof sample === 'object') {
        const codeVal = sample.code || sample.stockCode || sample.securityCode || '';
        if (isValidCode(cleanCode(String(codeVal)))) {
          const parsed = parseTWSEJsonData(obj);
          if (parsed.length > 0) return parsed;
        }
      }
      // 若是 Array of Arrays
      if (Array.isArray(sample) && isValidCode(cleanCode(String(sample[0] || '')))) {
        const parsed = parseTWSEJsonData(obj);
        if (parsed.length > 0) return parsed;
      }
    } catch (_) {}
  }

  for (const val of Object.values(obj)) {
    const found = findStocksInObject(val, depth + 1);
    if (found.length > 0) return found;
  }

  return [];
}

// ── 從 HTML Table 中用 Regex 提取資料（無 DOMParser）────────────────
function extractTableFromHtml(html) {
  const stocks = [];

  // 找出所有 <table>...</table>
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const tableMatches = html.match(tableRe) || [];

  for (const tableHtml of tableMatches) {
    // 判斷 header 是否包含股票相關欄位
    const headers = (tableHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || [])
      .map(th => stripHtml(th)).join('|');

    if (!/(代號|代碼|股票|Code|Symbol)/i.test(headers)) continue;

    // 提取所有 <tr>
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;

    while ((trMatch = trRe.exec(tableHtml)) !== null) {
      const cells = (trMatch[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(td => stripHtml(td));

      if (cells.length < 2) continue;
      const code = cleanCode(cells[0]);
      if (!isValidCode(code)) continue;

      stocks.push({
        code,
        name: cells[1] || '',
        shares: parseNumber(cells[2] || '0'),
        percentage: parsePercent(cells[4] || cells[3] || '0')
      });
    }

    if (stocks.length > 0) break;
  }

  return stocks;
}

// ── TWSE JSON 解析（支援多種格式） ───────────────────────────────────
function parseTWSEJsonData(data) {
  let rows = null;

  if (Array.isArray(data)) rows = data;
  else if (Array.isArray(data?.data)) rows = data.data;
  else if (Array.isArray(data?.portfolioData)) rows = data.portfolioData;
  else if (Array.isArray(data?.holdings)) rows = data.holdings;
  else if (Array.isArray(data?.stockList)) rows = data.stockList;

  if (!rows || rows.length === 0) throw new Error('JSON 格式無法識別或空白');

  return rows.map(row => {
    if (Array.isArray(row)) {
      return {
        code: cleanCode(row[0]),
        name: String(row[1] || '').trim(),
        shares: parseNumber(row[2]),
        percentage: parsePercent(row[4] ?? row[3])
      };
    }
    return {
      code: cleanCode(row.stockCode ?? row.code ?? row.securityCode ?? ''),
      name: String(row.stockName ?? row.name ?? row.securityName ?? '').trim(),
      shares: parseNumber(row.shares ?? row.holdingShares ?? 0),
      percentage: parsePercent(row.percentage ?? row.ratio ?? row.holdingRatio ?? 0)
    };
  }).filter(s => isValidCode(s.code) && s.name);
}

// ── 工具函式 ──────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanCode(raw) {
  return String(raw ?? '').trim().replace(/[^\dA-Za-z]/g, '');
}

function isValidCode(code) {
  return /^\d{4,6}[A-Za-z]?$/.test(code);
}

function parseNumber(raw) {
  return parseInt(String(raw ?? '0').replace(/[^0-9]/g, ''), 10) || 0;
}

function parsePercent(raw) {
  return parseFloat(String(raw ?? '0').replace(/[^0-9.]/g, '')) || 0;
}

// ── 手動匯入 ─────────────────────────────────────────────────────────
export function parseManualInput(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); }
  catch (e) { throw new Error('JSON 格式錯誤: ' + e.message); }

  const rows = Array.isArray(data) ? data : data?.data ?? data?.holdings ?? [];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('找不到持股資料陣列');

  return parseTWSEJsonData(rows);
}
