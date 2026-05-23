const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// GET /api/notifications  → 取得目前登入者的通知（最近 50 筆）
router.get('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const rows = db.prepare(`
    SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50
  `).all(uid);
  const unread = db.prepare(`SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0`).get(uid).n;
  res.json({ notifications: rows, unread });
});

// PUT /api/notifications/read-all
router.put('/read-all', requireAuth, (req, res) => {
  db.prepare(`UPDATE notifications SET is_read=1 WHERE user_id=?`).run(req.session.user.id);
  res.json({ ok: true });
});

// PUT /api/notifications/:id/read
router.put('/:id/read', requireAuth, (req, res) => {
  db.prepare(`UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?`)
    .run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

module.exports = router;
