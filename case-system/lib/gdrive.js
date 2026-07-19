// Google Drive 整合（OAuth，用 Gmail 授權；只用最小權限 drive.file）
// 純 fetch，不裝額外 npm 套件。Token 存 settings 表，access token 用時即取。
const db = require('../db');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.GDRIVE_REDIRECT_URI
                    || 'https://twcometsystem.zeabur.app/api/gdrive/callback';
// drive.file：只能存取自己建立的資料夾；calendar：派單行事曆同步
const SCOPE         = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar';

const getS = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setS = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v == null ? null : String(v));

const isConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);
const isConnected  = () => !!getS('gdrive_refresh_token');

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',       // 拿 refresh token
    prompt: 'consent',            // 每次都給 refresh token
    include_granted_scopes: 'true',
    state: state || '',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function _tokenReq(params) {
  // 遇端點節流(429)或暫時性 5xx 自動退避重試；invalid_grant 等永久錯誤直接拋出不重試
  let j = {};
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const transient = r.status === 429 || r.status >= 500 || j.error === 'rate_limit_exceeded';
    if (!transient || i === 4) throw new Error('Google token 失敗：' + (j.error_description || j.error || r.status));
    await _sleep(Math.min(1000 * 2 ** i, 15000)); // 1s,2s,4s,8s,15s
  }
  return j;
}

// 用授權碼換 refresh token（一次性授權）
async function exchangeCode(code) {
  const j = await _tokenReq({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  });
  if (j.refresh_token) setS('gdrive_refresh_token', j.refresh_token);
  _clearTokenCache();   // 重新授權（可能換帳號）→ 丟棄舊 access token 快取
  // 可能換了 Google 帳號：舊帳號的母資料夾/備份夾 ID 對新帳號無效（drive.file 碰不到）。
  // 清掉快取 ID，讓 _ensureParent / _ensureBackupFolder 用新帳號重新尋找（找得到同名沿用，否則新建）。
  setS('gdrive_parent_id', null);
  setS('gdrive_backup_folder_id', null);
  return j;
}

// 快取 access token：Google 效期約 1 小時。批次回填數百筆時，若每筆都打 OAuth
// token 端點換發，會觸發端點節流導致整批失敗——效期內重用同一個 token 即可根治。
let _tok = { value: null, exp: 0, rt: null };
async function accessToken() {
  const rt = getS('gdrive_refresh_token');
  if (!rt) throw new Error('尚未連接 Google 雲端');
  // refresh token 沒變且 access token 未過期 → 直接重用
  if (_tok.value && _tok.rt === rt && Date.now() < _tok.exp) return _tok.value;
  const j = await _tokenReq({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: rt, grant_type: 'refresh_token',
  });
  const ttlMs = (Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600) * 1000;
  _tok = { value: j.access_token, exp: Date.now() + ttlMs - 5 * 60 * 1000, rt }; // 提前 5 分鐘換發，留安全邊際
  return j.access_token;
}
function _clearTokenCache() { _tok = { value: null, exp: 0, rt: null }; }

// 同一把鑰匙的建立動作串行化：避免「查有沒有 → 建立(await Google) → 存回網址」
// 之間的 await 空檔讓兩個並發請求都查到「還沒有」而各建一個（同案件按兩次會出現重複資料夾）。
// 第一個跑完寫回網址後，排在後面的就會查到已存在、直接回傳現有網址。
const _folderLocks = new Map();
function _withLock(key, fn) {
  const prev = _folderLocks.get(key) || Promise.resolve();
  const cur = prev.catch(() => {}).then(fn);   // 不論前一個成敗都接著跑
  _folderLocks.set(key, cur);
  cur.finally(() => { if (_folderLocks.get(key) === cur) _folderLocks.delete(key); });
  return cur;
}

async function _createFolder(name, parentId, token) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('建立資料夾失敗：' + ((j.error && j.error.message) || r.status));
  return j; // { id, webViewLink }
}

