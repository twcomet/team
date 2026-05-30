const express = require('express');
const db = require('../db');
const { requireAuth, orgFilter } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const filter = orgFilter(me);
  const tags = filter.org_id
    ? db.prepare(`SELECT * FROM tags WHERE org_id = ? ORDER BY name`).all(filter.org_id)
    : db.prepare(`SELECT * FROM tags ORDER BY name`).all();
  res.json(tags);
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner') return res.status(403).json({ error: '僅限老闆可新增標籤' });
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: '請填入標籤名稱' });
  const result = db.prepare(`INSERT INTO tags (org_id, name, color) VALUES (?, ?, ?)`)
    .run(me.org_id, name.trim(), color || '#6b7280');
  res.json({ ok: true, id: result.lastInsertRowid, name: name.trim(), color: color || '#6b7280' });
});

router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner') return res.status(403).json({ error: '僅限老闆可刪除標籤' });
  db.prepare(`DELETE FROM tags WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

router.put('/client/:clientId', requireAuth, (req, res) => {
  const { tag_ids } = req.body;
  const cid = req.params.clientId;
  db.prepare(`DELETE FROM client_tags WHERE client_id = ?`).run(cid);
  if (tag_ids && tag_ids.length > 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO client_tags (client_id, tag_id) VALUES (?, ?)`);
    tag_ids.forEach(tid => ins.run(cid, tid));
  }
  res.json({ ok: true });
});

module.exports = router;
