const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const router = express.Router();

// 取得所有組織
router.get('/', requireAuth, (req, res) => {
  const orgs = db.prepare(`SELECT * FROM orgs ORDER BY type DESC, name`).all();
  res.json(orgs);
});

// 新增分店（僅 owner）
router.post('/', requireOwner, (req, res) => {
  const { name, type, address, phone } = req.body;
  if (!name || !type) return res.status(400).json({ error: '請填入名稱與類型' });
  const result = db.prepare(`INSERT INTO orgs (name, type, address, phone) VALUES (?, ?, ?, ?)`)
    .run(name, type, address ?? null, phone ?? null);
  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?, 'create_org', 'orgs', ?, ?)`)
    .run(req.session.user.id, result.lastInsertRowid, `新增組織：${name}`);
  res.json({ ok: true, id: result.lastInsertRowid });
});

// 修改組織
router.put('/:id', requireOwner, (req, res) => {
  const { name, address, phone, active } = req.body;
  db.prepare(`UPDATE orgs SET name=?, address=?, phone=?, active=? WHERE id=?`)
    .run(name, address ?? null, phone ?? null, active ?? 1, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
