/**
 * 上線前體檢（smoke test）
 * 用一個全新的暫存資料庫，把整個系統真的啟動起來，登入後巡一圈主要頁面與 API，
 * 任何一個回傳 500 / 壞掉就視為失敗、擋下上線。
 *
 * 執行：npm run smoke
 * 目的：新功能上線前自動確認「舊功能沒有被改壞、系統能正常啟動」。
 */
const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── 1. 準備乾淨的測試環境（完全不碰正式資料庫）─────────────────
const TMP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'huixin-smoke-'));
const PORT     = 4599;
process.env.DB_PATH        = path.join(TMP_DIR, 'test.db');
process.env.PORT           = String(PORT);
process.env.SESSION_SECRET = 'smoke-test';
delete process.env.NODE_ENV;            // 確保 cookie.secure=false，可用 http 測試

const BASE = `http://127.0.0.1:${PORT}`;
let cookie = '';
const results = [];

function cleanup() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await fetch(BASE + '/login', { redirect: 'manual' }); return true; }
    catch (_) { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('伺服器在時限內沒有啟動');
}

async function check(label, pathname, { method = 'GET', body, expect = 200 } = {}) {
  try {
    const res = await fetch(BASE + pathname, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ok = Array.isArray(expect) ? expect.includes(res.status) : res.status === expect;
    results.push({ label, pathname, status: res.status, ok });
    return res;
  } catch (e) {
    results.push({ label, pathname, status: 'ERR:' + e.message, ok: false });
    return null;
  }
}

(async () => {
  // ── 2. 啟動真實伺服器（含全新 DB 初始化）─────────────────────
  try {
    require('../server.js');
  } catch (e) {
    console.error('❌ 伺服器啟動就失敗（資料庫初始化或載入錯誤）：\n', e.message);
    cleanup();
    process.exit(1);
  }
  await waitForServer();

  // 讓 owner 帳號跳過合約頁，頁面才會正常回 200
  const db = require('../db');
  db.prepare(`UPDATE users SET contract_signed_at=CURRENT_TIMESTAMP, contract_type='employee' WHERE username='flora'`).run();

  // ── 3. 登入（種子帳號）─────────────────────────────────────
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'flora', password: 'huixin2024' }),
  });
  const setCookie = login.headers.get('set-cookie');
  if (login.status !== 200 || !setCookie) {
    console.error('❌ 登入失敗，status=' + login.status);
    cleanup();
    process.exit(1);
  }
  cookie = setCookie.split(';')[0];

  // ── 4. 巡頁面與 API（owner 全開）──────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const firstOfMonth = month + '-01';

  // 主要頁面（HTML）
  for (const [label, p] of [
    ['登入頁', '/login.html'], ['總覽', '/dashboard'], ['員工績效', '/staff-performance'],
    ['詢價管理', '/cases-inquiry'], ['客戶管理', '/clients'], ['人員管理', '/admin'],
    ['缺失管理', '/deficiencies'], ['請假管理', '/leave'], ['收支流水帳', '/ledger'],
    ['膜料管理', '/materials'], ['報價管理', '/quote-list'], ['業績報表', '/performance'],
    ['財務報表', '/reports'],
  ]) await check(label, p);

  // 主要 API
  await check('API 使用者清單',   '/api/users');
  await check('API 客戶清單',     '/api/clients');
  await check('API 缺失清單',     '/api/deficiencies');
  await check('API 案件清單',     '/api/cases');
  await check('API 員工績效',     `/api/staff-performance?from=${firstOfMonth}&to=${today}`);
  await check('API 出缺勤紅綠燈', `/api/staff-performance/attendance?month=${month}`);

  // ── 5. 結果 ───────────────────────────────────────────────
  cleanup();
  const failed = results.filter(r => !r.ok);
  console.log('\n──────── 體檢結果 ────────');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'}  [${r.status}]  ${r.label}  ${r.pathname}`);
  }
  console.log('──────────────────────────');
  if (failed.length) {
    console.log(`\n❌ 體檢未通過：${failed.length}/${results.length} 項失敗，請勿上線。\n`);
    process.exit(1);
  }
  console.log(`\n✅ 全部 ${results.length} 項通過，系統可正常啟動與運作。\n`);
  process.exit(0);
})();
