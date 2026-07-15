const express = require('express');
const db = require('../db');
const { requireAuth, orgFilterSQL, isOutsourced } = require('../middleware/auth');
const router = express.Router();

// GET /api/calendar?year=2026&month=5
// 回傳該月份的派工記錄 + 有施工日期的案件，與每日目標
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  // 🔒 外包/經銷：不給看全公司行事曆，改用「我的行事曆」看自己的工作
  if (isOutsourced(me.role)) return res.status(403).json({ error: '外包夥伴請改用「我的行事曆」' });
  if (me.role !== 'owner' && !me.permissions?.page_calendar) return res.status(403).json({ error: '無派單行事曆權限' });
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const { sql: orgSqlT, params: orgPsT } = orgFilterSQL(me, 'org_id');
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  // 範圍涵蓋整個「月曆 grid」：含上月底、下月初的補格，這樣跨月案件也載得到
  const _fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const _first = new Date(year, month - 1, 1);
  const _gridStart = new Date(year, month - 1, 1 - _first.getDay()); // grid 第一格(週日)
  const _gridEnd   = new Date(_gridStart); _gridEnd.setDate(_gridStart.getDate() + 41); // 固定 6 列 42 格
  const dateFrom = _fmt(_gridStart);
  const dateTo   = _fmt(_gridEnd); // 涵蓋畫面上全部 42 格，跨月日期的資料也都載得到

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
      c.location, c.entry_info, c.photo_upload_url, c.drive_folder_url,
      (SELECT sf.cs_service_note FROM survey_forms sf
         WHERE sf.case_id = c.id AND sf.cs_service_note IS NOT NULL AND TRIM(sf.cs_service_note) <> ''
         ORDER BY sf.id DESC LIMIT 1) AS cs_service_note,
      d.work_until, d.estimated_hours, d.notes AS dispatch_notes,
      cl.phone        AS client_phone,
      sv.name         AS surveyor_name,
      d.service_fee, d.warranty_covered,
      cl.name         AS client_name,
      ld.name         AS leader_name,
      GROUP_CONCAT(u.name, '、') AS installer_name,
      COUNT(DISTINCT du.user_id) AS worker_count,
      (SELECT COUNT(*) FROM work_reports w WHERE w.dispatch_id = d.id) AS report_count,
      'dispatch'      AS source
    FROM dispatches d
    JOIN cases c ON d.case_id = c.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users sv ON c.surveyor_id = sv.id
    LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
    LEFT JOIN users u ON u.id = du.user_id
    LEFT JOIN users ld ON ld.id = d.leader_id
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
      c.location, c.entry_info, c.photo_upload_url, c.drive_folder_url, c.final_price,
      cl.name  AS client_name,
      cl.phone AS client_phone,
      sf.cs_service_note,
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

  // 暫定事項（未關聯案件的行事曆備忘，全公司/分店可見）
  const { sql: orgSqlA, params: orgPsA } = orgFilterSQL(me, 'a.org_id');
  const orgCondA = orgSqlA ? `AND ${orgSqlA}` : '';
  const adhoc = db.prepare(`
    SELECT a.id, a.title, a.event_date, a.event_time, a.note, a.created_by,
           u.name AS creator_name, 'adhoc' AS source
    FROM adhoc_events a
    LEFT JOIN users u ON u.id = a.created_by
    WHERE a.event_date BETWEEN ? AND ? ${orgCondA}
    ORDER BY a.event_date, a.event_time
  `).all(dateFrom, dateTo, ...orgPsA);

  // 遲到名單（每天在行事曆上全體可見）：當天有遲到打卡記錄者
  const lateRows = db.prepare(`
    SELECT a.work_date AS date, u.name
    FROM attendance a
    JOIN users u ON u.id = a.user_id
    WHERE a.is_late=1 AND a.work_date BETWEEN ? AND ?
    ORDER BY a.work_date, u.sort_order, u.name
  `).all(dateFrom, dateTo);
  const lateMap = {};
  for (const r of lateRows) { (lateMap[r.date] ||= []).push(r.name); }
  const lateList = Object.entries(lateMap).map(([date, names]) => ({ date, names }));

  res.json({ cases, surveys, targets, leaves, caseInstallWeight, roster, assignments, adhoc, lateList });
});

// GET /api/calendar/search?q=  行事曆內搜尋（跨月）：找符合關鍵字的派工/場勘/暫定事項，回傳日期供跳轉
router.get('/search', requireAuth, (req, res) => {
  const me = req.session.user;
  if (isOutsourced(me.role)) return res.status(403).json({ error: '外包夥伴請改用「我的行事曆」' });
  if (me.role !== 'owner' && !me.permissions?.page_calendar) return res.status(403).json({ error: '無派單行事曆權限' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const like = `%${q}%`;
  const { sql: orgC, params: orgP } = orgFilterSQL(me, 'c.org_id');
  const cond  = orgC ? `AND ${orgC}` : '';

  const disp = db.prepare(`
    SELECT 'dispatch' AS type, d.scheduled_date AS date, c.id AS case_id, c.case_number, c.title,
           cl.name AS client_name, d.dispatch_type
    FROM dispatches d JOIN cases c ON c.id = d.case_id LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE d.status != 'cancelled' AND d.scheduled_date IS NOT NULL
      AND (c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ? OR cl.phone LIKE ?) ${cond}
    ORDER BY d.scheduled_date DESC LIMIT 30
  `).all(like, like, like, like, ...orgP);

  const surv = db.prepare(`
    SELECT 'survey' AS type, COALESCE(sf.survey_date, c.survey_date) AS date, c.id AS case_id,
           c.case_number, c.title, cl.name AS client_name
    FROM cases c LEFT JOIN survey_forms sf ON sf.case_id = c.id LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE COALESCE(sf.survey_date, c.survey_date) IS NOT NULL AND c.status NOT IN ('closed','invalid')
      AND (c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ?) ${cond}
    GROUP BY c.id ORDER BY date DESC LIMIT 30
  `).all(like, like, like, ...orgP);

  const { sql: orgA, params: orgPA } = orgFilterSQL(me, 'a.org_id');
  const condA = orgA ? `AND ${orgA}` : '';
  const adhoc = db.prepare(`
    SELECT 'adhoc' AS type, a.event_date AS date, a.id, a.title, NULL AS client_name, NULL AS case_number
    FROM adhoc_events a WHERE (a.title LIKE ? OR a.note LIKE ?) ${condA}
    ORDER BY a.event_date DESC LIMIT 30
  `).all(like, like, ...orgPA);

  const results = [...disp, ...surv, ...adhoc].filter(r => r.date).sort((a, b) => (b.date > a.date ? 1 : -1)).slice(0, 40);
  res.json({ results });
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
