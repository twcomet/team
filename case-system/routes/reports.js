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
  // 業績以成交日期（contracted_at）計算，無成交日期則 fallback 至建立日期
  if (from) { where += ' AND COALESCE(date(c.contracted_at), date(c.created_at))>=?'; params.push(from); }
  if (to)   { where += ' AND COALESCE(date(c.contracted_at), date(c.created_at))<=?'; params.push(to); }

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
    SELECT COALESCE(s.name,'未指定') as name,
      COUNT(*) as count,
      SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value,
      SUM(COALESCE(c.payment_received, 0)) as received
    FROM cases c LEFT JOIN users s ON s.id = c.sales_id
    ${where}
    GROUP BY c.sales_id ORDER BY gross_value DESC
  `).all(...params);

  // 依月份（以成交日期）
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', COALESCE(c.contracted_at, c.created_at)) as month,
      COUNT(*) as count,
      SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value,
      SUM(COALESCE(c.payment_received, 0)) as received
    FROM cases c ${where}
    GROUP BY month ORDER BY month
  `).all(...params);

  // 依膜料品牌
  const byFilm = db.prepare(`
    SELECT t.film_brand, COUNT(*) as case_count, SUM(t.case_value) as gross_value
    FROM (
      SELECT DISTINCT dm.film_brand, c.id,
        COALESCE(c.final_price, c.quoted_price, 0) as case_value
      FROM cases c
      JOIN dispatches d ON d.case_id = c.id
      JOIN dispatch_materials dm ON dm.dispatch_id = d.id
      ${where}
      AND dm.film_brand IS NOT NULL AND dm.film_brand != ''
    ) t
    GROUP BY t.film_brand
    ORDER BY gross_value DESC
  `).all(...params);

  // 案件明細
  const cases = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.case_type,
           cl.name as client_name, s.name as sales_name,
           COALESCE(date(c.contracted_at), date(c.created_at)) as contracted_date,
           COALESCE(c.final_price, c.quoted_price, 0) as value,
           COALESCE(c.final_price, c.quoted_price, 0)*1.05 as tax_value,
           COALESCE(c.payment_received, 0) as received,
           c.payment_status, c.status,
           o.name as org_name
    FROM cases c
    LEFT JOIN orgs o ON o.id = c.org_id
    LEFT JOIN users s ON s.id = c.sales_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    ${where}
    ORDER BY contracted_date DESC
  `).all(...params);

  res.json({ summary, byType, bySales, byMonth, byFilm, cases });
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

// ── 業務報表（回簽業績）GET /api/reports/sales?period=today|week|month&org_id= ──
router.get('/sales', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const { period = 'month', org_id, from: customFrom, to: customTo } = req.query;
    const orgRestrict = orgFilter(user);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    let fromDate, toDate, prevFrom, prevTo;

    if (customFrom && customTo) {
      // 自訂日期區間：不計算前期對比
      fromDate = customFrom; toDate = customTo;
      prevFrom = null; prevTo = null;
    } else if (period === 'today') {
      fromDate = toDate = today;
      const y = new Date(now); y.setDate(y.getDate() - 1);
      prevFrom = prevTo = y.toISOString().slice(0, 10);
    } else if (period === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 6);
      fromDate = d.toISOString().slice(0, 10); toDate = today;
      const p1 = new Date(d); p1.setDate(p1.getDate() - 7);
      const p2 = new Date(d); p2.setDate(p2.getDate() - 1);
      prevFrom = p1.toISOString().slice(0, 10); prevTo = p2.toISOString().slice(0, 10);
    } else if (period === 'quarter') {
      const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      fromDate = qStart.toISOString().slice(0, 10); toDate = today;
      const pqs = new Date(qStart); pqs.setMonth(pqs.getMonth() - 3);
      const pqe = new Date(qStart); pqe.setDate(pqe.getDate() - 1);
      prevFrom = pqs.toISOString().slice(0, 10); prevTo = pqe.toISOString().slice(0, 10);
    } else if (period === 'year') {
      fromDate = `${now.getFullYear()}-01-01`; toDate = today;
      prevFrom = `${now.getFullYear() - 1}-01-01`;
      prevTo   = `${now.getFullYear() - 1}-12-31`;
    } else {
      // month (default)
      fromDate = `${today.slice(0, 7)}-01`; toDate = today;
      const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const pe = new Date(now.getFullYear(), now.getMonth(), 0);
      prevFrom = pm.toISOString().slice(0, 10); prevTo = pe.toISOString().slice(0, 10);
    }
    const toEnd = toDate + ' 23:59:59';
    const prevEnd = prevTo ? prevTo + ' 23:59:59' : null;

    const params = [], prevParams = [];
    let where = `WHERE c.status IN ('contracted','payment','closed')
      AND c.contracted_at BETWEEN ? AND ?`;
    params.push(fromDate, toEnd);
    let prevWhere = `WHERE c.status IN ('contracted','payment','closed')
      AND c.contracted_at BETWEEN ? AND ?`;
    if (prevFrom && prevEnd) prevParams.push(prevFrom, prevEnd);

    if (orgRestrict.org_id) {
      where += ' AND c.org_id=?'; params.push(orgRestrict.org_id);
      prevWhere += ' AND c.org_id=?'; prevParams.push(orgRestrict.org_id);
    } else if (org_id) {
      where += ' AND c.org_id=?'; params.push(Number(org_id));
      prevWhere += ' AND c.org_id=?'; prevParams.push(Number(org_id));
    }

    const summary = db.prepare(`
      SELECT COUNT(*) as count,
        SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value,
        SUM(COALESCE(c.final_price, c.quoted_price, 0)*1.05) as tax_value,
        SUM(COALESCE(c.payment_received, 0)) as received
      FROM cases c ${where}
    `).get(...params);

    const prevSummary = (prevFrom && prevEnd)
      ? db.prepare(`SELECT COUNT(*) as count, SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value FROM cases c ${prevWhere}`).get(...prevParams)
      : null;

    const bySales = db.prepare(`
      SELECT COALESCE(s.name,'未指定') as name,
        COUNT(*) as count,
        SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value,
        SUM(COALESCE(c.final_price, c.quoted_price, 0)*1.05) as tax_value,
        SUM(COALESCE(c.payment_received, 0)) as received
      FROM cases c LEFT JOIN users s ON s.id = c.sales_id
      ${where}
      GROUP BY c.sales_id ORDER BY gross_value DESC
    `).all(...params);

    const byType = db.prepare(`
      SELECT c.case_type,
        COUNT(*) as count,
        SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value
      FROM cases c ${where}
      GROUP BY c.case_type ORDER BY gross_value DESC
    `).all(...params);

    const bySource = db.prepare(`
      SELECT COALESCE(cl.source, '未填寫') as source,
        COUNT(*) as count,
        SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value
      FROM cases c LEFT JOIN clients cl ON cl.id = c.client_id
      ${where.replace('WHERE', 'WHERE')}
      GROUP BY COALESCE(cl.source,'未填寫') ORDER BY gross_value DESC
    `).all(...params);

    const byLevel = db.prepare(`
      SELECT COALESCE(cl.client_level,'未分級') as level,
        COUNT(*) as count,
        SUM(COALESCE(c.final_price, c.quoted_price, 0)) as gross_value
      FROM cases c LEFT JOIN clients cl ON cl.id = c.client_id
      ${where.replace('WHERE', 'WHERE')}
      GROUP BY COALESCE(cl.client_level,'未分級') ORDER BY gross_value DESC
    `).all(...params);

    const orgRestrict2 = orgFilter(user);
    let pipeParams = [];
    let pipeWhere = `WHERE status NOT IN ('contracted','payment','closed','invalid')`;
    if (orgRestrict2.org_id) { pipeWhere += ' AND org_id=?'; pipeParams.push(orgRestrict2.org_id); }
    else if (org_id) { pipeWhere += ' AND org_id=?'; pipeParams.push(Number(org_id)); }

    const pipeline = db.prepare(`
      SELECT status, COUNT(*) as cnt
      FROM cases ${pipeWhere}
      GROUP BY status
    `).all(...pipeParams);

    const cases = db.prepare(`
      SELECT c.id, c.case_number, c.title, c.case_type,
             cl.name as client_name, s.name as sales_name,
             c.contracted_at, c.scheduled_date,
             COALESCE(c.final_price, c.quoted_price, 0) as value,
             COALESCE(c.final_price, c.quoted_price, 0)*1.05 as tax_value,
             COALESCE(c.payment_received, 0) as received,
             c.payment_status, c.status
      FROM cases c
      LEFT JOIN users s ON s.id = c.sales_id
      LEFT JOIN clients cl ON cl.id = c.client_id
      ${where}
      ORDER BY c.contracted_at DESC
    `).all(...params);

    // ── 施工派案統計（以 dispatch scheduled_date 為準）──────────────
    let dispatchWhere = `WHERE d.dispatch_type='install' AND date(d.scheduled_date) BETWEEN ? AND ?`;
    const dispatchParams = [fromDate, toDate];
    let prevDispatchWhere = `WHERE d.dispatch_type='install' AND date(d.scheduled_date) BETWEEN ? AND ?`;
    const prevDispatchParams = [prevFrom, prevTo];
    if (orgRestrict.org_id) {
      dispatchWhere     += ' AND c.org_id=?'; dispatchParams.push(orgRestrict.org_id);
      prevDispatchWhere += ' AND c.org_id=?'; prevDispatchParams.push(orgRestrict.org_id);
    } else if (org_id) {
      dispatchWhere     += ' AND c.org_id=?'; dispatchParams.push(Number(org_id));
      prevDispatchWhere += ' AND c.org_id=?'; prevDispatchParams.push(Number(org_id));
    }

    const dispatchSummary = db.prepare(`
      SELECT COUNT(*) as count, SUM(gross_value) as gross_value
      FROM (
        SELECT c.id, COALESCE(c.final_price, c.quoted_price, 0) as gross_value
        FROM dispatches d JOIN cases c ON c.id = d.case_id
        ${dispatchWhere} GROUP BY c.id
      )
    `).get(...dispatchParams);

    const prevDispatchSummary = db.prepare(`
      SELECT COUNT(*) as count, SUM(gross_value) as gross_value
      FROM (
        SELECT c.id, COALESCE(c.final_price, c.quoted_price, 0) as gross_value
        FROM dispatches d JOIN cases c ON c.id = d.case_id
        ${prevDispatchWhere} GROUP BY c.id
      )
    `).get(...prevDispatchParams);

    const dispatchCases = db.prepare(`
      SELECT c.id, c.case_number, c.title, c.case_type,
             cl.name as client_name, s.name as sales_name,
             COALESCE(c.final_price, c.quoted_price, 0) as value,
             MIN(d.scheduled_date) as dispatch_date,
             COUNT(d.id) as dispatch_count
      FROM dispatches d
      JOIN cases c ON c.id = d.case_id
      LEFT JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN users s ON s.id = c.sales_id
      ${dispatchWhere}
      GROUP BY c.id
      ORDER BY dispatch_date DESC
    `).all(...dispatchParams);

    res.json({ period, fromDate, toDate, summary, prevSummary, bySales, byType, bySource, byLevel, pipeline, cases, dispatchSummary, prevDispatchSummary, dispatchCases });
  } catch (err) {
    console.error('[reports/sales]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 收款狀況 GET /api/reports/payment-status?org_id= ──
router.get('/payment-status', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const { org_id } = req.query;
    const orgRestrict = orgFilter(user);

    const params = [];
    let orgCond = '';
    if (orgRestrict.org_id) { orgCond = ' AND c.org_id=?'; params.push(orgRestrict.org_id); }
    else if (org_id) { orgCond = ' AND c.org_id=?'; params.push(Number(org_id)); }

    const pendingDeposit = db.prepare(`
      SELECT c.id, c.case_number, cl.name as client_name, c.title, c.contracted_at,
             COALESCE(c.final_price, c.quoted_price, 0) as value,
             COALESCE(c.final_price, c.quoted_price, 0)*1.05 as tax_value,
             COALESCE(c.deposit_amount, 0) as deposit,
             COALESCE(c.payment_received, 0) as received,
             s.name as sales_name, c.payment_status
      FROM cases c
      LEFT JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN users s ON s.id = c.sales_id
      WHERE c.status IN ('contracted','payment') AND COALESCE(c.deposit_amount, 0) = 0 ${orgCond}
      ORDER BY c.contracted_at ASC
    `).all(...params);

    const pendingFinal = db.prepare(`
      SELECT c.id, c.case_number, cl.name as client_name, c.title, c.contracted_at,
             COALESCE(c.final_price, c.quoted_price, 0) as value,
             COALESCE(c.final_price, c.quoted_price, 0)*1.05 as tax_value,
             COALESCE(c.payment_received, 0) as received,
             s.name as sales_name, c.payment_status
      FROM cases c
      LEFT JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN users s ON s.id = c.sales_id
      WHERE c.status = 'payment' ${orgCond}
      ORDER BY c.contracted_at ASC
    `).all(...params);

    const now = new Date();
    const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const monthlyCollection = db.prepare(`
      SELECT SUM(COALESCE(payment_received, 0)) as total,
             COUNT(*) as cnt
      FROM cases
      WHERE status IN ('contracted','payment','closed')
        AND payment_received > 0 ${orgCond.replace('c.org_id', 'org_id')}
    `).get(...params);

    const dailyCollection = db.prepare(`
      SELECT date(updated_at) as day,
             SUM(COALESCE(payment_received, 0)) as total,
             COUNT(*) as cnt
      FROM cases
      WHERE status IN ('contracted','payment','closed')
        AND payment_received > 0
        AND date(updated_at) >= ? ${orgCond.replace('c.org_id', 'org_id')}
      GROUP BY day ORDER BY day DESC LIMIT 30
    `).all(thisMonthStart, ...params);

    res.json({ pendingDeposit, pendingFinal, monthlyCollection, dailyCollection });
  } catch (err) {
    console.error('[reports/payment-status]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
