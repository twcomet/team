const express = require('express');
const db = require('../db');
const { requireAuth, orgFilter } = require('../middleware/auth');
const router = express.Router();

// GET /api/calendar?year=2026&month=5
// 回傳該月份的派工記錄（附案件資訊）與每日目標
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const filter = orgFilter(me);
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const dateFrom = `${year}-${String(month).padStart(2,'0')}-01`;
  const dateTo   = `${year}-${String(month).padStart(2,'0')}-31`;

  const orgCond = filter.org_id ? `AND c.org_id = ${filter.org_id}` : '';

  const cases = db.prepare(`
    SELECT
      d.id            AS dispatch_id,
      d.scheduled_date,
      d.scheduled_time,
      d.dispatch_type,
      d.status        AS dispatch_status,
      c.id, c.case_number, c.title, c.status,
      c.final_price, c.quoted_price,
      cl.name         AS client_name,
      GROUP_CONCAT(u.name, '、') AS installer_name
    FROM dispatches d
    JOIN cases c ON d.case_id = c.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
    LEFT JOIN users u ON u.id = du.user_id
    WHERE d.scheduled_date BETWEEN ? AND ?
      AND d.status != 'cancelled'
      ${orgCond}
    GROUP BY d.id
    ORDER BY d.scheduled_date, d.scheduled_time
  `).all(dateFrom, dateTo);

  const targets = db.prepare(`
    SELECT date, target_amount FROM daily_targets
    WHERE date BETWEEN ? AND ? ${filter.org_id ? `AND org_id = ${filter.org_id}` : ''}
  `).all(dateFrom, dateTo);

  res.json({ cases, targets });
});

// POST /api/daily-target  { date, target_amount }
router.post('/daily-target', requireAuth, (req, res) => {
  const me = req.session.user;
  const { date, target_amount } = req.body;
  if (!date || !target_amount) return res.status(400).json({ error: '請填入日期與目標金額' });
  db.prepare(`
    INSERT INTO daily_targets (org_id, date, target_amount)
    VALUES (?, ?, ?)
    ON CONFLICT(org_id, date) DO UPDATE SET target_amount=excluded.target_amount
  `).run(me.org_id, date, Number(target_amount));
  res.json({ ok: true });
});

module.exports = router;
