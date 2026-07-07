// Google 行事曆整合：把派工同步到公司共用行事曆「繪新派單」
// 沿用 gdrive.js 的 OAuth（同一組 refresh token，授權範圍已含 calendar）
// 純 fetch，不裝額外套件。best-effort：Google 端失敗絕不影響派單存檔。
const db     = require('../db');
const gdrive = require('./gdrive');

const TZ      = 'Asia/Taipei';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const LABELS  = { survey: '場勘', factory_survey: '場勘', install: '施工', cut_material: '裁料', aftersales: '售後服務', other: '其他' };

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
           c.case_number, c.title, c.location, c.entry_info, c.drive_folder_url, c.photo_upload_url,
           cl.name AS client_name, cl.phone AS client_phone,
           ld.name AS leader_name,
           (SELECT sf.cs_service_note FROM survey_forms sf
              WHERE sf.case_id = c.id AND sf.cs_service_note IS NOT NULL AND TRIM(sf.cs_service_note) <> ''
              ORDER BY sf.id DESC LIMIT 1) AS cs_service_note,
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

// 依「小組長」上色（沒設小組長時看施工人員），姓名→固定 Google 色，與系統派單行事曆完全一致
// Google 事件色：1薰衣草 2鼠尾草 3葡萄 4火鶴 5香蕉 6橘 7孔雀藍 8石墨 9藍莓 10羅勒綠 11番茄
function _colorFor(names) {
  const s = names || '';
  if (s.includes('紹銘')) return '11'; // 紅 → 番茄
  if (s.includes('傳恩')) return '10'; // 綠 → 羅勒
  if (s.includes('申鴻')) return '6';  // 橘 → 橘
  if (s.includes('天鈞')) return '8';  // 棕 → 石墨
  if (s.includes('名汎')) return '7';  // 藍綠 → 孔雀藍
  if (s.includes('洪義')) return '4';  // 粉 → 火鶴
  if (s.includes('維宏')) return '3';  // 洋紅 → 葡萄
  if (s.includes('恰吉')) return '1';  // 紫 → 薰衣草
  if (s.includes('Dan'))  return '5';  // 黃 → 香蕉
  return '9';                          // 無小組長 → 藍莓（深藍）
}

