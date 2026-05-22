const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// GET /api/search?q=HX2605-001
// 用案件號（完整或部分）或客戶名稱搜尋，回傳案件 + 所有關聯單據
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
