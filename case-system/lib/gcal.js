// Google 行事曆整合：把派工同步到公司共用行事曆「繪新派單」
// 沿用 gdrive.js 的 OAuth（同一組 refresh token，授權範圍已含 calendar）
// 純 fetch，不裝額外套件。best-effort：Google 端失敗絕不影響派單存檔。
const db     = require('../db');
const gdrive = require('./gdrive');

const TZ      = 'Asia/Taipei';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const LABELS  = { survey: '場勘', factory_survey: '場勘', install: '施工', cut_material: '裁料', aftersales: '維修', other: '其他' };

const getS = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setS = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v == null ? null : String(v));

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Google API 呼叫：遇速率限制(403/429)自動指數退避重試，避免大量同步時被 Rate Limit Exceeded 擋掉
async function _fetchRetry(url, opts, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fetch(url, opts);
    if (last.status !== 403 && last.status !== 429) return last;   // 非速率限制 → 直接回
    if (i < tries - 1) await _sleep(Math.min(1500 * 2 ** i, 20000)); // 1.5s,3s,6s,12s,20s...
  }
  return last;                                                      // 用盡重試仍失敗 → 交回上層處理
}

// ── 同步序列化鎖：同一 key（同一筆派工/場勘）的同步排隊執行，杜絕並發競態造成的重複事件 ──
// 競態：safeSync 是 fire-and-forget，同筆派工被兩個觸發點near-同時同步時，兩次都讀到 gcal_event_id
// 還是 NULL → 各自 POST 建立 → Google 出現兩筆。用 per-key promise chain 讓同 key 串行即可根治。
const _locks = new Map();
function _withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const run  = prev.then(fn, fn);          // 不論前一個成功/失敗都接著跑
  const guard = run.catch(() => {});       // 吞掉錯誤，確保鏈不中斷
  _locks.set(key, guard);
  guard.then(() => { if (_locks.get(key) === guard) _locks.delete(key); }); // 隊尾清理，避免記憶體長大
  return run;
}

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
// 去姓取名（行事曆標題用）：劉申鴻→申鴻、林冠捷→冠捷；顧及常見複姓
const _COMPOUND_SURNAMES = ['歐陽','太史','端木','上官','司馬','東方','獨孤','南宮','夏侯','諸葛','尉遲','皇甫','宇文','長孫','慕容','司徒','司空','令狐','鍾離','宗政','濮陽','公孫','澹台','公冶','太叔','申屠','公羊','万俟','万俟'];
function _givenName(full) {
  const n = String(full || '').trim();
  if (n.length <= 1) return n;
  if (_COMPOUND_SURNAMES.includes(n.slice(0, 2))) return n.slice(2) || n;
  return n.slice(1);
}
// 一組人名 → 去姓、去重、以、串接
function _crewGiven(names) {
  const seen = new Set(); const out = [];
  names.forEach(nm => { const g = _givenName(nm); if (g && !seen.has(g)) { seen.add(g); out.push(g); } });
  return out.join('、');
}

// ── 取得/建立專用行事曆 ───────────────────────────────────
// ── 分享名單持久化：settings.gcal_shared_acl = [{email, role}] ──
// 讓「硬重置/清除重建」換成新行事曆(ID 變)後，能自動還原先前分享的同事，不必手動重分享。
function _getShares() {
  try { return JSON.parse(getS('gcal_shared_acl') || '[]') || []; } catch { return []; }
}
function _rememberShare(email, role) {
  const e = (email || '').trim(); if (!e) return;
  const list = _getShares().filter(s => (s.email || '').toLowerCase() !== e.toLowerCase());
  list.push({ email: e, role: role === 'writer' ? 'writer' : 'reader' });
  setS('gcal_shared_acl', JSON.stringify(list));
}
function _forgetShare(email) {
  const e = (email || '').trim().toLowerCase();
  setS('gcal_shared_acl', JSON.stringify(_getShares().filter(s => (s.email || '').toLowerCase() !== e)));
}
// 對指定行事曆重新套用已記住的分享（新建/重置後呼叫）
async function _reapplyShares(token, calId) {
  for (const s of _getShares()) {
    try {
      await _fetchRetry(`${CAL_API}/calendars/${encodeURIComponent(calId)}/acl?sendNotifications=false`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: s.role === 'writer' ? 'writer' : 'reader', scope: { type: 'user', value: s.email } }),
      });
      await _sleep(120);
    } catch (e) { console.error('[gcal] 還原分享失敗 ' + s.email + '：', e.message); }
  }
}

