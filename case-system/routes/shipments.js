const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// 寄件管理全員開放：所有登入者皆可使用
function canShip(req, res, next) { return next(); }

// GET / — 列出所有寄件紀錄
router.get('/', requireAuth, canShip, (req, res) => {
  const { org_id } = req.session.user;
  const year = req.query.year ? parseInt(req.query.year) : null;
  let where = 'WHERE s.org_id=?';
  const params = [org_id];
  if (year) { where += ` AND strftime('%Y', s.shipped_at)=?`; params.push(String(year)); }
  const rows = db.prepare(`
    SELECT s.*,
      c.case_number, c.title AS case_title,
      u.name AS created_by_name
    FROM shipments s
    LEFT JOIN cases c ON c.id = s.case_id
    LEFT JOIN users u ON u.id = s.created_by
    ${where}
    ORDER BY s.shipped_at DESC, s.id DESC
  `).all(...params);
  res.json(rows);
});

// GET /years — 取得有紀錄的年份清單
router.get('/years', requireAuth, canShip, (req, res) => {
  const { org_id } = req.session.user;
  const years = db.prepare(`
    SELECT DISTINCT strftime('%Y', shipped_at) AS year
    FROM shipments WHERE org_id=? AND shipped_at IS NOT NULL
    ORDER BY year DESC
  `).all(org_id).map(r => r.year);
  res.json(years);
});

// GET /:id — 單筆（編輯頁用）
router.get('/:id', requireAuth, canShip, (req, res) => {
  const { org_id } = req.session.user;
  const row = db.prepare(`
    SELECT s.*, c.case_number, c.title AS case_title
    FROM shipments s
    LEFT JOIN cases c ON c.id = s.case_id
    WHERE s.id=? AND s.org_id=?
  `).get(req.params.id, org_id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// POST / — 新增
router.post('/', requireAuth, canShip, (req, res) => {
  const { org_id, id: uid } = req.session.user;
  const { shipped_at, client_name, line_id_name, case_id,
          recipient_name, recipient_phone, postal_code, recipient_address,
          recipient_note, content, tracking_no, carrier } = req.body;
  const r = db.prepare(`
    INSERT INTO shipments (shipped_at, client_name, line_id_name, case_id,
      recipient_name, recipient_phone, postal_code, recipient_address, recipient_note,
      content, tracking_no, carrier, org_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(shipped_at||null, client_name||null, line_id_name||null, case_id||null,
         recipient_name||null, recipient_phone||null, postal_code||null, recipient_address||null,
         recipient_note||null, content||null, tracking_no||null, carrier||null, org_id, uid);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// PUT /:id — 修改
router.put('/:id', requireAuth, canShip, (req, res) => {
  const { org_id } = req.session.user;
  const { shipped_at, client_name, line_id_name, case_id,
          recipient_name, recipient_phone, postal_code, recipient_address,
          recipient_note, content, tracking_no, carrier } = req.body;
  db.prepare(`
    UPDATE shipments SET shipped_at=?, client_name=?, line_id_name=?, case_id=?,
      recipient_name=?, recipient_phone=?, postal_code=?, recipient_address=?, recipient_note=?,
      content=?, tracking_no=?, carrier=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND org_id=?
  `).run(shipped_at||null, client_name||null, line_id_name||null, case_id||null,
         recipient_name||null, recipient_phone||null, postal_code||null, recipient_address||null,
         recipient_note||null, content||null, tracking_no||null, carrier||null,
         req.params.id, org_id);
  res.json({ ok: true });
});

// DELETE /:id — 刪除
router.delete('/:id', requireAuth, canShip, (req, res) => {
  const { org_id } = req.session.user;
  db.prepare(`DELETE FROM shipments WHERE id=? AND org_id=?`).run(req.params.id, org_id);
  res.json({ ok: true });
});

module.exports = router;
