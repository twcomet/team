// AI 用量監控：儀表板資料 + 門檻設定 + 提醒檢查
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { FEATURE_LABEL } = require('../lib/ai-usage');

function ownerOnly(req, res, next) {
  if (req.session.user?.role === 'owner') return next();
  return res.status(403).json({ error: '此功能僅開放給老闆使用' });
}
function getSettings() {
  return db.prepare(`SELECT daily_limit_usd, alert_enabled FROM ai_usage_settings WHERE id=1`).get()
    || { daily_limit_usd: 5, alert_enabled: 1 };
}
function todayCost() {
  return db.prepare(`SELECT COALESCE(SUM(est_cost_usd),0) c, COUNT(*) n
                     FROM ai_usage_log WHERE date(created_at)=date('now','localtime')`).get();
}

// 儀表板總覽（老闆）
router.get('/summary', requireAuth, ownerOnly, (req, res) => {
  const today = todayCost();
  const month = db.prepare(`SELECT COALESCE(SUM(est_cost_usd),0) c, COUNT(*) n
                            FROM ai_usage_log WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime')`).get();
  const byFeatureToday = db.prepare(`SELECT feature, COUNT(*) n, COALESCE(SUM(est_cost_usd),0) c,
                                     COALESCE(SUM(input_tokens),0) it, COALESCE(SUM(output_tokens),0) ot
                                     FROM ai_usage_log WHERE date(created_at)=date('now','localtime')
                                     GROUP BY feature ORDER BY c DESC`).all();
  const byFeatureMonth = db.prepare(`SELECT feature, COUNT(*) n, COALESCE(SUM(est_cost_usd),0) c
                                     FROM ai_usage_log WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now','localtime')
                                     GROUP BY feature ORDER BY c DESC`).all();
  const byUserMonth = db.prepare(`SELECT u.name, COUNT(*) n, COALESCE(SUM(l.est_cost_usd),0) c
                                  FROM ai_usage_log l LEFT JOIN users u ON u.id=l.user_id
                                  WHERE strftime('%Y-%m',l.created_at)=strftime('%Y-%m','now','localtime')
                                  GROUP BY l.user_id ORDER BY c DESC LIMIT 20`).all();
  const last14 = db.prepare(`SELECT date(created_at) d, COALESCE(SUM(est_cost_usd),0) c, COUNT(*) n
                             FROM ai_usage_log WHERE created_at >= datetime('now','localtime','-13 days')
                             GROUP BY d ORDER BY d`).all();
  const recent = db.prepare(`SELECT l.created_at, l.feature, l.model, l.input_tokens, l.output_tokens,
                             l.est_cost_usd, u.name AS user_name
                             FROM ai_usage_log l LEFT JOIN users u ON u.id=l.user_id
                             ORDER BY l.id DESC LIMIT 60`).all();
  const s = getSettings();
  const label = f => FEATURE_LABEL[f] || f || '其他';
  res.json({
    today: { cost: today.c, count: today.n },
    month: { cost: month.c, count: month.n },
    byFeatureToday: byFeatureToday.map(r => ({ ...r, label: label(r.feature) })),
    byFeatureMonth: byFeatureMonth.map(r => ({ ...r, label: label(r.feature) })),
    byUserMonth,
    last14,
    recent: recent.map(r => ({ ...r, label: label(r.feature) })),
    settings: s,
    over_limit: !!s.alert_enabled && today.c >= s.daily_limit_usd,
  });
});

// 輕量提醒檢查（給 common.js 每頁載入時呼叫；老闆才回 over=true）
router.get('/alert', requireAuth, (req, res) => {
  if (req.session.user?.role !== 'owner') return res.json({ over: false });
  const s = getSettings();
  const today = todayCost();
  res.json({
    over: !!s.alert_enabled && today.c >= s.daily_limit_usd,
    today_usd: Number(today.c.toFixed(2)),
    limit_usd: s.daily_limit_usd,
  });
});

// 設定（老闆）：每日門檻、是否開啟提醒
router.get('/settings', requireAuth, ownerOnly, (req, res) => res.json(getSettings()));
router.put('/settings', requireAuth, ownerOnly, (req, res) => {
  const limit = Math.max(0, Number(req.body.daily_limit_usd) || 0);
  const enabled = req.body.alert_enabled ? 1 : 0;
  db.prepare(`UPDATE ai_usage_settings SET daily_limit_usd=?, alert_enabled=? WHERE id=1`).run(limit, enabled);
  res.json({ ok: true, daily_limit_usd: limit, alert_enabled: enabled });
});

module.exports = router;
