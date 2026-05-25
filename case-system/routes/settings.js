const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const ALLOWED_KEYS = ['push_mode', 'gcal_ical_url', 'gcal_ical_urls'];

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${ALLOWED_KEYS.map(()=>'?').join(',')})`).all(...ALLOWED_KEYS);
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

router.put('/', requireAuth, (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅最高管理者可修改' });
  const upd = db.prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  for (const key of ALLOWED_KEYS) {
    if (key in req.body) upd.run(key, String(req.body[key]));
  }
  res.json({ ok: true });
});

module.exports = router;