function _buildEvent(d) {
  const label   = LABELS[d.dispatch_type] || d.dispatch_type || '派工';
  const title   = [d.title, d.client_name].filter(Boolean).join('｜') || d.case_number || '案件';
  // 師傅名單：小組長排第一，其後才是組員（去重）
  const crew = [];
  if (d.leader_name) crew.push(d.leader_name);
  if (d.workers) String(d.workers).split('、').forEach(n => { n = n.trim(); if (n && !crew.includes(n)) crew.push(n); });
  const crewStr = crew.join('、');
  const summary = `【${label}】${title}${crewStr ? '　' + crewStr : ''}`;  // 標題後面帶師傅資訊
  const desc = [];
  if (d.case_number)  desc.push(`案件：${d.case_number}${d.title ? ' ' + d.title : ''}`);
  if (d.client_name)  desc.push(`客戶：${d.client_name}${d.client_phone ? ' ' + d.client_phone : ''}`);
  if (d.leader_name)  desc.push(`小組長：${d.leader_name}`);
  if (crewStr)           desc.push(`師傅：${crewStr}`);              // 小組長第一，組員在後
  if (d.cs_service_note) desc.push(`進場資訊：${d.cs_service_note}`);  // 客服場勘資訊備註
  if (d.entry_info)      desc.push(`門禁停車：${d.entry_info}`);
  if (d.notes)           desc.push(`客服備註：${d.notes}`);
  const folderUrl = d.photo_upload_url || d.drive_folder_url;  // 與系統顯示一致：優先客服貼的雲端資料夾
  if (folderUrl)         desc.push(`完工資料夾：${folderUrl}`);

  const ev = { summary, location: d.location || '', description: desc.join('\n') };
  // 依「小組長」上色（沒設小組長時看施工人員），與系統派單行事曆一致
  const colorId = _colorFor(d.leader_name || d.workers);
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

// 依派工 id 產生固定、唯一的 Google 事件 id（字元僅限 a-v 與 0-9）→ 同一派工永遠對同一事件，天然防重複
function _eventId(dispatchId) { return 'disp' + dispatchId; }
function _rememberEid(dispatchId, eid) { db.prepare('UPDATE dispatches SET gcal_event_id=? WHERE id=?').run(eid, dispatchId); }

async function _syncDispatch(dispatchId) {
  const d = _loadDispatch(dispatchId);
  if (!d) return;
  const eid = _eventId(dispatchId);
  if (d.status === 'cancelled') { await _removeEvent(d.gcal_event_id || eid, dispatchId); return; }

  const token   = await gdrive.accessToken();
  const calId   = await _ensureCalendar(token);
  const ev      = _buildEvent(d);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const base    = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;

  // 1) 已知事件 id（舊隨機 id 或固定 id）→ 直接 PATCH 更新，不會產生第二筆
  const known = d.gcal_event_id || eid;
  let r = await fetch(`${base}/${encodeURIComponent(known)}`,
    { method: 'PATCH', headers, body: JSON.stringify(ev) });
  if (r.ok) { if (d.gcal_event_id !== known) _rememberEid(dispatchId, known); return; }
  if (r.status !== 404 && r.status !== 410) {   // 非「不存在」的錯誤才拋
    const j = await r.json().catch(() => ({}));
    throw new Error('更新事件失敗：' + ((j.error && j.error.message) || r.status));
  }

  // 2) 不存在 → 用固定 id 建立（固定 id 讓重試/競態/重複同步都只會是同一筆）
  ev.id = eid;
  r = await fetch(base, { method: 'POST', headers, body: JSON.stringify(ev) });
  if (r.ok) { _rememberEid(dispatchId, eid); return; }
  if (r.status === 409) {                        // 固定 id 已存在或剛被刪除保留中
    const p = await fetch(`${base}/${encodeURIComponent(eid)}`, { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (p.ok) { _rememberEid(dispatchId, eid); return; }
    delete ev.id;                                // 刪除保留中無法重用 → 退回隨機 id 建立
    r = await fetch(base, { method: 'POST', headers, body: JSON.stringify(ev) });
    if (r.ok) { const j = await r.json().catch(() => ({})); _rememberEid(dispatchId, j.id); return; }
  }
  const j = await r.json().catch(() => ({}));
  throw new Error('建立事件失敗：' + ((j.error && j.error.message) || r.status));
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

// 列出行事曆內全部事件 id（分頁）
async function _listAllEventIds(token, calId) {
  const ids = [];
  let pageToken = null;
  do {
    const url = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events?maxResults=2500&singleEvents=false`
              + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('讀取事件失敗：' + ((j.error && j.error.message) || r.status));
    (j.items || []).forEach(e => { if (e.id) ids.push(e.id); });
    pageToken = j.nextPageToken || null;
  } while (pageToken);
  return ids;
}

// 清除重建：刪光「繪新派單」行事曆內所有事件（此曆專用），清空 event id，再重新同步一份乾淨的
// 用來修正「早期同步未記 id 造成的孤兒事件 → 重複」
async function purgeAndRebuild() {
  if (!isConnected()) throw new Error('尚未連接 Google');
  const token = await gdrive.accessToken();
  const calId = await _ensureCalendar(token);
  const ids   = await _listAllEventIds(token, calId);
  let purged = 0;
  for (const eid of ids) {
    const r = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eid)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    if (r.ok || r.status === 404 || r.status === 410) purged++;
  }
  db.prepare('UPDATE dispatches SET gcal_event_id=NULL').run();  // 全部重建
  const res = await syncAll();
  return { purged, ...res };
}

// 診斷：Google 帳號裡叫「繪新派單」的行事曆有幾個（>1 代表有重複曆，需手動刪多的）
async function duplicateCalendars() {
  if (!isConnected()) return [];
  const token = await gdrive.accessToken();
  const r = await fetch(`${CAL_API}/users/me/calendarList?maxResults=250`,
    { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return [];
  return (j.items || []).filter(c => c.summary === '繪新派單').map(c => ({ id: c.id, summary: c.summary }));
}

function calendarInfo() {
  return { enabled: syncEnabled(), connected: isConnected(), calendarId: getS('gcal_dispatch_calendar_id') || null };
}

module.exports = { safeSyncDispatch, safeRemoveEvent, syncAll, purgeAndRebuild, duplicateCalendars, syncEnabled, setEnabled, calendarInfo };
