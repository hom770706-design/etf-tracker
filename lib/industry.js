import { getIndustryMap, saveIndustryMap } from './storage.js';

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// TWSE 產業別代碼對應（備用靜態對照表）
const FALLBACK_INDUSTRY_NAMES = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維',
  '05': '電機機械', '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業',
  '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業', '13': '電子工業',
  '14': '建材營造', '15': '航運業',   '16': '觀光餐旅', '17': '金融保險',
  '18': '貿易百貨', '20': '其他',     '21': '化學工業', '22': '生技醫療',
  '23': '油電燃氣', '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業',
  '27': '通信網路業', '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業',
  '31': '其他電子業', '32': '文化創意業', '33': '農業科技業', '35': '綠能環保',
  '36': '數位雲端', '37': '運動休閒', '38': '居家生活'
};

export async function getOrRefreshIndustryMap() {
  const { map, updatedAt } = await getIndustryMap();
  const stale = (Date.now() - updatedAt) > REFRESH_INTERVAL_MS;

  if (Object.keys(map).length > 0 && !stale) return map;

  try {
    const fresh = await fetchIndustryMapFromTWSE();
    if (Object.keys(fresh).length > 50) {
      await saveIndustryMap(fresh);
      return fresh;
    }
  } catch (e) {
    console.warn('Industry map fetch failed, using cached/fallback:', e.message);
  }

  return Object.keys(map).length > 0 ? map : {};
}

async function fetchIndustryMapFromTWSE() {
  // TWSE ISIN page: 有價證券代號及名稱 (上市公司)
  const response = await fetch('https://isin.twse.com.tw/isin/C_public.jsp?strMode=2', {
    headers: { 'Accept': 'text/html', 'Accept-Language': 'zh-TW' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const html = new TextDecoder('big5').decode(buffer);
  return parseIsinHtml(html);
}

function parseIsinHtml(html) {
  // Service Worker 相容版：不使用 DOMParser，改用 Regex
  const map = {};

  // 找出所有 <tr>...</tr>
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRe.exec(html)) !== null) {
    const cells = (trMatch[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(td => td.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());

    if (cells.length < 5) continue;

    // 第一格：可能是 "XXXX　名稱" 或純代號
    const codeMatch = cells[0].match(/^(\d{4,6})/);
    if (!codeMatch) continue;

    const code = codeMatch[1];
    const industry = cells[4].replace(/\s+/g, '').trim();
    if (code && industry) map[code] = industry;
  }

  return map;
}

export function lookupIndustry(stockCode, industryMap) {
  return industryMap[stockCode] || '未知產業';
}

export function groupStocksByIndustry(stocks, industryMap) {
  const groups = {};
  for (const s of stocks) {
    const ind = lookupIndustry(s.code, industryMap);
    if (!groups[ind]) groups[ind] = [];
    groups[ind].push(s);
  }
  return groups;
}

export function summarizeIndustryChanges(changeHistory, industryMap) {
  // Returns { industry: { added: count, removed: count } }
  const summary = {};

  for (const { added, removed } of changeHistory) {
    for (const s of added) {
      const ind = lookupIndustry(s.code, industryMap);
      if (!summary[ind]) summary[ind] = { added: 0, removed: 0 };
      summary[ind].added++;
    }
    for (const s of removed) {
      const ind = lookupIndustry(s.code, industryMap);
      if (!summary[ind]) summary[ind] = { added: 0, removed: 0 };
      summary[ind].removed++;
    }
  }

  return summary;
}

export const INDUSTRY_COLORS = [
  '#E74C3C', '#3498DB', '#2ECC71', '#9B59B6', '#F39C12',
  '#1ABC9C', '#E67E22', '#34495E', '#E91E63', '#00BCD4',
  '#8BC34A', '#FF5722', '#607D8B', '#795548', '#CDDC39',
  '#673AB7', '#009688', '#FF9800', '#2196F3', '#4CAF50',
  '#F06292', '#26C6DA', '#D4E157', '#FF7043', '#78909C'
];
