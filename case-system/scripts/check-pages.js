/**
 * 頁面 inline script 語法檢查
 * 把每個 HTML 頁面的 inline <script> 與它載入的 common.js 合併後做 node --check，
 * 專門抓「重複宣告 common.js 全域變數」這類會讓整頁 JS 失效的 SyntaxError
 * （單獨 node --check 抓不到跨檔重複宣告）。push 前自動擋下。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const PUB = path.join(__dirname, '..', 'public');
const commonJs = fs.readFileSync(path.join(PUB, 'js', 'common.js'), 'utf8');

// 抓出沒有 src 的 inline <script> 內容
function inlineScripts(html) {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
}

const htmlFiles = fs.readdirSync(PUB).filter(f => f.endsWith('.html'));
const failed = [];

for (const f of htmlFiles) {
  const html    = fs.readFileSync(path.join(PUB, f), 'utf8');
  const scripts = inlineScripts(html);
  if (!scripts.length) continue;
  const usesCommon = /<script[^>]*\bsrc\s*=\s*["'][^"']*\/js\/common\.js/i.test(html);
  const combined  = (usesCommon ? commonJs + '\n;\n' : '') + scripts.join('\n;\n');
  const tmp = path.join(os.tmpdir(), `pagecheck_${f}.js`);
  fs.writeFileSync(tmp, combined);
  try {
    execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
  } catch (e) {
    const msg = (e.stderr || e.stdout || '').toString().split('\n').find(l => /Error|declared/.test(l)) || 'SyntaxError';
    failed.push({ file: f, msg: msg.trim() });
  }
  fs.unlinkSync(tmp);
}

if (failed.length) {
  console.error('❌ 頁面 inline script 語法檢查未通過：');
  failed.forEach(x => console.error(`   ${x.file} — ${x.msg}`));
  process.exit(1);
}
console.log(`✅ 頁面語法檢查通過（${htmlFiles.length} 頁，含 common.js 合併，無重複宣告/語法錯誤）`);
