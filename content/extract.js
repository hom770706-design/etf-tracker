/**
 * ETF Holdings Content Script
 *
 * 注入到各 ETF 官網頁面，等 React/Vue 渲染完畢後，
 * 從 DOM 提取持股資料並回傳給 background service worker。
 *
 * 這個 script 在一般瀏覽器頁面執行，有完整的 DOM 存取權限。
 */

(function () {
  // ── 判斷目前是哪一檔 ETF ──────────────────────────────────────────
  const url = location.href;

  // 先嘗試從 URL 直接比對 ETF 代碼
  const directMatch = url.match(/(00980A|00981A|00982A|00403A|00984A|00985A|00991A|00987A|00992A|00994A|00995A|00993A|00996A|00400A|00401A|00999A)/i);

  // URL 不含代碼的網站：用固定對應表
  const URL_CODE_MAP = [
    { re: /ezmoney\.com\.tw.*fundCode=49YTW/i, code: '00981A' },
    { re: /ezmoney\.com\.tw.*fundCode=63YTW/i, code: '00403A' },
    { re: /capitalfund\.com\.tw.*\/399\//i,    code: '00982A' },
  ];

  const etfCode = directMatch
    ? directMatch[1].toUpperCase()
    : URL_CODE_MAP.find(m => m.re.test(url))?.code;

  if (!etfCode) return; // 不是我們追蹤的 ETF，跳過

  const today = new Date().toISOString().slice(0, 10);
  let extracted = false;

  // ── 主要提取邏輯 ──────────────────────────────────────────────────
  function extractStocks() {
    const stocks = [];

    // ① 嘗試找持股 table（搜尋所有 table）
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      // 確認 header 有「代號」或「股票」相關欄位
      const headers = [...table.querySelectorAll('th, thead td')]
        .map(el => el.textContent.trim()).join('|');

      const isPortfolioTable =
        /(代號|代碼|股票代|Stock\s*Code|Symbol)/i.test(headers) ||
        // 如果沒有 th，看第一行 td 是否像代號
        (/^\d{4}/.test(table.querySelector('tbody tr td')?.textContent?.trim() || ''));

      if (!isPortfolioTable) continue;

      const rows = table.querySelectorAll('tbody tr, tr');
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length < 2) continue;

        const rawCode = cells[0].textContent.trim().replace(/\s+/g, '');
        if (!/^\d{4,6}[A-Za-z]?$/.test(rawCode)) continue;

        stocks.push({
          code: rawCode,
          name: cells[1].textContent.trim(),
          shares: parseNum(cells[2]?.textContent || '0'),
          percentage: parsePct(cells[4]?.textContent || cells[3]?.textContent || '0')
        });
      }

      if (stocks.length > 0) break;
    }

    // ② ezmoney.com.tw：#assetBody 內的最後一個 table（股票持股）
    // 欄位順序：股票代號 | 股票名稱 | 股數 | 持股權重
    if (stocks.length === 0) {
      const assetBody = document.querySelector('#assetBody');
      if (assetBody) {
        const tables = assetBody.querySelectorAll('table');
        const stockTable = tables[tables.length - 1];
        if (stockTable) {
          for (const row of stockTable.querySelectorAll('tbody tr')) {
            const cells = [...row.querySelectorAll('td')];
            if (cells.length < 2) continue;
            const rawCode = cells[0].textContent.trim().replace(/\s+/g, '');
            if (!/^\d{4,6}[A-Za-z]?$/.test(rawCode)) continue;
            stocks.push({
              code: rawCode,
              name: cells[1].textContent.trim(),
              shares: parseNum(cells[2]?.textContent || '0'),
              percentage: parsePct(cells[3]?.textContent || '0')
            });
          }
        }
      }
    }

    // ③ capitalfund.com.tw：Angular div-based table（非 <table> 元素）
    if (stocks.length === 0) {
      const tbody = document.querySelector('.pct-stock-table-tbody');
      if (tbody) {
        for (const row of tbody.children) {
          const cells = [...row.children]
            .map(el => el.textContent.trim())
            .filter(Boolean);
          if (cells.length < 2) continue;

          // 第一格應為股票代號（4~6位數字）
          const rawCode = cells[0].replace(/\s+/g, '');
          if (!/^\d{4,6}[A-Za-z]?$/.test(rawCode)) continue;

          // 找出持股權重（含 % 的格）和股數（最後一個純數字格）
          const pctText = cells.find(c => /%/.test(c)) || '0';
          const sharesText = [...cells].reverse()
            .find(c => /^[\d,.\s]+$/.test(c) && !/%/.test(c)) || '0';

          stocks.push({
            code: rawCode,
            name: cells[1] || '',
            percentage: parsePct(pctText),
            shares: parseNum(sharesText)
          });
        }
      }
    }

    // ③ pocket.tw：Nuxt SPA，持股列表為 div 模擬的表格
    if (stocks.length === 0 && url.includes('pocket.tw')) {
      // 持股明細通常在 class 含 "holding" 或 "stock" 的容器內
      const rows = document.querySelectorAll(
        '[class*="holding"] tr, [class*="stock"] tr, ' +
        '[class*="fund"] tr, .table-row, [class*="row"]'
      );
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td, [class*="cell"], [class*="col"]')]
          .map(el => el.textContent.trim()).filter(Boolean);
        if (cells.length < 2) continue;
        const rawCode = cells[0].replace(/\s+/g, '');
        if (!/^\d{4,6}[A-Za-z]?$/.test(rawCode)) continue;
        stocks.push({
          code: rawCode,
          name: cells[1] || '',
          shares: parseNum(cells.find(c => /^[\d,]+$/.test(c.replace(/,/g, ''))) || '0'),
          percentage: parsePct(cells.find(c => /%/.test(c)) || '0')
        });
      }
    }

    // ④ 備援：搜尋頁面中嵌入的 JSON（某些 SSR 頁面）
    if (stocks.length === 0) {
      const jsonStocks = tryExtractFromScripts();
      stocks.push(...jsonStocks);
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

    // Next.js __NEXT_DATA__
    const nextScript = document.querySelector('#__NEXT_DATA__');
    if (nextScript) {
      try {
        const obj = JSON.parse(nextScript.textContent);
        return findStocksInObject(obj);
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

    // Extension 重新載入後 chrome.runtime 會變成 undefined，需要防呆
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

  // ── 等待 React 渲染後再提取 ───────────────────────────────────────
  function tryAndWatch() {
    const stocks = extractStocks();
    if (stocks.length > 0) {
      sendToBackground(stocks);
      return;
    }

    // DOM 尚未渲染，用 MutationObserver + debounce 等待
    // 不用 checkCount 限制，因為 React/Angular SPA 初始化就會觸發大量 mutation
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

    // 另外每 5 秒強制掃描一次（避免 Angular 持續 mutation 導致 debounce 永遠不觸發）
    const periodicCheck = setInterval(() => {
      const stocks = extractStocks();
      if (stocks.length > 0) {
        clearInterval(periodicCheck);
        clearTimeout(debounceTimer);
        observer.disconnect();
        sendToBackground(stocks);
      }
    }, 5000);

    // 強制超時（45 秒）
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
