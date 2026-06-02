const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function isHR(u) {
  return u.role === 'owner' || u.role === 'hq_hr' || !!u.manage_users;
}

function notifyHR(ticketId, fromName, ticketTitle) {
  const hrs = db.prepare(`SELECT id FROM users WHERE role IN ('owner','hq_hr') AND active=1`).all();
  const ins = db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'feedback','feedback_tickets',?,?)`);
  for (const h of hrs) {
    ins.run(h.id, `${fromName} 新增申訴/回饋`, ticketTitle, ticketId, '/feedback');
  }
}

// ── 列表 ──────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, category } = req.query;
  let sql = `
    SELECT t.*, u.name AS user_name,
           (SELECT COUNT(*) FROM feedback_replies r WHERE r.ticket_id = t.id) AS reply_count,
           (SELECT MAX(r.created_at) FROM feedback_replies r WHERE r.ticket_id = t.id) AS last_reply_at
    FROM feedback_tickets t
    JOIN users u ON u.id = t.user_id
    WHERE 1=1
  `;
  const params = [];
  if (!isHR(me)) { sql += ` AND t.user_id = ?`; params.push(me.id); }
  if (status)   { sql += ` AND t.status = ?`;   params.push(status); }
  if (category) { sql += ` AND t.category = ?`; params.push(category); }
  sql += ` ORDER BY t.updated_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

// ── 取得單一案件（含對話紀錄）────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const ticket = db.prepare(`
    SELECT t.*, u.name AS user_name
    FROM feedback_tickets t JOIN users u ON u.id = t.user_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: '找不到此案件' });
  if (ticket.user_id !== me.id && !isHR(me)) return res.status(403).json({ error: '無權限' });

  const replies = db.prepare(`
    SELECT r.*, u.name AS user_name, u.role AS user_role
    FROM feedback_replies r JOIN users u ON u.id = r.user_id
    WHERE r.ticket_id = ? ORDER BY r.created_at ASC
  `).all(req.params.id);

  res.json({ ticket, replies });
});

// ── 新增案件 ──────────────────────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const { category = 'feedback', title, content } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: '請填寫主旨' });
  if (!content?.trim()) return res.status(400).json({ error: '請填寫內容' });
  const allowed = ['appeal', 'feedback', 'other'];
  if (!allowed.includes(category)) return res.status(400).json({ error: '無效類別' });

  const r = db.prepare(`
    INSERT INTO feedback_tickets (user_id, category, title, content)
    VALUES (?, ?, ?, ?)
  `).run(req.session.user.id, category, title.trim(), content.trim());

  const user = db.prepare(`SELECT name FROM users WHERE id=?`).get(req.session.user.id);
  notifyHR(r.lastInsertRowid, user?.name || '員工', title.trim());

  res.json({ ok: true, id: r.lastInsertRowid });
});

// ── 新增回覆 ──────────────────────────────────────────────────────────────────
router.post('/:id/reply', requireAuth, (req, res) => {
  const me = req.session.user;
  const ticket = db.prepare(`SELECT * FROM feedback_tickets WHERE id = ?`).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: '找不到此案件' });
  if (ticket.user_id !== me.id && !isHR(me)) return res.status(403).json({ error: '無權限' });
  if (ticket.status === 'resolved') return res.status(400).json({ error: '已結案的案件無法再回覆' });

  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: '請填寫回覆內容' });

  db.prepare(`INSERT INTO feedback_replies (ticket_id, user_id, content) VALUES (?,?,?)`)
    .run(req.params.id, me.id, content.trim());
  db.prepare(`UPDATE feedback_tickets SET updated_at=CURRENT_TIMESTAMP, status=CASE WHEN status='open' THEN 'in_progress' ELSE status END WHERE id=?`)
    .run(req.params.id);

  // 通知對方有新回覆
  const user = db.prepare(`SELECT name FROM users WHERE id=?`).get(me.id);
  if (isHR(me) && ticket.user_id !== me.id) {
    // HR 回覆 → 通知提案員工
    db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'feedback','feedback_tickets',?,?)`)
      .run(ticket.user_id, `${user?.name} 回覆了您的案件`, ticket.title, ticket.id, '/feedback');
  } else if (!isHR(me)) {
    // 員工回覆 → 通知 HR
    notifyHR(ticket.id, user?.name || '員工', `${ticket.title}（員工補充說明）`);
  }

  res.json({ ok: true });
});

// ── 更新狀態（HR only）────────────────────────────────────────────────────────
router.patch('/:id/status', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isHR(me)) return res.status(403).json({ error: '無權限' });
  const { status } = req.body;
  const allowed = ['open', 'in_progress', 'resolved'];
  if (!allowed.includes(status)) return res.status(400).json({ error: '無效狀態' });

  const ticket = db.prepare(`SELECT user_id, title FROM feedback_tickets WHERE id = ?`).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: '找不到此案件' });

  db.prepare(`UPDATE feedback_tickets SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, req.params.id);

  if (status === 'resolved') {
    db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'feedback','feedback_tickets',?,?)`)
      .run(ticket.user_id, '您的案件已結案', ticket.title, req.params.id, '/feedback');
  }

  res.json({ ok: true });
});

module.exports = router;
