# 台灣主動ETF成分股追蹤器

追蹤 **00980A、00981A、00982A、00403A** 四檔主動式 ETF 的每日成分股變化。

## 功能

| 頁籤 | 內容 |
|------|------|
| 今日變化 | 各 ETF 當日新增/移除股票摘要與明細（含產業別） |
| 趨勢圖 | 每日成分股異動數量折線圖 |
| 產業分布 | 新增/移除股票的 TWSE 產業別環形圖 + 統計表 |
| 股票分析 | 股票出現頻率橫向柱狀圖 + 個別股票進出時間軸 |

## 快速安裝

### 1. 安裝依賴
```bash
npm run setup
```
> 這會執行 `npm install` 並將 `chart.js` 複製到 `vendor/`

### 2. 載入到 Chrome
1. 開啟 `chrome://extensions`
2. 開啟右上角「**開發人員模式**」
3. 點擊「**載入未封裝項目**」
4. 選擇本資料夾 (`EFT/`)

### 3. 初次使用
- 安裝後 Extension 會自動嘗試抓取最新資料
- 若自動抓取失敗，請使用「手動匯入」功能（見下方）

---

## 資料來源架構

```
Extension 每日 18:00 自動抓取（台股收盤後）

策略 1: TWSE ETFortune API (JSON)
  → https://www.twse.com.tw/ETFortune/etfPortfolio?fundNo={CODE}

策略 2: TWSE ETFortune 頁面 (HTML 解析)
  → https://www.twse.com.tw/zh/ETFortune/etfInfo/{CODE}

策略 3: 各發行商官網 (備援)
  → 00980A: https://money.nomurafunds.com.tw/etf/00980A
```

> **注意**: TWSE API 的確切路徑尚需實際測試驗證。
> 若自動抓取失敗，請使用手動匯入功能。

---

## 手動匯入資料

若自動抓取失敗，可從各 ETF 官網複製每日持股資料手動匯入：

1. 點擊 Extension 右上角的 **⤓** 按鈕
2. 選擇 ETF 代號與日期
3. 貼上以下格式的 JSON：

```json
[
  {"code": "2330", "name": "台積電", "shares": 1000000, "percentage": 8.5},
  {"code": "2317", "name": "鴻海", "shares": 500000, "percentage": 3.2}
]
```

### 官方資料來源
| ETF | 發行商 | 每日持股頁面 |
|-----|--------|-------------|
| 00980A | 野村投信 | [money.nomurafunds.com.tw](https://money.nomurafunds.com.tw/etf/00980A) |
| 00981A | 統一投信 | [TWSE ETFortune](https://www.twse.com.tw/zh/ETFortune/etfInfo/00981A) |
| 00982A | 群益投信 | [TWSE ETFortune](https://www.twse.com.tw/zh/ETFortune/etfInfo/00982A) |
| 00403A | 統一投信 | [TWSE ETFortune](https://www.twse.com.tw/zh/ETFortune/etfInfo/00403A) |

---

## 檔案結構

```
EFT/
├── manifest.json           # Extension 設定 (MV3)
├── package.json
├── background/
│   └── service-worker.js   # 每日定時抓取
├── popup/
│   ├── popup.html          # 主介面
│   ├── popup.js            # UI 邏輯與圖表
│   └── popup.css           # 深色主題樣式
├── lib/
│   ├── etf-config.js       # ETF 基本資訊
│   ├── storage.js          # chrome.storage 封裝
│   ├── scraper.js          # 多策略資料爬取
│   ├── comparison.js       # 每日持股比對
│   └── industry.js         # TWSE 產業分類
├── scripts/
│   └── copy-deps.js        # 複製 Chart.js 到 vendor/
└── vendor/
    └── chart.min.js        # 由 npm run setup 產生
```

---

## 常見問題

**Q: 抓取失敗怎麼辦？**
Extension 圖示上會出現紅點。請先嘗試手動匯入，並在 DevTools Console 查看錯誤訊息，協助更新 `lib/scraper.js` 中的 API 端點。

**Q: 資料儲存多久？**
最多保留 90 天的歷史資料（每個 ETF 各自計算）。

**Q: 何時自動更新？**
每天平日 18:00 自動抓取。也可隨時按 ⟳ 手動觸發。
