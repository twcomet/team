const express = require('express');
const db = require('../db');
const { requireAuth, orgFilter } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const filter = orgFilter(me);
  const cats = filter.org_id
    ? db.prepare(`SELECT * FROM client_categories WHERE org_id = ? ORDER BY name`).all(filter.org_id)
    : db.prepare(`SELECT * FROM client_categories ORDER BY name`).all();
  res.json(cats);
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner') return res.status(403).json({ error: '僅限老闆可新增分類' });
  const { name, discount_rate, notes } = req.body;
  if (!name) return res.status(400).json({ error: '請填入分類名稱' });
  const result = db.prepare(`INSERT INTO client_categories (org_id, name, discount_rate, notes) VALUES (?, ?, ?, ?)`)
    .run(me.org_id, name.trim(), discount_rate ?? 1.0, notes ?? null);
  res.json({ ok: true, id: result.lastInsertRowid, name: name.trim(), discount_rate: discount_rate ?? 1.0 });
});

router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner') return res.status(403).json({ error: '僅限老闆可修改分類' });
  const { name, discount_rate, notes } = req.body;
  db.prepare(`UPDATE client_categories SET name=?, discount_rate=?, notes=? WHERE id=?`)
    .run(name, discount_rate ?? 1.0, notes ?? null, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner') return res.status(403).json({ error: '僅限老闆可刪除分類' });
  db.prepare(`UPDATE clients SET category_id=NULL WHERE category_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM client_categories WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
