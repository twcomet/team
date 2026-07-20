// 出勤共用工具：判定「工作日」「該打卡名冊」，供 出勤報表頁 + 每日提醒排程共用
const db = require('../db');
const { isOutsourced } = require('../middleware/auth');

// 角色自動免打卡：老闆、副總（外包/約聘/經銷另由 isOutsourced 排除）
const ROLE_EXEMPT = new Set(['owner', 'vp']);

// 2026 台灣國定假日（週一~週五才需打卡；六日本來就不算，這裡只放平日假日/補假）
// ⚠️ 每年初請核對政府公告更新；補假日以人事行政總處公告為準，若誤報再補上該日期即可。
const HOLIDAYS = new Set([
  '2026-01-01',                                                   // 元旦(四)
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', // 春節 除夕~初四(一~五)
  '2026-04-03', '2026-04-06',                                     // 兒童節/清明 彈性放假+補假(五、一)
  '2026-05-01',                                                   // 勞動節(五)
  '2026-06-19',                                                   // 端午(五)
  '2026-09-25',                                                   // 中秋(五)
  '2026-10-12',                                                   // 國慶(10/10 六)補假(一)
  '2026-10-26',                                                   // 光復節(10/25 日)補假(一)
  '2026-12-25',                                                   // 行憲紀念日(五)
]);

function isHoliday(dateStr) { return HOLIDAYS.has(dateStr); }

// 是否為「該打卡的工作日」：週一~週五(getDay 1~5) 且非國定假日
function isWorkday(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const dow = new Date(dateStr + 'T00:00:00').getDay(); // 0=日 6=六
  if (dow === 0 || dow === 6) return false;
  return !isHoliday(dateStr);
}

// 該打卡名冊：啟用中、非角色自動免(老闆/副總)、非外包/約聘/經銷、且未勾「免打卡」
function clockRoster() {
  const rows = db.prepare(`SELECT id, name, role, is_manager, line_user_id, clock_exempt
                           FROM users WHERE active=1 ORDER BY sort_order, name`).all();
  return rows.filter(u => !ROLE_EXEMPT.has(u.role) && !isOutsourced(u.role) && !u.clock_exempt);
}

// 單一使用者是否「免打卡」（角色自動免 或 手動勾選）
function isClockExempt(user) {
  return ROLE_EXEMPT.has(user.role) || isOutsourced(user.role) || !!user.clock_exempt;
}

// 台灣現在時間（UTC+8）：回 { date:'YYYY-MM-DD', min:自午夜起的分鐘 }
function _twNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// 計算某日出勤異常名單：{ late:[user], absent:[user] }
// 規則：只看「該打卡名冊」(已排除免打卡/老闆副總/外包)；有打卡且遲到→late；沒打卡且非請假→absent
function computeAnomaly(dateStr) {
  const roster = clockRoster();
  const rows = db.prepare(`SELECT user_id, clock_in, is_late FROM attendance WHERE work_date=?`).all(dateStr);
  const byUser = {}; rows.forEach(r => { byUser[r.user_id] = r; });
  const leaves = db.prepare(`SELECT user_id FROM leave_requests WHERE status='approved' AND ? BETWEEN leave_date AND COALESCE(leave_end_date, leave_date)`).all(dateStr);
  const onLeave = new Set(leaves.map(l => l.user_id));
  const absent = [], late = [];
  for (const u of roster) {
    const a = byUser[u.id];
    if (a && a.clock_in) { if (a.is_late) late.push(u); }
    else if (!onLeave.has(u.id)) absent.push(u);
  }
  return { late, absent };
}

// 只在「今天、且已過 10:00、且是工作日」時，把最新出勤異常名單重新同步到 Google 派單行事曆。
// 10:00 前不動，避免早上大家還在陸續打卡就先建立異常事件；之後打卡/請假/免打卡有變動時呼叫即可自我修正。
function syncAnomalyIfDue(dateStr) {
  try {
    const now = _twNow();
    if (dateStr !== now.date || now.min < 600 || !isWorkday(dateStr)) return;
    const { late, absent } = computeAnomaly(dateStr);
    require('./gcal').safeSyncLateList(dateStr, late.map(u => u.name), absent.map(u => u.name));
  } catch (e) { /* best-effort */ }
}

module.exports = { isWorkday, isHoliday, clockRoster, isClockExempt, computeAnomaly, syncAnomalyIfDue, twNow: _twNow, ROLE_EXEMPT, HOLIDAYS };