// 找帳號內既有、且自己是擁有者的「繪新派單」行事曆 id（沿用，避免重複建立）；沒有則回 null
async function _findOwnedDispatchCalendar(token) {
  const r = await _fetchRetry(`${CAL_API}/users/me/calendarList?maxResults=250`,
    { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  const owned = (j.items || []).filter(c => c.summary === '繪新派單' && c.accessRole === 'owner');
  return owned.length ? owned[0].id : null;
}

async function _ensureCalendar(token) {
  const existing = getS('gcal_dispatch_calendar_id');
  if (existing) return existing;
  // 上鎖 + 進鎖後再查一次 + 先找既有曆沿用：三重防護，杜絕並發/硬重置空窗期建出多本「繪新派單」重複曆
  return _withLock('__ensureCalendar', async () => {
    const again = getS('gcal_dispatch_calendar_id');
    if (again) return again;
    const found = await _findOwnedDispatchCalendar(token);   // 帳號內已有就沿用，不再另建
    if (found) { setS('gcal_dispatch_calendar_id', found); await _reapplyShares(token, found); return found; }
    const r = await _fetchRetry(`${CAL_API}/calendars`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: '繪新派單', description: '繪新管理系統自動同步的派工排程', timeZone: TZ }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('建立行事曆失敗：' + ((j.error && j.error.message) || r.status));
    setS('gcal_dispatch_calendar_id', j.id);
    await _reapplyShares(token, j.id);   // 新建行事曆 → 自動還原先前記住的分享名單
    return j.id;
  });
}

function _loadDispatch(dispatchId) {
  return db.prepare(`
    SELECT d.id, d.dispatch_type, d.scheduled_date, d.scheduled_time, d.work_until,
           d.estimated_hours,
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
  // 標題：師傅名字(去姓)放最前面、接標籤，如【申鴻、傳恩、天鈞施工】案件｜客戶
  const crewFront = _crewGiven(crew);
  const crewStr = crew.join('、');                  // 描述內文用完整姓名（小組長第一、組員在後）
  const summary = `【${crewFront}${label}】${title}`;
  const desc = [];
  if (d.case_number)  desc.push(`案件：${d.case_number}${d.title ? ' ' + d.title : ''}`);
  if (d.client_name)  desc.push(`客戶：${d.client_name}${d.client_phone ? ' ' + d.client_phone : ''}`);
  if (d.leader_name)  desc.push(`小組長：${d.leader_name}`);
  if (crewStr)           desc.push(`師傅：${crewStr}`);              // 小組長第一，組員在後
  const isSurvey = ['survey', 'factory_survey'].includes(d.dispatch_type);
  if (d.cs_service_note && isSurvey) desc.push(`進場資訊：${d.cs_service_note}`);  // 客服場勘資訊備註：只放場勘派工
  if (d.entry_info)      desc.push(`門禁停車：${d.entry_info}`);
  if (d.notes)           desc.push(`客服備註：${d.notes}`);           // 派工欄位的客服備註：施工等派工照常帶入
  const folderUrl = d.photo_upload_url || d.drive_folder_url;  // 與系統顯示一致：優先客服貼的雲端資料夾
  if (folderUrl)         desc.push(`完工資料夾：${folderUrl}`);

  // status:'confirmed' 確保事件為可見狀態：修正固定 id 被 Google 復活成「已取消(隱藏)」的問題
  // extendedProperties.private.dispatchId：蓋上派工標記，讓同步可「建立前先找既有事件」達成冪等、自癒重複
  const ev = { summary, location: d.location || '', description: desc.join('\n'), status: 'confirmed',
    extendedProperties: { private: { dispatchId: String(d.id) } } };
  // 依「小組長」上色（沒設小組長時看施工人員），與系統派單行事曆一致
  const colorId = _colorFor(d.leader_name || d.workers);
  if (colorId) ev.colorId = colorId;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.scheduled_date || ''));
  if (!validDate) return null;                         // 沒有有效日期 → 無法建立事件，交由上層跳過
  const _toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  const t = _hhmm(d.scheduled_time);                   // 客服填的抵達時間
  if (t) {
    // 完工時間優先序：① 客服明填的完工時間(work_until) ② 抵達 + 預估工時 ③ 抵達 + 預設7小時
    //   estimated_hours：客服有寫「預計施工幾小時」就用該時數，沒寫預設 7 小時（可含 0.5 小數）
    let endT = _hhmm(d.work_until);
    if (!endT || _toMin(endT) <= _toMin(t)) {
      const estH = Number(d.estimated_hours);
      const dur  = (estH > 0) ? estH : 7;              // (a)沒填→7小時 (b)有填→該時數
      endT = _plusHours(t, dur);                       // _plusHours 會夾在當天 23:59 內
    }
    ev.start = { dateTime: `${d.scheduled_date}T${t}:00`,    timeZone: TZ };
    ev.end   = { dateTime: `${d.scheduled_date}T${endT}:00`, timeZone: TZ };
  } else {
    ev.start = { date: d.scheduled_date };            // 全天事件（沒選抵達時間）
    ev.end   = { date: _nextDay(d.scheduled_date) };  // 全天事件 end 為隔天（不含）
  }
  return ev;
}

function _rememberEid(dispatchId, eid) { db.prepare('UPDATE dispatches SET gcal_event_id=? WHERE id=?').run(eid, dispatchId); }

async function _syncDispatch(dispatchId) {
  const d = _loadDispatch(dispatchId);
  if (!d) return;
  if (d.status === 'cancelled') { await _removeEvent(d.gcal_event_id, dispatchId); return; }

  const ev = _buildEvent(d);
  if (!ev) return;                               // 無有效日期 → 略過（不阻斷整批）

  const token   = await gdrive.accessToken();
  const calId   = await _ensureCalendar(token);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const base    = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;

  // 有存事件 id → PATCH 更新（含把隱藏事件 status:confirmed 復活）；不存在(404/410)才往下重建
  if (d.gcal_event_id) {
    const r = await _fetchRetry(`${base}/${encodeURIComponent(d.gcal_event_id)}`,
      { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (r.ok) return;
    if (r.status !== 404 && r.status !== 410) {
      const j = await r.json().catch(() => ({}));
      throw new Error('更新事件失敗：' + ((j.error && j.error.message) || r.status));
    }
  }

  // 建立前先找有沒有蓋著同 dispatchId 標記的既有事件（冪等、自癒重複/孤兒）：
  //   找到 → 沿用第一個(PATCH 更新並存回 id)、刪掉其餘重複；都沒有才真的建立新事件。
  const fr = await _fetchRetry(
    `${base}?privateExtendedProperty=${encodeURIComponent('dispatchId=' + d.id)}&showDeleted=false&maxResults=50&singleEvents=false`,
    { headers });
  const fj = await fr.json().catch(() => ({}));
  const dupes = (fr.ok && Array.isArray(fj.items)) ? fj.items.filter(e => e.id && e.status !== 'cancelled') : [];
  if (dupes.length) {
    const keep = dupes[0].id;
    const pr = await _fetchRetry(`${base}/${encodeURIComponent(keep)}`, { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (pr.ok) {
      _rememberEid(dispatchId, keep);
      for (let i = 1; i < dupes.length; i++) {   // 清掉多餘的重複事件
        await _fetchRetry(`${base}/${encodeURIComponent(dupes[i].id)}`, { method: 'DELETE', headers });
        await _sleep(80);
      }
      return;
    }
  }

  // 建立：讓 Google 指派全新隨機 id（不用固定 id，避免被刪除保留而復活成隱藏），可靠存回
  const r = await _fetchRetry(base, { method: 'POST', headers, body: JSON.stringify(ev) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('建立事件失敗：' + ((j.error && j.error.message) || r.status));
  _rememberEid(dispatchId, j.id);
}

// 只刪 Google 端事件（204 成功；404/410 視為已刪）
async function _gcalDelete(eventId) {
  if (!eventId) return;
  const token = await gdrive.accessToken();
  const calId = await _ensureCalendar(token);
  await _fetchRetry(`${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
}

async function _removeEvent(eventId, dispatchId) {
  await _gcalDelete(eventId);
  if (dispatchId) db.prepare('UPDATE dispatches SET gcal_event_id=NULL WHERE id=?').run(dispatchId);
}

// ── 場勘同步：場勘表單排定的日期(survey_forms.survey_date / cases.survey_date) 不是派工紀錄，
//    需另外同步到 Google。事件 id 記在 cases.survey_gcal_event_id（一案一場勘事件）。──────────
function _loadSurvey(caseId) {
  return db.prepare(`
    SELECT c.id AS case_id, c.case_number, c.title, c.status,
           c.location, c.entry_info, c.photo_upload_url, c.drive_folder_url,
           c.survey_date AS case_survey_date, c.survey_gcal_event_id,
           cl.name AS client_name, cl.phone AS client_phone,
           sf.survey_date, sf.survey_time, sf.site_address, sf.cs_service_note,
           su.name AS surveyor_name,
           (SELECT COUNT(*) FROM dispatches d WHERE d.case_id = c.id
              AND d.dispatch_type IN ('survey','factory_survey') AND d.status != 'cancelled') AS survey_dispatch_count
    FROM cases c
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN survey_forms sf ON sf.id = (
      SELECT id FROM survey_forms WHERE case_id = c.id AND survey_date IS NOT NULL
      ORDER BY survey_date DESC, id DESC LIMIT 1)
    LEFT JOIN users su ON su.id = COALESCE(sf.surveyor_id, c.surveyor_id)
    WHERE c.id = ?
  `).get(caseId);
}

function _buildSurveyEvent(s) {
  const date = s.survey_date || s.case_survey_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;   // 無有效場勘日 → 略過
  const title   = [s.title, s.client_name].filter(Boolean).join('｜') || s.case_number || '案件';
  const crewFront = _crewGiven([s.surveyor_name]);   // 場勘師傅名字(去姓)放最前面
  const crewStr = (s.surveyor_name || '').trim();    // 描述內文用完整姓名
  const summary = `【${crewFront}場勘】${title}`;
  const desc = [];
  if (s.case_number)   desc.push(`案件：${s.case_number}${s.title ? ' ' + s.title : ''}`);
  if (s.client_name)   desc.push(`客戶：${s.client_name}${s.client_phone ? ' ' + s.client_phone : ''}`);
  if (crewStr)         desc.push(`場勘師傅：${crewStr}`);
  if (s.cs_service_note) desc.push(`進場資訊：${s.cs_service_note}`);   // 客服場勘備註
  if (s.entry_info)    desc.push(`門禁停車：${s.entry_info}`);
  const folderUrl = s.photo_upload_url || s.drive_folder_url;
  if (folderUrl)       desc.push(`完工資料夾：${folderUrl}`);

  // extendedProperties.private.surveyCaseId：蓋上場勘標記，讓同步可「建立前先找既有事件」達成冪等、自癒重複
  const ev = { summary, location: s.site_address || s.location || '', description: desc.join('\n'), status: 'confirmed',
    extendedProperties: { private: { surveyCaseId: String(s.case_id) } } };
  const colorId = _colorFor(s.surveyor_name);
  if (colorId) ev.colorId = colorId;
  const _toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  const t = _hhmm(s.survey_time);
  let endT = t ? _plusHours(t, 2) : null;
  if (t && endT && _toMin(endT) > _toMin(t)) {
    ev.start = { dateTime: `${date}T${t}:00`,    timeZone: TZ };
    ev.end   = { dateTime: `${date}T${endT}:00`, timeZone: TZ };
  } else {
    ev.start = { date };
    ev.end   = { date: _nextDay(date) };
  }
  return ev;
}

async function _removeSurveyEvent(eventId, caseId) {
  await _gcalDelete(eventId);
  if (caseId) db.prepare('UPDATE cases SET survey_gcal_event_id=NULL WHERE id=?').run(caseId);
}

async function _syncSurvey(caseId) {
  const s = _loadSurvey(caseId);
  if (!s) return;
  const date = s.survey_date || s.case_survey_date;
  // 已作廢/結案、無場勘日、或該案已有「場勘派工」(以派工為準避免重複) → 移除場勘事件
  if (!date || ['closed', 'invalid'].includes(s.status) || s.survey_dispatch_count > 0) {
    await _removeSurveyEvent(s.survey_gcal_event_id, caseId);
    return;
  }
  const ev = _buildSurveyEvent(s);
  if (!ev) return;

  const token   = await gdrive.accessToken();
  const calId   = await _ensureCalendar(token);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const base    = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;

  if (s.survey_gcal_event_id) {
    const r = await _fetchRetry(`${base}/${encodeURIComponent(s.survey_gcal_event_id)}`,
      { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (r.ok) return;
    if (r.status !== 404 && r.status !== 410) {
      const j = await r.json().catch(() => ({}));
      throw new Error('更新場勘事件失敗：' + ((j.error && j.error.message) || r.status));
    }
  }

  // 建立前先找蓋著同 surveyCaseId 標記的既有事件（冪等、自癒重複/孤兒）：
  //   找到 → 沿用第一個(PATCH 並存回 id)、刪掉其餘重複；都沒有才真的建立新事件。
  const fr = await _fetchRetry(
    `${base}?privateExtendedProperty=${encodeURIComponent('surveyCaseId=' + s.case_id)}&showDeleted=false&maxResults=50&singleEvents=false`,
    { headers });
  const fj = await fr.json().catch(() => ({}));
  const dupes = (fr.ok && Array.isArray(fj.items)) ? fj.items.filter(e => e.id && e.status !== 'cancelled') : [];
  if (dupes.length) {
    const keep = dupes[0].id;
    const pr = await _fetchRetry(`${base}/${encodeURIComponent(keep)}`, { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (pr.ok) {
      db.prepare('UPDATE cases SET survey_gcal_event_id=? WHERE id=?').run(keep, caseId);
      for (let i = 1; i < dupes.length; i++) {   // 清掉多餘的重複場勘事件
        await _fetchRetry(`${base}/${encodeURIComponent(dupes[i].id)}`, { method: 'DELETE', headers });
        await _sleep(80);
      }
      return;
    }
  }

  const r = await _fetchRetry(base, { method: 'POST', headers, body: JSON.stringify(ev) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('建立場勘事件失敗：' + ((j.error && j.error.message) || r.status));
  db.prepare('UPDATE cases SET survey_gcal_event_id=? WHERE id=?').run(j.id, caseId);
}

// ── 暫定事項同步：未關聯案件的行事曆備忘（adhoc_events）→ 同一本「繪新派單」曆。
//    事件 id 記在 adhoc_events.gcal_event_id；標題加【暫定】、獨立顏色，標記 adhocId 供冪等自癒。──
function _loadAdhoc(id) {
  return db.prepare(`
    SELECT a.id, a.title, a.event_date, a.event_time, a.note, a.gcal_event_id, u.name AS creator_name
    FROM adhoc_events a LEFT JOIN users u ON u.id = a.created_by WHERE a.id = ?
  `).get(id);
}
function _buildAdhocEvent(a) {
  const date = a.event_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const desc = [];
  if (a.note)          desc.push(a.note);
  if (a.creator_name)  desc.push(`建立者：${a.creator_name}`);
  desc.push('（暫定事項：尚未關聯正式案件）');
  const ev = { summary: `【暫定】${a.title || '暫定事項'}`, description: desc.join('\n'), status: 'confirmed', colorId: '2',
    extendedProperties: { private: { adhocId: String(a.id) } } };
  const t = _hhmm(a.event_time);
  if (t) { ev.start = { dateTime: `${date}T${t}:00`, timeZone: TZ }; ev.end = { dateTime: `${date}T${_plusHours(t, 1)}:00`, timeZone: TZ }; }
  else   { ev.start = { date }; ev.end = { date: _nextDay(date) }; }
  return ev;
}
async function _removeAdhocEvent(eventId, id) {
  await _gcalDelete(eventId);
  if (id) db.prepare('UPDATE adhoc_events SET gcal_event_id=NULL WHERE id=?').run(id);
}
async function _syncAdhoc(id) {
  const a = _loadAdhoc(id);
  if (!a) return;
  const ev = _buildAdhocEvent(a);
  if (!ev) { await _removeAdhocEvent(a.gcal_event_id, id); return; }

  const token   = await gdrive.accessToken();
  const calId   = await _ensureCalendar(token);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const base    = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;

  if (a.gcal_event_id) {
    const r = await _fetchRetry(`${base}/${encodeURIComponent(a.gcal_event_id)}`,
      { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (r.ok) return;
    if (r.status !== 404 && r.status !== 410) {
      const j = await r.json().catch(() => ({}));
      throw new Error('更新暫定事項失敗：' + ((j.error && j.error.message) || r.status));
    }
  }
  // 建立前先找同 adhocId 標記的既有事件（冪等、自癒重複）
  const fr = await _fetchRetry(
    `${base}?privateExtendedProperty=${encodeURIComponent('adhocId=' + a.id)}&showDeleted=false&maxResults=50&singleEvents=false`,
    { headers });
  const fj = await fr.json().catch(() => ({}));
  const dupes = (fr.ok && Array.isArray(fj.items)) ? fj.items.filter(e => e.id && e.status !== 'cancelled') : [];
  if (dupes.length) {
    const keep = dupes[0].id;
    const pr = await _fetchRetry(`${base}/${encodeURIComponent(keep)}`, { method: 'PATCH', headers, body: JSON.stringify(ev) });
    if (pr.ok) {
      db.prepare('UPDATE adhoc_events SET gcal_event_id=? WHERE id=?').run(keep, id);
      for (let i = 1; i < dupes.length; i++) { await _fetchRetry(`${base}/${encodeURIComponent(dupes[i].id)}`, { method: 'DELETE', headers }); await _sleep(80); }
      return;
    }
  }
  const r = await _fetchRetry(base, { method: 'POST', headers, body: JSON.stringify(ev) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('建立暫定事項失敗：' + ((j.error && j.error.message) || r.status));
  db.prepare('UPDATE adhoc_events SET gcal_event_id=? WHERE id=?').run(j.id, id);
}

// ── 對外 API：best-effort，永不 throw（不阻塞派單流程）──────
function safeSyncDispatch(dispatchId) {
  if (!syncEnabled() || !isConnected()) return Promise.resolve();
  return _withLock('d' + dispatchId, () => _syncDispatch(dispatchId))
    .catch(e => console.error('[gcal] 同步派工失敗 #' + dispatchId + '：', e.message));
}
function safeRemoveEvent(eventId) {
  if (!eventId || !isConnected()) return Promise.resolve();
  return _removeEvent(eventId, null)
    .catch(e => console.error('[gcal] 刪除事件失敗：', e.message));
}
// 同步某案件的「場勘事件」（非派工的場勘日期）。best-effort，永不 throw
function safeSyncSurvey(caseId) {
  if (!syncEnabled() || !isConnected()) return Promise.resolve();
  return _withLock('s' + caseId, () => _syncSurvey(caseId))
    .catch(e => console.error('[gcal] 同步場勘失敗 case#' + caseId + '：', e.message));
}
// 同步一筆「暫定事項」。best-effort，永不 throw
function safeSyncAdhoc(id) {
  if (!syncEnabled() || !isConnected()) return Promise.resolve();
  return _withLock('a' + id, () => _syncAdhoc(id))
    .catch(e => console.error('[gcal] 同步暫定事項失敗 #' + id + '：', e.message));
}
// 刪除一筆「暫定事項」的 Google 事件。best-effort，永不 throw
function safeRemoveAdhoc(eventId, id) {
  if (!eventId || !isConnected()) return Promise.resolve();
  return _removeAdhocEvent(eventId, id)
    .catch(e => console.error('[gcal] 刪除暫定事項失敗 #' + id + '：', e.message));
}

// ── 背景同步任務：長時間工作(數百筆)不走 HTTP 請求，避免閘道逾時 ──
// 前端「啟動→輪詢進度」，任務進度存在模組記憶體
let _job = { kind: null, running: false, phase: '', total: 0, ok: 0, fail: 0, purged: 0, sampleError: null, aborted: false, done: false, dupCalendars: 0 };
function syncJobStatus() { return { ..._job }; }

async function _runSyncAll() {
  const rows = db.prepare(`SELECT id FROM dispatches WHERE status != 'cancelled'`).all();
  // 有場勘日期、且尚未結案/作廢的案件（場勘非派工，需另外同步）
  const surveyRows = db.prepare(`
    SELECT DISTINCT c.id FROM cases c
    LEFT JOIN survey_forms sf ON sf.case_id = c.id
    WHERE c.status NOT IN ('closed','invalid')
      AND COALESCE(sf.survey_date, c.survey_date) IS NOT NULL
  `).all();
  const adhocRows = db.prepare(`SELECT id FROM adhoc_events`).all();
  _job.total = rows.length + surveyRows.length + adhocRows.length; _job.phase = '同步派工';
  for (const row of rows) {
    try { await _withLock('d' + row.id, () => _syncDispatch(row.id)); _job.ok++; }
    catch (e) {
      _job.fail++;
      if (!_job.sampleError) _job.sampleError = e.message;
      console.error('[gcal] 回填失敗 #' + row.id + '：', e.message);
      if (_job.ok === 0 && _job.fail >= 3) { _job.aborted = true; break; } // 連續失敗＝系統性問題，提早中止
    }
    await _sleep(150); // 節流：放慢呼叫速度，避免觸發 Google 速率限制
  }
  if (_job.aborted) return;
  _job.phase = '同步場勘';
  for (const row of surveyRows) {
    try { await _withLock('s' + row.id, () => _syncSurvey(row.id)); _job.ok++; }
    catch (e) {
      _job.fail++;
      if (!_job.sampleError) _job.sampleError = e.message;
      console.error('[gcal] 場勘回填失敗 case#' + row.id + '：', e.message);
    }
    await _sleep(150);
  }
  _job.phase = '同步暫定事項';
  for (const row of adhocRows) {
    try { await _withLock('a' + row.id, () => _syncAdhoc(row.id)); _job.ok++; }
    catch (e) {
      _job.fail++;
      if (!_job.sampleError) _job.sampleError = e.message;
      console.error('[gcal] 暫定事項回填失敗 #' + row.id + '：', e.message);
    }
    await _sleep(150);
  }
}

// 列出行事曆內全部事件 id（分頁）
async function _listAllEventIds(token, calId) {
  const ids = [];
  let pageToken = null;
  do {
    const url = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events?maxResults=2500&singleEvents=false&showDeleted=true`
              + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const r = await _fetchRetry(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('讀取事件失敗：' + ((j.error && j.error.message) || r.status));
    (j.items || []).forEach(e => { if (e.id) ids.push(e.id); });
    pageToken = j.nextPageToken || null;
  } while (pageToken);
  return ids;
}

// 清除重建：刪光「繪新派單」行事曆內所有事件（此曆專用），清空 event id，再重新同步一份乾淨的
// 用來修正「早期同步未記 id 造成的孤兒事件 → 重複」
async function _runRebuild() {
  const token = await gdrive.accessToken();
  const calId = await _ensureCalendar(token);
  try { _job.dupCalendars = (await duplicateCalendars()).length; } catch {}
  // 先刪掉「多出來的」重複繪新派單曆（保留目前使用的這本），否則跨曆重複永遠清不掉
  _job.phase = '清除重複行事曆';
  try {
    const extras = (await duplicateCalendars()).filter(c => c.id !== calId && c.accessRole === 'owner');
    for (const c of extras) {
      const r = await _fetchRetry(`${CAL_API}/calendars/${encodeURIComponent(c.id)}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      if (r.ok || r.status === 404 || r.status === 410) _job.purged++;
      await _sleep(120);
    }
  } catch (e) { if (!_job.sampleError) _job.sampleError = '清除重複曆：' + e.message; }
  _job.phase = '清除舊事件';
  const ids = await _listAllEventIds(token, calId);
  _job.total = ids.length;
  for (const eid of ids) {
    const r = await _fetchRetry(`${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eid)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    if (r.ok || r.status === 404 || r.status === 410) _job.purged++;
    else { _job.fail++; if (!_job.sampleError) _job.sampleError = '刪除事件失敗 HTTP ' + r.status + '（多半是 Google 速率限制，建議改用硬重置）'; }
    await _sleep(120); // 節流：避免刪除大量事件時觸發速率限制
  }
  db.prepare('UPDATE dispatches SET gcal_event_id=NULL').run();  // 全部重建
  db.prepare('UPDATE cases SET survey_gcal_event_id=NULL').run(); // 場勘事件也一併重建
  db.prepare('UPDATE adhoc_events SET gcal_event_id=NULL').run(); // 暫定事項也一併重建
  await _runSyncAll();
}

// 硬重置：直接刪掉整個「繪新派單」行事曆（一次 API 呼叫清光裡面所有事件，不受逐筆刪除的速率限制），
// 再建一個全新的空行事曆重新同步。用於事件數爆量(上千筆)導致逐筆清除卡在速率限制時。
// 代價：行事曆 id 會變，先前分享給師傅的訂閱需重新分享。
async function _runHardReset() {
  const token = await gdrive.accessToken();
  _job.phase = '刪除所有「繪新派單」行事曆';
  // 刪掉帳號內「所有」叫繪新派單、且自己是擁有者的行事曆（含重複的多本），一次清乾淨。
  // 舊版只刪 settings 記的那一本，重複曆會殘留 → 事件永遠重複。這裡改為全刪。
  const owned = (await duplicateCalendars()).filter(c => c.accessRole === 'owner');
  const stored = getS('gcal_dispatch_calendar_id');
  const ids = [...new Set([...owned.map(c => c.id), ...(stored ? [stored] : [])])];
  for (const id of ids) {
    // DELETE 整個次要行事曆＝連同裡面全部事件一起消失，一次搞定
    const r = await _fetchRetry(`${CAL_API}/calendars/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    if (r.ok || r.status === 404 || r.status === 410) { _job.purged++; }
    else {
      // 刪不掉(非 404/410)就中止，不要默默往下建立新曆造成並存
      const j = await r.json().catch(() => ({}));
      throw new Error('刪除舊行事曆失敗 HTTP ' + r.status + '：' + ((j.error && j.error.message) || '') + '（多半是 Google 速率限制，請等 3–5 分鐘再試）');
    }
    await _sleep(120);
  }
  setS('gcal_dispatch_calendar_id', null);          // 清掉舊 id，_ensureCalendar 會建新的
  db.prepare('UPDATE dispatches SET gcal_event_id=NULL').run();
  db.prepare('UPDATE cases SET survey_gcal_event_id=NULL').run();
  db.prepare('UPDATE adhoc_events SET gcal_event_id=NULL').run();
  _job.phase = '建立新行事曆';
  await _ensureCalendar(token);                      // 建立全新空行事曆
  _job.phase = '重新同步';
  await _runSyncAll();                               // 重新同步派工＋場勘
}

// 啟動背景同步（立即回傳、不阻塞 HTTP）。kind: 'sync' 一般回填 / 'rebuild' 清除重建 / 'reset' 硬重置
function startSync(kind) {
  if (!isConnected()) throw new Error('尚未連接 Google');
  if (_job.running) return { running: true, already: true, ..._job };
  _job = { kind, running: true, phase: '準備中', total: 0, ok: 0, fail: 0, purged: 0, sampleError: null, aborted: false, done: false, dupCalendars: 0 };
  const task = kind === 'reset' ? _runHardReset() : kind === 'rebuild' ? _runRebuild() : _runSyncAll();
  task.catch(e => { _job.sampleError = _job.sampleError || e.message; _job.aborted = true; })
      .finally(() => { _job.running = false; _job.done = true; _job.phase = '完成'; });
  return { started: true, kind };
}

// 診斷：Google 帳號裡叫「繪新派單」的行事曆有幾個（>1 代表有重複曆，需手動刪多的）
async function duplicateCalendars() {
  if (!isConnected()) return [];
  const token = await gdrive.accessToken();
  const r = await _fetchRetry(`${CAL_API}/users/me/calendarList?maxResults=250`,
    { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return [];
  return (j.items || []).filter(c => c.summary === '繪新派單').map(c => ({ id: c.id, summary: c.summary, accessRole: c.accessRole }));
}

// 把「繪新派單」行事曆分享給指定 email（加入對方 Google 行事曆清單）
// role: reader(唯讀，給師傅/檢視) / writer(可編輯)
async function shareCalendar(email, role) {
  email = (email || '').trim();
  if (!email) throw new Error('請輸入 email');
  if (!isConnected()) throw new Error('尚未連接 Google');
  const token = await gdrive.accessToken();
  const calId = await _ensureCalendar(token);
  const r = await _fetchRetry(`${CAL_API}/calendars/${encodeURIComponent(calId)}/acl?sendNotifications=true`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: role === 'writer' ? 'writer' : 'reader', scope: { type: 'user', value: email } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('分享失敗：' + ((j.error && j.error.message) || r.status));
  _rememberShare(email, role);   // 記住分享名單，硬重置/重建換新行事曆時可自動還原
  return { ok: true, calendarId: calId, email, role: role === 'writer' ? 'writer' : 'reader' };
}
// 已記住的分享名單（供設定頁顯示 / 手動還原）
function listShares() { return _getShares(); }
// 手動把記住的名單重新套用到目前行事曆（例如舊資料沒記到、想補上）
async function reapplyShares() {
  if (!isConnected()) throw new Error('尚未連接 Google');
  const token = await gdrive.accessToken();
  const calId = await _ensureCalendar(token);
  await _reapplyShares(token, calId);
  return { ok: true, count: _getShares().length };
}

// 診斷：列出帳號內所有叫「繪新派單」的行事曆、各有幾筆事件、系統目前用的是哪一個
async function diagnose() {
  if (!isConnected()) throw new Error('尚未連接 Google');
  const token = await gdrive.accessToken();
  const storedId = getS('gcal_dispatch_calendar_id') || null;
  const r = await _fetchRetry(`${CAL_API}/users/me/calendarList?maxResults=250`,
    { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  const named = (j.items || []).filter(c => c.summary === '繪新派單');
  const calendars = [];
  for (const c of named) {
    let eventCount = null;
    try { eventCount = (await _listAllEventIds(token, c.id)).length; } catch (e) { eventCount = 'err:' + e.message; }
    calendars.push({ id: c.id, isStored: c.id === storedId, accessRole: c.accessRole, eventCount });
  }
  const dispatchCount = db.prepare(`SELECT COUNT(*) n FROM dispatches WHERE status != 'cancelled'`).get().n;
  const surveyCount = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT DISTINCT c.id FROM cases c
      LEFT JOIN survey_forms sf ON sf.case_id = c.id
      WHERE c.status NOT IN ('closed','invalid')
        AND COALESCE(sf.survey_date, c.survey_date) IS NOT NULL)
  `).get().n;
  const storedInList = named.some(c => c.id === storedId);
  return { storedId, storedInList, dispatchCount, surveyCount, namedCount: calendars.length, calendars };
}

// 只刪「多餘的重複」繪新派單，保留目前使用中(stored)那本 → 訂到正確那本的同事完全不受影響，
// 訂到舊那本的會自動從清單消失。比硬重置安全：不換行事曆、不需大家重訂、不重同步。
async function purgeDuplicateCalendars() {
  if (!isConnected()) throw new Error('尚未連接 Google');
  const token = await gdrive.accessToken();
  const stored = getS('gcal_dispatch_calendar_id');
  const owned = (await duplicateCalendars()).filter(c => c.accessRole === 'owner');
  // 安全鎖：找不到「使用中」那本、或它不在自己擁有的清單裡 → 不動作，避免誤刪唯一一本
  if (!stored || !owned.some(c => c.id === stored)) {
    return { ok: false, needReset: true, keptId: stored || null, ownedCount: owned.length,
      message: '找不到「使用中」的行事曆，為安全起見未刪除。請先按「同步全部」建立/指定使用中那本，或改用硬重置。' };
  }
  const toDelete = owned.filter(c => c.id !== stored);
  let deleted = 0;
  for (const c of toDelete) {
    const r = await _fetchRetry(`${CAL_API}/calendars/${encodeURIComponent(c.id)}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    if (r.ok || r.status === 404 || r.status === 410) { deleted++; }
    else {
      const j = await r.json().catch(() => ({}));
      throw new Error('刪除多餘行事曆失敗 HTTP ' + r.status + '：' + ((j.error && j.error.message) || '') + '（多半是 Google 速率限制，請等 3–5 分鐘再試）');
    }
    await _sleep(120);
  }
  // 保險：把記住的共用名單重新套用到保留的那本，確保同事都掛在正確那本上
  try { await _reapplyShares(token, stored); } catch (e) { /* 非關鍵 */ }
  return { ok: true, deleted, keptId: stored, ownedCountBefore: owned.length };
}

function calendarInfo() {
  return { enabled: syncEnabled(), connected: isConnected(), calendarId: getS('gcal_dispatch_calendar_id') || null };
}

module.exports = { safeSyncDispatch, safeSyncSurvey, safeSyncAdhoc, safeRemoveAdhoc, safeRemoveEvent, startSync, syncJobStatus, duplicateCalendars, shareCalendar, listShares, reapplyShares, diagnose, purgeDuplicateCalendars, syncEnabled, setEnabled, calendarInfo };
