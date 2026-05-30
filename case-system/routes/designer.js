const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const crypto  = require('crypto');

function canManage(user) {
  return user.role === 'owner' || !!user.manage_users || !!user.can_manage_assets;
}

// ── 公開：驗證存取碼 + PIN ───────────────────────────────────────────────
router.post('/verify', (req, res) => {
  const { code, pin } = req.body;
  if (!code || !pin) return res.status(400).json({ error: '請輸入存取碼與 PIN' });

  const row = db.prepare(`
    SELECT dac.*, c.name as client_name, c.category_id,
           cc.discount_rate as cat_discount
    FROM designer_access_codes dac
    LEFT JOIN clients c ON c.id = dac.client_id
    LEFT JOIN client_categories cc ON cc.id = c.category_id
    WHERE dac.code = ? AND dac.is_active = 1
  `).get(code.toUpperCase());

  if (!row) return res.status(404).json({ error: '存取碼不存在或已停用' });
  if (row.expires_at && new Date(row.expires_at) < new Date())
    return res.status(403).json({ error: '存取碼已過期' });
  if (row.pin !== pin) return res.status(401).json({ error: 'PIN 不正確' });

  req.session.designer = {
    client_id:    row.client_id,
    client_name:  row.client_name,
    cat_discount: row.cat_discount || 1.0,
    code:         row.code,
  };
  res.json({ ok: true, client_name: row.client_name });
});

// ── 公開：登出設計師 session ──────────────────────────────────────────────
router.post('/logout', (req, res) => {
  delete req.session.designer;
  res.json({ ok: true });
});

// ── 公開：查詢庫存與定價（需先 verify）──────────────────────────────────
router.get('/stock', (req, res) => {
  if (!req.session.designer) return res.status(401).json({ error: '請先輸入存取碼' });
  const { cat_discount } = req.session.designer;

  const materials = db.prepare(`
    SELECT m.id, m.brand, m.model, m.color, m.spec, m.category, m.unit_price,
           COALESCE(SUM(mr.remaining_meters), 0) as total_stock
    FROM materials m
    LEFT JOIN material_rolls mr ON mr.material_id = m.id AND mr.status = 'active'
    WHERE m.unit_price > 0 OR COALESCE(SUM(mr.remaining_meters),0) > 0
    GROUP BY m.id
    ORDER BY m.brand, m.model
  `).all();

  // 各分店庫存
  const byBranch = db.prepare(`
    SELECT mr.material_id, mr.branch, COALESCE(SUM(mr.remaining_meters),0) as stock
    FROM material_rolls mr WHERE mr.status='active'
    GROUP BY mr.material_id, mr.branch
  `).all();

  const branchMap = {};
  byBranch.forEach(r => {
    if (!branchMap[r.material_id]) branchMap[r.material_id] = {};
    branchMap[r.material_id][r.branch || '總部'] = r.stock;
  });

  const result = materials.map(m => ({
    ...m,
    discount_price: m.unit_price ? Math.round(m.unit_price * cat_discount) : null,
    branches: branchMap[m.id] || {},
  }));

  res.json({ materials: result, discount_rate: cat_discount });
});

// ── 公開：取得目前 session 狀態 ──────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session.designer) return res.json({ logged_in: false });
  res.json({ logged_in: true, client_name: req.session.designer.client_name });
});

// ── 公開：取得客戶的報價單（需先 verify）────────────────────────────────
router.get('/quotes', (req, res) => {
  if (!req.session.designer) return res.status(401).json({ error: '請先輸入存取碼' });
  const { client_id } = req.session.designer;

  const quotes = db.prepare(`
    SELECT qs.id, qs.case_id, qs.status, qs.valid_until, qs.share_token,
           qs.total_price, qs.discount_rate, qs.created_at,
           c.case_number, c.title as case_title,
           u.name as created_by_name
    FROM quote_sheets qs
    JOIN cases c ON c.id = qs.case_id
    LEFT JOIN users u ON u.id = qs.created_by
    WHERE c.client_id = ?
      AND qs.status IN ('sent','signed','ready')
    ORDER BY qs.created_at DESC
    LIMIT 10
  `).all(client_id);

  res.json(quotes);
});

// ── 後台：存取碼管理（需登入）────────────────────────────────────────────

router.get('/codes', requireAuth, (req, res) => {
  const me = req.session.user;
  const { client_id } = req.query;
  let sql = `
    SELECT dac.*, c.name as client_name, u.name as created_by_name
    FROM designer_access_codes dac
    LEFT JOIN clients c ON c.id = dac.client_id
    LEFT JOIN users u ON u.id = dac.created_by
    WHERE 1=1
  `;
  const params = [];
  if (client_id) { sql += ` AND dac.client_id=?`; params.push(client_id); }
  if (me.role !== 'owner') { sql += ` AND c.org_id=?`; params.push(me.org_id); }
  sql += ` ORDER BY dac.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.post('/codes', requireAuth, (req, res) => {
  const me = req.session.user;
  const { client_id, pin, note, expires_at } = req.body;
  if (!client_id) return res.status(400).json({ error: '請指定客戶' });
  if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN 須為 4 位數字' });

  // 驗證 client 屬於同分店（非 owner 時）
  if (me.role !== 'owner') {
    const c = db.prepare(`SELECT org_id FROM clients WHERE id=?`).get(client_id);
    if (!c || c.org_id !== me.org_id) return res.status(403).json({ error: '無權限' });
  }

  // 生成唯一 8 碼大寫英數存取碼
  let code;
  for (let i = 0; i < 10; i++) {
    code = crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!db.prepare(`SELECT id FROM designer_access_codes WHERE code=?`).get(code)) break;
  }

  const r = db.prepare(`
    INSERT INTO designer_access_codes (client_id, code, pin, note, expires_at, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(client_id, code, pin, note || null, expires_at || null, me.id);

  res.json({ ok: true, id: r.lastInsertRowid, code });
});

router.patch('/codes/:id/toggle', requireAuth, (req, res) => {
  const me = req.session.user;
  const row = db.prepare(`
    SELECT dac.*, c.org_id FROM designer_access_codes dac
    LEFT JOIN clients c ON c.id=dac.client_id WHERE dac.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到存取碼' });
  if (me.role !== 'owner' && row.org_id !== me.org_id) return res.status(403).json({ error: '無權限' });
  db.prepare(`UPDATE designer_access_codes SET is_active=? WHERE id=?`).run(row.is_active ? 0 : 1, row.id);
  res.json({ ok: true, is_active: row.is_active ? 0 : 1 });
});

router.delete('/codes/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const row = db.prepare(`
    SELECT dac.*, c.org_id FROM designer_access_codes dac
    LEFT JOIN clients c ON c.id=dac.client_id WHERE dac.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到存取碼' });
  if (me.role !== 'owner' && row.org_id !== me.org_id) return res.status(403).json({ error: '無權限' });
  db.prepare(`DELETE FROM designer_access_codes WHERE id=?`).run(row.id);
  res.json({ ok: true });
});

module.exports = router;
