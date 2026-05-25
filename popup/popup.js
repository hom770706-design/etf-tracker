import { ETF_CONFIG, ETF_CODES } from '../lib/etf-config.js';
import {
  getHoldings, getDates, getLatestDate, getRecentHoldings,
  getLastFetch, getFetchErrors, saveHoldings
} from '../lib/storage.js';
import { diffHoldings, buildChangeHistory, calcStockFrequency, buildStockTimeline } from '../lib/comparison.js';
import { getOrRefreshIndustryMap, lookupIndustry, groupStocksByIndustry, summarizeIndustryChanges, INDUSTRY_COLORS } from '../lib/industry.js';
import { parseManualInput } from '../lib/scraper.js';
import { syncToSheets, testSheetsConnection } from '../lib/sheets.js';
import { getSettings, saveSettings } from '../lib/storage.js';

// ── State ────────────────────────────────────────────────────────────
let activeTab = 'today';
let activeSubTab = 'frequency';
let activeEtf = 'all';
let industryMap = {};
let charts = {};

// ── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  industryMap = await getOrRefreshIndustryMap();
  await renderAll();
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Sub-tab switching
  document.querySelectorAll('.sub-tab').forEach(btn => {
    btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
  });

  // ETF filter
  document.querySelectorAll('.etf-btn').forEach(btn => {
    btn.addEventListener('click', () => switchEtf(btn.dataset.etf));
  });

  // Expand button — open popup in a new tab for full-width view
  document.getElementById('btn-expand').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?fullpage=1') });
  });

  // Mark fullpage mode when opened in tab
  if (new URLSearchParams(location.search).get('fullpage')) {
    document.body.classList.add('fullpage');
  }

  // Refresh button
  document.getElementById('btn-refresh').addEventListener('click', () => {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    btn.textContent = '…';
    setStatus('<span class="spinner"></span>自動開啟 ETF 頁面擷取資料（最多 80 秒）…');

    chrome.runtime.sendMessage({ action: 'fetchNow' }, resp => {
      // SW 完成後（成功或失敗）才會呼叫這個 callback
      if (chrome.runtime.lastError) {
        setStatus('Service Worker 未回應: ' + chrome.runtime.lastError.message);
        btn.disabled = false;
        btn.textContent = '⟳';
        return;
      }
      // 正常完成由 storage.onChanged 處理 UI 更新，這裡只做保險解鎖
      if (!resp?.ok) {
        setStatus('抓取失敗: ' + (resp?.error || '未知錯誤'));
        btn.disabled = false;
        btn.textContent = '⟳';
      }
    });
  });

  // 監聽 storage 變化，抓取完成後自動更新 UI
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.lastFetch) return;
    const btn = document.getElementById('btn-refresh');
    const lastFetch = changes.lastFetch.newValue;
    industryMap = await getOrRefreshIndustryMap();
    await renderAll();
    const ok = lastFetch?.success?.length ?? 0;
    const fail = lastFetch?.failed?.length ?? 0;
    setStatus(`完成：${ok} 檔成功${fail > 0 ? `，${fail} 檔失敗` : ''}`);
    btn.disabled = false;
    btn.textContent = '⟳';
  });

  // Import modal
  document.getElementById('btn-import').addEventListener('click', openImportModal);
  document.getElementById('btn-import-cancel').addEventListener('click', closeImportModal);
  document.getElementById('btn-import-confirm').addEventListener('click', handleImport);

  // Settings modal
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-settings-cancel').addEventListener('click', closeSettingsModal);
  document.getElementById('btn-settings-save').addEventListener('click', handleSettingsSave);
  document.getElementById('btn-settings-test').addEventListener('click', handleSettingsTest);

  // Manual Sheets sync button
  document.getElementById('btn-sync-sheets').addEventListener('click', handleManualSync);

  // Pre-fill import date
  document.getElementById('import-date').value = new Date().toISOString().slice(0, 10);
}

// ── Tab & Filter Switching ────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  renderCurrentTab();
}

function switchSubTab(sub) {
  activeSubTab = sub;
  document.querySelectorAll('.sub-tab').forEach(b => b.classList.toggle('active', b.dataset.subtab === sub));
  document.querySelectorAll('.sub-panel').forEach(p => p.classList.toggle('active', p.id === `subtab-${sub}`));
  renderCurrentTab();
}

function switchEtf(etf) {
  activeEtf = etf;
  document.querySelectorAll('.etf-btn').forEach(b => b.classList.toggle('active', b.dataset.etf === etf));
  renderCurrentTab();
}

// ── Render Orchestration ─────────────────────────────────────────────
async function renderAll() {
  await updateHeader();
  await renderCurrentTab();
  await updateErrorIndicator();
}

async function renderCurrentTab() {
  destroyCharts();
  switch (activeTab) {
    case 'today':    return renderToday();
    case 'holdings': return renderHoldings();
    case 'trend':    return renderTrend();
    case 'industry': return renderIndustry();
    case 'stocks':   return renderStocks();
    case 'overlap':  return renderOverlap();
    case 'ai':       return renderAI();
  }
}

// ── Header ────────────────────────────────────────────────────────────
async function updateHeader() {
  const lastFetch = await getLastFetch();
  const el = document.getElementById('last-update');
  if (lastFetch) {
    const dt = new Date(lastFetch.time).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    el.textContent = `最後更新: ${dt}`;
  } else {
    el.textContent = '尚無資料 — 按 ⟳ 抓取';
  }
}