// 在「我的雲端硬碟」根目錄找 app 建過的同名資料夾（沿用，避免重新連接時建出重複的頂層資料夾）
async function _findRootFolder(name, token) {
  const q = `name='${String(name).replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
  const r = await fetch('https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name)&pageSize=10&q=' + encodeURIComponent(q), {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  return (j.files && j.files[0]) ? j.files[0].id : null;
}

// 母資料夾「繪新案件資料」——所有案件資料夾開在裡面（app 自己建，drive.file 才能寫子資料夾）
async function _ensureParent(token) {
  const pid = getS('gdrive_parent_id');
  if (pid) return pid;
  let id = await _findRootFolder('繪新案件資料', token);   // 先找現有的（同帳號重連可沿用）
  if (!id) { const f = await _createFolder('繪新案件資料', null, token); id = f.id; }
  setS('gdrive_parent_id', id);
  return id;
}

// 為案件建立資料夾，回傳 { id, webViewLink }
async function createCaseFolder(name) {
  const token  = await accessToken();
  const parent = await _ensureParent(token);
  return _createFolder(name || '未命名案件', parent, token);
}

// 資料夾名前綴年月：優先用建立日期(YYYY-MM)，取不到再從案號 HXyymm 解析
function _yearMonth(createdAt, caseNumber) {
  const m = String(createdAt || '').match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const cm = String(caseNumber || '').match(/^[A-Za-z]*(\d{2})(\d{2})/);
  if (cm) return `20${cm[1]}-${cm[2]}`;
  return '';
}

// 確保案件有雲端資料夾（沒有才建立），回傳資料夾網址或 null。未連 Google / 已有資料夾則不動作。
function ensureCaseFolder(caseId) {
  if (!isConnected()) return Promise.resolve(null);
  return _withLock('case:' + caseId, () => _ensureCaseFolderInner(caseId));
}
async function _ensureCaseFolderInner(caseId) {
  const c = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.drive_folder_url, c.created_at, cl.name AS client_name
    FROM cases c LEFT JOIN clients cl ON c.client_id = cl.id WHERE c.id = ?
  `).get(caseId);
  if (!c) return null;
  if (c.drive_folder_url) return c.drive_folder_url;
  const name = [_yearMonth(c.created_at, c.case_number), c.case_number, c.title, c.client_name].filter(Boolean).join(' ');
  const f = await createCaseFolder(name);
  db.prepare('UPDATE cases SET drive_folder_id = ?, drive_folder_url = ? WHERE id = ?').run(f.id, f.webViewLink, c.id);
  return f.webViewLink;
}

// best-effort 版本：永不 throw（用於案件建立等流程，不阻塞、不影響存檔）
function safeEnsureCaseFolder(caseId) {
  if (!isConnected()) return Promise.resolve(null);
  return ensureCaseFolder(caseId).catch(e => { console.error('[gdrive] 自動建立資料夾失敗 case#' + caseId + '：', e.message); return null; });
}

// 批次補建：為所有還沒有資料夾的案件建立（排除作廢），回傳統計
async function backfillCaseFolders() {
  if (!isConnected()) throw new Error('尚未連接 Google');
  const rows = db.prepare(`
    SELECT id FROM cases
    WHERE (drive_folder_url IS NULL OR drive_folder_url = '')
      AND status <> 'invalid'
    ORDER BY id DESC
  `).all();
  let ok = 0, fail = 0, sampleError = null;
  for (const r of rows) {
    try { await ensureCaseFolder(r.id); ok++; }
    catch (e) { fail++; if (!sampleError) sampleError = e.message; if (ok === 0 && fail >= 3) break; }
  }
  return { total: rows.length, ok, fail, sampleError };
}

// 改名（同一個檔案/資料夾，只改名稱，內容/ID/共享都不動）
async function _renameFile(fileId, name, token) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('資料夾改名失敗：' + ((j.error && j.error.message) || r.status)); }
}

