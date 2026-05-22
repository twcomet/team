const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 收入類別
const INCOME_CATEGORIES  = ['施工款','訂金','尾款','材料銷售','其他收入'];
// 支出類別
const EXPENSE_CATEGORIES = ['材料費','人工費（外包）','油資/交通','工具耗材','水電費','租金','廣告費','辦公費','稅費','其他支出'];

// GET /api/ledger?from=&to=&type=&org_id=
router.get('/', requireAuth, (req, res) => {
  const { from, to, type, org_id } = req.query;
  let sql = `
    SELECT l.*, u.name as created_by_name, c.case_number, c.title as case_title
    FROM ledger_entries l
    LEFT JOIN users u ON l.created_by = u.id
    LEFT JOIN cases c ON l.case_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (from)   { sql += ' AND l.date >= ?'; params.push(from); }
  if (to)     { sql += ' AND l.date <= ?'; params.push(to); }
  if (type)   { sql += ' AND l.type = ?'; params.push(type); }
  if (org_id) { sql += ' AND l.org_id = ?'; params.push(org_id); }
  sql += ' ORDER BY l.date DESC, l.id DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/ledger/categories
router.get('/categories', requireAuth, (req, res) => {
  res.json({ income: INCOME_CATEGORIES, expense: EXPENSE_CATEGORIES });
});

// POST /api/ledger
router.post('/', requireAuth, (req, res) => {
  const { date, type, category, amount, case_id, description, org_id } = req.body;
  if (!date || !type || !category || !amount) return res.status(400).json({ error: '必填欄位不完整' });
  const r = db.prepare(`
    INSERT INTO ledger_entries (date, type, category, amount, case_id, description, org_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, type, category, Number(amount), case_id || null, description || null, org_id || null, req.session.user.id);
  res.json({ id: r.lastInsertRowid });
});

// PUT /api/ledger/:id
router.put('/:id', requireAuth, (req, res) => {
  const { date, type, category, amount, case_id, description, org_id } = req.body;
  db.prepare(`
    UPDATE ledger_entries SET date=?, type=?, category=?, amount=?, case_id=?, description=?, org_id=?
    WHERE id=?
  `).run(date, type, category, Number(amount), case_id || null, description || null, org_id || null, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/ledger/:id
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM ledger_entries WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
