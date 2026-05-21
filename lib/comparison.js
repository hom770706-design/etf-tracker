import { getDates, getHoldings } from './storage.js';

export function diffHoldings(prevStocks, currStocks) {
  const prevMap = new Map(prevStocks.map(s => [s.code, s]));
  const currMap = new Map(currStocks.map(s => [s.code, s]));

  const added   = currStocks.filter(s => !prevMap.has(s.code));
  const removed = prevStocks.filter(s => !currMap.has(s.code));
  const changed = currStocks
    .filter(s => prevMap.has(s.code))
    .map(s => ({
      ...s,
      prevPct: prevMap.get(s.code).percentage,
      delta: +(s.percentage - prevMap.get(s.code).percentage).toFixed(2)
    }))
    .filter(s => Math.abs(s.delta) >= 0.1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return { added, removed, changed };
}

// Returns array of { date, added[], removed[] } for an ETF
export async function buildChangeHistory(etfCode) {
  const dates = await getDates(etfCode);
  const history = [];

  for (let i = 1; i < dates.length; i++) {
    const [prev, curr] = await Promise.all([
      getHoldings(etfCode, dates[i - 1]),
      getHoldings(etfCode, dates[i])
    ]);
    if (prev.length === 0 || curr.length === 0) continue;

    const { added, removed, changed } = diffHoldings(prev, curr);
    history.push({ date: dates[i], added, removed, changed });
  }

  return history;
}

// Returns { stockCode: { code, name, addedCount, removedCount, total } }
export function calcStockFrequency(histories) {
  const freq = {};

  for (const { added, removed } of histories) {
    for (const s of added) {
      if (!freq[s.code]) freq[s.code] = { code: s.code, name: s.name, addedCount: 0, removedCount: 0 };
      freq[s.code].addedCount++;
    }
    for (const s of removed) {
      if (!freq[s.code]) freq[s.code] = { code: s.code, name: s.name, addedCount: 0, removedCount: 0 };
      freq[s.code].removedCount++;
    }
  }

  return Object.values(freq)
    .map(f => ({ ...f, total: f.addedCount + f.removedCount }))
    .sort((a, b) => b.total - a.total);
}

// Returns { stockCode: [{ start, end }] } — periods when stock was in ETF
export function buildStockTimeline(dates, holdingsByDate) {
  const timeline = {};

  let prevCodes = new Set();
  for (const date of dates) {
    const stocks = holdingsByDate[date] || [];
    const currCodes = new Set(stocks.map(s => s.code));

    for (const s of stocks) {
      if (!timeline[s.code]) timeline[s.code] = { code: s.code, name: s.name, periods: [] };
      const periods = timeline[s.code].periods;

      if (!prevCodes.has(s.code)) {
        // Newly entered
        periods.push({ start: date, end: date });
      } else {
        // Extend current period
        periods[periods.length - 1].end = date;
      }
    }

    prevCodes = currCodes;
  }

  return timeline;
}
