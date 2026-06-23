const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router = express.Router();

function requireHR(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  if (u.role === 'owner' || u.role === 'hq_hr') return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// ── 特休天數計算 ──────────────────────────────────────────────────────────────
function calcAnnualLeave(hireDateStr, year) {
  if (!hireDateStr) return 0;
  const hire = new Date(hireDateStr + 'T00:00:00');
  const hireYear = hire.getFullYear();
  const hireMonth = hire.getMonth(); // 0-indexed

  if (year < hireYear) return 0;

  if (year === hireYear) {
    // 入職當年：從入職月到12月共幾個月
    const monthsWorked = 12 - hireMonth;
    if (monthsWorked < 6) return 0;
    return Math.ceil(monthsWorked / 12 * 3);
  }

  // 之後年度：計算截至 1/1 的年資
  const jan1 = new Date(year, 0, 1);
  let yrs = jan1.getFullYear() - hire.getFullYear();
  const mDiff = jan1.getMonth() - hire.getMonth();
  if (mDiff < 0 || (mDiff === 0 && jan1.getDate() < hire.getDate())) yrs--;

  if (yrs < 0) return 0;
  if (yrs < 1) return 3;
  if (yrs < 2) return 7;
  if (yrs < 3) return 10;
  if (yrs < 5) return 14;
  if (yrs < 10) return 15;
  return Math.min(15 + (yrs - 10), 30);
}

// GET /api/hr/employees
router.get('/employees', requireAuth, requireHR, (req, res) => {
  const employees = db.prepare(`
    SELECT id, name, username, role, department, active, hire_date, birthday, org_id
    FROM users ORDER BY sort_order, name
  `).all();
  res.json(employees);
});

// GET /api/hr/employees/:id
router.get('/employees/:id', requireAuth, requireHR, (req, res) => {
  const u = db.prepare(`
    SELECT id, name, username, role, department, active, hire_date,
           id_number, bank_account, bank_name, birthday, home_address,
           emergency_contact, emergency_phone, hr_notes, org_id
    FROM users WHERE id=?
  `).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });

  const year = new Date().getFullYear();
  const entitlement = calcAnnualLeave(u.hire_date, year);

  const usedSpecial = db.prepare(`
    SELECT COALESCE(SUM(hours)/8.0, 0) AS days
    FROM leave_requests
    WHERE user_id=? AND leave_type='特休' AND status='approved'
    AND strftime('%Y', leave_date)=?
  `).get(req.params.id, String(year))?.days || 0;

  const adjustments = db.prepare(`
    SELECT la.*, u.name AS adjusted_by_name
    FROM leave_adjustments la
    LEFT JOIN users u ON u.id = la.adjusted_by
    WHERE la.user_id=? AND la.year=? ORDER BY la.created_at DESC
  `).all(req.params.id, year);
  const adjustTotal = adjustments.reduce((s, a) => s + a.days, 0);

  u.leave_year        = year;
  u.leave_entitlement = entitlement;
  u.leave_used        = Math.round(usedSpecial * 10) / 10;
  u.leave_adjustments = Math.round(adjustTotal * 10) / 10;
  u.leave_remaining   = Math.round((entitlement - usedSpecial + adjustTotal) * 10) / 10;
  u.leave_adjustment_list = adjustments;

  u.leave_requests = db.prepare(`
    SELECT lr.*, u.name AS reviewer_name
    FROM leave_requests lr
    LEFT JOIN users u ON u.id = lr.reviewed_by
    WHERE lr.user_id=? ORDER BY lr.leave_date DESC LIMIT 50
  `).all(req.params.id);

  u.attendance = db.prepare(`
    SELECT * FROM attendance WHERE user_id=? ORDER BY work_date DESC LIMIT 60
  `).all(req.params.id);

  u.makeup_requests = db.prepare(`
    SELECT mr.*, u.name AS reviewer_name
    FROM makeup_requests mr
    LEFT JOIN users u ON u.id = mr.reviewed_by
    WHERE mr.user_id=? ORDER BY mr.created_at DESC LIMIT 30
  `).all(req.params.id);

  res.json(u);
});

