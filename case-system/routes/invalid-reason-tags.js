const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const tags = db.prepare(`
    SELECT id, name, is_preset, org_id, created_at
    FROM invalid_reason_tags
    WHERE is_preset=1 OR org_id=?
    ORDER BY is_preset DESC, id ASC
  `).all(me.org_id);
  res.json(tags);
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填寫標籤名稱' });
  const r = db.prepare(`INSERT INTO invalid_reason_tags (org_id, name, is_preset, created_by) VALUES (?,?,0,?)`)
    .run(me.org_id, name.trim(), me.id);
  res.json({ id: r.lastInsertRowid, name: name.trim(), is_preset: 0, org_id: me.org_id });
});

router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const tag = db.prepare(`SELECT * FROM invalid_reason_tags WHERE id=?`).get(req.params.id);
  if (!tag) return res.status(404).json({ error: 'not found' });
  if (tag.is_preset) return res.status(400).json({ error: '系統預設標籤不可刪除' });
  if (tag.org_id !== me.org_id && !me.manage_users) return res.status(403).json({ error: '無權限' });
  db.prepare(`DELETE FROM invalid_reason_tags WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
