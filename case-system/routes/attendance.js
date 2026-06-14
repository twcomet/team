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

// 允許打卡的時段設定
const CLOCKIN_WINDOWS = [
  { label: '早班',     start: '06:30', end: '12:00', shiftStart: '09:00', lateAfter: '09:01' },
  { label: '下午時段', start: '13:00', end: '14:30', shiftStart: '14:00', lateAfter: '14:01' },
];

function getClockInWindow(now) {
  return CLOCKIN_WINDOWS.find(w => now >= w.start && now <= w.end) || null;
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

  // 打卡時段檢查
  const window = getClockInWindow(now);
  if (!window) {
    const windowList = CLOCKIN_WINDOWS.map(w => `${w.label} ${w.start}–${w.end}`).join('、');
    return res.status(400).json({
      error: 'Outside allowed hours',
      message: `目前不在打卡時段內。\n允許時段：${windowList}`,
    });
  }

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

  const isLate    = now >= window.lateAfter;
  const workStart = isLate ? now : window.shiftStart;

  if (existing) {
    db.prepare(`UPDATE attendance SET clock_in=?, work_start=?, is_late=?, clock_in_lat=?, clock_in_lng=?, location_type=? WHERE id=?`)
      .run(now, workStart, isLate ? 1 : 0, lat, lng, location_type, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance (user_id, work_date, clock_in, work_start, is_late, clock_in_lat, clock_in_lng, location_type) VALUES (?,?,?,?,?,?,?,?)`)
      .run(emp.id, today, now, workStart, isLate ? 1 : 0, lat, lng, location_type);
  }

  return res.json({ ok: true, time: now, is_late: isLate, location: location_name });
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