// ── TODAY TAB ─────────────────────────────────────────────────────────
async function renderToday() {
  const codes = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const summaryEl = document.getElementById('today-summary');
  const detailEl = document.getElementById('today-details');
  summaryEl.innerHTML = '';
  detailEl.innerHTML = '';

  for (const code of codes) {
    const cfg = ETF_CONFIG[code];
    const dates = await getDates(code);
    if (dates.length < 2) {
      summaryEl.insertAdjacentHTML('beforeend', noDataCard(cfg));
      continue;
    }

    const [prev, curr] = await Promise.all([
      getHoldings(code, dates[dates.length - 2]),
      getHoldings(code, dates[dates.length - 1])
    ]);
    const { added, removed, changed } = diffHoldings(prev, curr);
    const latestDate = dates[dates.length - 1];

    summaryEl.insertAdjacentHTML('beforeend', summaryCard(cfg, latestDate, added, removed, changed));

    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      detailEl.insertAdjacentHTML('beforeend', changeDetail(cfg, added, removed, changed));
    }
  }

  if (!summaryEl.innerHTML) {
    summaryEl.innerHTML = '<p class="no-data">尚無資料，請按 ⟳ 抓取最新資料</p>';
  }
}

function noDataCard(cfg) {
  return `
  <div class="summary-card" style="--card-color:${cfg.color}">
    <div class="card-etf">${cfg.code}</div>
    <div class="card-name">${cfg.name}</div>
    <div class="no-data" style="padding:8px 0">尚無資料</div>
  </div>`;
}

function summaryCard(cfg, date, added, removed, changed = []) {
  // 有股數資料的情況下，區分實際調倉 vs 市價漂移
  const hasShareData = changed.some(s => s.shares > 0);
  const tradedCount = hasShareData
    ? changed.filter(s => s.shareDelta !== 0 || s.shares === 0).length
    : changed.length;
  const driftCount = hasShareData
    ? changed.filter(s => s.shareDelta === 0 && s.shares > 0).length
    : 0;

  return `
  <div class="summary-card" style="--card-color:${cfg.color}">
    <div class="card-etf">${cfg.code} · ${cfg.issuer}</div>
    <div class="card-name">${cfg.name}</div>
    <div class="card-stats">
      <div class="card-stat">
        <div class="card-stat-val added">+${added.length}</div>
        <div class="card-stat-label">新增</div>
      </div>
      <div class="card-stat">
        <div class="card-stat-val removed">−${removed.length}</div>
        <div class="card-stat-label">移除</div>
      </div>
      <div class="card-stat">
        <div class="card-stat-val" style="color:var(--yellow)">${tradedCount}</div>
        <div class="card-stat-label">調整</div>
      </div>
      ${driftCount > 0 ? `<div class="card-stat">
        <div class="card-stat-val" style="color:var(--muted)">${driftCount}</div>
        <div class="card-stat-label">漂移</div>
      </div>` : ''}
    </div>
    <div class="muted" style="margin-top:4px">${date}</div>
  </div>`;
}

function changeDetail(cfg, added, removed, changed = []) {
  let html = `<div style="margin-bottom:12px; padding-top:4px; border-top:1px solid var(--border)">
    <div class="changes-header" style="color:${cfg.color}">${cfg.code} ${cfg.name}</div>`;

  if (added.length > 0) {
    html += `<div class="changes-header"><span class="badge badge-green">新增 ${added.length}</span></div>
      <div class="stock-list">${added.map(s => stockChip(s, 'added')).join('')}</div>`;
  }
  if (removed.length > 0) {
    html += `<div class="changes-header"><span class="badge badge-red">移除 ${removed.length}</span></div>
      <div class="stock-list">${removed.map(s => stockChip(s, 'removed')).join('')}</div>`;
  }

  // 有股數資料時區分：實際調倉 vs 市價漂移（股數未動但比重隨股價變化）
  const hasShareData = changed.some(s => s.shares > 0);
  const traded  = hasShareData ? changed.filter(s => s.shareDelta !== 0 || s.shares === 0) : changed;
  const drifted = hasShareData ? changed.filter(s => s.shareDelta === 0 && s.shares > 0)   : [];

  const increased = traded.filter(s => s.delta > 0);
  const decreased = traded.filter(s => s.delta < 0);
  if (increased.length > 0) {
    html += `<div class="changes-header"><span class="badge badge-green">增加比重 ${increased.length}</span></div>
      <div class="stock-list">${increased.map(s => weightChip(s, 'increased')).join('')}</div>`;
  }
  if (decreased.length > 0) {
    html += `<div class="changes-header"><span class="badge badge-red">減少比重 ${decreased.length}</span></div>
      <div class="stock-list">${decreased.map(s => weightChip(s, 'decreased')).join('')}</div>`;
  }

  // 市價漂移：股數未動，比重因股價相對漲跌而自然偏移
  if (drifted.length > 0) {
    const dUp   = drifted.filter(s => s.delta > 0);
    const dDown = drifted.filter(s => s.delta < 0);
    html += `<div class="changes-header"><span class="badge" style="background:rgba(136,146,164,.12);color:var(--muted)">市價漂移 ${drifted.length}（股數未異動）</span></div>
      <div class="stock-list">
        ${dUp.map(s => weightChip(s, 'increased')).join('')}
        ${dDown.map(s => weightChip(s, 'decreased')).join('')}
      </div>`;
  }

  return html + '</div>';
}

