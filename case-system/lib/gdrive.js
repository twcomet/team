// Google Drive 整合（OAuth，用 Gmail 授權；只用最小權限 drive.file）
// 純 fetch，不裝額外 npm 套件。Token 存 settings 表，access token 用時即取。
const db = require('../db');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.GDRIVE_REDIRECT_URI
                    || 'https://twcometsystem.zeabur.app/api/gdrive/callback';
const SCOPE         = 'https://www.googleapis.com/auth/drive.file';

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

async function _tokenReq(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google token 失敗：' + (j.error_description || j.error || r.status));
  return j;
}

// 用授權碼換 refresh token（一次性授權）
async function exchangeCode(code) {
  const j = await _tokenReq({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  });
  if (j.refresh_token) setS('gdrive_refresh_token', j.refresh_token);
  return j;
}

async function accessToken() {
  const rt = getS('gdrive_refresh_token');
  if (!rt) throw new Error('尚未連接 Google 雲端');
  const j = await _tokenReq({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: rt, grant_type: 'refresh_token',
  });
  return j.access_token;
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

// 母資料夾「繪新案件資料」——所有案件資料夾開在裡面（app 自己建，drive.file 才能寫子資料夾）
async function _ensureParent(token) {
  const pid = getS('gdrive_parent_id');
  if (pid) return pid;
  const f = await _createFolder('繪新案件資料', null, token);
  setS('gdrive_parent_id', f.id);
  return f.id;
}

// 為案件建立資料夾，回傳 { id, webViewLink }
async function createCaseFolder(name) {
  const token  = await accessToken();
  const parent = await _ensureParent(token);
  return _createFolder(name || '未命名案件', parent, token);
}

// 中斷連接（清掉 token）
function disconnect() {
  setS('gdrive_refresh_token', null);
  db.prepare("DELETE FROM settings WHERE key='gdrive_refresh_token'").run();
}

module.exports = { isConfigured, isConnected, authUrl, exchangeCode, createCaseFolder, disconnect };
