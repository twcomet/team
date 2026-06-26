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
  // 範圍涵蓋整個「月曆 grid」：含上月底、下月初的補格，這樣跨月案件也載得到
  const _fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const _first = new Date(year, month - 1, 1);
  const _last  = new Date(year, month, 0);
  const dateFrom = _fmt(new Date(year, month - 1, 1 - _first.getDay()));        // 該週週日
  const dateTo   = _fmt(new Date(year, month - 1, _last.getDate() + (6 - _last.getDay()))); // 該週週六

  const orgCond = orgSql ? `AND ${orgSql}` : '';

  // 派工記錄
  const dispatched = db.prepare(`
    SELECT
      d.id            AS dispatch_id,
      d.scheduled_date,
      d.scheduled_time,
      d.dispatch_type,
      d.day_index,
      (SELECT COUNT(*) FROM dispatches d2
         WHERE d2.case_id = d.case_id AND d2.dispatch_type='install' AND d2.status != 'cancelled'
           AND (d2.scheduled_date < d.scheduled_date OR (d2.scheduled_date = d.scheduled_date AND d2.id <= d.id))
      ) AS day_no,  -- 同案施工依日期排序的第幾天（最早=1）
      d.status        AS dispatch_status,
      c.id, c.case_number, c.title, c.status,
      c.final_price, c.quoted_price,
      d.service_fee, d.warranty_covered,
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
      -- 只要案件已有施工派工，就以派工日期為準，不再用可能過期的 scheduled_date 備援顯示
      AND c.id NOT IN (SELECT case_id FROM dispatches WHERE dispatch_type='install' AND status != 'cancelled')
      ${orgCond}
      ${excludeClause}
    ORDER BY c.scheduled_date
  `).all(dateFrom, dateTo, ...orgPs);

  const cases = [...dispatched, ...scheduled];

  // 場勘記錄（以 survey_forms 為主，fallback 到 cases.survey_date）
  const surveys = db.prepare(`
    SELECT
      c.id, c.case_number, c.title, c.status,
      COALESCE(sf.survey_date, c.survey_date) AS survey_date,
      cl.name  AS client_name,
      COALESCE(sf_u.name, sv.name) AS surveyor_name,
      'survey' AS source
    FROM cases c
    LEFT JOIN survey_forms sf ON sf.case_id = c.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users sv ON c.surveyor_id = sv.id
    LEFT JOIN users sf_u ON sf.surveyor_id = sf_u.id
    WHERE COALESCE(sf.survey_date, c.survey_date) BETWEEN ? AND ?
      AND c.status NOT IN ('closed','invalid')
      ${orgCond}
    ORDER BY COALESCE(sf.survey_date, c.survey_date)
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

  // 各案件「全部日期」的施工(install)派工權重總和（攤分分母，與業績報表一致；排除已取消）
  const caseInstallWeight = {};
  db.prepare(`
    SELECT d.case_id,
           SUM(MAX(1, (SELECT COUNT(DISTINCT du.user_id) FROM dispatch_users du WHERE du.dispatch_id = d.id))) AS w
    FROM dispatches d
    WHERE d.dispatch_type = 'install' AND d.status != 'cancelled'
    GROUP BY d.case_id
  `).all().forEach(r => { caseInstallWeight[r.case_id] = r.w; });

  // ── 人力空檔（管理端用）：施工名冊 + 各日 install 派工指派 ──────────
  const orgUserCond = orgSqlT ? `AND ${orgSqlT}` : '';
  const roster = db.prepare(`
    SELECT id, name FROM users
    WHERE accept_dispatch=1 AND active=1 ${orgUserCond}
    ORDER BY sort_order, name
  `).all(...orgPsT);
  const assignments = db.prepare(`
    SELECT d.scheduled_date AS date, du.user_id
    FROM dispatches d
    JOIN dispatch_users du ON du.dispatch_id = d.id
    WHERE d.dispatch_type='install' AND d.status != 'cancelled'
      AND d.scheduled_date BETWEEN ? AND ?
  `).all(dateFrom, dateTo);

  res.json({ cases, surveys, targets, leaves, caseInstallWeight, roster, assignments });
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
