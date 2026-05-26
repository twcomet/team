const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

// ── 列表（含分頁、狀態篩選、關鍵字搜尋）──────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { status, q, page = 1, limit = 40 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const where  = [];
  const params = [];
  if (!status || status === 'all') {
    where.push(`i.status IN ('new','in_progress')`);
  } else {
    where.push(`i.status=?`); params.push(status);
  }
  if (q) {
    where.push(`(i.display_name LIKE ? OR i.last_message LIKE ? OR i.staff_note LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const ws = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) as n FROM line_inquiries i ${ws}`).get(...params)?.n || 0;
  const rows  = db.prepare(`
    SELECT i.*,
           c.phone, c.email, c.address,
           cc.case_number AS converted_case_number,
           su.name AS sales_name,
           cu.name AS cs_name
    FROM line_inquiries i
    LEFT JOIN clients c  ON i.client_id = c.id
    LEFT JOIN cases   cc ON i.converted_case_id = cc.id
    LEFT JOIN users   su ON i.sales_id = su.id
    LEFT JOIN users   cu ON i.cs_id = cu.id
    ${ws}
    ORDER BY i.last_message_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({ rows, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── 狀態統計（用於 badge）────────────────────────────────────
router.get('/stats', requireAuth, (req, res) => {
  const raw = db.prepare(`SELECT status, COUNT(*) as cnt FROM line_inquiries GROUP BY status`).all();
  const s   = { new: 0, in_progress: 0, converted: 0, invalid: 0, hidden: 0 };
  raw.forEach(r => { s[r.status] = r.cnt; });
  res.json(s);
});

// ── 單筆詳情 + 對話記錄 ──────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const inq = db.prepare(`
    SELECT i.*, c.phone, c.email, c.address,
           cc.case_number AS converted_case_number,
           su.name AS sales_name, su.id AS sales_id_val,
           cu.name AS cs_name,    cu.id AS cs_id_val
    FROM line_inquiries i
    LEFT JOIN clients c  ON i.client_id = c.id
    LEFT JOIN cases   cc ON i.converted_case_id = cc.id
    LEFT JOIN users   su ON i.sales_id = su.id
    LEFT JOIN users   cu ON i.cs_id = cu.id
    WHERE i.id=?
  `).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });

  const messages = db.prepare(`
    SELECT m.*, u.name AS sender_name
    FROM line_inquiry_messages m
    LEFT JOIN users u ON m.sent_by = u.id
    WHERE m.inquiry_id=?
    ORDER BY m.created_at ASC
  `).all(req.params.id);

  res.json({ ...inq, messages });
});

// ── 指派負責業務 / 負責客服 ───────────────────────────────────
router.put('/:id/assign', requireAuth, (req, res) => {
  const { sales_id, cs_id } = req.body;
  db.prepare(`UPDATE line_inquiries SET sales_id=?, cs_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(sales_id || null, cs_id || null, req.params.id);
  res.json({ ok: true });
});

// ── 更新狀態 ─────────────────────────────────────────────────
router.put('/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  if (!['new', 'in_progress', 'invalid', 'hidden'].includes(status))
    return res.status(400).json({ error: 'invalid status' });
  db.prepare(`UPDATE line_inquiries SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, req.params.id);
  res.json({ ok: true });
});

// ── 更新備註 ─────────────────────────────────────────────────
router.put('/:id/note', requireAuth, (req, res) => {
  const { note } = req.body;
  db.prepare(`UPDATE line_inquiries SET staff_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(note ?? null, req.params.id);
  res.json({ ok: true });
});

// ── 更新客戶資料 ──────────────────────────────────────────────
router.put('/:id/client', requireAuth, (req, res) => {
  const { name, phone, email, address } = req.body;
  const inq = db.prepare(`SELECT client_id FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });

  if (inq.client_id) {
    const cols = []; const vals = [];
    if (name    !== undefined) { cols.push('name=?');    vals.push(name); }
    if (phone   !== undefined) { cols.push('phone=?');   vals.push(phone); }
    if (email   !== undefined) { cols.push('email=?');   vals.push(email); }
    if (address !== undefined) { cols.push('address=?'); vals.push(address); }
    if (cols.length)
      db.prepare(`UPDATE clients SET ${cols.join(',')} WHERE id=?`).run(...vals, inq.client_id);
  }
  if (name)
    db.prepare(`UPDATE line_inquiries SET display_name=? WHERE id=?`).run(name, req.params.id);
  res.json({ ok: true });
});

// ── 轉換為案件 ───────────────────────────────────────────────
router.post('/:id/convert', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq)                    return res.status(404).json({ error: 'not found' });
  if (inq.status === 'converted') return res.status(400).json({ error: '已轉案' });

  const { case_type = 'other', title, notes } = req.body;
  const u   = req.session.user;
  const org = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const orgId = org?.id || null;

  // 產生案件編號
  const now    = new Date();
  const prefix = `HX${String(now.getFullYear()).slice(-2)}${String(now.getMonth()+1).padStart(2,'0')}`;
  const last   = db.prepare(`SELECT case_number FROM cases WHERE case_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  const seq    = last ? (parseInt(last.case_number.split('-')[1]) || 0) + 1 : 1;
  const caseNumber = `${prefix}-${String(seq).padStart(3,'0')}`;

  const r = db.prepare(`
    INSERT INTO cases (
      case_number, org_id, case_type, client_id,
      title, description, line_source, source_type,
      status, case_group, priority, created_by,
      sales_id, cs_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'line', 'inquiry', 'inquiry', 'normal', ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    caseNumber, orgId, case_type, inq.client_id,
    title || `LINE詢問｜${inq.display_name}`,
    notes || inq.last_message || '',
    inq.line_user_id, u.id,
    inq.sales_id || null, inq.cs_id || null
  );

  db.prepare(`
    UPDATE line_inquiries
    SET status='converted', converted_case_id=?, converted_at=CURRENT_TIMESTAMP,
        converted_by=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(r.lastInsertRowid, u.id, inq.id);

  res.json({ ok: true, case_id: r.lastInsertRowid, case_number: caseNumber });
});

// ── 透過 LINE 回覆客戶 ────────────────────────────────────────
router.post('/:id/reply', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '訊息不可空白' });

  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: 'LINE_CHANNEL_ACCESS_TOKEN 未設定' });

  const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: inq.line_user_id, messages: [{ type: 'text', text: message.trim() }] })
  });

  if (!pushRes.ok) {
    const err = await pushRes.text().catch(() => '');
    return res.status(502).json({ error: 'LINE API 錯誤', detail: err });
  }

  db.prepare(`
    INSERT INTO line_inquiry_messages (inquiry_id, direction, msg_type, content, sent_by)
    VALUES (?, 'out', 'text', ?, ?)
  `).run(inq.id, message.trim(), req.session.user.id);

  db.prepare(`UPDATE line_inquiries SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(inq.id);
  res.json({ ok: true });
});

// ── 刪除詢問（僅限已轉案 / 無效）────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT status, display_name FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });
  if (!['converted','invalid'].includes(inq.status))
    return res.status(400).json({ error: '只有已轉案或無效的詢問才可刪除' });
  db.prepare(`DELETE FROM line_inquiry_messages WHERE inquiry_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM line_inquiries WHERE id=?`).run(req.params.id);
  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
    .run(req.session.user.id, 'delete', 'line_inquiries', req.params.id, `刪除 LINE 詢問：${inq.display_name || ''}（${inq.status}）`);
  res.json({ ok: true });
});

module.exports = router;
