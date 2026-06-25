const express = require('express');
const db      = require('../db');
const { requireAuth, orgFilterSQL } = require('../middleware/auth');
const router  = express.Router();

// 技術／外包角色：只看得到自己被派工的案件（與 cases.js 列表同規則）
const DISPATCH_ONLY_ROLES = ['hq_tech', 'branch_tech', 'contractor_install', 'contractor_sales'];

// 由案件 status 推導「階段徽章」（對應前端 5 種：line/inq/survey/quote/deal）
function stageOf(status) {
  if (['inquiry', 'initial_estimate', 'quote_needed', 'quote_sent'].includes(status))
    return { stage: 'inq',    stage_label: '詢價' };
  if (['survey_pending', 'survey_scheduled', 'surveyed'].includes(status))
    return { stage: 'survey', stage_label: '場勘' };
  if (['quote_draft', 'quoted'].includes(status))
    return { stage: 'quote',  stage_label: '報價' };
  return { stage: 'deal', stage_label: '成交' };  // contracted/dispatched/constructing/payment/closed/aftersales…
}

// ── GET /api/search/quick?q=… ── 萬用搜尋：跨 5 階段找案件 ─────────────
// 權限兩層：(1) 可見範圍依角色/分店過濾 (2) 成本毛利僅 can_see_cost 回傳
router.get('/quick', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json({ count: 0, results: [] });

  const me    = req.session.user;
  const like  = `%${q}%`;
  const seeCost = !!me.can_see_cost;
  const dispatchOnly = DISPATCH_ONLY_ROLES.includes(me.role);

  // ── 1) cases（詢價＋場勘＋報價＋成交，同一張表）─────────────────
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const where  = [`(c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ? OR cl.phone LIKE ? OR c.location LIKE ? OR s.name LIKE ? OR o.name LIKE ?)`];
  const params = [like, like, like, like, like, like, like];
  if (orgSql) { where.push(orgSql); params.push(...orgPs); }
  if (dispatchOnly) {
    where.push(`EXISTS (SELECT 1 FROM dispatch_users du JOIN dispatches d ON du.dispatch_id = d.id WHERE d.case_id = c.id AND du.user_id = ?)`);
    params.push(me.id);
  }

  const caseRows = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.case_group, c.updated_at,
           cl.name AS client_name, cl.phone AS client_phone,
           s.name  AS sales_name,  o.name AS org_name,
           c.final_price, c.material_cost,
           ROUND((c.final_price - c.material_cost) * 100.0 / NULLIF(c.final_price, 0), 1) AS gross_margin_pct
    FROM cases c
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users   s  ON c.sales_id  = s.id
    LEFT JOIN orgs    o  ON c.org_id    = o.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.updated_at DESC
    LIMIT 30
  `).all(...params);

  const cases = caseRows.map(c => {
    const { stage, stage_label } = stageOf(c.status);
    return {
      type: 'case',
      id: c.id,
      stage, stage_label,
      case_number: c.case_number,
      title: c.title,
      client_name: c.client_name,
      phone: c.client_phone,
      sales_name: c.sales_name,
      org_name: c.org_name,
      status: c.status,
      // 第2層權限：成本/毛利僅成本可見者回傳，其餘一律 null（前端顯示🔒）
      cost: seeCost ? c.material_cost : null,
      gross_margin_pct: seeCost ? c.gross_margin_pct : null,
      link: `/case-detail?id=${c.id}`,
      sort_ts: c.updated_at || '',
    };
  });

  // ── 2) LINE 詢問（尚未轉案：new/in_progress）─────────────────────
  // 技術/外包不經手詢問，直接略過；已轉案者會以 case 形式出現，故只取未轉案 → 自動去重
  let inquiries = [];
  if (!dispatchOnly) {
    const { sql: iOrgSql, params: iOrgPs } = orgFilterSQL(me, 'i.org_id');
    const iWhere  = [`i.status IN ('new','in_progress')`,
                     `(i.display_name LIKE ? OR i.last_message LIKE ? OR i.staff_note LIKE ? OR cl.name LIKE ? OR cl.phone LIKE ?)`];
    const iParams = [like, like, like, like, like];
    if (iOrgSql) { iWhere.push(iOrgSql); iParams.push(...iOrgPs); }

    const inqRows = db.prepare(`
      SELECT i.id, i.display_name, i.last_message_at, i.status,
             cl.name AS client_name, cl.phone AS client_phone,
             su.name AS sales_name, o.name AS org_name
      FROM line_inquiries i
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN users   su ON i.sales_id  = su.id
      LEFT JOIN orgs    o  ON i.org_id    = o.id
      WHERE ${iWhere.join(' AND ')}
      ORDER BY i.last_message_at DESC
      LIMIT 15
    `).all(...iParams);

    inquiries = inqRows.map(i => ({
      type: 'inquiry',
      id: i.id,
      stage: 'line', stage_label: 'LINE詢問',
      case_number: null,
      title: i.display_name || '（未命名詢問）',
      client_name: i.client_name,
      phone: i.client_phone,
      sales_name: i.sales_name,
      org_name: i.org_name,
      status: i.status,
      cost: null, gross_margin_pct: null,
      link: `/line-inquiries`,
      sort_ts: i.last_message_at || '',
    }));
  }

  // ── 合併，最近更新排前面，取前 25 ──────────────────────────────
  const results = [...cases, ...inquiries]
    .sort((a, b) => (b.sort_ts || '').localeCompare(a.sort_ts || ''))
    .slice(0, 25);

  res.json({ count: results.length, results });
});

// ── 既有：GET /api/search?q=… 全域搜尋（保留，未動）────────────────────
router.get('/', requireAuth, (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: '請輸入至少 2 個字元' });

  const me = req.session.user;
  const like = `%${q.trim()}%`;

  const cases = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.case_type, c.location,
           c.scheduled_date, c.created_at,
           cl.name as client_name, cl.phone as client_phone,
           s.name  as sales_name
    FROM cases c
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users   s  ON s.id  = c.sales_id
    WHERE c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ? OR c.location LIKE ?
    ORDER BY c.updated_at DESC LIMIT 20
  `).all(like, like, like, like);

  const result = cases.map(c => {
    const survey = db.prepare(`
      SELECT id, status, share_token, survey_date, client_signed_at
      FROM survey_forms WHERE case_id = ? ORDER BY id DESC LIMIT 1
    `).get(c.id);

    const quote = db.prepare(`
      SELECT id, status, share_token, client_type, discount_type, discount_value,
             valid_days, client_accepted_at, created_at
      FROM quote_sheets WHERE case_id = ? ORDER BY id DESC LIMIT 1
    `).get(c.id);

    const dispatches = db.prepare(`
      SELECT dispatch_type, scheduled_date, status,
             GROUP_CONCAT(u.name, '、') as assignees
      FROM dispatches d
      LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
      LEFT JOIN users u ON u.id = du.user_id
      WHERE d.case_id = ?
      GROUP BY d.id ORDER BY d.scheduled_date
    `).all(c.id);

    const origin = req.headers.origin || `http://localhost:3000`;

    return {
      case: c,
      survey: survey ? {
        ...survey,
        sign_url: `${origin}/sign/${survey.share_token}`,
      } : null,
      quote: quote ? {
        ...quote,
        quote_url: `${origin}/quote/${quote.share_token}`,
        quote_number: `${c.case_number}-Q${quote.id}`,
      } : null,
      dispatches,
    };
  });

  res.json({ count: result.length, results: result });
});