// PUT /api/hr/employees/:id
router.put('/employees/:id', requireAuth, requireHR, (req, res) => {
  const { hire_date, id_number, bank_account, bank_name, birthday,
          home_address, emergency_contact, emergency_phone, hr_notes } = req.body;
  db.prepare(`
    UPDATE users SET hire_date=?, id_number=?, bank_account=?, bank_name=?,
    birthday=?, home_address=?, emergency_contact=?, emergency_phone=?, hr_notes=?
    WHERE id=?
  `).run(hire_date||null, id_number||null, bank_account||null, bank_name||null,
         birthday||null, home_address||null, emergency_contact||null,
         emergency_phone||null, hr_notes||null, req.params.id);
  res.json({ ok: true });
});

// ── 個人資料（本人自覽）──────────────────────────────────────────
router.get('/my-profile', requireAuth, (req, res) => {
  const id = req.session.user.id;
  const u = db.prepare(`
    SELECT id, name, username, role, department, org_id, hire_date,
           birthday, home_address, emergency_contact, emergency_phone,
           bank_name, bank_account, line_user_id
    FROM users WHERE id=?
  `).get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });

  const year = new Date().getFullYear();
  const entitlement = calcAnnualLeave(u.hire_date, year);
  const usedSpecial = db.prepare(`
    SELECT COALESCE(SUM(hours)/8.0, 0) AS days FROM leave_requests
    WHERE user_id=? AND leave_type='特休' AND status='approved'
    AND strftime('%Y', leave_date)=?
  `).get(id, String(year))?.days || 0;
  const adjustTotal = db.prepare(`
    SELECT COALESCE(SUM(days),0) AS total FROM leave_adjustments WHERE user_id=? AND year=?
  `).get(id, year)?.total || 0;

  u.leave_entitlement = entitlement;
  u.leave_used        = Math.round(usedSpecial * 10) / 10;
  u.leave_remaining   = Math.round((entitlement - usedSpecial + adjustTotal) * 10) / 10;
  u.line_bound        = !!u.line_user_id;
  delete u.line_user_id;

  const org = db.prepare(`SELECT name FROM orgs WHERE id=?`).get(u.org_id);
  u.org_name = org?.name || '';

  res.json(u);
});

// ── 個人資料（本人自填）──────────────────────────────────────────
router.put('/my-profile', requireAuth, (req, res) => {
  const id = req.session.user.id;
  const { birthday, home_address, emergency_contact, emergency_phone, bank_name, bank_account } = req.body;
  db.prepare(`
    UPDATE users SET birthday=?, home_address=?, emergency_contact=?,
    emergency_phone=?, bank_name=?, bank_account=? WHERE id=?
  `).run(birthday||null, home_address||null, emergency_contact||null,
         emergency_phone||null, bank_name||null, bank_account||null, id);
  res.json({ ok: true });
});

// GET /api/hr/pending — 待審核列表
router.get('/pending', requireAuth, requireHR, (req, res) => {
  const leave = db.prepare(`
    SELECT lr.*, u.name AS user_name
    FROM leave_requests lr JOIN users u ON u.id=lr.user_id
    WHERE lr.status='pending' ORDER BY lr.created_at
  `).all();
  const makeup = db.prepare(`
    SELECT mr.*, u.name AS user_name
    FROM makeup_requests mr JOIN users u ON u.id=mr.user_id
    WHERE mr.status='pending' ORDER BY mr.created_at
  `).all();
  res.json({ leave, makeup });
});

// GET /api/hr/leave-requests — 請假申請列表
router.get('/leave-requests', requireAuth, (req, res) => {
  const me = req.session.user;
  const isHR = me.role === 'owner' || me.role === 'hq_hr' || !!me.manage_users;
  const { status, user_id, month, date } = req.query;

  let sql = `
    SELECT lr.*, u.name AS user_name, rv.name AS reviewed_by_name
    FROM leave_requests lr
    JOIN users u ON u.id = lr.user_id
    LEFT JOIN users rv ON rv.id = lr.reviewed_by
    WHERE 1=1
  `;
  const params = [];

  if (!isHR) {
    sql += ` AND lr.user_id = ?`; params.push(me.id);
  } else if (user_id) {
    sql += ` AND lr.user_id = ?`; params.push(user_id);
  }
  if (status) { sql += ` AND lr.status = ?`; params.push(status); }
  if (date)   { sql += ` AND lr.leave_date <= ? AND COALESCE(lr.leave_end_date, lr.leave_date) >= ?`; params.push(date, date); }
  else if (month) { sql += ` AND lr.leave_date LIKE ?`; params.push(`${month}%`); }
  sql += ` ORDER BY lr.created_at DESC`;

  res.json(db.prepare(sql).all(...params));
});

