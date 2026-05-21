import { getSettings } from './storage.js';

// data = { etfs: { code: { holdings, added, removed, changed } }, overlap: [...] }
export async function syncToSheets(date, data) {
  const { sheetsWebAppUrl } = await getSettings();
  if (!sheetsWebAppUrl) throw new Error('尚未設定 Google Apps Script Web App URL');

  const resp = await fetch(sheetsWebAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'syncAll', date, etfs: data.etfs, overlap: data.overlap || [] })
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const result = await resp.json();
  if (!result.ok) throw new Error(result.error || '同步失敗');
  return result;
}

export async function testSheetsConnection(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const result = await resp.json();
  if (!result.ok) throw new Error(result.error || '連線失敗');
  return result;
}