// 派工子資料夾：建在「案件資料夾」裡面（父層＝案件資料夾，絕不另開頂層資料夾）。
//   命名 YYYYMMDD_類型_師傅名字；場勘/施工/維修才建，材料(裁料)不建。
//   已建者：改人員/日期 → 同一個資料夾直接改名（ID 不變、內容都在）。
const _DISPATCH_SUB_LABELS = { survey: '場勘', factory_survey: '場勘', install: '施工', aftersales: '維修' };
function ensureDispatchSubfolder(dispatchId) {
  if (!isConnected()) return Promise.resolve(null);
  return _withLock('dispatch:' + dispatchId, () => _ensureDispatchSubfolderInner(dispatchId));
}
async function _ensureDispatchSubfolderInner(dispatchId) {
  const d = db.prepare(`
    SELECT d.id, d.dispatch_type, d.scheduled_date, d.case_id,
           d.drive_subfolder_id, d.drive_subfolder_url, d.drive_subfolder_name,
           ld.name AS leader_name,
           (SELECT GROUP_CONCAT(u.name, '、') FROM dispatch_users du JOIN users u ON u.id = du.user_id
              WHERE du.dispatch_id = d.id) AS workers
    FROM dispatches d LEFT JOIN users ld ON ld.id = d.leader_id
    WHERE d.id = ?
  `).get(dispatchId);
  if (!d) return null;
  const label = _DISPATCH_SUB_LABELS[d.dispatch_type];
  if (!label) return null;                                  // 材料/其他 → 不建
  // 師傅名字：小組長第一、組員在後、去重（完整姓名）
  const crew = [];
  if (d.leader_name) crew.push(String(d.leader_name).trim());
  if (d.workers) String(d.workers).split('、').forEach(n => { n = n.trim(); if (n && !crew.includes(n)) crew.push(n); });
  const dateStr = String(d.scheduled_date || '').replace(/-/g, '');
  const base = [dateStr, label].filter(Boolean).join('_');
  let name = crew.length ? `${base}_${crew.join('、')}` : base;

  // 拍照者：完工回報指定後直接寫進資料夾名稱（可能多人多筆回報，取聯集）
  const wrs = db.prepare(`SELECT photographer_ids FROM work_reports
    WHERE dispatch_id=? AND photographer_ids IS NOT NULL AND photographer_ids NOT IN ('', '[]')`).all(d.id);
  if (wrs.length) {
    const pids = [];
    wrs.forEach(w => { try { JSON.parse(w.photographer_ids).forEach(id => { if (!pids.includes(id)) pids.push(id); }); } catch {} });
    if (pids.length) {
      const rows = db.prepare(`SELECT id, name FROM users WHERE id IN (${pids.map(() => '?').join(',')})`).all(...pids);
      const map = {}; rows.forEach(r => { map[r.id] = r.name; });
      const photog = pids.map(id => map[id]).filter(Boolean);
      if (photog.length) name += `_拍照${photog.join('、')}`;
    }
  }

  const token = await accessToken();
  if (d.drive_subfolder_id) {                               // 已有 → 名稱變了才改名（同一個資料夾）
    if (d.drive_subfolder_name !== name) {
      await _renameFile(d.drive_subfolder_id, name, token);
      db.prepare('UPDATE dispatches SET drive_subfolder_name=? WHERE id=?').run(name, d.id);
    }
    return d.drive_subfolder_url;
  }
  await ensureCaseFolder(d.case_id);                        // 保底：先確保案件資料夾存在
  const c = db.prepare('SELECT drive_folder_id FROM cases WHERE id=?').get(d.case_id);
  if (!c || !c.drive_folder_id) return null;                // 仍無案件資料夾 → 略過
  const f = await _createFolder(name, c.drive_folder_id, token);   // 父層＝案件資料夾 → 一定在案件夾裡面
  db.prepare('UPDATE dispatches SET drive_subfolder_id=?, drive_subfolder_url=?, drive_subfolder_name=? WHERE id=?')
    .run(f.id, f.webViewLink, name, d.id);
  return f.webViewLink;
}
function safeEnsureDispatchSubfolder(dispatchId) {
  if (!isConnected()) return Promise.resolve(null);
  return ensureDispatchSubfolder(dispatchId).catch(e => { console.error('[gdrive] 派工子資料夾失敗 dispatch#' + dispatchId + '：', e.message); return null; });
}

