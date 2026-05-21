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
        <div class="card-stat-val" style="color:var(--yellow)">${changed.length}</div>
        <div class="card-stat-label">調整</div>
      </div>
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

  const increased = changed.filter(s => s.delta > 0);
  const decreased = changed.filter(s => s.delta < 0);
  if (increased.length > 0) {
    html += `<div class="changes-header"><span class="badge badge-green">增加比重 ${increased.length}</span></div>
      <div class="stock-list">${increased.map(s => weightChip(s, 'increased')).join('')}</div>`;
  }
  if (decreased.length > 0) {
    html += `<div class="changes-header"><span class="badge badge-red">減少比重 ${decreased.length}</span></div>
      <div class="stock-list">${decreased.map(s => weightChip(s, 'decreased')).join('')}</div>`;
  }

  return html + '</div>';
}

function stockChip(stock, type) {
  const ind = lookupIndustry(stock.code, industryMap);
  return `<span class="stock-chip ${type}"><span class="code">${stock.code}</span>${stock.name}<span class="ind"> ${ind}</span></span>`;
}

function weightChip(stock, type) {
  const ind = lookupIndustry(stock.code, industryMap);
  const sign = stock.delta > 0 ? '+' : '';
  const cls  = type === 'increased' ? 'delta-up' : 'delta-down';
  return `<span class="stock-chip ${type}"><span class="code">${stock.code}</span>${stock.name}<span class="${cls}"> ${sign}${stock.delta.toFixed(2)}%</span><span class="ind"> ${ind}</span></span>`;
}