// DELETE /api/hr/leave-requests/:id — 員工撤銷 / HR刪除
router.delete('/leave-requests/:id', requireAuth, (req, res) => {
  const lr = db.prepare(`SELECT * FROM leave_requests WHERE id = ?`).get(req.params.id);
  if (!lr) return res.status(404).json({ error: '找不到請假申請' });
  const me = req.session.user;
  const isHR = me.role === 'owner' || me.role === 'hq_hr' || !!me.manage_users;
  if (lr.user_id !== me.id && !isHR) return res.status(403).json({ error: '無權限' });
  if (lr.status === 'approved' && !isHR) return res.status(400).json({ error: '已核准的請假無法自行取消，請聯繫 HR' });
  db.prepare(`DELETE FROM leave_requests WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// PUT /api/hr/leave-requests/:id/review
router.put('/leave-requests/:id/review', requireAuth, requireHR, (req, res) => {
  const { status, review_note } = req.body;
  if (!['approved','rejected','pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  // 撤回：改回審核中，清除審核結果（不推播）
  if (status === 'pending') {
    db.prepare(`UPDATE leave_requests SET status='pending', review_note=NULL, reviewed_by=NULL, reviewed_at=NULL WHERE id=?`).run(req.params.id);
    return res.json({ ok: true });
  }
  db.prepare(`UPDATE leave_requests SET status=?, review_note=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, review_note||null, req.session.user.id, req.params.id);

  // 推播結果給員工
  const lr = db.prepare(`SELECT lr.*, u.line_user_id, u.name FROM leave_requests lr JOIN users u ON u.id=lr.user_id WHERE lr.id=?`).get(req.params.id);
  if (lr?.line_user_id) {
    const label = status === 'approved' ? '✅ 已核准' : '❌ 已拒絕';
    const msg = `【請假審核結果】${label}\n${lr.leave_type}｜${lr.leave_date}｜${lr.hours}小時${review_note ? '\n備註：'+review_note : ''}`;
    pushMessage(lr.line_user_id, msg).catch(() => {});
  }
  res.json({ ok: true });
});

// PUT /api/hr/leave-requests/:id — HR 編輯請假內容（員工填錯時代為修正）
router.put('/leave-requests/:id', requireAuth, requireHR, (req, res) => {
  const { leave_type, leave_date, leave_end_date, hours, reason } = req.body;
  if (!leave_type || !leave_date || !hours) return res.status(400).json({ error: '假別、日期、時數為必填' });
  const exists = db.prepare(`SELECT id FROM leave_requests WHERE id=?`).get(req.params.id);
  if (!exists) return res.status(404).json({ error: '找不到請假申請' });
  db.prepare(`UPDATE leave_requests SET leave_type=?, leave_date=?, leave_end_date=?, hours=?, reason=? WHERE id=?`)
    .run(leave_type, leave_date, leave_end_date || null, Number(hours), reason || null, req.params.id);
  res.json({ ok: true });
});

// PUT /api/hr/makeup-requests/:id/review
router.put('/makeup-requests/:id/review', requireAuth, requireHR, (req, res) => {
  const { status, review_note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE makeup_requests SET status=?, review_note=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, review_note||null, req.session.user.id, req.params.id);
  if (status === 'approved') {
    const mr = db.prepare(`SELECT * FROM makeup_requests WHERE id=?`).get(req.params.id);
    if (mr) {
      const existing = db.prepare(`SELECT id FROM attendance WHERE user_id=? AND work_date=?`).get(mr.user_id, mr.makeup_date);
      if (!existing) {
        db.prepare(`INSERT INTO attendance (user_id, work_date, clock_in, work_start, is_late) VALUES (?,?,'09:00','09:00',0)`)
          .run(mr.user_id, mr.makeup_date);
      }
    }
  }

  // 推播結果給員工
  const mr2 = db.prepare(`SELECT mr.*, u.line_user_id FROM makeup_requests mr JOIN users u ON u.id=mr.user_id WHERE mr.id=?`).get(req.params.id);
  if (mr2?.line_user_id) {
    const label = status === 'approved' ? '✅ 已核准' : '❌ 已拒絕';
    const msg = `【補打卡審核結果】${label}\n補打卡日期：${mr2.makeup_date}${review_note ? '\n備註：'+review_note : ''}`;
    pushMessage(mr2.line_user_id, msg).catch(() => {});
  }
  res.json({ ok: true });
});