// 場勘單（客服填寫區流程，非派工）→ 在案件資料夾內建「場勘」子資料夾，含場勘人員名字，改人員/日期自動改名
function ensureSurveyFolder(caseId) {
  if (!isConnected()) return Promise.resolve(null);
  return _withLock('survey:' + caseId, () => _ensureSurveyFolderInner(caseId));
}
async function _ensureSurveyFolderInner(caseId) {
  const sf = db.prepare(`
    SELECT sf.id, sf.survey_date, sf.drive_subfolder_id, sf.drive_subfolder_url, sf.drive_subfolder_name,
           u.name AS surveyor_name
    FROM survey_forms sf LEFT JOIN users u ON u.id = sf.surveyor_id
    WHERE sf.case_id = ? ORDER BY sf.id DESC LIMIT 1
  `).get(caseId);
  if (!sf) return null;
  if (!sf.survey_date && !sf.surveyor_name) return null;          // 尚未排場勘 → 先不建
  const dateStr = String(sf.survey_date || '').replace(/-/g, '');
  const crew = sf.surveyor_name ? String(sf.surveyor_name).trim() : '';
  const base = [dateStr, '場勘'].filter(Boolean).join('_');
  const name = crew ? `${base}_${crew}` : base;

  const token = await accessToken();
  if (sf.drive_subfolder_id) {                                    // 已有 → 名稱變了才改名（同一個資料夾）
    if (sf.drive_subfolder_name !== name) {
      await _renameFile(sf.drive_subfolder_id, name, token);
      db.prepare('UPDATE survey_forms SET drive_subfolder_name=? WHERE id=?').run(name, sf.id);
    }
    return sf.drive_subfolder_url;
  }
  await ensureCaseFolder(caseId);                                 // 保底：先確保案件資料夾存在
  const c = db.prepare('SELECT drive_folder_id FROM cases WHERE id=?').get(caseId);
  if (!c || !c.drive_folder_id) return null;
  const f = await _createFolder(name, c.drive_folder_id, token);
  db.prepare('UPDATE survey_forms SET drive_subfolder_id=?, drive_subfolder_url=?, drive_subfolder_name=? WHERE id=?')
    .run(f.id, f.webViewLink, name, sf.id);
  return f.webViewLink;
}
function safeEnsureSurveyFolder(caseId) {
  if (!isConnected()) return Promise.resolve(null);
  return ensureSurveyFolder(caseId).catch(e => { console.error('[gdrive] 場勘子資料夾失敗 case#' + caseId + '：', e.message); return null; });
}

// 目前連接的 Google 帳號 email + 容量（讓老闆確認系統連的是哪個帳號、還剩多少空間）
async function accountInfo() {
  if (!isConnected()) return { connected: false };
  const token = await accessToken();
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage,usageInDrive)', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('查詢帳號資訊失敗：' + ((j.error && j.error.message) || r.status));
  const q = j.storageQuota || {};
  const limit = q.limit != null ? Number(q.limit) : null;   // null = 無上限（Workspace 無限方案）
  const usage = q.usage != null ? Number(q.usage) : null;
  return {
    connected: true,
    email: j.user && j.user.emailAddress || null,
    name:  j.user && j.user.displayName  || null,
    limit, usage,
    usageInDrive: q.usageInDrive != null ? Number(q.usageInDrive) : null,
    percent: (limit && usage != null) ? Math.round(usage / limit * 100) : null,
  };
}

