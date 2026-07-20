const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 公司座標（可透過環境變數覆蓋）
const COMPANY_LAT    = parseFloat(process.env.COMPANY_LAT || '24.95744456377013');
const COMPANY_LNG    = parseFloat(process.env.COMPANY_LNG || '121.34953081108718');
const COMPANY_RADIUS = 500;  // 公尺
const SITE_RADIUS    = 300;

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function verifyLineToken(access_token) {
  try {
    const r = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function getEmployee(req) {
  if (req.session?.user) {
    return db.prepare(`SELECT id, name FROM users WHERE id=? AND active=1`).get(req.session.user.id);
  }
  const { access_token } = req.body;
  if (!access_token) return null;
  const profile = await verifyLineToken(access_token);
  if (!profile?.userId) return null;
  return db.prepare(`SELECT id, name FROM users WHERE line_user_id=? AND active=1`).get(profile.userId);
}

function todayTW() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}
function nowTimeTW() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }).slice(0, 5);
}

// 四個固定班別。準時窗 = 表定上班前 15 分鐘那一段；下班 = 基準 +9 小時（含午休 1h、實際工時 8h）
const ONTIME_LEAD = 15;       // 準時窗長度（分鐘）
const WORK_SPAN   = 9 * 60;   // 上班基準 +9 小時 = 下班
const SHIFTS = [
  { key: 'early',  label: '提早班', start: '08:00' },   // 07:45–08:00 準時，下班 17:00
  { key: 'normal', label: '正常班', start: '09:00' },   // 08:45–09:00 準時，下班 18:00
  { key: 'noon',   label: '下午班', start: '14:00' },   // 13:45–14:00 準時，下班 23:00
  { key: 'night',  label: '晚班',   start: '20:00' },   // 19:45–20:00 準時，下班 隔日 05:00
];
const _toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
// 分鐘 → {time:'HH:MM', next_day:是否跨日}
const _fmtMin = mins => {
  const next_day = mins >= 1440;
  const m = ((mins % 1440) + 1440) % 1440;
  return { time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, next_day };
};

// 依打卡時間分類：歸到「時間最接近」的班別，早到=特殊、準時、晚到=遲到（全天皆可打卡）
function classifyPunch(now) {
  const t = _toMin(now);
  let shift = SHIFTS[0], best = Infinity;
  for (const s of SHIFTS) { const d = Math.abs(t - _toMin(s.start)); if (d <= best) { best = d; shift = s; } } // 平手取較晚的班（早到）
  const st = _toMin(shift.start);
  let type, isLate, outMin, workStartMin;
  if (t >= st - ONTIME_LEAD && t <= st) { type = 'ontime';  isLate = false; workStartMin = st; outMin = st + WORK_SPAN; }  // 準時 → 下班用表定
  else if (t > st)                       { type = 'late';    isLate = true;  workStartMin = t;  outMin = t  + WORK_SPAN; }  // 晚到 → 遲到，下班用實際 +9h
  else                                   { type = 'special'; isLate = false; workStartMin = t;  outMin = t  + WORK_SPAN; }  // 早到/離峰 → 特殊，不算遲到
  return { shift, type, isLate, out: _fmtMin(outMin), workStart: _fmtMin(workStartMin).time };
}

