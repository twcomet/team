const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const router = express.Router();

// GET / — 列出全部膜料
router.get('/', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const rows = db.prepare(`SELECT * FROM materials WHERE org_id = ? ORDER BY brand, model`).all(org_id);
  res.json(rows);
});

// POST / — 新增
router.post('/', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const { brand, model, color, spec, unit_cost, unit_price, stock_meters, notes } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });
  const r = db.prepare(`
    INSERT INTO materials (org_id, brand, model, color, spec, unit_cost, unit_price, stock_meters, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(org_id, brand, model, color || null, spec || null,
         unit_cost || 0, unit_price || 0, stock_meters || 0, notes || null);
  res.json({ id: r.lastInsertRowid });
});

// PUT /:id — 更新
router.put('/:id', requireAuth, (req, res) => {
  const { brand, model, color, spec, unit_cost, unit_price, stock_meters, notes } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });
  db.prepare(`
    UPDATE materials SET brand=?, model=?, color=?, spec=?, unit_cost=?, unit_price=?, stock_meters=?, notes=?
    WHERE id=? AND org_id=?
  `).run(brand, model, color || null, spec || null,
         unit_cost || 0, unit_price || 0, stock_meters || 0, notes || null,
         req.params.id, req.session.user.org_id);
  res.json({ ok: true });
});

// DELETE /:id
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM materials WHERE id=? AND org_id=?`)
    .run(req.params.id, req.session.user.org_id);
  res.json({ ok: true });
});

// PATCH /:id/stock — 調整庫存
router.patch('/:id/stock', requireAuth, (req, res) => {
  const { delta } = req.body; // 正數=入庫, 負數=出庫
  db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters + ?) WHERE id=? AND org_id=?`)
    .run(delta || 0, req.params.id, req.session.user.org_id);
  res.json({ ok: true });
});

module.exports = router;