// POST /api/hr/leave-adjustments
router.post('/leave-adjustments', requireAuth, requireHR, (req, res) => {
  const { user_id, year, days, reason } = req.body;
  if (!user_id || !year || days === undefined || !reason) return res.status(400).json({ error: 'Missing fields' });
  db.prepare(`INSERT INTO leave_adjustments (user_id, year, days, reason, adjusted_by) VALUES (?,?,?,?,?)`)
    .run(user_id, year, parseFloat(days), reason, req.session.user.id);
  res.json({ ok: true });
});

// GET /api/hr/leave-calc?hire_date=YYYY-MM-DD&year=2026
router.get('/leave-calc', requireAuth, requireHR, (req, res) => {
  const { hire_date, year } = req.query;
  res.json({ days: calcAnnualLeave(hire_date, parseInt(year || new Date().getFullYear())) });
});

// GET /api/hr/attendance-summary?year=YYYY&month=MM — 全員月出勤統計
router.get('/attendance-summary', requireAuth, requireHR, (req, res) => {
  const now = new Date();
  const year  = parseInt(req.query.year  || now.getFullYear());
  const month = parseInt(req.query.month || now.getMonth() + 1);
  const ym = `${year}-${String(month).padStart(2,'0')}`;

  const employees = db.prepare(`SELECT id, name, role, active FROM users WHERE active=1 ORDER BY sort_order, name`).all();

  const result = employees.map(emp => {
    const records = db.prepare(`SELECT * FROM attendance WHERE user_id=? AND work_date LIKE ? ORDER BY work_date`)
      .all(emp.id, `${ym}-%`);
    const lateCount    = records.filter(r => r.is_late).length;
    const workedDays   = records.filter(r => r.clock_in).length;
    const autoOut      = records.filter(r => r.auto_clock_out).length;
    // 請假天數
    const leaveHours   = db.prepare(`SELECT COALESCE(SUM(hours),0) AS h FROM leave_requests WHERE user_id=? AND status='approved' AND leave_date LIKE ?`)
      .get(emp.id, `${ym}-%`)?.h || 0;
    return {
      id: emp.id, name: emp.name, role: emp.role,
      worked_days: workedDays, late_count: lateCount, auto_out: autoOut,
      leave_hours: leaveHours,
      records,
    };
  });

  res.json({ year, month, employees: result });
});