// 中斷連接（清掉 token）
function disconnect() {
  setS('gdrive_refresh_token', null);
  db.prepare("DELETE FROM settings WHERE key='gdrive_refresh_token'").run();
  _clearTokenCache();
}

// ── 系統資料庫備份：專屬備份資料夾 + 上傳 + 只保留最近 N 份 ──────────────
// drive.file 權限：app 只能存取自己建立的檔案/資料夾，備份夾與備份檔皆 app 自建，故可管理。
async function _ensureBackupFolder(token) {
  const cached = getS('gdrive_backup_folder_id');
  if (cached) return cached;
  let id = await _findRootFolder('繪新系統備份（資料庫）', token);   // 先找現有的（同帳號重連可沿用）
  if (!id) { const f = await _createFolder('繪新系統備份（資料庫）', null, token); id = f.id; }
  setS('gdrive_backup_folder_id', id);
  return id;
}
// 上傳一份資料庫備份（buf = 檔案內容 Buffer）
async function uploadBackup(name, buf) {
  const token    = await accessToken();
  const folderId = await _ensureBackupFolder(token);
  const boundary = 'hxbk' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/x-sqlite3\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('備份上傳失敗：' + ((j.error && j.error.message) || r.status));
  return j;
}
// 只保留最近 keep 份（依檔名新到舊排序），較舊的刪除；回傳刪除份數
async function pruneBackups(keep) {
  const token    = await accessToken();
  const folderId = await _ensureBackupFolder(token);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&orderBy=name desc&fields=files(id,name)&pageSize=1000`, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  const extra = (j.files || []).slice(keep);
  for (const f of extra) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  }
  return extra.length;
}
// 列出最近備份（後台顯示用）
async function listBackups(limit) {
  const token    = await accessToken();
  const folderId = await _ensureBackupFolder(token);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&orderBy=name desc&fields=files(id,name,size,createdTime)&pageSize=${Math.min(Number(limit) || 20, 100)}`, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  return { folderId, files: j.files || [] };
}

