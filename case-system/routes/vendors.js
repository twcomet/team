const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');

// GET /api/vendors — 列出所有廠商（含停用，owner 才看得到停用的）
router.get('/', requireAuth, (req, res) => {
  const isOwner = req.session.user.role === 'owner';
  const rows = db.prepare(
    `SELECT * FROM vendors ${isOwner ? '' : 'WHERE active=1'} ORDER BY name`
  ).all();
  res.json(rows);
});

// GET /api/vendors/:id — 單一廠商
router.get('/:id', requireAuth, (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  res.json(v);
});

// POST /api/vendors — 新增廠商
router.post('/', requireAuth, (req, res) => {
  const { name, category, contact, phone, email,
          bank_name, bank_account, bank_branch, payment_terms, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填入廠商名稱' });
  try {
    const r = db.prepare(`
      INSERT INTO vendors (name, category, contact, phone, email, bank_name, bank_account, bank_branch, payment_terms, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), category||null, contact||null, phone||null, email||null,
           bank_name||null, bank_account||null, bank_branch||null, payment_terms||null, notes||null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '廠商名稱已存在' });
    throw e;
  }
});

// PUT /api/vendors/:id — 更新廠商
router.put('/:id', requireAuth, (req, res) => {
  const { name, category, contact, phone, email,
          bank_name, bank_account, bank_branch, payment_terms, notes, active } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填入廠商名稱' });
  try {
    db.prepare(`
      UPDATE vendors SET name=?, category=?, contact=?, phone=?, email=?,
        bank_name=?, bank_account=?, bank_branch=?, payment_terms=?, notes=?, active=?
      WHERE id=?
    `).run(name.trim(), category||null, contact||null, phone||null, email||null,
           bank_name||null, bank_account||null, bank_branch||null, payment_terms||null,
           notes||null, active??1, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '廠商名稱已存在' });
    throw e;
  }
});

// DELETE /api/vendors/:id — 停用廠商
router.delete('/:id', requireOwner, (req, res) => {
  db.prepare(`UPDATE vendors SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
