// 自家短網址：/s/<code> → 302 直接導向目標，取代 TinyURL（無第三方中轉預覽頁）
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function genCode(n = 7) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += B62[bytes[i] % 62];
  return s;
}

// 產生（或重用既有）指向 target 的短碼；同一 target 重用同一碼
function makeShort(target) {
  const hit = db.prepare(`SELECT code FROM short_links WHERE target=? ORDER BY id LIMIT 1`).get(target);
  if (hit) return hit.code;
  for (let i = 0; i < 6; i++) {
    const code = genCode(7);
    try { db.prepare(`INSERT INTO short_links (code, target) VALUES (?, ?)`).run(code, target); return code; }
    catch (e) { /* 撞碼 → 重試 */ }
  }
  return null;
}

// /s/:code → 直接 302 導向（客戶端，不需登入）
router.get('/:code', (req, res) => {
  const row = db.prepare(`SELECT target FROM short_links WHERE code=?`).get(req.params.code);
  if (!row) return res.status(404).send('連結不存在或已失效');
  res.redirect(302, row.target);
});

module.exports = router;
module.exports.makeShort = makeShort;
