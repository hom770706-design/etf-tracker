const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
const destDir = path.join(__dirname, '..', 'vendor');
const dest = path.join(destDir, 'chart.min.js');

fs.mkdirSync(destDir, { recursive: true });

if (!fs.existsSync(src)) {
  console.error('找不到 chart.js，請先執行 npm install');
  process.exit(1);
}

fs.copyFileSync(src, dest);
console.log(`✓ Chart.js 已複製到 vendor/chart.min.js (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
