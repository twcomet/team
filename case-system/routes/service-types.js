const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/service-types — 列出全部（含停用）
router.get('/', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM service_types ORDER BY sort_order, id`).all());
});

// GET /api/service-types/active — 只列啟用的（供報價頁下拉用）
router.get('/active', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM service_types WHERE is_active=1 ORDER BY sort_order, id`).all());
});

// POST /api/service-types — 新增（owner/manage_users）
router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.manage_users) return res.status(403).json({ error: '無權限' });
  const { name, sort_order } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請輸入施工類型名稱' });

  // 自動產生唯一 key（時間戳）
  const key = 'svc_' + Date.now();
  const r = db.prepare(`INSERT INTO service_types (key,name,sort_order) VALUES (?,?,?)`)
    .run(key, name.trim(), sort_order ?? 99);
  res.json({ ok: true, id: r.lastInsertRowid, key });
});

// PUT /api/service-types/:id — 改名稱 / 排序 / 啟停
router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.manage_users) return res.status(403).json({ error: '無權限' });
  const row = db.prepare(`SELECT * FROM service_types WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到' });

  const { name, sort_order, is_active } = req.body;
  db.prepare(`UPDATE service_types SET name=?, sort_order=?, is_active=? WHERE id=?`)
    .run(name ?? row.name, sort_order ?? row.sort_order, is_active ?? row.is_active, row.id);
  res.json({ ok: true });
});

// DELETE /api/service-types/:id — 軟刪（停用）
router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.manage_users) return res.status(403).json({ error: '無權限' });
  db.prepare(`UPDATE service_types SET is_active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
