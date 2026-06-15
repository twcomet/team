const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function ownerOnly(req, res, next) {
  if (req.session.user?.role !== 'owner') return res.status(403).json({ error: '無權限' });
  next();
}

router.get('/', requireAuth, ownerOnly, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: '請提供 from / to' });

  // 每位有操作記錄的使用者統計
  const users = db.prepare(`
    SELECT
      u.id   AS user_id,
      u.name,
      u.username,
      COUNT(*)                                                          AS total_actions,
      COUNT(DISTINCT l.entity_id)                                       AS cases_touched,
      COUNT(DISTINCT CASE WHEN c.case_group='inquiry' THEN l.entity_id END) AS inquiry_cases,
      COUNT(DISTINCT CASE WHEN c.case_group='survey'  THEN l.entity_id END) AS survey_cases,
      COUNT(DISTINCT CASE WHEN c.case_group='deal'    THEN l.entity_id END) AS deal_cases,
      SUM(CASE WHEN l.action='advance' THEN 1 ELSE 0 END)               AS advances,
      SUM(CASE WHEN l.action='create'  THEN 1 ELSE 0 END)               AS creates,
      SUM(CASE WHEN l.action='update'  THEN 1 ELSE 0 END)               AS updates
    FROM audit_logs l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN cases c ON c.id = l.entity_id AND l.entity = 'cases'
    WHERE l.entity = 'cases'
      AND date(l.created_at, '+8 hours') BETWEEN ? AND ?
    GROUP BY u.id, u.name, u.username
    HAVING total_actions > 0
    ORDER BY cases_touched DESC, total_actions DESC
  `).all(from, to);

  // 每位使用者的每日案件明細
  const dailyStmt = db.prepare(`
    SELECT
      date(l.created_at, '+8 hours') AS date,
      COUNT(*)                        AS actions,
      COUNT(DISTINCT l.entity_id)     AS cases,
      SUM(CASE WHEN l.action='advance' THEN 1 ELSE 0 END) AS advances,
      SUM(CASE WHEN l.action='create'  THEN 1 ELSE 0 END) AS creates,
      SUM(CASE WHEN l.action='update'  THEN 1 ELSE 0 END) AS updates
    FROM audit_logs l
    WHERE l.entity = 'cases' AND l.user_id = ?
      AND date(l.created_at, '+8 hours') BETWEEN ? AND ?
    GROUP BY date(l.created_at, '+8 hours')
    ORDER BY date
  `);

  // 每位使用者的登入 session 匯總
  const loginSummaryStmt = db.prepare(`
    SELECT
      COUNT(*)                          AS login_count,
      COALESCE(SUM(
        CASE WHEN logout_at IS NOT NULL THEN duration_seconds
             ELSE CAST((julianday('now') - julianday(login_at)) * 86400 AS INTEGER)
        END
      ), 0)                             AS total_seconds,
      MAX(login_at)                     AS last_login_at
    FROM login_sessions
    WHERE user_id = ?
      AND date(login_at, '+8 hours') BETWEEN ? AND ?
  `);

  // 每位使用者的每日登入明細
  const dailyLoginStmt = db.prepare(`
    SELECT
      date(login_at, '+8 hours')        AS date,
      COUNT(*)                          AS login_count,
      COALESCE(SUM(
        CASE WHEN logout_at IS NOT NULL THEN duration_seconds
             ELSE CAST((julianday('now') - julianday(login_at)) * 86400 AS INTEGER)
        END
      ), 0)                             AS login_seconds
    FROM login_sessions
    WHERE user_id = ?
      AND date(login_at, '+8 hours') BETWEEN ? AND ?
    GROUP BY date(login_at, '+8 hours')
  `);

  const result = users.map(u => {
    const daily    = dailyStmt.all(u.user_id, from, to);
    const loginSum = loginSummaryStmt.get(u.user_id, from, to);
    const dailyLogins = dailyLoginStmt.all(u.user_id, from, to);

    // 合併每日案件 + 登入資料
    const loginMap = {};
    dailyLogins.forEach(d => { loginMap[d.date] = d; });
    const mergedDaily = daily.map(d => ({
      ...d,
      login_count:   loginMap[d.date]?.login_count  || 0,
      login_seconds: loginMap[d.date]?.login_seconds || 0,
    }));

    return {
      ...u,
      login_count:        loginSum?.login_count   || 0,
      total_login_seconds: loginSum?.total_seconds || 0,
      last_login_at:      loginSum?.last_login_at  || null,
      daily: mergedDaily,
    };
  });

  res.json(result);
});

