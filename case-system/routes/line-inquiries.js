const express = require('express');
const router  = express.Router();
const db      = require('../db');
const gdrive  = require('../lib/gdrive');
const { requireAuth } = require('../middleware/auth');

// ── 列表（含分頁、狀態篩選、關鍵字搜尋）──────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { status, q, page = 1, limit = 40 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const where  = [];
  const params = [];

  if (!status || status === 'all') {
    // 全部：只顯示活躍中的詢問
    where.push(`i.status IN ('new','in_progress')`);
  } else if (status === 'converted') {
    // 已轉案：排除案件已結案或已設為無效保存的
    where.push(`i.status='converted' AND (cc.status IS NULL OR cc.status NOT IN ('closed','invalid'))`);
  } else if (status === 'invalid') {
    // 無效：(1) 詢問本身標記無效 + (2) 已轉案但案件被設為無效保存
    where.push(`(i.status='invalid' OR (i.status='converted' AND cc.status='invalid'))`);
  } else if (status === 'case_closed') {
    // 結案：已轉案且對應案件已結案
    where.push(`(i.status='converted' AND cc.status='closed')`);
  } else {
    where.push(`i.status=?`); params.push(status);
  }

  if (q) {
    where.push(`(i.display_name LIKE ? OR i.last_message LIKE ? OR i.staff_note LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const ws = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`
    SELECT COUNT(*) as n FROM line_inquiries i
    LEFT JOIN cases cc ON i.converted_case_id = cc.id ${ws}
  `).get(...params)?.n || 0;

  const rows  = db.prepare(`
    SELECT i.*,
           c.phone, c.email, c.address,
           cc.case_number AS converted_case_number,
           cc.status      AS converted_case_status,
           su.name AS sales_name,
           cu.name AS cs_name,
           o.name  AS org_name,
           o.type  AS org_type,
           (SELECT m.direction FROM line_inquiry_messages m WHERE m.inquiry_id=i.id ORDER BY m.id DESC LIMIT 1) AS last_dir,
           COALESCE(cc.status,      (SELECT status      FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_status,
           COALESCE(cc.case_number, (SELECT case_number FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_number
    FROM line_inquiries i
    LEFT JOIN clients c  ON i.client_id = c.id
    LEFT JOIN cases   cc ON i.converted_case_id = cc.id
    LEFT JOIN users   su ON i.sales_id = su.id
    LEFT JOIN users   cu ON i.cs_id = cu.id
    LEFT JOIN orgs    o  ON i.org_id = o.id
    ${ws}
    ORDER BY i.last_message_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({ rows, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── 狀態統計（用於 badge）────────────────────────────────────
router.get('/stats', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN i.status='new'         THEN 1 ELSE 0 END) as new,
      SUM(CASE WHEN i.status='in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN i.status='converted'   AND (cc.status IS NULL OR cc.status NOT IN ('closed','invalid')) THEN 1 ELSE 0 END) as converted,
      SUM(CASE WHEN i.status='invalid'     OR  (i.status='converted' AND cc.status='invalid') THEN 1 ELSE 0 END) as invalid,
      SUM(CASE WHEN i.status='hidden'      THEN 1 ELSE 0 END) as hidden,
      SUM(CASE WHEN i.status='converted'   AND cc.status='closed' THEN 1 ELSE 0 END) as case_closed,
      SUM(CASE WHEN i.status IN ('new','in_progress')
                AND (SELECT m.direction FROM line_inquiry_messages m WHERE m.inquiry_id=i.id ORDER BY m.id DESC LIMIT 1)='in'
               THEN 1 ELSE 0 END) as awaiting
    FROM line_inquiries i
    LEFT JOIN cases cc ON i.converted_case_id = cc.id
  `).get();
  res.json({
    new:         row.new         || 0,
    in_progress: row.in_progress || 0,
    converted:   row.converted   || 0,
    invalid:     row.invalid     || 0,
    hidden:      row.hidden      || 0,
    case_closed: row.case_closed || 0,
    awaiting:    row.awaiting     || 0,
  });
});

// ── 單筆詳情 + 對話記錄 ──────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const inq = db.prepare(`
    SELECT i.*, c.phone, c.email, c.address,
           cc.case_number AS converted_case_number,
           su.name AS sales_name, su.id AS sales_id_val,
           cu.name AS cs_name,    cu.id AS cs_id_val,
           o.name  AS org_name,
           o.type  AS org_type,
           COALESCE(cc.status,      (SELECT status      FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_status,
           COALESCE(cc.case_number, (SELECT case_number FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_number
    FROM line_inquiries i
    LEFT JOIN clients c  ON i.client_id = c.id
    LEFT JOIN cases   cc ON i.converted_case_id = cc.id
    LEFT JOIN users   su ON i.sales_id = su.id
    LEFT JOIN users   cu ON i.cs_id = cu.id
    LEFT JOIN orgs    o  ON i.org_id = o.id
    WHERE i.id=?
  `).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });

  const messages = db.prepare(`
    SELECT m.*, u.name AS sender_name
    FROM line_inquiry_messages m
    LEFT JOIN users u ON m.sent_by = u.id
    WHERE m.inquiry_id=?
    ORDER BY m.created_at ASC, m.id ASC
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
      sales_id, cs_id, line_display_name, line_official_name, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'line', 'inquiry', 'inquiry', 'normal', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    caseNumber, orgId, case_type, inq.client_id,
    title || inq.display_name || '（未命名）',
    notes || inq.last_message || '',
    inq.line_user_id, u.id,
    inq.sales_id || null, inq.cs_id || null,
    inq.display_name || null, inq.display_name || null
  );

  db.prepare(`
    UPDATE line_inquiries
    SET status='converted', converted_case_id=?, converted_at=CURRENT_TIMESTAMP,
        converted_by=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(r.lastInsertRowid, u.id, inq.id);

  gdrive.safeEnsureCaseFolder(r.lastInsertRowid); // LINE 詢問轉案件也自動建雲端資料夾（best-effort，不阻塞）

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

  // 送出後清掉 AI 草稿（已由真人處理）
  db.prepare(`UPDATE line_inquiries SET updated_at=CURRENT_TIMESTAMP, ai_draft=NULL, ai_draft_at=NULL, ai_needs_human=0, ai_needs_human_reason=NULL WHERE id=?`).run(inq.id);
  res.json({ ok: true });
});

// ── 產生 / 重新產生 AI 建議回覆（草稿模式，不會傳給客人）──────────
router.post('/:id/ai-draft', requireAuth, async (req, res) => {
  try {
    const { generateInquiryDraft } = require('../lib/line-ai');
    const result = await generateInquiryDraft(req.params.id);
    if (!result) return res.status(400).json({ error: '此詢問最後一則不是客人的訊息，或沒有訊息可擬稿' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'AI 擬稿失敗：' + e.message });
  }
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
