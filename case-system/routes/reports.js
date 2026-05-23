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
  // 業績以第一天施工日期（scheduled_date）計算，無施工日期則 fallback 至建立日期
  if (from) { where += ' AND COALESCE(c.scheduled_date, date(c.created_at))>=?'; params.push(from); }
  if (to)   { where += ' AND COALESCE(c.scheduled_date, date(c.created_at))<=?'; params.push(to); }

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

  // 依月份（以施工日期）
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', COALESCE(c.scheduled_date, c.created_at)) as month,
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

// ── 收入分析 GET /api/reports/income-analysis?from=YYYY-MM&to=YYYY-MM ──
router.get('/income-analysis', requireAuth, (req, res) => {
  const user = req.session.user;
  const orgRestrict = orgFilter(user);

  const now = new Date();
  let { from, to } = req.query;
  if (!from) from = `${now.getFullYear()}-01`;
  if (!to)   to   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const fromDate = `${from}-01`;
  const lastDay  = new Date(ty, tm, 0).getDate();
  const toDate   = `${to}-${String(lastDay).padStart(2,'0')}`;

  const params = [];
  let where = `WHERE le.type='income' AND le.date>=? AND le.date<=?`;
  params.push(fromDate, toDate);
  if (orgRestrict.org_id) { where += ' AND le.org_id=?'; params.push(orgRestrict.org_id); }
  else if (req.query.org_id) { where += ' AND le.org_id=?'; params.push(req.query.org_id); }

  // 品牌/產品收入（流水帳科目）
  const byBrand = db.prepare(`
    SELECT le.category, COALESCE(lc.section,'income') as section,
           SUM(le.amount) as total, COUNT(*) as count
    FROM ledger_entries le
    LEFT JOIN ledger_categories lc ON lc.name = le.category
    ${where}
    GROUP BY le.category
    ORDER BY total DESC
  `).all(...params);

  const totalIncome = byBrand.reduce((s, r) => s + r.total, 0);
  byBrand.forEach(r => { r.pct = totalIncome > 0 ? r.total / totalIncome * 100 : 0; });

  // 月份趨勢（品牌 × 月份 pivot）
  const monthlyParams = [...params];
  const monthlyRows = db.prepare(`
    SELECT le.category, strftime('%Y%m', le.date) as month, SUM(le.amount) as total
    FROM ledger_entries le
    LEFT JOIN ledger_categories lc ON lc.name = le.category
    ${where}
    GROUP BY le.category, month ORDER BY month
  `).all(...monthlyParams);

  // 案件類型收入（透過 case_id join cases）
  const caseTypeParams = [...params];
  const byCaseType = db.prepare(`
    SELECT COALESCE(c.case_type, '未分類') as case_type,
           SUM(le.amount) as total, COUNT(DISTINCT le.case_id) as case_count
    FROM ledger_entries le
    LEFT JOIN cases c ON c.id = le.case_id
    ${where} AND le.case_id IS NOT NULL
    GROUP BY case_type ORDER BY total DESC
  `).all(...caseTypeParams);

  // 無案件關聯的收入
  const noCase = db.prepare(`
    SELECT SUM(le.amount) as total, COUNT(*) as count
    FROM ledger_entries le
    ${where} AND le.case_id IS NULL
  `).get(...params);

  // 月份清單
  const months = [];
  let cy = fy, cm = fm;
  while (cy < ty || (cy === ty && cm <= tm)) {
    months.push(`${cy}${String(cm).padStart(2,'0')}`);
    cm++; if (cm > 12) { cm = 1; cy++; }
  }

  res.json({ byBrand, byCaseType, noCase, totalIncome, months, monthlyRows });
});