function stockChip(stock, type) {
  const ind = lookupIndustry(stock.code, industryMap);
  return `<span class="stock-chip ${type}"><span class="code">${stock.code}</span>${stock.name}<span class="ind"> ${ind}</span></span>`;
}

function weightChip(stock, type) {
  const ind      = lookupIndustry(stock.code, industryMap);
  const sign     = stock.delta > 0 ? '+' : '';
  const cls      = type === 'increased' ? 'delta-up' : 'delta-down';
  let primary, secondary;
  if (stock.shareDelta != null && stock.shareDelta !== 0) {
    const sSign = stock.shareDelta > 0 ? '+' : '';
    primary   = `${sSign}${stock.shareDelta.toLocaleString()}`;
    secondary = `(${sign}${stock.delta.toFixed(2)}%)`;
  } else {
    primary   = `${sign}${stock.delta.toFixed(2)}%`;
    secondary = stock.shares > 0 ? '持股不變' : '';
  }
  return `<span class="stock-chip ${type}"><span class="code">${stock.code}</span>${stock.name}<span class="${cls}"> ${primary}</span><span style="color:var(--muted);font-size:10px"> ${secondary}</span><span class="ind"> ${ind}</span></span>`;
}

// ── HOLDINGS TAB ─────────────────────────────────────────────────
async function renderHoldings() {
  const codes = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const container = document.getElementById('holdings-container');
  const searchEl  = document.getElementById('holdings-search');
  container.innerHTML = '';
  searchEl.value = '';

  const allRenderFns = [];

  for (const code of codes) {
    const cfg = ETF_CONFIG[code];
    const dates = await getDates(code);
    if (!dates.length) {
      container.insertAdjacentHTML('beforeend', `
        <div class="holdings-section" style="--card-color:${cfg.color}">
          <div class="holdings-header">
            <span class="holdings-header-name" style="color:${cfg.color}">${code} · ${cfg.name}</span>
            <span class="holdings-header-meta">尚無資料</span>
          </div>
        </div>`);
      continue;
    }

    const latestDate = dates[dates.length - 1];
    const holdings   = await getHoldings(code, latestDate);
    if (!holdings?.length) continue;

    // 建立今日變化對照表 { code: { deltaPercent, deltaShares, isNew } }
    const changeMap = {};
    if (dates.length >= 2) {
      const prevHoldings = await getHoldings(code, dates[dates.length - 2]);
      const { added, changed } = diffHoldings(prevHoldings, holdings);
      for (const s of added)   changeMap[s.code] = { isNew: true };
      for (const s of changed) changeMap[s.code] = { delta: s.delta, shareDelta: s.shareDelta, shares: s.shares };
    }

    const sectionId = `holdings-${code}`;
    const tbodyId   = `holdings-tbody-${code}`;

    container.insertAdjacentHTML('beforeend', `
      <div class="holdings-section" id="${sectionId}" style="--card-color:${cfg.color}">
        <div class="holdings-header">
          <span class="holdings-header-name" style="color:${cfg.color}">${code} · ${cfg.name}</span>
          <span class="holdings-header-meta">${latestDate} · ${holdings.length} 檔</span>
        </div>
        <table class="holdings-table">
          <thead>
            <tr>
              <th data-col="code">代號</th>
              <th data-col="name">名稱</th>
              <th data-col="percentage" class="sort-desc">比重</th>
              <th data-col="shares">股數</th>
              <th data-col="industry">產業</th>
              <th data-col="change">今日變化</th>
            </tr>
          </thead>
          <tbody id="${tbodyId}"></tbody>
        </table>
      </div>`);

    const tbody = document.getElementById(tbodyId);
    const sort  = { col: 'percentage', dir: 'desc' };

    const renderRows = (kw = '') => {
      const q = kw.toLowerCase();
      const sorted = [...holdings].sort((a, b) => {
        let va = sort.col === 'industry' ? lookupIndustry(a.code, industryMap) : a[sort.col];
        let vb = sort.col === 'industry' ? lookupIndustry(b.code, industryMap) : b[sort.col];
        if (typeof va === 'string') return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        return sort.dir === 'asc' ? va - vb : vb - va;
      });

      tbody.innerHTML = sorted.map(s => {
        const ind  = lookupIndustry(s.code, industryMap);
        const hide = q && ![s.code, s.name, ind].some(v => v.toLowerCase().includes(q));
        const chg  = changeMap[s.code];
        let changeCell = '<td class="col-ind">—</td>';
        if (chg?.isNew) {
          changeCell = '<td><span style="color:var(--green);font-size:10px;font-weight:700">▲ 新增</span></td>';
        } else if (chg?.delta != null) {
          const sign  = chg.delta > 0 ? '+' : '';
          const cls   = chg.delta > 0 ? 'delta-up' : 'delta-down';
          const sSign = chg.shareDelta > 0 ? '+' : '';
          const sStr = chg.shareDelta !== 0
            ? `<br><span style="font-size:10px">${sSign}${chg.shareDelta.toLocaleString()}</span>`
            : (chg.shares > 0 ? `<br><span style="font-size:10px;color:var(--muted)">持股不變</span>` : '');
          changeCell  = `<td class="${cls}" style="text-align:right">${sign}${chg.delta.toFixed(2)}%${sStr}</td>`;
        }
        return `<tr${hide ? ' class="hidden-row"' : ''}>
          <td class="col-code">${s.code}</td>
          <td>${s.name}</td>
          <td class="col-pct">${s.percentage.toFixed(2)}%</td>
          <td class="col-shares">${s.shares > 0 ? s.shares.toLocaleString() : '—'}</td>
          <td class="col-ind">${ind}</td>
          ${changeCell}
        </tr>`;
      }).join('');
    };

    renderRows();
    allRenderFns.push(renderRows);

    document.querySelectorAll(`#${sectionId} thead th`).forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        sort.dir = sort.col === col
          ? (sort.dir === 'asc' ? 'desc' : 'asc')
          : (['code', 'name', 'industry', 'change'].includes(col) ? 'asc' : 'desc');
        sort.col = col;
        document.querySelectorAll(`#${sectionId} thead th`).forEach(t =>
          t.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(sort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        renderRows(searchEl.value);
      });
    });
  }

  if (!container.innerHTML) {
    container.innerHTML = '<p class="no-data">尚無資料，請按 ⟳ 抓取最新資料</p>';
  }

  searchEl.oninput = () => allRenderFns.forEach(fn => fn(searchEl.value));
}

