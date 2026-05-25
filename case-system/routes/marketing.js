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

    // line_inquiries 用獨立 org 過濾（欄名相同，保留相容）
    const lineOf = buildOrgFilter(me, 'org_id', org_id);
    const lineStats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status='new'         THEN 1 ELSE 0 END) as new_cnt,
             SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) as in_progress,
             SUM(CASE WHEN status IN ('converted','invalid') THEN 1 ELSE 0 END) as closed_cnt
      FROM line_inquiries
      WHERE (created_at BETWEEN ? AND ?) ${lineOf.where}
    `).get(fromDate, toEnd, ...lineOf.params);

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

module.exports = router;
