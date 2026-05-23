const express = require('express');
const db      = require('../db');
const { requireAuth, orgFilter } = require('../middleware/auth');
const router  = express.Router();

// ── 損益表 GET /api/reports/pl?from=&to=&org_id= ─────────────
router.get('/pl', requireAuth, (req, res) => {
  const user = req.session.user;
  const { from, to } = req.query;
  const orgRestrict = orgFilter(user);

  const params = [];
  let where = 'WHERE 1=1';
  if (orgRestrict.org_id) { where += ' AND org_id=?'; params.push(orgRestrict.org_id); }
  else if (req.query.org_id) { where += ' AND org_id=?'; params.push(req.query.org_id); }
  if (from) { where += ' AND date>=?'; params.push(from); }
  if (to)   { where += ' AND date<=?'; params.push(to); }

  const rows = db.prepare(`
    SELECT type, category, SUM(amount) as total
    FROM ledger_entries ${where}
    GROUP BY type, category
    ORDER BY type, total DESC
  `).all(...params);

  const income  = rows.filter(r => r.type === 'income');
  const expense = rows.filter(r => r.type === 'expense');
  const totalIn  = income.reduce((s, r) => s + r.total, 0);
  const totalOut = expense.reduce((s, r) => s + r.total, 0);

  res.json({ income, expense, totalIn, totalOut, net: totalIn - totalOut });
});

// ── 業績報表 GET /api/reports/performance?from=&to=&org_id= ──
router.get('/performance', requireAuth, (req, res) => {
  const user = req.session.user;
  const { from, to } = req.query;
  const orgRestrict = orgFilter(user);

  const params = [];
  let where = "WHERE c.status NOT IN ('invalid','initial_estimate','survey')";
  if (orgRestrict.org_id) { where += ' AND c.org_id=?'; params.push(orgRestrict.org_id); }
  else if (req.query.org_id) { where += ' AND c.org_id=?'; params.push(req.query.org_id); }
  if (from) { where += ' AND date(c.created_at)>=?'; params.push(from); }
  if (to)   { where += ' AND date(c.created_at)<=?'; params.push(to); }

  // 案件彙總
  const summary = db.prepare(`
    SELECT
      COUNT(*) as count,
      SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value,
      SUM(COALESCE(c.final_price, c.quoted_price, 0) * 1.05) as tax_value,
      SUM(COALESCE(c.payment_received, 0)) as received,
      SUM(COALESCE(c.deposit_amount, 0)) as deposit
    FROM cases c ${where}
  `).get(...params);

  // 依案件類型
  const byType = db.prepare(`
    SELECT c.case_type,
      COUNT(*) as count,
      SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value
    FROM cases c ${where}
    GROUP BY c.case_type ORDER BY gross_value DESC
  `).all(...params);

  // 依業務員
  const bySales = db.prepare(`
    SELECT COALESCE(c.sales_name,'未指定') as name,
      COUNT(*) as count,
      SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value,
      SUM(COALESCE(c.payment_received, 0)) as received
    FROM cases c ${where}
    GROUP BY c.sales_name ORDER BY gross_value DESC
  `).all(...params);

  // 依月份
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', c.created_at) as month,
      COUNT(*) as count,
      SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value,
      SUM(COALESCE(c.payment_received, 0)) as received
    FROM cases c ${where}
    GROUP BY month ORDER BY month
  `).all(...params);

  // 案件明細
  const cases = db.prepare(`
    SELECT c.case_number, c.title, c.client_name, c.case_type,
           c.sales_name, c.scheduled_date,
           COALESCE(c.final_price, c.quoted_price, 0) as value,
           COALESCE(c.final_price, c.quoted_price, 0)*1.05 as tax_value,
           COALESCE(c.payment_received, 0) as received,
           c.payment_status, c.status,
           o.name as org_name
    FROM cases c
    LEFT JOIN orgs o ON o.id = c.org_id
    ${where}
    ORDER BY c.created_at DESC
  `).all(...params);

  res.json({ summary, byType, bySales, byMonth, cases });
});

// ── 現金流量表 GET /api/reports/cashflow?from=&to=&org_id= ────
router.get('/cashflow', requireAuth, (req, res) => {
  const user = req.session.user;
  const { from, to } = req.query;
  const orgRestrict = orgFilter(user);

  const params = [];
  let where = 'WHERE 1=1';
  if (orgRestrict.org_id) { where += ' AND org_id=?'; params.push(orgRestrict.org_id); }
  else if (req.query.org_id) { where += ' AND org_id=?'; params.push(req.query.org_id); }
  if (from) { where += ' AND date>=?'; params.push(from); }
  if (to)   { where += ' AND date<=?'; params.push(to); }

  // 每日匯總
  const daily = db.prepare(`
    SELECT date,
      SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) as inflow,
      SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) as outflow
    FROM ledger_entries ${where}
    GROUP BY date ORDER BY date
  `).all(...params);

  // 各科目收支
  const byCategory = db.prepare(`
    SELECT type, category,
      SUM(amount) as total,
      COUNT(*) as count
    FROM ledger_entries ${where}
    GROUP BY type, category ORDER BY type, total DESC
  `).all(...params);

  const totalIn  = daily.reduce((s, r) => s + r.inflow, 0);
  const totalOut = daily.reduce((s, r) => s + r.outflow, 0);

  // 計算累計餘額
  let running = 0;
  const withBalance = daily.map(r => {
    running += r.inflow - r.outflow;
    return { ...r, balance: running };
  });

  res.json({ daily: withBalance, byCategory, totalIn, totalOut, net: totalIn - totalOut });
});

module.exports = router;
