const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function ownerOnly(req, res, next) {
  if (req.session.user?.role !== 'owner') return res.status(403).json({ error: '無權限' });
  next();
}

router.get('/', requireAuth, ownerOnly, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: '請提供 from / to' });

  // 每位有操作記錄的使用者統計
  const users = db.prepare(`
    SELECT
      u.id   AS user_id,
      u.name,
      u.username,
      COUNT(*)                                                          AS total_actions,
      COUNT(DISTINCT l.entity_id)                                       AS cases_touched,
      COUNT(DISTINCT CASE WHEN c.case_group='inquiry' THEN l.entity_id END) AS inquiry_cases,
      COUNT(DISTINCT CASE WHEN c.case_group='survey'  THEN l.entity_id END) AS survey_cases,
      COUNT(DISTINCT CASE WHEN c.case_group='deal'    THEN l.entity_id END) AS deal_cases,
      SUM(CASE WHEN l.action='advance' THEN 1 ELSE 0 END)               AS advances,
      SUM(CASE WHEN l.action='create'  THEN 1 ELSE 0 END)               AS creates,
      SUM(CASE WHEN l.action='update'  THEN 1 ELSE 0 END)               AS updates
    FROM audit_logs l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN cases c ON c.id = l.entity_id AND l.entity = 'cases'
    WHERE l.entity = 'cases'
      AND date(l.created_at, '+8 hours') BETWEEN ? AND ?
    GROUP BY u.id, u.name, u.username
    HAVING total_actions > 0
    ORDER BY cases_touched DESC, total_actions DESC
  `).all(from, to);

  // 每位使用者的每日明細
  const dailyStmt = db.prepare(`
    SELECT
      date(l.created_at, '+8 hours') AS date,
      COUNT(*)                        AS actions,
      COUNT(DISTINCT l.entity_id)     AS cases,
      SUM(CASE WHEN l.action='advance' THEN 1 ELSE 0 END) AS advances,
      SUM(CASE WHEN l.action='create'  THEN 1 ELSE 0 END) AS creates,
      SUM(CASE WHEN l.action='update'  THEN 1 ELSE 0 END) AS updates
    FROM audit_logs l
    WHERE l.entity = 'cases' AND l.user_id = ?
      AND date(l.created_at, '+8 hours') BETWEEN ? AND ?
    GROUP BY date(l.created_at, '+8 hours')
    ORDER BY date
  `);

  const result = users.map(u => ({
    ...u,
    daily: dailyStmt.all(u.user_id, from, to),
  }));

  res.json(result);
});

module.exports = router;
