/**
 * ETF Holdings Content Script
 *
 * 注入到 pocket.tw ETF 持股頁面，等 Nuxt 渲染完畢後，
 * 從 DOM 提取持股資料並回傳給 background service worker。
 */

(function () {
  // ── 判斷目前是哪一檔 ETF ──────────────────────────────────────────
  const url = location.href;

  const match = url.match(/(00980A|00981A|00982A|00403A|00984A|00985A|00991A|00987A|00992A|00994A|00995A|00993A|00996A|00400A|00401A|00999A)/i);
  if (!match) return;

  const etfCode = match[1].toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  let extracted = false;

  // ── 主要提取邏輯 ──────────────────────────────────────────────────
  // pocket.tw 欄位順序：代號 | 名稱 | 權重(%) | 持有數
  function extractStocks() {
    const stocks = [];

    // ① 標準 <table>（pocket.tw 渲染完成後的結構）
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = [...table.querySelectorAll('th, thead td')]
        .map(el => el.textContent.trim()).join('|');

      const isPortfolioTable =
        /(代號|代碼|股票代|Stock\s*Code|Symbol)/i.test(headers) ||
        (/^\d{4}/.test(table.querySelector('tbody tr td')?.textContent?.trim() || ''));

      if (!isPortfolioTable) continue;

      for (const row of table.querySelectorAll('tbody tr, tr')) {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length < 2) continue;
        const rawCode = cells[0].textContent.trim().replace(/\s+/g, '');
        if (!/^\d{4,6}[A-Za-z]?$/.test(rawCode)) continue;
        stocks.push({
          code: rawCode,
          name: cells[1].textContent.trim(),
          percentage: parsePct(cells[2]?.textContent || '0'),
          shares: parseNum(cells[3]?.textContent || '0')
        });
      }

      if (stocks.length > 0) break;
    }

    // ② 備援：搜尋頁面中嵌入的 JSON（SSR / __NEXT_DATA__）
    if (stocks.length === 0) {
      stocks.push(...tryExtractFromScripts());
    }

    return stocks;
  }

  function tryExtractFromScripts() {
    const keyPatterns = [
      'portfolioData', 'holdings', 'fundPortfolio', 'stockList', 'components'
    ];

    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent;
      for (const key of keyPatterns) {
        const re = new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]{20,200000}?\\])`, '');
        const m = text.match(re);
        if (m) {
          try {
            const arr = JSON.parse(m[1]);
            const stocks = parseStockArray(arr);
            if (stocks.length > 0) return stocks;
          } catch (_) {}
        }
      }
    }

    const nextScript = document.querySelector('#__NEXT_DATA__');
    if (nextScript) {
      try {
        return findStocksInObject(JSON.parse(nextScript.textContent));
      } catch (_) {}
    }

    return [];
  }

  function parseStockArray(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
      if (Array.isArray(item)) {
        return { code: clean(item[0]), name: String(item[1] || ''), shares: parseNum(item[2]), percentage: parsePct(item[4] ?? item[3]) };
      }
      return {
        code: clean(item.stockCode ?? item.code ?? item.securityCode ?? ''),
        name: String(item.stockName ?? item.name ?? ''),
        shares: parseNum(item.shares ?? item.holdingShares ?? 0),
        percentage: parsePct(item.percentage ?? item.ratio ?? 0)
      };
    }).filter(s => /^\d{4,6}[A-Za-z]?$/.test(s.code) && s.name);
  }

  function findStocksInObject(obj, depth = 0) {
    if (depth > 6 || !obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj) && obj.length >= 3) {
      const stocks = parseStockArray(obj);
      if (stocks.length > 0) return stocks;
    }
    for (const val of Object.values(obj)) {
      const found = findStocksInObject(val, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }

  // ── 傳送資料給 background SW ──────────────────────────────────────
  function sendToBackground(stocks) {
    if (extracted) return;
    extracted = true;
    if (!chrome?.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({
      action: 'contentScriptHoldings',
      etfCode,
      date: today,
      stocks,
      url
    }, () => {
      if (chrome.runtime?.lastError) return;
      console.log(`[ETF Tracker] ${etfCode} 已傳送 ${stocks.length} 筆持股`);
    });
  }

  // ── 等待 Nuxt 渲染後再提取 ────────────────────────────────────────
  function tryAndWatch() {
    const stocks = extractStocks();
    if (stocks.length > 0) {
      sendToBackground(stocks);
      return;
    }

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const stocks = extractStocks();
        if (stocks.length > 0) {
          observer.disconnect();
          clearInterval(periodicCheck);
          sendToBackground(stocks);
        }
      }, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const periodicCheck = setInterval(() => {
      const stocks = extractStocks();
      if (stocks.length > 0) {
        clearInterval(periodicCheck);
        clearTimeout(debounceTimer);
        observer.disconnect();
        sendToBackground(stocks);
      }
    }, 5000);

    setTimeout(() => {
      clearTimeout(debounceTimer);
      clearInterval(periodicCheck);
      observer.disconnect();
      if (!extracted) sendToBackground([]);
    }, 45000);
  }

  // ── 工具 ──────────────────────────────────────────────────────────
  function clean(raw) { return String(raw ?? '').trim().replace(/[^\dA-Za-z]/g, ''); }
  function parseNum(raw) { return parseInt(String(raw).replace(/[^0-9]/g, ''), 10) || 0; }
  function parsePct(raw) { return parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0; }

  // ── 啟動 ──────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAndWatch);
  } else {
    tryAndWatch();
  }
})();
