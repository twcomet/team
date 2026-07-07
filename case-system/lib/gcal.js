// Google 行事曆整合：把派工同步到公司共用行事曆「繪新派單」
// 沿用 gdrive.js 的 OAuth（同一組 refresh token，授權範圍已含 calendar）
// 純 fetch，不裝額外套件。best-effort：Google 端失敗絕不影響派單存檔。
const db     = require('../db');
const gdrive = require('./gdrive');

const TZ      = 'Asia/Taipei';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const LABELS  = { survey: '場勘', install: '施工', aftersales: '售後維修' };

const getS = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setS = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v == null ? null : String(v));

const isConnected  = () => gdrive.isConnected();
// 同步開關：預設開啟；設為 '0' 則暫停（未連 Google 時本來就不會動作）
const syncEnabled  = () => getS('gcal_sync_enabled') !== '0';
const setEnabled   = (on) => setS('gcal_sync_enabled', on ? '1' : '0');

// ── 時間工具 ──────────────────────────────────────────────
function _hhmm(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2}):?(\d{2})?/);
  if (!m) return null;
  const h  = String(Math.min(23, parseInt(m[1], 10))).padStart(2, '0');
  const mm = (m[2] || '00').padStart(2, '0');
  return `${h}:${mm}`;
}
function _plusHours(hhmm, hrs) {
  const [h, m] = hhmm.split(':').map(Number);
  const total  = Math.min(h * 60 + m + hrs * 60, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function _nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 取得/建立專用行事曆 ───────────────────────────────────
async function _ensureCalendar(token) {
  const existing = getS('gcal_dispatch_calendar_id');
  if (existing) return existing;
  const r = await fetch(`${CAL_API}/calendars`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: '繪新派單', description: '繪新管理系統自動同步的派工排程', timeZone: TZ }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('建立行事曆失敗：' + ((j.error && j.error.message) || r.status));
  setS('gcal_dispatch_calendar_id', j.id);
  return j.id;
}

function _loadDispatch(dispatchId) {
  return db.prepare(`
    SELECT d.id, d.dispatch_type, d.scheduled_date, d.scheduled_time, d.work_until,
           d.notes, d.status, d.gcal_event_id, d.leader_id,
           c.case_number, c.title, c.location, c.entry_info, c.drive_folder_url,
           cl.name AS client_name, cl.phone AS client_phone,
           ld.name AS leader_name,
           (SELECT du.user_id FROM dispatch_users du WHERE du.dispatch_id = d.id ORDER BY du.id LIMIT 1) AS first_user_id,
           (SELECT GROUP_CONCAT(u.name, '、') FROM dispatch_users du
              JOIN users u ON u.id = du.user_id WHERE du.dispatch_id = d.id) AS workers
    FROM dispatches d
    JOIN cases c ON c.id = d.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users ld ON ld.id = d.leader_id
    WHERE d.id = ?
  `).get(dispatchId);
}

// 每個人一個固定顏色：依需求自動指派 Google 行事曆 11 色（1..11），存 settings 保持穩定
// Google 事件色：1薰衣草 2鼠尾草 3葡萄 4火鶴 5香蕉 6橘 7孔雀藍 8石墨 9藍莓 10羅勒綠 11番茄
function _colorFor(userId) {
  if (!userId) return undefined;
  let map = {};
  try { map = JSON.parse(getS('gcal_user_colors') || '{}'); } catch {}
  if (map[userId]) return String(map[userId]);
  const used = Object.values(map).map(Number);
  let next = null;
  for (let c = 1; c <= 11; c++) { if (!used.includes(c)) { next = c; break; } } // 先用沒被占用的色
  if (next == null) next = (Object.keys(map).length % 11) + 1;                   // 超過 11 人才輪迴重複
  map[userId] = next;
  setS('gcal_user_colors', JSON.stringify(map));
  return String(next);
}

function _buildEvent(d) {
  const label   = LABELS[d.dispatch_type] || d.dispatch_type || '派工';
  const title   = [d.title, d.client_name].filter(Boolean).join('｜') || d.case_number || '案件';
  const summary = `【${label}】${title}`;
  const desc = [];
  if (d.case_number)  desc.push(`案件：${d.case_number}${d.title ? ' ' + d.title : ''}`);
  if (d.client_name)  desc.push(`客戶：${d.client_name}${d.client_phone ? ' ' + d.client_phone : ''}`);
  if (d.leader_name)  desc.push(`小組長：${d.leader_name}`);
  if (d.workers)         desc.push(`師傅：${d.workers}`);
  if (d.entry_info)      desc.push(`進場資訊：${d.entry_info}`);
  if (d.notes)           desc.push(`備註：${d.notes}`);
  if (d.drive_folder_url) desc.push(`完工資料夾：${d.drive_folder_url}`);

  const ev = { summary, location: d.location || '', description: desc.join('\n') };
  // 依「小組長」上色（沒設小組長時退回第一位師傅），每個人一個固定顏色
  const colorId = _colorFor(d.leader_id || d.first_user_id);
  if (colorId) ev.colorId = colorId;
  const t  = _hhmm(d.scheduled_time);
  if (t) {
    const endT = _hhmm(d.work_until) || _plusHours(t, 2);
    ev.start = { dateTime: `${d.scheduled_date}T${t}:00`,    timeZone: TZ };
    ev.end   = { dateTime: `${d.scheduled_date}T${endT}:00`, timeZone: TZ };
  } else {
    ev.start = { date: d.scheduled_date };            // 全天事件
    ev.end   = { date: _nextDay(d.scheduled_date) };  // 全天事件 end 為隔天（不含）
  }
  return ev;
}

async function _syncDispatch(dispatchId) {
  const d = _loadDispatch(dispatchId);
  if (!d) return;
  if (d.status === 'cancelled') { await _removeEvent(d.gcal_event_id, dispatchId); return; }

  const token   = await gdrive.accessToken();
  const calId   = await _ensureCalendar(token);
  const ev      = _buildEvent(d);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const base    = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;

  if (d.gcal_event_id) {
    const r = await fetch(`${base}/${encodeURIComponent(d.gcal_event_id)}`,
      { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (r.ok) return;
    if (r.status !== 404 && r.status !== 410) {   // 事件被手動刪除 → 往下重建；其他錯誤才拋
      const j = await r.json().catch(() => ({}));
      throw new Error('更新事件失敗：' + ((j.error && j.error.message) || r.status));
    }
  }
  const r = await fetch(base, { method: 'POST', headers, body: JSON.stringify(ev) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('建立事件失敗：' + ((j.error && j.error.message) || r.status));
  db.prepare('UPDATE dispatches SET gcal_event_id=? WHERE id=?').run(j.id, dispatchId);
}

async function _removeEvent(eventId, dispatchId) {
  if (eventId) {
    const token = await gdrive.accessToken();
    const calId = await _ensureCalendar(token);
    await fetch(`${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); // 204 成功；404/410 視為已刪
  }
  if (dispatchId) db.prepare('UPDATE dispatches SET gcal_event_id=NULL WHERE id=?').run(dispatchId);
}

// ── 對外 API：best-effort，永不 throw（不阻塞派單流程）──────
function safeSyncDispatch(dispatchId) {
  if (!syncEnabled() || !isConnected()) return Promise.resolve();
  return _syncDispatch(dispatchId)
    .catch(e => console.error('[gcal] 同步派工失敗 #' + dispatchId + '：', e.message));
}
function safeRemoveEvent(eventId) {
  if (!eventId || !isConnected()) return Promise.resolve();
  return _removeEvent(eventId, null)
    .catch(e => console.error('[gcal] 刪除事件失敗：', e.message));
}

// 回填：把所有未取消的派工推上去（老闆手動觸發，第一次連接後使用）
async function syncAll() {
  if (!isConnected()) throw new Error('尚未連接 Google');
  const rows = db.prepare(`SELECT id FROM dispatches WHERE status != 'cancelled'`).all();
  let ok = 0, fail = 0, sampleError = null, aborted = false;
  for (const row of rows) {
    try { await _syncDispatch(row.id); ok++; }
    catch (e) {
      fail++;
      if (!sampleError) sampleError = e.message;
      console.error('[gcal] 回填失敗 #' + row.id + '：', e.message);
      if (ok === 0 && fail >= 3) { aborted = true; break; } // 連續失敗＝系統性問題（權限/API未啟用），提早中止避免狂打 API
    }
  }
  return { total: rows.length, ok, fail, sampleError, aborted };
}

function calendarInfo() {
  return { enabled: syncEnabled(), connected: isConnected(), calendarId: getS('gcal_dispatch_calendar_id') || null };
}

module.exports = { safeSyncDispatch, safeRemoveEvent, syncAll, syncEnabled, setEnabled, calendarInfo };
