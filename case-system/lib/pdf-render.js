// 用系統 Chromium（puppeteer-core）把報價單頁面轉成 A4 PDF。
// 共用單一瀏覽器實例；斷線自動重啟。若環境無 Chromium，renderPdf 會 throw，由呼叫端 fallback。
const puppeteer = require('puppeteer-core');

let _browser = null;
let _launching = null;

async function getBrowser() {
  if (_browser) return _browser;
  if (_launching) return _launching;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
  _launching = puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  }).then(b => {
    _browser = b;
    _launching = null;
    b.on('disconnected', () => { _browser = null; });
    return b;
  }).catch(err => {
    _launching = null;
    throw err;
  });
  return _launching;
}

// url：要轉檔的頁面（本機 http://127.0.0.1:PORT/quote/:token?pdf=1）
async function renderPdf(url, { waitSelector } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    if (waitSelector) {
      try { await page.waitForSelector(waitSelector, { timeout: 8000 }); } catch (e) {}
    }
    // 等所有圖片載入完成（膜料示意圖、現場照、簽名、條款附圖）
    try {
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map(img =>
          img.complete ? Promise.resolve() : new Promise(res => { img.onload = img.onerror = res; })
        ));
      });
    } catch (e) {}
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '12mm', left: '8mm', right: '8mm' },
    });
    return pdf;
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

module.exports = { renderPdf };