// GET /api/hr/monitoring?year=&month= — 人事監控報表
router.get('/monitoring', requireAuth, requireHR, (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || now.getMonth() + 1);
    const ym = `${year}-${String(month).padStart(2,'0')}`;

    const employees = db.prepare(`SELECT id, name FROM users WHERE active=1 ORDER BY sort_order, name`).all();

    // 遲到：只列有遲到記錄的員工
    const lateList = [];
    for (const emp of employees) {
      const records = db.prepare(`
        SELECT id, work_date, clock_in, clock_out, is_late
        FROM attendance WHERE user_id=? AND work_date LIKE ? ORDER BY work_date
      `).all(emp.id, `${ym}-%`);
      const lateRecs = records.filter(r => r.is_late);
      if (lateRecs.length) lateList.push({ user_id: emp.id, name: emp.name, late_count: lateRecs.length, records: lateRecs });
    }

    // 補打卡：本月全部申請
    const makeupList = db.prepare(`
      SELECT mr.*, u.name AS user_name, rv.name AS reviewer_name
      FROM makeup_requests mr
      JOIN users u ON u.id = mr.user_id
      LEFT JOIN users rv ON rv.id = mr.reviewed_by
      WHERE mr.makeup_date LIKE ?
      ORDER BY mr.makeup_date, u.name
    `).all(`${ym}-%`);

    // 請假：本月全部申請（含所有狀態），依員工分組
    const leaveRows = db.prepare(`
      SELECT lr.*, u.name AS user_name, rv.name AS reviewer_name
      FROM leave_requests lr
      JOIN users u ON u.id = lr.user_id
      LEFT JOIN users rv ON rv.id = lr.reviewed_by
      WHERE lr.leave_date LIKE ?
      ORDER BY u.name, lr.leave_date
    `).all(`${ym}-%`);

    const leaveMap = {};
    for (const r of leaveRows) {
      if (!leaveMap[r.user_id]) leaveMap[r.user_id] = { user_id: r.user_id, name: r.user_name, requests: [], total_hours: 0 };
      leaveMap[r.user_id].requests.push(r);
      if (r.status === 'approved') leaveMap[r.user_id].total_hours += r.hours || 0;
    }

    res.json({ year, month, lateList, makeupList, leaveList: Object.values(leaveMap) });
  } catch (err) {
    console.error('[hr/monitoring]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/hr/attendance/:id — 修改打卡時間 / 遲到標記
router.put('/attendance/:id', requireAuth, requireHR, (req, res) => {
  const { is_late, clock_in, clock_out } = req.body;
  const fields = [], vals = [];
  if (is_late  !== undefined) { fields.push('is_late=?');   vals.push(is_late  ? 1 : 0); }
  if (clock_in  !== undefined) { fields.push('clock_in=?');  vals.push(clock_in  || null); }
  if (clock_out !== undefined) { fields.push('clock_out=?'); vals.push(clock_out || null); }
  if (!fields.length) return res.status(400).json({ error: 'No fields' });
  vals.push(req.params.id);
  db.prepare(`UPDATE attendance SET ${fields.join(',')} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

// ── 一次性：清除 staff OA 所有 API 設定的圖文選單 ──────────────
router.post('/clear-staff-richmenu', requireHR, async (req, res) => {
  const token = process.env.LINE_STAFF_CHANNEL_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'STAFF TOKEN not set' });

  try {
    // 取消預設圖文選單
    await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    // 列出所有 API 設定的圖文選單並全部刪除
    const listRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const listData = await listRes.json();
    const menus = listData.richmenus || [];

    for (const m of menus) {
      await fetch(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    }

    res.json({ ok: true, deleted: menus.length, message: `已清除 ${menus.length} 個 API 圖文選單` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 員工活動報告 GET /api/hr/staff-activity ──────────────────────────────────
router.get('/staff-activity', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!me.manage_users) return res.status(403).json({ error: '權限不足' });

  const { from, to } = req.query;
  const dateFrom = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const dateTo   = to   || new Date().toISOString().slice(0, 10);

  // 登入 sessions
  const sessions = db.prepare(`
    SELECT ls.id, ls.user_id, u.name as user_name, u.role,
           ls.login_at, ls.logout_at, ls.duration_seconds, ls.ip
    FROM login_sessions ls
    JOIN users u ON ls.user_id = u.id
    WHERE date(ls.login_at) >= ? AND date(ls.login_at) <= ?
    ORDER BY ls.login_at DESC
  `).all(dateFrom, dateTo);

  // 新增案件
  const created = db.prepare(`
    SELECT created_by as user_id, COUNT(*) as cnt
    FROM cases
    WHERE date(created_at) >= ? AND date(created_at) <= ? AND created_by IS NOT NULL
    GROUP BY created_by
  `).all(dateFrom, dateTo);

  // 修改案件（排除自己新增的）
  const updated = db.prepare(`
    SELECT updated_by as user_id, COUNT(*) as cnt
    FROM cases
    WHERE date(updated_at) >= ? AND date(updated_at) <= ?
      AND updated_by IS NOT NULL
      AND NOT (updated_by = created_by AND date(created_at) >= ? AND date(created_at) <= ?)
    GROUP BY updated_by
  `).all(dateFrom, dateTo, dateFrom, dateTo);

  // 總登入時間（從上週六開始）
  const lastSat = new Date();
  lastSat.setDate(lastSat.getDate() - ((lastSat.getDay() + 1) % 7));
  const satStr = lastSat.toISOString().slice(0, 10);
  const totalByUser = db.prepare(`
    SELECT user_id,
           SUM(COALESCE(duration_seconds,
               CAST((julianday(COALESCE(logout_at,'now')) - julianday(login_at)) * 86400 AS INTEGER)
           )) as total_seconds,
           COUNT(*) as login_count
    FROM login_sessions
    WHERE date(login_at) >= ?
    GROUP BY user_id
  `).all(satStr);

  res.json({
    from: dateFrom, to: dateTo, since_saturday: satStr,
    sessions, created, updated, totals: totalByUser
  });
});

module.exports = router;
