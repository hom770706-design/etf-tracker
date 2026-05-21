export const ETF_CONFIG = {
  '00980A': {
    code: '00980A',
    name: '野村臺灣智慧優選',
    issuer: '野村投信',
    color: '#E74C3C',
    bgColor: 'rgba(231, 76, 60, 0.15)',
    // 要開啟的持股頁面（Content Script 從這裡提取資料）
    portfolioUrls: [
      'https://www.nomurafunds.com.tw/ETFWEB/product-description?fundNo=00980A&tab=Shareholding',
      'https://money.nomurafunds.com.tw/etf/00980A'
    ]
  },
  '00981A': {
    code: '00981A',
    name: '統一台股增長',
    issuer: '統一投信',
    color: '#3498DB',
    bgColor: 'rgba(52, 152, 219, 0.15)',
    portfolioUrls: [
      'https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=49YTW'
    ]
  },
  '00982A': {
    code: '00982A',
    name: '群益台灣精選強棒',
    issuer: '群益投信',
    color: '#2ECC71',
    bgColor: 'rgba(46, 204, 113, 0.15)',
    portfolioUrls: [
      'https://www.capitalfund.com.tw/etf/product/detail/399/portfolio'
    ]
  },
  '00403A': {
    code: '00403A',
    name: '統一台股精選',
    issuer: '統一投信',
    color: '#9B59B6',
    bgColor: 'rgba(155, 89, 182, 0.15)',
    portfolioUrls: [
      'https://www.ezmoney.com.tw/ETF/Fund/Info?fundCode=63YTW'
    ]
  }
};

export const ETF_CODES = Object.keys(ETF_CONFIG);