// ── 出缺勤紅綠燈績效 ──────────────────────────────────────────
// 遲到（attendance.is_late）佔 7 分、缺失（deficiencies）佔 3 分，合計 10 分
// 燈號嚴重度：green > yellow > red > black；總燈號取兩指標中較差者
const LIGHT_RANK = { green: 3, yellow: 2, red: 1, black: 0 };

function lateScore(n) {
  if (n === 0)  return { light: 'green',  score: 7 };
  if (n <= 5)   return { light: 'yellow', score: 5 };
  if (n <= 10)  return { light: 'red',    score: 2 };
  return                { light: 'black',  score: 0 };
}
function deficiencyScore(n) {
  if (n === 0)  return { light: 'green',  score: 3 };
  if (n === 1)  return { light: 'yellow', score: 1.5 };
  if (n === 2)  return { light: 'red',    score: 0 };
  return                { light: 'black',  score: 0 };
}

router.get('/attendance', requireAuth, ownerOnly, (req, res) => {
  // month 格式 YYYY-MM，預設本月（台灣時區）
  const month = req.query.month
    || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month 格式須為 YYYY-MM' });

  // 全部在職員工（從完整清單載入，沒紀錄者也要顯示綠燈）
  const users = db.prepare(`
    SELECT id, name, username FROM users WHERE active = 1 ORDER BY name
  `).all();

  // 遲到次數（work_date 已是台灣當地日期，免時區校正）
  const lateRows = db.prepare(`
    SELECT user_id, COUNT(*) AS n
    FROM attendance
    WHERE is_late = 1 AND substr(work_date, 1, 7) = ?
    GROUP BY user_id
  `).all(month);
  const lateMap = {};
  lateRows.forEach(r => { lateMap[r.user_id] = r.n; });

  // 缺失件數（created_at 為 UTC，+8 小時換算台灣月份；以被點名人員計）
  const defRows = db.prepare(`
    SELECT dp.user_id, COUNT(*) AS n
    FROM deficiency_persons dp
    JOIN deficiencies d ON d.id = dp.deficiency_id
    WHERE strftime('%Y-%m', d.created_at, '+8 hours') = ?
    GROUP BY dp.user_id
  `).all(month);
  const defMap = {};
  defRows.forEach(r => { defMap[r.user_id] = r.n; });

  const result = users.map(u => {
    const lateCount = lateMap[u.id] || 0;
    const defCount  = defMap[u.id]  || 0;
    const late = lateScore(lateCount);
    const def  = deficiencyScore(defCount);
    const total = late.score + def.score;
    const overall = LIGHT_RANK[late.light] <= LIGHT_RANK[def.light] ? late.light : def.light;
    return {
      user_id: u.id, name: u.name, username: u.username,
      late_count: lateCount, late_light: late.light, late_score: late.score,
      deficiency_count: defCount, deficiency_light: def.light, deficiency_score: def.score,
      total_score: total, overall_light: overall,
    };
  });

  // 問題優先：總分低的排前面，方便主管一眼看到需要關注的人
  result.sort((a, b) => a.total_score - b.total_score || a.name.localeCompare(b.name));

  res.json({ month, max_score: 10, employees: result });
});

module.exports = router;