// ── OVERLAP TAB ───────────────────────────────────────────────────────
async function renderOverlap() {
  const container = document.getElementById('overlap-container');
  container.innerHTML = '';

  // 取得所有 ETF 最新持股
  const holdingsByEtf = {};
  for (const code of ETF_CODES) {
    const latestDate = await getLatestDate(code);
    if (!latestDate) continue;
    const holdings = await getHoldings(code, latestDate);
    if (holdings?.length) holdingsByEtf[code] = holdings;
  }

  const etfsWithData = ETF_CODES.filter(c => holdingsByEtf[c]);
  if (etfsWithData.length < 2) {
    container.innerHTML = '<p class="no-data">需要至少兩檔 ETF 的資料才能分析重疊</p>';
    return;
  }

  // 建立 股票代號 → { name, etfs: { code: pct } } 對照
  const stockMap = {};
  for (const etfCode of etfsWithData) {
    for (const s of holdingsByEtf[etfCode]) {
      if (!stockMap[s.code]) stockMap[s.code] = { name: s.name, etfs: {} };
      stockMap[s.code].etfs[etfCode] = s.percentage;
    }
  }

  // 篩選出 ≥2 檔 ETF 同持的股票
  let overlaps = Object.entries(stockMap)
    .filter(([, v]) => Object.keys(v.etfs).length >= 2)
    .map(([code, v]) => ({
      code,
      name: v.name,
      etfs: v.etfs,
      count: Object.keys(v.etfs).length,
      avgPct: Object.values(v.etfs).reduce((a, b) => a + b, 0) / Object.keys(v.etfs).length
    }))
    .sort((a, b) => b.count - a.count || b.avgPct - a.avgPct);

  // ETF 篩選器：只顯示含所選 ETF 的重疊股
  if (activeEtf !== 'all') {
    overlaps = overlaps.filter(s => s.etfs[activeEtf] !== undefined);
  }

  if (overlaps.length === 0) {
    container.innerHTML = '<p class="no-data">目前無重疊持股</p>';
    return;
  }

  // 依重疊數量分組
  const groups = {};
  for (const stock of overlaps) {
    if (!groups[stock.count]) groups[stock.count] = [];
    groups[stock.count].push(stock);
  }

  let html = `<div style="margin-bottom:10px;font-size:11px;color:var(--muted)">
    共 <strong style="color:var(--text)">${overlaps.length}</strong> 檔重疊股票（同時被 2 檔以上 ETF 持有）
  </div>`;

  for (const count of Object.keys(groups).sort((a, b) => b - a)) {
    const stocks = groups[count];
    const label = count === etfsWithData.length ? '全部' : `${count} 檔`;
    html += `
      <div style="margin-bottom:12px">
        <div class="changes-header">
          <span class="badge" style="background:rgba(79,110,247,0.15);color:var(--accent)">${label} ETF 同持・共 ${stocks.length} 支</span>
        </div>
        <div class="holdings-section scrollable-x" style="--card-color:var(--accent)">
          <table class="holdings-table">
            <thead><tr>
              <th>代號</th><th>名稱</th><th>產業</th>
              ${etfsWithData.map(c => `<th style="color:${ETF_CONFIG[c].color};text-align:right">${c}</th>`).join('')}
            </tr></thead>
            <tbody>
              ${stocks.map(s => {
                const ind = lookupIndustry(s.code, industryMap);
                return `<tr>
                  <td class="col-code">${s.code}</td>
                  <td>${s.name}</td>
                  <td class="col-ind">${ind}</td>
                  ${etfsWithData.map(c => s.etfs[c] !== undefined
                    ? `<td class="col-pct">${s.etfs[c].toFixed(2)}%</td>`
                    : `<td style="color:var(--muted);text-align:right">—</td>`
                  ).join('')}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

// ── TREND TAB ─────────────────────────────────────────────────────────
async function renderTrend() {
  const codes  = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const isAll  = activeEtf === 'all';
  const allDates = new Set();
  const dataByCode   = {};
  const detailByCode = {};

  for (const code of codes) {
    const history = await buildChangeHistory(code);
    dataByCode[code]   = {};
    detailByCode[code] = {};
    for (const { date, added, removed, changed = [] } of history) {
      allDates.add(date);
      // 區分實際調倉 vs 市價漂移
      const hasShareData = changed.some(s => s.shares > 0);
      const traded = hasShareData
        ? changed.filter(s => s.shareDelta !== 0 || s.shares === 0)
        : changed;
      dataByCode[code][date]   = { added: added.length, removed: removed.length, traded: traded.length };
      detailByCode[code][date] = { added, removed, traded };
    }
  }

  const labels = [...allDates].sort();
  const trendCanvas = document.getElementById('chart-trend');
  trendCanvas.parentElement.querySelector('.no-data')?.remove();

  if (labels.length === 0) {
    trendCanvas.style.display = 'none';
    trendCanvas.insertAdjacentHTML('afterend', '<p class="no-data">資料不足（需至少2天資料）</p>');
    return;
  }
  trendCanvas.style.display = '';

  let datasets, chartType;

  if (isAll) {
    // 全部模式：每檔 ETF 一條折線，Y = 總交易檔數（新增+移除+調倉）
    chartType = 'line';
    datasets = codes.map(code => {
      const cfg = ETF_CONFIG[code];
      return {
        label: code,
        data: labels.map(d => {
          const v = dataByCode[code][d];
          return v != null ? v.added + v.removed + v.traded : null;
        }),
        borderColor: cfg.color, backgroundColor: cfg.bgColor,
        borderWidth: 2, pointRadius: 4, tension: 0.3, fill: false
      };
    });
  } else {
    // 單一 ETF：長條圖，新增/移除/調倉分開
    chartType = 'bar';
    datasets = [
      {
        label: '新增',
        data: labels.map(d => dataByCode[codes[0]][d]?.added ?? null),
        backgroundColor: 'rgba(46,204,113,0.75)', borderColor: '#2ecc71',
        borderWidth: 1, borderRadius: 3
      },
      {
        label: '移除',
        data: labels.map(d => dataByCode[codes[0]][d]?.removed ?? null),
        backgroundColor: 'rgba(231,76,60,0.75)', borderColor: '#e74c3c',
        borderWidth: 1, borderRadius: 3
      },
      {
        label: '調倉',
        data: labels.map(d => dataByCode[codes[0]][d]?.traded ?? null),
        backgroundColor: 'rgba(243,156,18,0.65)', borderColor: '#f39c12',
        borderWidth: 1, borderRadius: 3
      }
    ];
  }

  charts.trend = new Chart(trendCanvas, {
    type: chartType,
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8892a4', font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#1a1d27', titleColor: '#e2e8f0', bodyColor: '#8892a4',
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.raw != null ? ctx.raw + ' 檔' : '—'}`,
            afterLabel: ctx => {
              const date = labels[ctx.dataIndex];
              if (isAll) {
                const code   = ctx.dataset.label;
                const detail = detailByCode[code]?.[date];
                if (!detail) return [];
                const lines = [];
                detail.added.slice(0, 3).forEach(s => lines.push(`  ＋${s.code} ${s.name}`));
                detail.removed.slice(0, 3).forEach(s => lines.push(`  －${s.code} ${s.name}`));
                detail.traded.slice(0, 3).forEach(s => {
                  const sSign = s.shareDelta > 0 ? '+' : '';
                  const shareStr = s.shareDelta ? ` ${sSign}${s.shareDelta.toLocaleString()}` : '';
                  lines.push(`  ↕${s.code} ${s.name}${shareStr}`);
                });
                return lines;
              } else {
                const code   = codes[0];
                const detail = detailByCode[code]?.[date];
                if (!detail) return [];
                const type = ctx.dataset.label;
                const arr  = type === '新增' ? detail.added : type === '移除' ? detail.removed : detail.traded;
                return arr.slice(0, 6).map(s => {
                  if (type === '調倉' && s.shareDelta) {
                    const sSign = s.shareDelta > 0 ? '+' : '';
                    return `  ${s.code} ${s.name} ${sSign}${s.shareDelta.toLocaleString()}`;
                  }
                  return `  ${s.code} ${s.name} ${(s.percentage||0).toFixed(1)}%`;
                });
              }
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#8892a4', font: { size: 10 }, maxTicksLimit: 12 }, grid: { color: '#2e3148' } },
        y: {
          ticks: { color: '#8892a4', font: { size: 11 }, stepSize: 1, callback: v => v + ' 檔' },
          grid: { color: '#2e3148' }, beginAtZero: true,
          title: { display: true, text: '股票檔數', color: '#8892a4', font: { size: 10 } }
        }
      }
    }
  });

  renderTrendLegend(codes);
}

function renderTrendLegend(codes) {
  const el = document.getElementById('trend-legend');
  el.innerHTML = codes.map(code => {
    const cfg = ETF_CONFIG[code];
    return `<div class="legend-item"><div class="legend-dot" style="background:${cfg.color}"></div>${code} ${cfg.name}</div>`;
  }).join('');
}

// ── INDUSTRY TAB ──────────────────────────────────────────────────────
async function renderIndustry() {
  const codes = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const allAdded = [], allRemoved = [];

  for (const code of codes) {
    const history = await buildChangeHistory(code);
    for (const { added, removed } of history) {
      allAdded.push(...added);
      allRemoved.push(...removed);
    }
  }

  renderIndustryDonut('chart-industry-added', allAdded, '新增股票產業分布');
  renderIndustryDonut('chart-industry-removed', allRemoved, '移除股票產業分布');
  renderIndustryTable(allAdded, allRemoved);
}

function renderIndustryDonut(canvasId, stocks, title) {
  const groups = groupStocksByIndustry(stocks, industryMap);
  const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length).slice(0, 12);
  const labels = sorted.map(([k]) => k);
  const data = sorted.map(([, v]) => v.length);

  const indCanvas = document.getElementById(canvasId);
  indCanvas.parentElement.querySelector('.no-data')?.remove();

  if (data.length === 0) {
    indCanvas.style.display = 'none';
    indCanvas.insertAdjacentHTML('afterend', '<p class="no-data">無資料</p>');
    return;
  }
  indCanvas.style.display = '';

  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: INDUSTRY_COLORS.slice(0, labels.length),
        borderColor: '#0f1117',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#8892a4', font: { size: 10 }, boxWidth: 10, padding: 6 }
        },
        tooltip: { backgroundColor: '#1a1d27', titleColor: '#e2e8f0', bodyColor: '#8892a4' }
      }
    }
  });
}

function renderIndustryTable(allAdded, allRemoved) {
  const summary = {};
  for (const s of allAdded) {
    const ind = lookupIndustry(s.code, industryMap);
    if (!summary[ind]) summary[ind] = { added: 0, removed: 0 };
    summary[ind].added++;
  }
  for (const s of allRemoved) {
    const ind = lookupIndustry(s.code, industryMap);
    if (!summary[ind]) summary[ind] = { added: 0, removed: 0 };
    summary[ind].removed++;
  }

  const rows = Object.entries(summary).sort((a, b) => (b[1].added + b[1].removed) - (a[1].added + a[1].removed));
  const maxTotal = Math.max(...rows.map(([, v]) => v.added + v.removed), 1);

  const tbody = rows.map(([ind, { added, removed }]) => {
    const total = added + removed;
    const pct = Math.round((total / maxTotal) * 100);
    return `<tr>
      <td>${ind}</td>
      <td style="color:var(--green)">+${added}</td>
      <td style="color:var(--red)">−${removed}</td>
      <td class="bar-cell"><div class="bar-inner" style="width:${pct}%"></div></td>
    </tr>`;
  }).join('');

  document.getElementById('industry-table-container').innerHTML = `
    <table class="ind-table">
      <thead><tr><th>產業</th><th>新增</th><th>移除</th><th>占比</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

// ── STOCKS TAB ────────────────────────────────────────────────────────
async function renderStocks() {
  if (activeSubTab === 'frequency') return renderFrequency();
  if (activeSubTab === 'timeline') return renderTimeline();
}

async function renderFrequency() {
  const codes = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const allHistories = [];

  for (const code of codes) {
    allHistories.push(...await buildChangeHistory(code));
  }

  const freq = calcStockFrequency(allHistories).slice(0, 20);
  const freqCanvas = document.getElementById('chart-frequency');
  freqCanvas.parentElement.querySelector('.no-data')?.remove();

  if (freq.length === 0) {
    freqCanvas.style.display = 'none';
    freqCanvas.insertAdjacentHTML('afterend', '<p class="no-data">資料不足</p>');
    return;
  }
  freqCanvas.style.display = '';

  const labels = freq.map(f => `${f.code} ${f.name}`);
  charts.frequency = new Chart(document.getElementById('chart-frequency'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '新增次數',
          data: freq.map(f => f.addedCount),
          backgroundColor: 'rgba(46,204,113,0.7)',
          borderColor: '#2ecc71',
          borderWidth: 1
        },
        {
          label: '移除次數',
          data: freq.map(f => f.removedCount),
          backgroundColor: 'rgba(231,76,60,0.7)',
          borderColor: '#e74c3c',
          borderWidth: 1
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { labels: { color: '#8892a4', font: { size: 11 } } },
        tooltip: { backgroundColor: '#1a1d27', titleColor: '#e2e8f0', bodyColor: '#8892a4' }
      },
      scales: {
        x: { ticks: { color: '#8892a4' }, grid: { color: '#2e3148' }, stacked: false },
        y: { ticks: { color: '#e2e8f0', font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}

async function renderTimeline() {
  const codes = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const container = document.getElementById('timeline-container');
  container.innerHTML = '';

  for (const code of codes) {
    const holdingsByDate = await getRecentHoldings(code, 60);
    const dates = Object.keys(holdingsByDate).sort();
    if (dates.length < 2) continue;

    const timeline = buildStockTimeline(dates, holdingsByDate);
    const cfg = ETF_CONFIG[code];

    const stocks = Object.values(timeline).sort((a, b) => a.code.localeCompare(b.code));
    if (stocks.length === 0) continue;

    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];
    const totalDays = daysBetween(minDate, maxDate) || 1;

    let html = `<div style="margin-bottom:16px">
      <div style="color:${cfg.color};font-size:12px;font-weight:600;margin-bottom:6px">${code} ${cfg.name}</div>
      <div class="gantt-wrap">`;

    for (const stock of stocks.slice(0, 40)) {
      const label = `${stock.code}`;
      html += `<div class="gantt-row">
        <div class="gantt-label" title="${stock.name}">${label}</div>
        <div class="gantt-track">`;
      for (const { start, end } of stock.periods) {
        const left = (daysBetween(minDate, start) / totalDays) * 100;
        const width = Math.max((daysBetween(start, end) / totalDays) * 100, 0.8);
        html += `<div class="gantt-bar" style="left:${left}%;width:${width}%;background:${cfg.color}80" title="${stock.name} ${start}→${end}"></div>`;
      }
      html += `</div></div>`;
    }

    html += `</div></div>`;
    container.insertAdjacentHTML('beforeend', html);
  }

  if (!container.innerHTML) {
    container.innerHTML = '<p class="no-data">資料不足（需至少2天資料）</p>';
  }
}

// ── Import Modal ─────────────────────────────────────────────────────
function openImportModal() {
  document.getElementById('modal-import').classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('modal-import').classList.add('hidden');
  document.getElementById('import-json').value = '';
  document.getElementById('import-result').textContent = '';
}

async function handleImport() {
  const code = document.getElementById('import-etf-select').value;
  const date = document.getElementById('import-date').value;
  const json = document.getElementById('import-json').value.trim();
  const resultEl = document.getElementById('import-result');

  if (!date || !json) {
    resultEl.textContent = '請填入日期與 JSON 資料';
    return;
  }

  try {
    const stocks = parseManualInput(json);
    await saveHoldings(code, date, stocks);
    resultEl.textContent = `✓ 已匯入 ${stocks.length} 筆持股（${code} ${date}）`;
    await renderAll();
  } catch (e) {
    resultEl.textContent = '錯誤: ' + e.message;
  }
}

// ── Settings Modal ────────────────────────────────────────────────────
async function openSettingsModal() {
  const { sheetsWebAppUrl, groqApiKey } = await getSettings();
  document.getElementById('settings-sheets-url').value = sheetsWebAppUrl || '';
  document.getElementById('settings-groq-key').value = groqApiKey || '';
  document.getElementById('settings-result').textContent = '';
  document.getElementById('modal-settings').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('modal-settings').classList.add('hidden');
}

async function handleSettingsSave() {
  const url    = document.getElementById('settings-sheets-url').value.trim();
  const groqKey = document.getElementById('settings-groq-key').value.trim();
  await saveSettings({ sheetsWebAppUrl: url, groqApiKey: groqKey });
  document.getElementById('settings-result').textContent = '✓ 已儲存';
}

async function handleSettingsTest() {
  const url = document.getElementById('settings-sheets-url').value.trim();
  const resultEl = document.getElementById('settings-result');
  if (!url) { resultEl.textContent = '請先輸入 URL'; return; }
  resultEl.textContent = '連線測試中…';
  try {
    await testSheetsConnection(url);
    resultEl.textContent = '✓ 連線成功！';
  } catch (e) {
    resultEl.textContent = '✗ 連線失敗: ' + e.message;
  }
}

async function handleManualSync() {
  const btn = document.getElementById('btn-sync-sheets');
  btn.disabled = true;
  setStatus('<span class="spinner"></span>同步到 Google Sheets…');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const indMap = await getOrRefreshIndustryMap().catch(() => ({}));
    const addInd = stocks => stocks.map(s => ({ ...s, industry: lookupIndustry(s.code, indMap) }));

    const etfsData = {};
    for (const code of ETF_CODES) {
      const dates = await getDates(code);
      if (!dates.length) continue;
      const latestDate = dates[dates.length - 1];
      const holdings = addInd(await getHoldings(code, latestDate));
      let added = [], removed = [], changed = [];
      if (dates.length >= 2) {
        const prevHoldings = await getHoldings(code, dates[dates.length - 2]);
        ({ added, removed, changed } = diffHoldings(prevHoldings, holdings));
        added = addInd(added); removed = addInd(removed); changed = addInd(changed);
      }
      etfsData[code] = { holdings, added, removed, changed };
    }
    if (!Object.keys(etfsData).length) throw new Error('尚無資料可同步');

    const stockMap = {};
    for (const [code, data] of Object.entries(etfsData)) {
      for (const s of data.holdings) {
        if (!stockMap[s.code]) stockMap[s.code] = { name: s.name, industry: s.industry || '', etfs: {} };
        stockMap[s.code].etfs[code] = s.percentage;
      }
    }
    const overlap = Object.entries(stockMap)
      .filter(([, v]) => Object.keys(v.etfs).length >= 2)
      .map(([code, v]) => ({ code, ...v, count: Object.keys(v.etfs).length }))
      .sort((a, b) => b.count - a.count);

    await syncToSheets(today, { etfs: etfsData, overlap });
    setStatus('✓ 已同步到 Google Sheets');
  } catch (e) {
    setStatus('✗ 同步失敗: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Error Indicator ───────────────────────────────────────────────────
async function updateErrorIndicator() {
  const errors = await getFetchErrors();
  const hasErrors = Object.keys(errors).length > 0;
  const dot = document.getElementById('error-indicator');
  dot.classList.toggle('hidden', !hasErrors);
  if (hasErrors) {
    const msgs = Object.entries(errors).map(([code, e]) => `${code}: ${e.message}`).join('\n');
    dot.title = msgs;
    dot.addEventListener('click', () => alert('抓取錯誤:\n\n' + msgs), { once: true });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────
function destroyCharts() {
  for (const chart of Object.values(charts)) {
    chart?.destroy?.();
  }
  charts = {};
}

function setStatus(msg) {
  document.getElementById('status-msg').innerHTML = msg;
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.max(0, Math.round((b - a) / 86400000));
}

// ── AI Chat ───────────────────────────────────────────────────────────
let chatHistory = [];   // { role, content }[]
let chatContextReady = false;

async function renderAI() {
  const msgsEl = document.getElementById('chat-messages');
  if (chatContextReady) return;

  chatContextReady = true;
  chatHistory = [];
  msgsEl.innerHTML = '';

  // 先綁定事件，再做 async 資料載入
  const sendBtn = document.getElementById('chat-send');
  const inputEl = document.getElementById('chat-input');

  sendBtn.disabled = true;
  sendBtn.addEventListener('click', handleChatSend);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(); }
  });
  document.getElementById('chat-clear').onclick = e => {
    e.preventDefault();
    chatContextReady = false;
    sendBtn.removeEventListener('click', handleChatSend);
    renderAI();
  };

  const loadingEl = appendChatMsg('muted-msg', '載入今日持股資料中…');
  const systemPrompt = await buildChatContext();
  chatHistory.push({ role: 'system', content: systemPrompt });
  loadingEl.textContent = 'AI 已載入今日 ETF 異動資料，可以開始提問';
  sendBtn.disabled = false;
  inputEl.focus();
}

async function handleChatSend() {
  const inputEl = document.getElementById('chat-input');
  const text = inputEl.value.trim();
  if (!text) return;

  const { groqApiKey } = await getSettings();
  if (!groqApiKey) {
    appendChatMsg('muted-msg', '請先在設定（⚙）中填入 Groq API Key');
    return;
  }

  inputEl.value = '';
  document.getElementById('chat-send').disabled = true;

  appendChatMsg('user', text);
  chatHistory.push({ role: 'user', content: text });

  const aiEl = appendChatMsg('ai streaming', '');
  try {
    const reply = await streamGroq(groqApiKey, chatHistory, chunk => {
      aiEl.textContent += chunk;
      document.getElementById('chat-messages').scrollTop = 9999;
    });
    aiEl.classList.remove('streaming');
    chatHistory.push({ role: 'assistant', content: reply });
  } catch (err) {
    aiEl.classList.remove('streaming');
    aiEl.textContent = '錯誤：' + err.message;
  }

  document.getElementById('chat-send').disabled = false;
  document.getElementById('chat-input').focus();
}

async function streamGroq(apiKey, messages, onChunk) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      stream: true,
      max_tokens: 1536,
      temperature: 0.5
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value, { stream: true }).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;
      try {
        const delta = JSON.parse(data).choices[0]?.delta?.content || '';
        if (delta) { fullText += delta; onChunk(delta); }
      } catch (_) {}
    }
  }
  return fullText;
}

function appendChatMsg(cls, text) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + cls;
  div.textContent = text;
  const msgsEl = document.getElementById('chat-messages');
  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return div;
}

async function buildChatContext() {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `你是一位台灣主動式ETF投資分析助理。請用繁體中文回答，語氣專業但易懂。`,
    `以下是 ${today} 各檔主動式ETF的持股異動摘要，請根據這些資料回答使用者問題。`,
    ''
  ];

  for (const code of ETF_CODES) {
    const latestDate = await getLatestDate(code);
    if (!latestDate) continue;

    const cfg = ETF_CONFIG[code];
    const holdings = await getHoldings(code, latestDate);
    if (!holdings.length) continue;

    const dates = await getDates(code);
    let added = [], removed = [], changed = [];
    if (dates.length >= 2) {
      const prev = await getHoldings(code, dates[dates.length - 2]);
      ({ added, removed, changed } = diffHoldings(prev, holdings));
    }

    const actualTrades = changed.filter(s => s.shareDelta !== 0);
    const drifted = changed.filter(s => s.shareDelta === 0 && s.shares > 0);

    lines.push(`【${code} ${cfg.name}】共 ${holdings.length} 檔 (資料日期: ${latestDate})`);
    if (added.length)
      lines.push(`  新增: ${added.map(s => `${s.code}${s.name}(${s.percentage.toFixed(2)}%)`).join('、')}`);
    if (removed.length)
      lines.push(`  移除: ${removed.map(s => `${s.code}${s.name}`).join('、')}`);
    if (actualTrades.length)
      lines.push(`  調整持股: ${actualTrades.map(s =>
        `${s.code}${s.name}(${s.shareDelta > 0 ? '+' : ''}${s.shareDelta?.toLocaleString()}股, ${s.delta > 0 ? '+' : ''}${s.delta.toFixed(2)}%)`
      ).join('、')}`);
    if (drifted.length)
      lines.push(`  市價漂移（未交易）: ${drifted.map(s => `${s.code}${s.name}`).join('、')}`);
    if (!added.length && !removed.length && !actualTrades.length)
      lines.push(`  今日無異動`);
    lines.push('');
  }

  return lines.join('\n');
}
