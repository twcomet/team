const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner, orgFilter } = require('../middleware/auth');
const router = express.Router();

const log = (uid, action, entity, eid, detail) =>
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`).run(uid, action, entity, eid ?? null, detail ?? null);

// ── 會計科目 CRUD ─────────────────────────────────────────────

// GET /api/ledger/categories
router.get('/categories', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM ledger_categories ORDER BY type, sort_order, id`).all();
  res.json(rows);
});

// POST /api/ledger/categories  (owner only)
router.post('/categories', requireOwner, (req, res) => {
  const { type, name, section } = req.body;
  if (!type || !name?.trim()) return res.status(400).json({ error: '必填欄位不完整' });
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order),0) m FROM ledger_categories WHERE section=?`).get(section || type).m;
  const r = db.prepare(`INSERT INTO ledger_categories (type, section, name, sort_order) VALUES (?, ?, ?, ?)`)
    .run(type, section || type, name.trim(), maxOrder + 1);
  res.json({ id: r.lastInsertRowid });
});

// PUT /api/ledger/categories/:id  (owner only)
router.put('/categories/:id', requireOwner, (req, res) => {
  const { name, section, sort_order, active } = req.body;
  db.prepare(`UPDATE ledger_categories SET name=?, section=?, sort_order=?, active=? WHERE id=?`)
    .run(name, section, sort_order ?? 0, active ?? 1, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/ledger/categories/:id  (owner only)
router.delete('/categories/:id', requireOwner, (req, res) => {
  db.prepare(`DELETE FROM ledger_categories WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 流水帳 CRUD ───────────────────────────────────────────────

// GET /api/ledger?from=&to=&type=&org_id=
router.get('/', requireAuth, (req, res) => {
  const user = req.session.user;
  const { from, to, type } = req.query;
  const orgRestrict = orgFilter(user);

  let sql = `
    SELECT l.*, u.name as created_by_name, c.case_number, c.title as case_title,
           o.name as org_name
    FROM ledger_entries l
    LEFT JOIN users u ON l.created_by = u.id
    LEFT JOIN cases c ON l.case_id = c.id
    LEFT JOIN orgs  o ON l.org_id  = o.id
    WHERE 1=1
  `;
  const params = [];

  // 非跨分店角色只能看自己的 org
  if (orgRestrict.org_id) {
    sql += ' AND l.org_id = ?'; params.push(orgRestrict.org_id);
  } else if (req.query.org_id) {
    sql += ' AND l.org_id = ?'; params.push(req.query.org_id);
  }

  if (from) { sql += ' AND l.date >= ?'; params.push(from); }
  if (to)   { sql += ' AND l.date <= ?'; params.push(to);   }
  if (type) { sql += ' AND l.type = ?';  params.push(type); }

  sql += ' ORDER BY l.date DESC, l.id DESC';
  res.json(db.prepare(sql).all(...params));
});

// POST /api/ledger
router.post('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { date, type, category, amount, case_id, description, org_id } = req.body;
  if (!date || !type || !category || !amount) return res.status(400).json({ error: '必填欄位不完整' });
  const r = db.prepare(`
    INSERT INTO ledger_entries (date, type, category, amount, case_id, description, org_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, type, category, Number(amount), case_id || null, description || null, org_id || null, uid);
  log(uid, 'create', 'ledger', r.lastInsertRowid, `${date} ${category} $${amount}`);
  res.json({ id: r.lastInsertRowid });
});

// PUT /api/ledger/:id
router.put('/:id', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { date, type, category, amount, case_id, description, org_id } = req.body;
  db.prepare(`
    UPDATE ledger_entries SET date=?, type=?, category=?, amount=?, case_id=?, description=?, org_id=?
    WHERE id=?
  `).run(date, type, category, Number(amount), case_id || null, description || null, org_id || null, req.params.id);
  log(uid, 'update', 'ledger', req.params.id, `${date} ${category} $${amount}`);
  res.json({ ok: true });
});

// DELETE /api/ledger/:id
router.delete('/:id', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const entry = db.prepare(`SELECT date,category,amount FROM ledger_entries WHERE id=?`).get(req.params.id);
  db.prepare(`DELETE FROM ledger_entries WHERE id=?`).run(req.params.id);
  if (entry) log(uid, 'delete', 'ledger', req.params.id, `${entry.date} ${entry.category} $${entry.amount}`);
  res.json({ ok: true });
});

module.exports = router;