// ── 打卡（上班）────────────────────────────────────────────────
router.post('/clockin', async (req, res) => {
  const emp = await getEmployee(req);
  if (!emp) return res.status(401).json({ error: 'Unauthorized' });

  const lat = parseFloat(req.body.lat);
  const lng = parseFloat(req.body.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Location required' });

  const today = todayTW();
  const now   = nowTimeTW();

  // 全天皆可打卡，依打卡時間自動判定班別／準時／遲到／特殊時段
  const cls = classifyPunch(now);

  // 今天已打卡
  const existing = db.prepare(`SELECT * FROM attendance WHERE user_id=? AND work_date=?`).get(emp.id, today);
  if (existing?.clock_in) return res.status(409).json({ error: 'Already clocked in', time: existing.clock_in });

  // 定位驗證
  const companyDist = distanceM(lat, lng, COMPANY_LAT, COMPANY_LNG);
  let location_type = null;
  let location_name = '公司';

  if (companyDist <= COMPANY_RADIUS) {
    location_type = 'company';
  } else {
    const dispatches = db.prepare(`
      SELECT c.title, c.lat AS clat, c.lng AS clng
      FROM dispatches d
      JOIN dispatch_users du ON du.dispatch_id = d.id
      JOIN cases c ON c.id = d.case_id
      WHERE d.scheduled_date=? AND du.user_id=? AND c.lat IS NOT NULL AND c.lat != 0
    `).all(today, emp.id);

    for (const site of dispatches) {
      if (distanceM(lat, lng, site.clat, site.clng) <= SITE_RADIUS) {
        location_type = 'site';
        location_name = site.title || '案場';
        break;
      }
    }
  }

  if (!location_type) {
    return res.status(400).json({
      error: 'Too far',
      message: `距離公司 ${Math.round(companyDist)} 公尺，超出打卡範圍（${COMPANY_RADIUS} 公尺）`,
      distance: Math.round(companyDist),
    });
  }

  const isLate    = cls.isLate;
  const workStart = cls.workStart;
  const autoOut   = cls.out.time;           // 下班 = 基準 +9 小時（晚班會跨日）
  const clockType = cls.type;               // ontime / late / special

  if (existing) {
    db.prepare(`UPDATE attendance SET clock_in=?, work_start=?, is_late=?, clock_in_lat=?, clock_in_lng=?, location_type=?, clock_out=?, work_end=?, auto_clock_out=1, clock_type=? WHERE id=?`)
      .run(now, workStart, isLate ? 1 : 0, lat, lng, location_type, autoOut, autoOut, clockType, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance (user_id, work_date, clock_in, work_start, is_late, clock_in_lat, clock_in_lng, location_type, clock_out, work_end, auto_clock_out, clock_type) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(emp.id, today, now, workStart, isLate ? 1 : 0, lat, lng, location_type, autoOut, autoOut, clockType);
  }

  // 遲到 → 即時提醒員工（站內通知 + LINE），並告知本月累積次數與全勤獎金影響
  if (isLate) {
    try {
      const ym = today.slice(0, 7);
      const lateCount = db.prepare(`SELECT COUNT(*) n FROM attendance WHERE user_id=? AND work_date LIKE ? AND is_late=1`).get(emp.id, `${ym}-%`).n;
      const warn = lateCount > 5 ? '\n⚠️ 本月遲到已超過 5 次，將影響全勤獎金。'
                 : lateCount === 5 ? '\n⚠️ 本月遲到已達 5 次，再遲到將影響全勤獎金。' : '';
      const body = `你今天遲到了（${now} 打卡）。本月已遲到 ${lateCount} 次。${warn}\n請注意你的出缺勤。`;
      db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'attendance','users',?,?)`)
        .run(emp.id, '⏰ 出勤提醒：今天遲到', body, emp.id, '/my-tasks');
      const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(emp.id);
      if (u?.line_user_id) { const { pushMessage } = require('./webhook'); pushMessage(u.line_user_id, `⏰ 出勤提醒\n${body}`).catch(() => {}); }
    } catch (e) { /* non-critical */ }
  }

  // 打卡後更新今日出勤異常事件（10:00 後才作用）：把剛打卡的人移出未打卡、遲到者改列遲到
  try { const att = require('../lib/attendance-util'); att.syncAnomalyIfDue(today); } catch (e) {}

  const outDisp = cls.out.next_day ? `隔日 ${autoOut}` : autoOut;
  return res.json({
    ok: true, time: now, is_late: isLate, location: location_name,
    clock_out: autoOut, clock_out_display: outDisp, next_day: cls.out.next_day,
    shift: cls.shift.label, clock_type: clockType,
  });
});

// ── 打卡（下班）────────────────────────────────────────────────
router.post('/clockout', async (req, res) => {
  const emp = await getEmployee(req);
  if (!emp) return res.status(401).json({ error: 'Unauthorized' });

  const lat = parseFloat(req.body.lat);
  const lng = parseFloat(req.body.lng);
  const today = todayTW();
  const now   = nowTimeTW();

  const existing = db.prepare(`SELECT * FROM attendance WHERE user_id=? AND work_date=?`).get(emp.id, today);
  if (!existing?.clock_in) return res.status(400).json({ error: 'Not clocked in' });
  if (existing.clock_out)  return res.status(409).json({ error: 'Already clocked out', time: existing.clock_out });

  db.prepare(`UPDATE attendance SET clock_out=?, work_end=?, clock_out_lat=?, clock_out_lng=? WHERE id=?`)
    .run(now, now, isNaN(lat) ? null : lat, isNaN(lng) ? null : lng, existing.id);

  return res.json({ ok: true, time: now });
});

// ── 今日狀態（供 LIFF 頁面查詢，以 access_token 驗證）────────
router.post('/status', async (req, res) => {
  const emp = await getEmployee(req);
  if (!emp) return res.status(401).json({ error: 'Unauthorized' });

  const today = todayTW();
  const record = db.prepare(`SELECT * FROM attendance WHERE user_id=? AND work_date=?`).get(emp.id, today);

  const dispatches = db.prepare(`
    SELECT d.scheduled_date, d.dispatch_type, d.scheduled_time, c.title, c.location
    FROM dispatches d
    JOIN dispatch_users du ON du.dispatch_id = d.id
    JOIN cases c ON c.id = d.case_id
    WHERE d.scheduled_date=? AND du.user_id=?
    ORDER BY d.scheduled_time
  `).all(today, emp.id);

  res.json({ name: emp.name, today, record: record || null, dispatches });
});

// ── 今日出勤（web session）──────────────────────────────────
router.get('/today', requireAuth, (req, res) => {
  const today = todayTW();
  res.json(db.prepare(`SELECT * FROM attendance WHERE user_id=? AND work_date=?`).get(req.session.user.id, today) || {});
});

// ── 當月出勤（web session）──────────────────────────────────
router.get('/monthly', requireAuth, (req, res) => {
  const { year, month } = req.query;
  const ym = year && month ? `${year}-${String(month).padStart(2,'0')}` : todayTW().slice(0, 7);
  res.json(db.prepare(`SELECT * FROM attendance WHERE user_id=? AND work_date LIKE ? ORDER BY work_date`)
    .all(req.session.user.id, `${ym}-%`));
});

// ── 申請請假（web session）──────────────────────────────────
router.post('/leave', requireAuth, (req, res) => {
  const { leave_type, leave_date, leave_end_date, hours, reason } = req.body;
  if (!leave_type || !leave_date || !hours) return res.status(400).json({ error: 'Missing fields' });
  const valid = ['特休','病假','事假','生理假','家庭照顧假','公假','婚假','喪假','產假','產檢假','補休/調休','其他'];
  if (!valid.includes(leave_type)) return res.status(400).json({ error: 'Invalid leave_type' });

  const endDate = leave_end_date && leave_end_date >= leave_date ? leave_end_date : null;
  const r = db.prepare(`INSERT INTO leave_requests (user_id, leave_type, leave_date, leave_end_date, hours, reason) VALUES (?,?,?,?,?,?)`)
    .run(req.session.user.id, leave_type, leave_date, endDate, parseFloat(hours), reason ?? null);

  const hrs  = db.prepare(`SELECT id FROM users WHERE role IN ('owner','hq_hr') AND active=1`).all();
  const user = db.prepare(`SELECT name FROM users WHERE id=?`).get(req.session.user.id);
  const dateRange = endDate && endDate !== leave_date ? `${leave_date} ~ ${endDate}` : leave_date;
  const insN = db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'leave','users',?,?)`);
  for (const h of hrs) {
    insN.run(h.id, `${user?.name} 申請請假`, `${leave_type}｜${dateRange}｜${hours}小時${reason ? '\n'+reason : ''}`, req.session.user.id, '/leave');
  }

  res.json({ ok: true, id: r.lastInsertRowid });
});

// ── 申請補打卡（web session）────────────────────────────────
router.post('/makeup', requireAuth, (req, res) => {
  const { makeup_date, reason } = req.body;
  if (!makeup_date || !reason) return res.status(400).json({ error: 'Missing fields' });

  db.prepare(`INSERT INTO makeup_requests (user_id, makeup_date, reason) VALUES (?,?,?)`)
    .run(req.session.user.id, makeup_date, reason);

  const hrs  = db.prepare(`SELECT id FROM users WHERE role IN ('owner','hq_hr') AND active=1`).all();
  const user = db.prepare(`SELECT name FROM users WHERE id=?`).get(req.session.user.id);
  const insN = db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'makeup','users',?,?)`);
  for (const h of hrs) {
    insN.run(h.id, `${user?.name} 申請補打卡`, `補打卡日期：${makeup_date}\n${reason}`, req.session.user.id, '/hr');
  }

  res.json({ ok: true });
});

module.exports = router;