// ── 損益表（月份交叉表）GET /api/reports/pl-monthly?from=YYYY-MM&to=YYYY-MM ──
router.get('/pl-monthly', requireAuth, (req, res) => {
  const user = req.session.user;
  const orgRestrict = orgFilter(user);

  const now = new Date();
  const curYM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  let { from, to } = req.query;
  if (!from) from = `${now.getFullYear()}-01`;
  if (!to)   to   = curYM;

  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const fromDate = `${from}-01`;
  const lastDay  = new Date(ty, tm, 0).getDate();
  const toDate   = `${to}-${String(lastDay).padStart(2,'0')}`;

  // Generate ordered month list
  const months = [];
  let cy = fy, cm = fm;
  while (cy < ty || (cy === ty && cm <= tm)) {
    months.push(`${cy}${String(cm).padStart(2,'0')}`);
    cm++; if (cm > 12) { cm = 1; cy++; }
  }

  const params = [];
  let where = 'WHERE le.date>=? AND le.date<=?';
  params.push(fromDate, toDate);
  if (orgRestrict.org_id) { where += ' AND le.org_id=?'; params.push(orgRestrict.org_id); }
  else if (req.query.org_id) { where += ' AND le.org_id=?'; params.push(req.query.org_id); }

  // All entries grouped by category + month
  const rows = db.prepare(`
    SELECT
      le.category,
      le.type AS entry_type,
      COALESCE(lc.section, le.type) AS section,
      COALESCE(lc.sort_order, 999)  AS sort_order,
      strftime('%Y%m', le.date)     AS month,
      SUM(le.amount)                AS total
    FROM ledger_entries le
    LEFT JOIN ledger_categories lc ON lc.name = le.category
    ${where}
    GROUP BY le.category, section, month
    ORDER BY sort_order, le.category, month
  `).all(...params);

  // Build pivot: catKey → { name, section, sort_order, monthly, total }
  const catMap = {};
  for (const r of rows) {
    if (!catMap[r.category]) {
      catMap[r.category] = { name: r.category, section: r.section, sort_order: r.sort_order, monthly: {}, total: 0 };
    }
    catMap[r.category].monthly[r.month] = (catMap[r.category].monthly[r.month] || 0) + r.total;
    catMap[r.category].total += r.total;
  }

  // Merge all known active categories (show even if 0)
  const allCats = db.prepare(`SELECT * FROM ledger_categories WHERE active=1 ORDER BY sort_order, id`).all();
  for (const c of allCats) {
    if (!catMap[c.name]) {
      catMap[c.name] = {
        name: c.name,
        section: c.section || (c.type === 'income' ? 'income' : 'expense'),
        sort_order: c.sort_order,
        monthly: {},
        total: 0
      };
    }
  }

  // Group by section, sorted by sort_order
  const sections = { income: [], cost: [], expense: [], asset_liability: [] };
  for (const cat of Object.values(catMap)) {
    const s = cat.section || 'expense';
    if (!sections[s]) sections[s] = [];
    sections[s].push(cat);
  }
  for (const s of Object.keys(sections)) {
    sections[s].sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, 'zh-TW'));
  }

  const sumCats   = cats => cats.reduce((s, c) => s + c.total, 0);
  const sumMonth  = (cats, m) => cats.reduce((s, c) => s + (c.monthly[m] || 0), 0);

  const incomeTotal = sumCats(sections.income);
  const costTotal   = sumCats(sections.cost);
  const expTotal    = sumCats(sections.expense);
  const assetTotal  = sumCats(sections.asset_liability);
  const grossProfit = incomeTotal - costTotal;
  const opIncome    = grossProfit - expTotal;

  const mIncome = {}, mCost = {}, mExp = {}, mGross = {}, mOp = {};
  for (const m of months) {
    mIncome[m] = sumMonth(sections.income, m);
    mCost[m]   = sumMonth(sections.cost, m);
    mExp[m]    = sumMonth(sections.expense, m);
    mGross[m]  = mIncome[m] - mCost[m];
    mOp[m]     = mGross[m] - mExp[m];
  }

  res.json({
    months,
    sections,
    totals: {
      incomeTotal, costTotal, expTotal, assetTotal,
      grossProfit,
      grossMargin:  incomeTotal > 0 ? grossProfit / incomeTotal * 100 : 0,
      opIncome,
      netMargin:    incomeTotal > 0 ? opIncome / incomeTotal * 100 : 0,
      mIncome, mCost, mExp, mGross, mOp
    }
  });
});

module.exports = router;