// ── HOLDINGS TAB ─────────────────────────────────────────────────
async function renderHoldings() {
  const codes = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const container = document.getElementById('holdings-container');
  const searchEl = document.getElementById('holdings-search');
  container.innerHTML = '';
  searchEl.value = '';

  const allRenderFns = []; // 每個 ETF 一個 renderRows fn，搜尋時同時呼叫

  for (const code of codes) {
    const cfg = ETF_CONFIG[code];
    const latestDate = await getLatestDate(code);
    if (!latestDate) {
      container.insertAdjacentHTML('beforeend', `
        <div class="holdings-section" style="--card-color:${cfg.color}">
          <div class="holdings-header">
            <span class="holdings-header-name" style="color:${cfg.color}">${code} · ${cfg.name}</span>
            <span class="holdings-header-meta">尚無資料</span>
          </div>
        </div>`);
      continue;
    }

    const holdings = await getHoldings(code, latestDate);
    if (!holdings?.length) continue;

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
            </tr>
          </thead>
          <tbody id="${tbodyId}"></tbody>
        </table>
      </div>`);

    const tbody = document.getElementById(tbodyId);
    const sort = { col: 'percentage', dir: 'desc' };

    const renderRows = (kw = '') => {
      const q = kw.toLowerCase();
      const sorted = [...holdings].sort((a, b) => {
        let va = sort.col === 'industry' ? lookupIndustry(a.code, industryMap) : a[sort.col];
        let vb = sort.col === 'industry' ? lookupIndustry(b.code, industryMap) : b[sort.col];
        if (typeof va === 'string') return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        return sort.dir === 'asc' ? va - vb : vb - va;
      });

      tbody.innerHTML = sorted.map(s => {
        const ind = lookupIndustry(s.code, industryMap);
        const hide = q && ![s.code, s.name, ind].some(v => v.toLowerCase().includes(q));
        return `<tr${hide ? ' class="hidden-row"' : ''}>
          <td class="col-code">${s.code}</td>
          <td>${s.name}</td>
          <td class="col-pct">${s.percentage.toFixed(2)}%</td>
          <td class="col-shares">${s.shares > 0 ? s.shares.toLocaleString() : '—'}</td>
          <td class="col-ind">${ind}</td>
        </tr>`;
      }).join('');
    };

    renderRows();
    allRenderFns.push(renderRows);

    // 欄位標頭點擊排序
    document.querySelectorAll(`#${sectionId} thead th`).forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        sort.dir = sort.col === col
          ? (sort.dir === 'asc' ? 'desc' : 'asc')
          : (['code', 'name', 'industry'].includes(col) ? 'asc' : 'desc');
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

  // 搜尋框：同時過濾所有 ETF 的表格
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
        <div class="holdings-section" style="--card-color:var(--accent)">
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
  const codes = activeEtf === 'all' ? ETF_CODES : [activeEtf];
  const allDates = new Set();
  const dataByCode   = {};
  const detailByCode = {}; // for tooltips

  for (const code of codes) {
    const history = await buildChangeHistory(code);
    dataByCode[code]   = {};
    detailByCode[code] = {};
    for (const { date, added, removed, changed = [] } of history) {
      allDates.add(date);
      dataByCode[code][date] = {
        added:   added.reduce((s, x) => s + (x.percentage || 0), 0),
        removed: removed.reduce((s, x) => s + (x.percentage || 0), 0),
        changed: changed.reduce((s, x) => s + Math.abs(x.delta || 0), 0)
      };
      detailByCode[code][date] = { added, removed, changed };
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

  const datasets = [];
  for (const code of codes) {
    const cfg = ETF_CONFIG[code];
    datasets.push({
      label: `${code} 新增`,
      data: labels.map(d => dataByCode[code][d]?.added ?? null),
      borderColor: cfg.color, backgroundColor: cfg.bgColor,
      borderWidth: 2, pointRadius: 3, tension: 0.3, fill: false
    });
    datasets.push({
      label: `${code} 移除`,
      data: labels.map(d => dataByCode[code][d]?.removed ?? null),
      borderColor: cfg.color, backgroundColor: cfg.bgColor,
      borderWidth: 2, borderDash: [4, 4], pointRadius: 3, tension: 0.3, fill: false
    });
    datasets.push({
      label: `${code} 比重調整`,
      data: labels.map(d => dataByCode[code][d]?.changed ?? null),
      borderColor: cfg.color + '88', backgroundColor: cfg.bgColor,
      borderWidth: 1, borderDash: [2, 2], pointRadius: 2, tension: 0.3, fill: false
    });
  }

  charts.trend = new Chart(trendCanvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8892a4', font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#1a1d27', titleColor: '#e2e8f0', bodyColor: '#8892a4',
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.raw != null ? ctx.raw.toFixed(2) + '%' : '—'}`,
            afterLabel: ctx => {
              const codeMatch = ctx.dataset.label.match(/^(\S+)/);
              if (!codeMatch) return [];
              const code = codeMatch[1];
              const date = labels[ctx.dataIndex];
              const detail = detailByCode[code]?.[date];
              if (!detail) return [];
              if (ctx.dataset.label.includes('新增'))
                return detail.added.slice(0, 5).map(s => `  ＋${s.code} ${s.name} ${(s.percentage||0).toFixed(1)}%`);
              if (ctx.dataset.label.includes('移除'))
                return detail.removed.slice(0, 5).map(s => `  －${s.code} ${s.name} ${(s.percentage||0).toFixed(1)}%`);
              if (ctx.dataset.label.includes('比重'))
                return detail.changed.slice(0, 5).map(s => {
                  const sign = s.delta > 0 ? '▲' : '▼';
                  return `  ${sign}${s.code} ${s.name} ${s.delta > 0 ? '+' : ''}${s.delta.toFixed(2)}%`;
                });
              return [];
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#8892a4', font: { size: 10 }, maxTicksLimit: 10 }, grid: { color: '#2e3148' } },
        y: {
          ticks: { color: '#8892a4', font: { size: 11 }, callback: v => v.toFixed(1) + '%' },
          grid: { color: '#2e3148' }, beginAtZero: true,
          title: { display: true, text: '持股比重 (%)', color: '#8892a4', font: { size: 10 } }
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
  const { sheetsWebAppUrl } = await getSettings();
  document.getElementById('settings-sheets-url').value = sheetsWebAppUrl || '';
  document.getElementById('settings-result').textContent = '';
  document.getElementById('modal-settings').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('modal-settings').classList.add('hidden');
}

async function handleSettingsSave() {
  const url = document.getElementById('settings-sheets-url').value.trim();
  await saveSettings({ sheetsWebAppUrl: url });
  document.getElementById('settings-result').textContent = url ? '✓ 已儲存' : '已清除 URL';
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
    const etfsData = {};
    for (const code of ETF_CODES) {
      const dates = await getDates(code);
      if (!dates.length) continue;
      const latestDate = dates[dates.length - 1];
      const holdings = await getHoldings(code, latestDate);
      let added = [], removed = [];
      if (dates.length >= 2) {
        const prevHoldings = await getHoldings(code, dates[dates.length - 2]);
        ({ added, removed } = diffHoldings(prevHoldings, holdings));
      }
      etfsData[code] = { holdings, added, removed };
    }
    if (!Object.keys(etfsData).length) throw new Error('尚無資料可同步');
    await syncToSheets(today, etfsData);
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
