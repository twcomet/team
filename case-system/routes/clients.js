const express = require('express');
const db = require('../db');
const { requireAuth, orgFilter } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const filter = orgFilter(me);
  const clients = filter.org_id
    ? db.prepare(`SELECT * FROM clients WHERE org_id = ? ORDER BY name`).all(filter.org_id)
    : db.prepare(`SELECT c.*, o.name as org_name FROM clients c LEFT JOIN orgs o ON c.org_id = o.id ORDER BY c.name`).all();
  res.json(clients);
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { name, phone, email, address, source, discount, notes } = req.body;
  if (!name) return res.status(400).json({ error: '請填入客戶姓名' });
  const result = db.prepare(`
    INSERT INTO clients (org_id, name, phone, email, address, source, discount, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(me.org_id, name, phone ?? null, email ?? null, address ?? null,
         source ?? null, discount ?? 1.0, notes ?? null, me.id);
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/:id', requireAuth, (req, res) => {
  const { name, phone, email, address, source, discount, notes } = req.body;
  db.prepare(`UPDATE clients SET name=?, phone=?, email=?, address=?, source=?, discount=?, notes=? WHERE id=?`)
    .run(name, phone ?? null, email ?? null, address ?? null, source ?? null, discount ?? 1.0, notes ?? null, req.params.id);
  res.json({ ok: true });
});

router.get('/:id/cases', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.final_price, c.payment_status, c.scheduled_date
    FROM cases c WHERE c.client_id = ? ORDER BY c.created_at DESC
  `).all(req.params.id);
  res.json(cases);
});

module.exports = router;
