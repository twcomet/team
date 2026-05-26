const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

function buildOrgFilter(me, col, orgId) {
  if (orgId) return { where: `AND ${col} = ?`, params: [Number(orgId)] };
  if (!me.view_all_branches) return { where: `AND ${col} = ?`, params: [me.org_id] };
  return { where: '', params: [] };
}

// GET /api/marketing/summary?from=&to=&org_id=
router.get('/summary', requireAuth, (req, res) => {
  try {
    const me = req.session.user;
    const { from, to, org_id } = req.query;
    const fromDate = from || new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    const toEnd = toDate + ' 23:59:59';
    const of = buildOrgFilter(me, 'org_id', org_id);

    const sourceStats = db.prepare(`
      SELECT COALESCE(source,'other') as source, COUNT(*) as cnt
      FROM clients
      WHERE (created_at BETWEEN ? AND ?) ${of.where}
      GROUP BY COALESCE(source,'other') ORDER BY cnt DESC
    `).all(fromDate, toEnd, ...of.params);

    const monthlyClients = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as cnt
      FROM clients
      WHERE (created_at BETWEEN ? AND ?) ${of.where}
      GROUP BY month ORDER BY month
    `).all(fromDate, toEnd, ...of.params);

    // 正確的狀態值（依現行流程）
    const monthlyFunnel = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month,
             COUNT(*) as total,
             SUM(CASE WHEN status IN ('survey_pending','survey_scheduled','surveyed','quote_draft','quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as surveyed,
             SUM(CASE WHEN status IN ('quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as quoted_cnt,
             SUM(CASE WHEN status IN ('contracted','payment','closed') THEN 1 ELSE 0 END) as deals
      FROM cases
      WHERE (created_at BETWEEN ? AND ?) AND status != 'invalid' ${of.where}
      GROUP BY month ORDER BY month
    `).all(fromDate, toEnd, ...of.params);

    // 每日趨勢（供線性圖）
    const dailyTrend = db.prepare(`
      SELECT strftime('%Y-%m-%d', created_at) as day,
             COUNT(*) as inquiries,
             SUM(CASE WHEN status IN ('contracted','payment','closed') THEN 1 ELSE 0 END) as deals
      FROM cases
      WHERE (created_at BETWEEN ? AND ?) AND status != 'invalid' ${of.where}
      GROUP BY day ORDER BY day
    `).all(fromDate, toEnd, ...of.params);

    const caseTypeStats = db.prepare(`
      SELECT case_type, COUNT(*) as cnt,
             SUM(CASE WHEN status IN ('contracted','payment','closed') THEN 1 ELSE 0 END) as deals
      FROM cases
      WHERE (created_at BETWEEN ? AND ?) AND status != 'invalid' ${of.where}
      GROUP BY case_type ORDER BY cnt DESC
    `).all(fromDate, toEnd, ...of.params);

    // line_inquiries — 不加日期限制，顯示所有（含全期）資料
    const lineStats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status='new'         THEN 1 ELSE 0 END) as new_cnt,
             SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) as in_progress,
             SUM(CASE WHEN status IN ('converted','invalid') THEN 1 ELSE 0 END) as closed_cnt
      FROM line_inquiries
    `).get();

    const keywords = db.prepare(`
      SELECT keyword, COUNT(*) as cnt
      FROM cases
      WHERE keyword IS NOT NULL AND keyword != ''
        AND (created_at BETWEEN ? AND ?) ${of.where}
      GROUP BY keyword ORDER BY cnt DESC LIMIT 10
    `).all(fromDate, toEnd, ...of.params);

    res.json({ sourceStats, monthlyClients, monthlyFunnel, dailyTrend, caseTypeStats, lineStats, keywords, fromDate, toDate });
  } catch (err) {
    console.error('[marketing/summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/marketing/cs-funnel?from=&to=&group=month|week|day&org_id=
router.get('/cs-funnel', requireAuth, (req, res) => {
  try {
    const me = req.session.user;
    const { from, to, group = 'month', org_id } = req.query;
    const fromDate = from || new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const toDate = to || new Date().toISOString().slice(0, 10);
    const toEnd = toDate + ' 23:59:59';
    const of = buildOrgFilter(me, 'c.org_id', org_id);

    const fmtMap = { day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' };
    const fmt = fmtMap[group] || '%Y-%m';

    const periods = db.prepare(`
      SELECT strftime('${fmt}', c.created_at) as period,
             COUNT(*) as inquiries,
             SUM(CASE WHEN c.status IN ('survey_pending','survey_scheduled','surveyed','quote_draft','quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as surveyed,
             SUM(CASE WHEN c.status IN ('quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as quoted_cnt,
             SUM(CASE WHEN c.status IN ('contracted','payment','closed') THEN 1 ELSE 0 END) as deals
      FROM cases c
      WHERE (c.created_at BETWEEN ? AND ?) AND c.status != 'invalid' ${of.where}
      GROUP BY period ORDER BY period
    `).all(fromDate, toEnd, ...of.params);

    const byUser = db.prepare(`
      SELECT u.id, u.name, u.username, u.role,
             COUNT(*) as inquiries,
             SUM(CASE WHEN c.status IN ('survey_pending','survey_scheduled','surveyed','quote_draft','quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as surveyed,
             SUM(CASE WHEN c.status IN ('quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as quoted_cnt,
             SUM(CASE WHEN c.status IN ('contracted','payment','closed') THEN 1 ELSE 0 END) as deals
      FROM cases c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE (c.created_at BETWEEN ? AND ?) AND c.status != 'invalid' ${of.where}
      GROUP BY c.created_by ORDER BY inquiries DESC
    `).all(fromDate, toEnd, ...of.params);

    res.json({ periods, byUser, fromDate, toDate, group });
  } catch (err) {
    console.error('[marketing/cs-funnel]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/marketing/report?period=today|week|month&org_id=
router.get('/report', requireAuth, (req, res) => {
  try {
    const me = req.session.user;
    const { period = 'today', org_id } = req.query;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    let fromDate, toDate;
    if (period === 'today') {
      fromDate = toDate = today;
    } else if (period === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 6);
      fromDate = d.toISOString().slice(0, 10); toDate = today;
    } else {
      fromDate = `${today.slice(0, 7)}-01`; toDate = today;
    }
    const toEnd = toDate + ' 23:59:59';

    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const limit3d = threeDaysAgo.toISOString().slice(0, 19).replace('T', ' ');

    const of = buildOrgFilter(me, 'c.org_id', org_id);
    const of0 = buildOrgFilter(me, 'org_id', org_id);

    function alertQuery(status, tsCol) {
      return db.prepare(`
        SELECT c.id, c.case_number, c.client_name, c.title, c.${tsCol} as ts,
               u.name as sales_name
        FROM cases c LEFT JOIN users u ON u.id = c.sales_id
        WHERE c.status=? AND c.${tsCol} IS NOT NULL AND c.${tsCol} < ?
          ${of.where}
        ORDER BY c.${tsCol} ASC
      `).all(status, limit3d, ...of.params);
    }

    const afterEstimate  = alertQuery('initial_estimate', 'initial_estimate_at');
    const surveyPending  = alertQuery('survey_pending',   'survey_pending_at');
    const afterSurvey    = alertQuery('surveyed',         'surveyed_at');
    const afterQuote     = alertQuery('quoted',           'quoted_at');

    const funnel = db.prepare(`
      SELECT
        COUNT(*) as inquiries,
        SUM(CASE WHEN status IN ('initial_estimate','survey_pending','survey_scheduled','surveyed','quote_draft','quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as initial_estimate,
        SUM(CASE WHEN status IN ('survey_pending','survey_scheduled','surveyed','quote_draft','quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as survey_pending,
        SUM(CASE WHEN status IN ('surveyed','quote_draft','quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as surveyed,
        SUM(CASE WHEN status IN ('quoted','contracted','payment','closed') THEN 1 ELSE 0 END) as quoted,
        SUM(CASE WHEN status IN ('contracted','payment','closed') THEN 1 ELSE 0 END) as contracted
      FROM cases
      WHERE created_at BETWEEN ? AND ? AND status != 'invalid' ${of0.where}
    `).get(fromDate, toEnd, ...of0.params);

    const pendingRows = db.prepare(`
      SELECT status, COUNT(*) as cnt
      FROM cases
      WHERE status NOT IN ('contracted','payment','closed','invalid') ${of0.where}
      GROUP BY status
    `).all(...of0.params);

    const invalidRows = db.prepare(`
      SELECT invalid_reason_tags, COUNT(*) as cnt
      FROM cases
      WHERE status='invalid'
        AND invalid_at BETWEEN ? AND ?
        AND invalid_reason_tags IS NOT NULL AND invalid_reason_tags != '' AND invalid_reason_tags != '[]'
        ${of0.where}
    `).all(fromDate, toEnd, ...of0.params);

    const tagCounts = {};
    invalidRows.forEach(r => {
      let tags = [];
      try { tags = JSON.parse(r.invalid_reason_tags); } catch {}
      tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + r.cnt; });
    });
    const invalidReasons = Object.entries(tagCounts).sort((a,b)=>b[1]-a[1]).map(([name,cnt])=>({name,cnt}));

    res.json({
      period, fromDate, toDate,
      alerts: {
        afterEstimate, surveyPending, afterSurvey, afterQuote,
        total: afterEstimate.length + surveyPending.length + afterSurvey.length + afterQuote.length,
      },
      funnel,
      pending: pendingRows,
      invalidReasons,
    });
  } catch (err) {
    console.error('[marketing/report]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
