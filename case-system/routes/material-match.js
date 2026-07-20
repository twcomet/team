// 相似花色查詢（第一期）：庫存米數篩選＋條件搜尋＋分享連結（免登入、伺服器端過濾機密欄位）。
// 第二/三期再接 AI 視覺標籤相似推薦與圖片搜尋。此模組獨立、不影響現有功能。
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function _code(n = 8) {
  const B = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const b = crypto.randomBytes(n); let s = '';
  for (let i = 0; i < n; i++) s += B[b[i] % 62];
  return s;
}
const FILM = "1=1";   // 不用 category 過濾：正式庫 category 值不一，過濾會把膜料全濾掉

// ── 搜尋膜料：庫存 >= 米數 ＋ 品牌 ＋ 關鍵字（品牌/型號/花色/規格）──
router.get('/search', requireAuth, (req, res) => {
  const min   = Number(req.query.min_meters) || 0;
  const brand = (req.query.brand || '').trim();
  const q     = (req.query.q || '').trim();
  const where = [FILM, 'COALESCE(m.stock_meters,0) >= ?'];
  const params = [min];
  if (brand) { where.push('TRIM(LOWER(m.brand))=TRIM(LOWER(?))'); params.push(brand); }
  if (q) {
    // 忽略連字號/空格、不分大小寫：AA611 也能搜到 AA-611、aa 611
    const nq = '%' + q.replace(/[-\s]/g, '').toLowerCase() + '%';
    const norm = c => `REPLACE(REPLACE(LOWER(${c}),'-',''),' ','')`;
    where.push(`(${norm('m.brand')} LIKE ? OR ${norm('m.model')} LIKE ? OR ${norm('m.color')} LIKE ? OR ${norm('m.spec')} LIKE ?)`);
    params.push(nq, nq, nq, nq);
  }
  const rows = db.prepare(`
    SELECT m.id, m.brand, m.model, m.color, m.spec, m.image_url, m.unit_price,
           m.stock_meters, m.location, m.width_cm, o.name AS branch
    FROM materials m LEFT JOIN orgs o ON o.id = m.org_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(m.stock_meters,0) DESC, m.brand, m.model
    LIMIT 200
  `).all(...params);
  res.json(rows);
});

// 品牌下拉清單
router.get('/brands', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT brand FROM materials WHERE brand IS NOT NULL AND brand!='' AND ${FILM} ORDER BY brand`).all();
  res.json(rows.map(r => r.brand));
});

// 建立分享連結：勾選要顯示的機密欄位（品牌/型號/圖片必出、不受此控制）
router.post('/share', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
  if (!ids.length) return res.status(400).json({ error: '請至少勾選一項膜料再分享' });
  const f = req.body.fields || {};
  const token = _code(8);
  db.prepare(`INSERT INTO material_share (token, material_ids, show_price, show_stock, show_location, show_branch, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(token, JSON.stringify(ids.slice(0, 100)), f.price ? 1 : 0, f.stock ? 1 : 0, f.location ? 1 : 0, f.branch ? 1 : 0, req.session.user.id);
  res.json({ ok: true, token });
});

// 公開分享頁資料（免登入）：只回品牌/型號/圖片 ＋ 建立時勾選允許的機密欄位（伺服器端過濾）
router.get('/shared/:token', (req, res) => {
  const s = db.prepare(`SELECT * FROM material_share WHERE token=?`).get(req.params.token);
  if (!s) return res.status(404).json({ error: '連結不存在或已失效' });
  let ids = []; try { ids = JSON.parse(s.material_ids) || []; } catch (_) {}
  if (!ids.length) return res.json({ fields: {}, items: [] });
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.id, m.brand, m.model, m.color, m.image_url, m.unit_price, m.stock_meters, m.location, o.name AS branch
    FROM materials m LEFT JOIN orgs o ON o.id = m.org_id WHERE m.id IN (${ph})
  `).all(...ids);
  const byId = {}; rows.forEach(r => byId[r.id] = r);
  const items = ids.map(id => byId[id]).filter(Boolean).map(r => {
    const o = { brand: r.brand, model: r.model, color: r.color, image_url: r.image_url };   // 必出欄位
    if (s.show_price)    o.unit_price   = r.unit_price;
    if (s.show_stock)    o.stock_meters = r.stock_meters;
    if (s.show_location) o.location     = r.location;
    if (s.show_branch)   o.branch       = r.branch;
    return o;
  });
  res.json({ fields: { price: !!s.show_price, stock: !!s.show_stock, location: !!s.show_location, branch: !!s.show_branch }, items });
});

module.exports = router;