// GET /api/search/case/:case_number — 精確查詢單一案件的完整連動資料
router.get('/case/:case_number', requireAuth, (req, res) => {
  const c = db.prepare(`
    SELECT c.*, cl.name as client_name, cl.phone as client_phone,
           s.name as sales_name, o.name as org_name
    FROM cases c
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users   s  ON s.id  = c.sales_id
    LEFT JOIN orgs    o  ON o.id  = c.org_id
    WHERE c.case_number = ?
  `).get(req.params.case_number);

  if (!c) return res.status(404).json({ error: '找不到此案件號' });

  const origin = req.headers.origin || `http://localhost:3000`;

  const survey = db.prepare(`
    SELECT id, status, share_token, survey_date, surveyor_id,
           site_address, client_signed_at, created_at
    FROM survey_forms WHERE case_id = ? ORDER BY id DESC LIMIT 1
  `).get(c.id);

  const quote = db.prepare(`
    SELECT id, status, share_token, client_type, discount_type, discount_value,
           marketing_label, payment_terms, valid_days, client_accepted_at, created_at
    FROM quote_sheets WHERE case_id = ? ORDER BY id DESC LIMIT 1
  `).get(c.id);

  const dispatches = db.prepare(`
    SELECT d.id, d.dispatch_type, d.scheduled_date, d.scheduled_time,
           d.status, d.estimated_hours, d.material,
           GROUP_CONCAT(u.name, '、') as assignees
    FROM dispatches d
    LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
    LEFT JOIN users u ON u.id = du.user_id
    WHERE d.case_id = ?
    GROUP BY d.id ORDER BY d.scheduled_date
  `).all(c.id);

  res.json({
    case: c,
    survey: survey ? { ...survey, sign_url: `${origin}/sign/${survey.share_token}` } : null,
    quote:  quote  ? { ...quote,  quote_url: `${origin}/quote/${quote.share_token}`,
                        quote_number: `${c.case_number}-Q${quote.id}` } : null,
    dispatches,
    _links: {
      case_detail:  `${origin}/case-detail?id=${c.id}`,
      survey_form:  `${origin}/survey-form?case_id=${c.id}`,
      sign_url:     survey ? `${origin}/sign/${survey.share_token}` : null,
      quote_url:    quote  ? `${origin}/quote/${quote.share_token}` : null,
    },
  });
});

module.exports = router;
