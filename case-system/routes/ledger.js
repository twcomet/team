const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner, orgFilterSQL } = require('../middleware/auth');
const router = express.Router();

const log = (uid, action, entity, eid, detail) =>
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`).run(uid, action, entity, eid ?? null, detail ?? null);

// ── 會計科目 CRUD ─────────────────────────────────────────────

// GET /api/ledger/categories
router.get('/categories', requireAuth, (req, res) => {
  const isOwner = req.session.user.role === 'owner';
  const rows = isOwner
    ? db.prepare(`SELECT * FROM ledger_categories ORDER BY section, sort_order, id`).all()
    : db.prepare(`SELECT * FROM ledger_categories WHERE sensitive=0 ORDER BY section, sort_order, id`).all();
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
  const { name, section, sort_order, active, sensitive, product_line } = req.body;
  db.prepare(`UPDATE ledger_categories SET name=?, section=?, sort_order=?, active=?, sensitive=?, product_line=? WHERE id=?`)
    .run(name, section, sort_order ?? 0, active ?? 1, sensitive ?? 0, product_line ?? null, req.params.id);
  res.json({ ok: true });
});

// PATCH /api/ledger/categories/:id/reorder  (owner only)
router.patch('/categories/:id/reorder', requireOwner, (req, res) => {
  const { direction } = req.body;
  const cat = db.prepare(`SELECT * FROM ledger_categories WHERE id=?`).get(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  const all = db.prepare(`SELECT id FROM ledger_categories WHERE section=? ORDER BY sort_order, id`).all(cat.section);
  const upd = db.prepare(`UPDATE ledger_categories SET sort_order=? WHERE id=?`);
  all.forEach((c, i) => upd.run(i * 10, c.id)); // normalize
  const idx = all.findIndex(c => c.id === cat.id);
  if (direction === 'up' && idx > 0) {
    upd.run((idx - 1) * 10, cat.id);
    upd.run(idx * 10, all[idx - 1].id);
  } else if (direction === 'down' && idx < all.length - 1) {
    upd.run((idx + 1) * 10, cat.id);
    upd.run(idx * 10, all[idx + 1].id);
  }
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
  const p = user.permissions || {};
  const canLedger = user.role === 'owner' ||
    (p.page_ledger !== undefined ? p.page_ledger === true : p.page_payments === true);
  if (!canLedger) return res.status(403).json({ error: '無收支流水帳權限' });
  const { from, to, type } = req.query;
  const { sql: orgSql, params: orgPs } = orgFilterSQL(user, 'l.org_id');
  const isOwner = user.role === 'owner';

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

  if (!isOwner) {
    // 非老闆：過濾私密科目和隱藏筆記
    sql += ` AND l.category NOT IN (SELECT name FROM ledger_categories WHERE sensitive=1)`;
    sql += ` AND (l.hidden IS NULL OR l.hidden = 0)`;
  }

  // 非跨分店角色只能看自己的 org
  if (orgSql) {
    sql += ` AND ${orgSql}`; params.push(...orgPs);
  } else if (req.query.org_id) {
    sql += ' AND l.org_id = ?'; params.push(req.query.org_id);
  }

  if (from)                  { sql += ' AND l.date >= ?';       params.push(from); }
  if (to)                    { sql += ' AND l.date <= ?';       params.push(to);   }
  if (type)                  { sql += ' AND l.type = ?';        params.push(type); }
  if (req.query.pay_status)  { sql += ' AND l.pay_status = ?'; params.push(req.query.pay_status); }

  sql += ' ORDER BY l.date DESC, l.id DESC';
  res.json(db.prepare(sql).all(...params));
});

// POST /api/ledger
router.post('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { date, type, category, amount, case_id, description, org_id, hidden, pay_status, pay_due_date, paid_note } = req.body;
  if (!date || !type || !category || !amount) return res.status(400).json({ error: '必填欄位不完整' });
  const isPaid   = pay_status !== 'pending' && !!paid_note;
  const paid_at  = isPaid ? date : null;
  const r = db.prepare(`
    INSERT INTO ledger_entries (date, type, category, amount, case_id, description, org_id, created_by, hidden, pay_status, pay_due_date, paid_note, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, type, category, Number(amount), case_id || null, description || null, org_id || null, uid,
         hidden ? 1 : 0, pay_status || null, pay_due_date || null, paid_note || null, paid_at);
  log(uid, 'create', 'ledger', r.lastInsertRowid, `${date} ${category} $${amount}`);
  res.json({ id: r.lastInsertRowid });
});

// PUT /api/ledger/:id
router.put('/:id', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { date, type, category, amount, case_id, description, org_id, hidden, pay_status, pay_due_date, paid_note } = req.body;
  const existing = db.prepare(`SELECT paid_at FROM ledger_entries WHERE id=?`).get(req.params.id);
  const paid_at  = (pay_status !== 'pending' && paid_note && !existing?.paid_at) ? date : (existing?.paid_at || null);
  db.prepare(`
    UPDATE ledger_entries SET date=?, type=?, category=?, amount=?, case_id=?, description=?, org_id=?, hidden=?, pay_status=?, pay_due_date=?, paid_note=?, paid_at=?
    WHERE id=?
  `).run(date, type, category, Number(amount), case_id || null, description || null, org_id || null,
         hidden ? 1 : 0, pay_status || null, pay_due_date || null, paid_note || null, paid_at, req.params.id);
  log(uid, 'update', 'ledger', req.params.id, `${date} ${category} $${amount}`);
  res.json({ ok: true });
});

// PATCH /api/ledger/:id/pay  — 標記已付款（owner only）
router.patch('/:id/pay', requireOwner, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { paid_note } = req.body;
  db.prepare(`UPDATE ledger_entries SET pay_status='paid', paid_at=?, paid_note=? WHERE id=?`)
    .run(today, paid_note || null, req.params.id);
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

// POST /api/ledger/scan — 用 Claude Vision 辨識收據圖片
router.post('/scan', requireAuth, async (req, res) => {
  const { image_base64, mime_type } = req.body;
  if (!image_base64 || !mime_type) return res.status(400).json({ error: 'missing image' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime_type, data: image_base64 } },
            { type: 'text', text: '請從這張收據/發票/單據圖片提取帳務資訊，僅回傳 JSON（不含其他說明文字）：\n{"date":"YYYY-MM-DD","amount":數字,"type":"income或expense","description":"一句話說明","category_hint":"科目關鍵字"}\n\n規則：收款單/發票/入帳=income；支出收據/費用單=expense。日期轉為台灣本地日期 YYYY-MM-DD 格式。無法判斷的欄位填 null。' }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return res.status(502).json({ error: `AI API error ${response.status}`, detail: errBody.slice(0, 300) });
    }
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'parse error' });
    res.json(JSON.parse(match[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
