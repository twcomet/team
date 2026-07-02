const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 營運日報（AI 總監 階段1a，純規則）：老闆/管理者可看
router.get('/summary', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.manage_users) {
    return res.status(403).json({ error: '無權限' });
  }
  const PRICE = `COALESCE(c.final_price, c.quoted_price, 0)`;
  const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { return {}; } };
  const many = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return []; } };

  // ── ① 業績概況 ──
  const revenue = {
    inbound_today:  one(`SELECT COUNT(*) n FROM cases c WHERE date(c.created_at,'localtime')=date('now','localtime')`).n || 0,
    inbound_month:  one(`SELECT COUNT(*) n FROM cases c WHERE strftime('%Y-%m',c.created_at,'localtime')=strftime('%Y-%m','now','localtime')`).n || 0,
    deal_today:     one(`SELECT COUNT(*) n FROM cases c WHERE date(c.contracted_at,'localtime')=date('now','localtime')`).n || 0,
    deal_month:     one(`SELECT COUNT(*) n FROM cases c WHERE strftime('%Y-%m',c.contracted_at,'localtime')=strftime('%Y-%m','now','localtime')`).n || 0,
    deal_amount_month: one(`SELECT COALESCE(SUM(${PRICE}),0) s FROM cases c WHERE strftime('%Y-%m',c.contracted_at,'localtime')=strftime('%Y-%m','now','localtime')`).s || 0,
  };

  // ── ② 施工狀況 ──
  const construction = {
    install_today: one(`SELECT COUNT(DISTINCT d.case_id) n FROM dispatches d WHERE d.dispatch_type='install' AND d.status!='cancelled' AND d.scheduled_date=date('now','localtime')`).n || 0,
    install_week:  one(`SELECT COUNT(*) n FROM dispatches d WHERE d.dispatch_type='install' AND d.status!='cancelled' AND d.scheduled_date BETWEEN date('now','localtime') AND date('now','localtime','+6 days')`).n || 0,
    reports_today: one(`SELECT COUNT(*) n FROM work_reports w WHERE date(w.submitted_at,'localtime')=date('now','localtime')`).n || 0,
    to_dispatch:   one(`SELECT COUNT(*) n FROM cases c WHERE c.status='contracted'`).n || 0,
    constructing:  one(`SELECT COUNT(*) n FROM cases c WHERE c.status IN ('dispatched','constructing')`).n || 0,
  };

  // ── ③ 需跟進紅燈 ──
  const surveyed_no_quote = many(`
    SELECT c.id, c.case_number, cl.name AS client_name, c.title,
           CAST(julianday('now','localtime') - julianday(COALESCE(c.surveyed_at, c.survey_date)) AS INT) AS days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status='surveyed' AND COALESCE(c.surveyed_at,c.survey_date) IS NOT NULL
      AND julianday('now','localtime') - julianday(COALESCE(c.surveyed_at,c.survey_date)) >= 3
    ORDER BY days DESC LIMIT 30`);

  const quoted_no_deal = many(`
    SELECT c.id, c.case_number, cl.name AS client_name, c.title, s.name AS sales_name,
           CAST(julianday('now','localtime') - julianday(c.quoted_at) AS INT) AS days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id LEFT JOIN users s ON s.id=c.sales_id
    WHERE c.status='quoted' AND c.quoted_at IS NOT NULL
      AND julianday('now','localtime') - julianday(c.quoted_at) >= 5
    ORDER BY days DESC LIMIT 30`);

  // 逾期收款：完工(施工日+7天緩衝已過) 但未收滿
  const overdue_payment = many(`
    SELECT c.id, c.case_number, cl.name AS client_name, c.title,
           ${PRICE} AS amount, COALESCE(c.payment_received,0) AS received,
           CAST(julianday('now','localtime') - julianday(c.scheduled_date,'+7 days') AS INT) AS overdue_days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status IN ('constructing','payment','closed','tech_accepted','dispatched')
      AND c.payment_status IS NOT 'paid'
      AND c.scheduled_date IS NOT NULL AND date(c.scheduled_date,'+7 days') < date('now','localtime')
      AND ${PRICE} > COALESCE(c.payment_received,0)
    ORDER BY overdue_days DESC LIMIT 30`);

  // 完工卻還沒開始收款（施工日已過、完全沒收到錢）
  const done_no_payment = many(`
    SELECT c.id, c.case_number, cl.name AS client_name, c.title, ${PRICE} AS amount
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status IN ('constructing','payment','tech_accepted','dispatched')
      AND c.scheduled_date IS NOT NULL AND c.scheduled_date < date('now','localtime')
      AND COALESCE(c.payment_received,0)=0 AND COALESCE(c.deposit_amount,0)=0
    ORDER BY c.scheduled_date ASC LIMIT 30`);

  // ── ④ 各部門現況 ──
  const departments = {
    cs:  {  // 客服：詢價/初估待處理
      inquiry_pending: one(`SELECT COUNT(*) n FROM cases c WHERE c.status IN ('inquiry','initial_estimate','quote_needed')`).n || 0,
      survey_todo:     one(`SELECT COUNT(*) n FROM cases c WHERE c.status IN ('survey_pending','survey_scheduled')`).n || 0,
    },
    sales: {  // 業務：待報價 / 已報價待成交
      to_quote: one(`SELECT COUNT(*) n FROM cases c WHERE c.status IN ('surveyed','quote_draft')`).n || 0,
      to_deal:  one(`SELECT COUNT(*) n FROM cases c WHERE c.status='quoted'`).n || 0,
    },
    accounting: {  // 會計：逾期收款數 / 待審核帳
      overdue_count: overdue_payment.length,
      ledger_pending: one(`SELECT COUNT(*) n FROM ledger_entries WHERE review_status='pending'`).n || 0,
    },
    tech: {  // 技術：今日施工 / 待施工 / 今日完工回報
      install_today: construction.install_today,
      to_dispatch:   construction.to_dispatch,
      reports_today: construction.reports_today,
    },
  };

  res.json({
    generated_at: new Date().toISOString(),
    revenue, construction,
    redflags: { surveyed_no_quote, quoted_no_deal, overdue_payment, done_no_payment },
    departments,
  });
});

module.exports = router;
