const express = require('express');
const db = require('../db');
const { requireAuth, orgFilterSQL } = require('../middleware/auth');
const router = express.Router();

// GET /api/calendar?year=2026&month=5
// 回傳該月份的派工記錄 + 有施工日期的案件，與每日目標
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.permissions?.page_calendar) return res.status(403).json({ error: '無派單行事曆權限' });
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const { sql: orgSqlT, params: orgPsT } = orgFilterSQL(me, 'org_id');
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const dateFrom = `${year}-${String(month).padStart(2,'0')}-01`;
  const dateTo   = `${year}-${String(month).padStart(2,'0')}-31`;

  const orgCond = orgSql ? `AND ${orgSql}` : '';

  // 派工記錄
  const dispatched = db.prepare(`
    SELECT
      d.id            AS dispatch_id,
      d.scheduled_date,
      d.scheduled_time,
      d.dispatch_type,
      d.status        AS dispatch_status,
      c.id, c.case_number, c.title, c.status,
      c.final_price, c.quoted_price,
      cl.name         AS client_name,
      GROUP_CONCAT(u.name, '、') AS installer_name,
      COUNT(DISTINCT du.user_id) AS worker_count,
      'dispatch'      AS source
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
  `).all(dateFrom, dateTo, ...orgPs);

  // 有施工日期但無派工記錄的案件
  const dispatchedCaseIds = dispatched.map(d => d.id);
  const excludeClause = dispatchedCaseIds.length
    ? `AND c.id NOT IN (${dispatchedCaseIds.join(',')})`
    : '';

  const scheduled = db.prepare(`
    SELECT
      NULL            AS dispatch_id,
      c.scheduled_date,
      NULL            AS scheduled_time,
      NULL            AS dispatch_type,
      NULL            AS dispatch_status,
      c.id, c.case_number, c.title, c.status,
      c.final_price, c.quoted_price,
      cl.name         AS client_name,
      sv.name         AS installer_name,
      'case'          AS source
    FROM cases c
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users sv ON c.surveyor_id = sv.id
    WHERE c.scheduled_date BETWEEN ? AND ?
      AND c.status NOT IN ('closed','invalid')
      ${orgCond}
      ${excludeClause}
    ORDER BY c.scheduled_date
  `).all(dateFrom, dateTo, ...orgPs);

  const cases = [...dispatched, ...scheduled];

  // 場勘記錄（survey_date 落在本月的案件）
  const surveys = db.prepare(`
    SELECT
      c.id, c.case_number, c.title, c.status,
      c.survey_date,
      cl.name  AS client_name,
      sv.name  AS surveyor_name,
      'survey' AS source
    FROM cases c
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users   sv ON c.surveyor_id = sv.id
    WHERE c.survey_date BETWEEN ? AND ?
      AND c.status NOT IN ('closed','invalid')
      ${orgCond}
    ORDER BY c.survey_date
  `).all(dateFrom, dateTo, ...orgPs);

  const orgCondT = orgSqlT ? `AND ${orgSqlT}` : '';
  const targets = db.prepare(`
    SELECT date, target_amount FROM daily_targets
    WHERE date BETWEEN ? AND ? ${orgCondT}
  `).all(dateFrom, dateTo, ...orgPsT);

  // 已核准的請假（含跨日）
  const leaves = db.prepare(`
    SELECT lr.id, lr.leave_date, lr.leave_end_date, lr.leave_type, lr.hours,
           u.name AS user_name, u.id AS user_id
    FROM leave_requests lr
    JOIN users u ON u.id = lr.user_id
    WHERE lr.status = 'approved'
      AND (
        lr.leave_date BETWEEN ? AND ?
        OR (lr.leave_end_date IS NOT NULL AND lr.leave_end_date BETWEEN ? AND ?)
        OR (lr.leave_date <= ? AND lr.leave_end_date >= ?)
      )
    ORDER BY lr.leave_date
  `).all(dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo);

  res.json({ cases, surveys, targets, leaves });
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
