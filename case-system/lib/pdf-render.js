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
// title：頁尾顯示的文件名稱（＝檔名，繪新報價單-客戶-案名）
async function renderPdf(url, { waitSelector, title } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    if (waitSelector) {
      try { await page.waitForSelector(waitSelector, { timeout: 8000 }); } catch (e) {}
    }
    // 縮小 Cloudinary 圖片（避免 PDF 動輒十幾 MB）：插入 w_1100,q_auto,f_auto 轉換
    try {
      await page.evaluate(() => {
        document.querySelectorAll('img').forEach(img => {
          try {
            const u = new URL(img.src, location.href);
            if (u.hostname.includes('cloudinary') && u.pathname.includes('/upload/') &&
                !/\/upload\/[^/]*(?:w_|q_)/.test(u.pathname)) {
              img.src = img.src.replace('/upload/', '/upload/w_1100,q_auto,f_auto/');
            }
          } catch (e) {}
        });
      });
    } catch (e) {}
    // 等所有圖片載入完成（膜料示意圖、現場照、簽名、條款附圖）
    try {
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map(img =>
          img.complete ? Promise.resolve() : new Promise(res => { img.onload = img.onerror = res; })
        ));
      });
    } catch (e) {}
    // 頁面本身的 @page{margin:10mm} 會蓋掉 puppeteer 的邊界，導致頁尾沒有空間 → 這裡歸零，交給 pdf() 的 margin 控制
    try { await page.addStyleTag({ content: '@page{margin:0 !important}' }); } catch (e) {}
    const esc = s => String(s || '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
    const docTitle = esc(title || '繪新報價單');
    const footerTemplate = `<div style="font-size:8px;width:100%;box-sizing:border-box;padding:0 8mm;color:#999;font-family:'Noto Sans CJK TC','Noto Sans TC',sans-serif;display:flex;justify-content:space-between;align-items:center;">
      <span style="max-width:72%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${docTitle}</span>
      <span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 頁</span>
    </div>`;
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate,
      margin: { top: '10mm', bottom: '16mm', left: '8mm', right: '8mm' },
    });
    return pdf;
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

// 直接用 HTML 字串產 PDF（不需另開網址/路由；用於客服對話備份）
async function renderPdfFromHtml(html, { title } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    // 縮小 Cloudinary 圖片，避免 PDF 過大
    try {
      await page.evaluate(() => {
        document.querySelectorAll('img').forEach(img => {
          try {
            const u = new URL(img.src, location.href);
            if (u.hostname.includes('cloudinary') && u.pathname.includes('/upload/') &&
                !/\/upload\/[^/]*(?:w_|q_)/.test(u.pathname)) {
              img.src = img.src.replace('/upload/', '/upload/w_1100,q_auto,f_auto/');
            }
          } catch (e) {}
        });
      });
    } catch (e) {}
    try {
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map(img =>
          img.complete ? Promise.resolve() : new Promise(res => { img.onload = img.onerror = res; })
        ));
      });
    } catch (e) {}
    try { await page.addStyleTag({ content: '@page{margin:0 !important}' }); } catch (e) {}
    const esc = s => String(s || '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
    const docTitle = esc(title || '客服對話紀錄');
    const footerTemplate = `<div style="font-size:8px;width:100%;box-sizing:border-box;padding:0 8mm;color:#999;font-family:'Noto Sans CJK TC','Noto Sans TC',sans-serif;display:flex;justify-content:space-between;align-items:center;">
      <span style="max-width:72%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${docTitle}</span>
      <span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 頁</span>
    </div>`;
    const pdf = await page.pdf({
      format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<div></div>', footerTemplate,
      margin: { top: '10mm', bottom: '16mm', left: '8mm', right: '8mm' },
    });
    return pdf;
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

module.exports = { renderPdf, renderPdfFromHtml };