// ── 客服對話備份：獨立母資料夾「系統客服對話紀錄」（跟案件樹分開；權限由使用者在此夾自行分享）──
async function _ensureCsRoot(token) {
  const pid = getS('gdrive_cs_root_id');
  if (pid) return pid;
  let id = await _findRootFolder('系統客服對話紀錄', token);   // 同帳號重連可沿用
  if (!id) { const f = await _createFolder('系統客服對話紀錄', null, token); id = f.id; }
  setS('gdrive_cs_root_id', id);
  return id;
}
function _safeName(s) { return String(s || '').replace(/[\\/?%*:|"<>\r\n]+/g, ' ').trim().slice(0, 120); }
// 第二層客戶資料夾命名：「系統存檔 客戶名稱 #客戶編號」（編號＝系統客戶 id）
function _clientFolderName(clientId, clientName) {
  return _safeName('系統存檔 ' + (clientName || ('客戶' + clientId)) + ' #' + clientId);
}
// 某客戶在「系統客服對話紀錄」下的子夾（存 clients.drive_cs_folder_id）
async function ensureClientCsFolder(clientId, clientName) {
  const c = db.prepare('SELECT id, drive_cs_folder_id FROM clients WHERE id=?').get(clientId);
  if (!c) throw new Error('找不到客戶');
  const wantName = _clientFolderName(clientId, clientName);
  if (c.drive_cs_folder_id) {
    try { const token = await accessToken(); await _renameFile(c.drive_cs_folder_id, wantName, token); } catch (e) {} // 既有資料夾自動更名成新格式
    return c.drive_cs_folder_id;
  }
  const token = await accessToken();
  const root  = await _ensureCsRoot(token);
  const f = await _createFolder(wantName, root, token);
  db.prepare('UPDATE clients SET drive_cs_folder_id=? WHERE id=?').run(f.id, clientId);
  return f.id;
}
// 某案件在客戶夾下的子夾（存 cases.drive_cs_folder_id）→ 回傳 { folderId, link }
async function ensureCaseCsFolder(caseId) {
  const cs = db.prepare('SELECT id, drive_cs_folder_id, drive_cs_folder_url, client_id, case_number, title FROM cases WHERE id=?').get(caseId);
  if (!cs) throw new Error('找不到案件');
  if (cs.drive_cs_folder_id) return { folderId: cs.drive_cs_folder_id, link: cs.drive_cs_folder_url || null };
  if (!cs.client_id) throw new Error('此案件尚未連結客戶，請先在報價單「儲存並建檔」或指定客戶');
  const cl = db.prepare('SELECT name FROM clients WHERE id=?').get(cs.client_id);
  const clientFolder = await ensureClientCsFolder(cs.client_id, cl && cl.name);
  const token = await accessToken();
  const name = _safeName((cs.case_number ? cs.case_number + ' ' : '') + (cs.title || '')) || ('案件' + caseId);
  const f = await _createFolder(name, clientFolder, token);
  db.prepare('UPDATE cases SET drive_cs_folder_id=?, drive_cs_folder_url=? WHERE id=?').run(f.id, f.webViewLink || null, caseId);
  return { folderId: f.id, link: f.webViewLink || null };
}
// ── 合約簽署雲端樹：母資料夾「合約簽署」→ 依合約標題分類子夾 ──
async function _ensureContractRoot(token) {
  const pid = getS('gdrive_contract_root_id');
  if (pid) return pid;
  let id = await _findRootFolder('合約簽署', token);   // 同帳號重連可沿用
  if (!id) { const f = await _createFolder('合約簽署', null, token); id = f.id; }
  setS('gdrive_contract_root_id', id);
  return id;
}
// 某合約在「合約簽署」下的分類子夾（存 contracts.drive_folder_id；標題改了自動更名）
async function ensureContractFolder(contractId, title) {
  const c = db.prepare('SELECT id, drive_folder_id FROM contracts WHERE id=?').get(contractId);
  if (!c) throw new Error('找不到合約');
  const wantName = _safeName(title || ('合約' + contractId));
  if (c.drive_folder_id) {
    try { const token = await accessToken(); await _renameFile(c.drive_folder_id, wantName, token); } catch (e) {}
    return c.drive_folder_id;
  }
  const token = await accessToken();
  const root  = await _ensureContractRoot(token);
  const f = await _createFolder(wantName, root, token);
  db.prepare('UPDATE contracts SET drive_folder_id=? WHERE id=?').run(f.id, contractId);
  return f.id;
}

// 通用：上傳一個檔案(buffer)到指定資料夾
async function uploadFileToFolder(folderId, name, buf, mime) {
  const token = await accessToken();
  const boundary = 'hxf' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`),
    Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('檔案上傳失敗：' + ((j.error && j.error.message) || r.status));
  return j;
}

// 更名既有檔案/資料夾（供對話 PDF 補上客戶名關鍵字）
async function renameFile(fileId, name) {
  const token = await accessToken();
  return _renameFile(fileId, name, token);
}
// 更新既有檔案內容（去重複用：對話 PDF 每次覆蓋同一份，不新增）
async function updateFileContent(fileId, buf, mime) {
  const token = await accessToken();
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': mime || 'application/octet-stream' },
    body: Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('檔案更新失敗：' + ((j.error && j.error.message) || r.status));
  return j;
}

module.exports = { isConfigured, isConnected, authUrl, exchangeCode, createCaseFolder, ensureCaseFolder, safeEnsureCaseFolder, backfillCaseFolders, ensureDispatchSubfolder, safeEnsureDispatchSubfolder, ensureSurveyFolder, safeEnsureSurveyFolder, disconnect, accessToken, accountInfo, uploadBackup, pruneBackups, listBackups, ensureClientCsFolder, ensureCaseCsFolder, ensureContractFolder, uploadFileToFolder, updateFileContent, renameFile };
