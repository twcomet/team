const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
require('./db'); // 初始化資料庫

const fs   = require('fs');
const { requireAuth, requireOwner } = require('./middleware/auth');

// 確保資料目錄存在（Zeabur volume）
const dataDir = process.env.DB_PATH ? require('path').dirname(process.env.DB_PATH) : __dirname;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// LINE webhook 必須在 express.json() 之前，才能取得 raw body 做簽名驗證
app.use('/webhook', require('./routes/webhook'));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 防止直接以 /xxx.html 繞過路由層的登入/權限檢查
// 公開 HTML 頁（客戶用、不需登入）保持可直接訪問
const PUBLIC_HTML = new Set(['login.html', 'survey-sign.html', 'quote-sign.html', 'survey-worker.html']);
app.use((req, res, next) => {
  if (req.path.endsWith('.html') && !PUBLIC_HTML.has(path.basename(req.path))) {
    return res.redirect(308, req.path.slice(0, -5) + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dataDir }),
  secret: process.env.SESSION_SECRET || 'huixin-internal-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' }
}));

// ── API 路由 ─────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/orgs',   require('./routes/orgs'));
app.use('/api/users',  require('./routes/users'));
app.use('/api/clients',require('./routes/clients'));
app.use('/api/cases',  require('./routes/cases'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/survey',  require('./routes/survey'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/search', require('./routes/search'));
app.use('/api/ledger', require('./routes/ledger'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/tags',       require('./routes/tags'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/my-tasks',        require('./routes/my-tasks'));
app.use('/api/my-calendar',     require('./routes/my-calendar'));
app.use('/api/dispatch-detail',   require('./routes/dispatch-detail'));
app.use('/api/materials',         require('./routes/materials'));
app.use('/api/reports',           require('./routes/reports'));
app.use('/api/notifications',     require('./routes/notifications'));
app.use('/api/settings',          require('./routes/settings'));
app.use('/api/marketplace',       require('./routes/marketplace'));
app.use('/api/line-inquiries',    require('./routes/line-inquiries'));
app.use('/api/marketing',             require('./routes/marketing'));
app.use('/api/invalid-reason-tags',   require('./routes/invalid-reason-tags'));
app.use('/api/hr',                    require('./routes/hr'));
app.use('/api/attendance',            require('./routes/attendance'));
app.use('/api/client-deposits',       require('./routes/client-deposits'));
app.use('/api/contracts',             require('./routes/contracts'));
app.use('/api/expenses',              require('./routes/expenses'));

// ── 前端公開設定 ──────────────────────────────────────────────
app.get('/api/config/maps-key', requireAuth, (req, res) => {
  res.json({ key: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// ── 頁面路由 ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 頁面 → 對應的 permission key（owner 永遠放行）
const PAGE_PERMS = {
  dashboard:        'page_dashboard',
  cases:            'page_cases',
  'cases-inquiry':  'page_cases',
  'cases-survey':   'page_cases',
  'cases-deal':     'page_cases_deal',
  'case-detail':    'page_cases',
  clients:          'page_clients',
  'client-detail':  'page_clients',
  calendar:         'page_calendar',
  payments:         'page_payments',
  ledger:           'page_ledger',
  'line-inquiries': 'page_line_inquiries',
  'dispatch-detail':'page_cases',
  'survey-form':    'page_cases',
  'quote-form':     'page_cases',
  admin:            'manage_users',
  materials:        'page_materials',
  'material-calc':  'page_material_calc',
  reports:          'page_reports',
  performance:      'page_performance',
  'dispatch-pool':  'page_dispatch_pool',
  marketing:        'page_marketing',
  hr:               'page_hr',
  contracts:        'manage_users',
  expenses:         'page_expenses',
  'expense-liff':   null,
};

function requirePagePerm(page) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/');
    if (u.role === 'owner') return next();
    const key = PAGE_PERMS[page];
    if (!key) return next();
    const p = u.permissions || {};
    let allowed;
    if (key === 'manage_users') {
      allowed = !!u.manage_users;
    } else if (key === 'page_line_inquiries') {
      // 舊 session 無此 key 時退回 page_cases
      allowed = p.page_line_inquiries !== undefined ? p.page_line_inquiries === true : p.page_cases === true;
    } else if (key === 'page_ledger') {
      allowed = p.page_ledger !== undefined ? p.page_ledger === true : p.page_payments === true;
    } else if (key === 'page_dispatch_pool') {
      allowed = p.page_dispatch_pool !== undefined ? p.page_dispatch_pool === true : !!u.manage_users;
    } else if (key === 'page_cases_deal') {
      const HQ = ['owner','vp','hq_cs','hq_sales','hq_accounting','hq_hr'];
      allowed = p.page_cases_deal !== undefined ? p.page_cases_deal === true : HQ.includes(u.role);
    } else if (key === 'page_material_calc') {
      allowed = p.page_material_calc !== undefined ? p.page_material_calc === true : true;
    } else if (key === 'page_materials') {
      allowed = p.page_materials !== undefined ? p.page_materials === true : !!u.manage_users;
    } else if (key === 'page_reports') {
      allowed = p.page_reports !== undefined ? p.page_reports === true : !!u.manage_users;
    } else if (key === 'page_performance') {
      allowed = p.page_performance !== undefined ? p.page_performance === true : !!u.manage_users;
    } else if (key === 'page_marketing') {
      allowed = p.page_marketing !== undefined ? p.page_marketing === true : !!u.manage_users;
    } else if (key === 'page_hr') {
      allowed = p.page_hr !== undefined ? p.page_hr === true : ['owner','hq_hr'].includes(u.role);
    } else {
      allowed = p[key] === true;
    }
    if (!allowed) return res.redirect('/my-tasks');
    next();
  };
}

// 合約簽署頁（已登入員工）
app.get('/contract', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contract.html'));
});

function requireContract(req, res, next) {
  const u = req.session?.user;
  if (!u) return next();
  const pending = db.prepare(`
    SELECT COUNT(*) as cnt FROM contract_assignments ca
    LEFT JOIN contract_signatures cs ON cs.contract_id=ca.contract_id AND cs.user_id=ca.user_id
    JOIN contracts c ON c.id=ca.contract_id AND c.active=1
    WHERE ca.user_id=? AND cs.id IS NULL
  `).get(u.id);
  if (pending?.cnt > 0) return res.redirect('/contract');
  next();
}

const pages = ['dashboard', 'cases', 'cases-inquiry', 'cases-survey', 'cases-deal', 'case-detail', 'calendar', 'payments', 'ledger', 'performance', 'reports', 'marketing', 'admin', 'clients', 'client-detail', 'survey-form', 'quote-form', 'my-tasks', 'my-calendar', 'dispatch-detail', 'materials', 'material-calc', 'marketplace', 'line-inquiries', 'dispatch-pool', 'hr', 'profile', 'contracts', 'guide', 'expenses'];
pages.forEach(page => {
  // cases-inquiry / cases-survey / cases-deal 都共用 cases.html
  const htmlFile = ['cases-inquiry','cases-survey','cases-deal'].includes(page) ? 'cases.html' : `${page}.html`;
  app.get(`/${page}`, requireAuth, requireContract, requirePagePerm(page), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', htmlFile));
  });
});
// /cases 舊路由 → 導向 cases-survey
app.get('/cases', requireAuth, requireContract, (req, res) => res.redirect('/cases-survey'));

// 公開場勘簽名頁（客戶用，不需登入）
app.get('/sign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'survey-sign.html'));
});

// 公開場勘任務頁（師傅用，不需登入）
app.get('/survey-worker', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'survey-worker.html'));
});

// 公開報價單頁（客戶用，不需登入）
app.get('/quote/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quote-sign.html'));
});

// LIFF 打卡頁（不需登入，由 LIFF access_token 驗證身份）
app.get('/liff/clockin', (req, res) => {
  const liffId = process.env.LIFF_ID || '';
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>繪新 打卡</title>
<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/versions/2.22.3/sdk.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans TC',sans-serif;background:#f0f4f8;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
.card{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:360px;box-shadow:0 2px 12px rgba(0,0,0,.08);margin-bottom:16px}
h1{font-size:18px;font-weight:700;color:#1a202c;margin-bottom:4px}
.sub{font-size:13px;color:#718096}
.time-display{font-size:36px;font-weight:700;color:#2d3748;text-align:center;padding:16px 0;letter-spacing:2px}
.date-display{text-align:center;color:#718096;font-size:13px;margin-top:-8px;margin-bottom:16px}
.status-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:14px}
.status-row:last-child{border-bottom:none}
.status-label{color:#718096}
.status-val{font-weight:600;color:#2d3748}
.status-val.late{color:#e53e3e}
.status-val.ok{color:#38a169}
.btn{display:block;width:100%;padding:14px;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .2s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-in{background:#3182ce;color:#fff;margin-bottom:10px}
.btn-out{background:#718096;color:#fff}
.dispatch-item{padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:13px}
.dispatch-item:last-child{border-bottom:none}
.dispatch-title{font-weight:600;color:#2d3748}
.dispatch-sub{color:#718096;margin-top:2px}
.msg{text-align:center;font-size:14px;padding:12px;border-radius:8px;margin-bottom:12px}
.msg-success{background:#c6f6d5;color:#22543d}
.msg-error{background:#fed7d7;color:#742a2a}
.msg-info{background:#bee3f8;color:#2a4365}
#loadingMsg{text-align:center;color:#718096;padding:32px}
</style>
</head>
<body>
<div id="loadingMsg">載入中...</div>
<div id="app" style="display:none;width:100%;max-width:360px">
  <div class="card">
    <h1>繪新打卡系統</h1>
    <p class="sub" id="empName">—</p>
    <div class="time-display" id="clockDisplay">--:--</div>
    <div class="date-display" id="dateDisplay">—</div>
    <div id="msg"></div>
    <button class="btn btn-in" id="btnIn" disabled>上班打卡</button>
    <button class="btn btn-out" id="btnOut" disabled>下班打卡</button>
  </div>
  <div class="card" id="statusCard">
    <div style="font-weight:600;font-size:15px;margin-bottom:8px">今日出勤</div>
    <div class="status-row"><span class="status-label">上班</span><span class="status-val" id="stIn">—</span></div>
    <div class="status-row"><span class="status-label">下班</span><span class="status-val" id="stOut">—</span></div>
    <div class="status-row"><span class="status-label">狀態</span><span class="status-val" id="stLate">—</span></div>
  </div>
  <div class="card" id="dispatchCard" style="display:none">
    <div style="font-weight:600;font-size:15px;margin-bottom:8px">今日派工</div>
    <div id="dispatchList"></div>
  </div>
</div>
<script>
const LIFF_ID = '${liffId}';
const DISPATCH_LABELS = {cut_material:'裁切材料',factory_survey:'廠勘',survey:'場勘',install:'施工',aftersales:'售後服務',other:'其他'};
let accessToken = null;

function showMsg(text, type='info') {
  const el = document.getElementById('msg');
  el.className = 'msg msg-' + type;
  el.textContent = text;
}

function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2,'0');
  const m = String(now.getMinutes()).padStart(2,'0');
  document.getElementById('clockDisplay').textContent = h + ':' + m;
  document.getElementById('dateDisplay').textContent = now.toLocaleDateString('zh-TW', {year:'numeric',month:'long',day:'numeric',weekday:'short'});
}

async function loadStatus() {
  const r = await fetch('/api/attendance/status', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ access_token: accessToken })
  });
  if (!r.ok) { showMsg('無法取得狀態，請重試', 'error'); return; }
  const data = await r.json();

  document.getElementById('empName').textContent = data.name;

  const rec = data.record;
  document.getElementById('stIn').textContent  = rec?.clock_in  || '—';
  document.getElementById('stOut').textContent = rec?.clock_out || '—';
  const lateEl = document.getElementById('stLate');
  if (!rec?.clock_in) { lateEl.textContent = '未打卡'; lateEl.className = 'status-val'; }
  else if (rec.is_late) { lateEl.textContent = '遲到'; lateEl.className = 'status-val late'; }
  else { lateEl.textContent = '正常'; lateEl.className = 'status-val ok'; }

  document.getElementById('btnIn').disabled  = !!rec?.clock_in;
  document.getElementById('btnOut').disabled = !rec?.clock_in || !!rec?.clock_out;

  if (data.dispatches?.length) {
    document.getElementById('dispatchCard').style.display = '';
    document.getElementById('dispatchList').innerHTML = data.dispatches.map(d =>
      '<div class="dispatch-item">' +
      '<div class="dispatch-title">' + (DISPATCH_LABELS[d.dispatch_type]||d.dispatch_type) + ' — ' + (d.title||'') + '</div>' +
      '<div class="dispatch-sub">' + (d.scheduled_time||'') + '　' + (d.location||'') + '</div>' +
      '</div>'
    ).join('');
  }
}

async function doClockIn() {
  document.getElementById('btnIn').disabled = true;
  showMsg('定位中…', 'info');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    const r = await fetch('/api/attendance/clockin', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ access_token: accessToken, lat, lng })
    });
    const data = await r.json();
    if (r.ok) {
      showMsg('✅ 上班打卡成功！' + data.time + (data.is_late ? '（遲到）' : ''), 'success');
      loadStatus();
    } else {
      showMsg(data.message || data.error || '打卡失敗', 'error');
      document.getElementById('btnIn').disabled = false;
    }
  }, err => {
    showMsg('無法取得位置：' + err.message, 'error');
    document.getElementById('btnIn').disabled = false;
  }, { enableHighAccuracy: true, timeout: 10000 });
}

async function doClockOut() {
  document.getElementById('btnOut').disabled = true;
  showMsg('定位中…', 'info');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    const r = await fetch('/api/attendance/clockout', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ access_token: accessToken, lat, lng })
    });
    const data = await r.json();
    if (r.ok) {
      showMsg('✅ 下班打卡成功！' + data.time, 'success');
      loadStatus();
    } else {
      showMsg(data.error || '打卡失敗', 'error');
      document.getElementById('btnOut').disabled = false;
    }
  }, err => {
    showMsg('無法取得位置：' + err.message, 'error');
    document.getElementById('btnOut').disabled = false;
  }, { enableHighAccuracy: true, timeout: 10000 });
}

async function init() {
  updateClock();
  setInterval(updateClock, 30000);

  if (!LIFF_ID) {
    document.getElementById('loadingMsg').textContent = '⚠️ LIFF 尚未設定，請聯絡管理員';
    return;
  }

  try {
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    accessToken = liff.getAccessToken();
    document.getElementById('loadingMsg').style.display = 'none';
    document.getElementById('app').style.display = '';
    await loadStatus();
    document.getElementById('btnIn').addEventListener('click', doClockIn);
    document.getElementById('btnOut').addEventListener('click', doClockOut);
  } catch(e) {
    document.getElementById('loadingMsg').textContent = '載入失敗：' + e.message;
  }
}

init();
</script>
</body>
</html>`);
});

// LIFF 費用申請頁（不需登入，由 LIFF access_token 驗證身份）
app.get('/liff/expense', (req, res) => {
  const liffId = process.env.LIFF_EXPENSE_ID || process.env.LIFF_ID || '';
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>繪新 費用申請</title>
<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/versions/2.22.3/sdk.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans TC',sans-serif;background:#f0f4f8;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px 16px}
.card{background:#fff;border-radius:16px;padding:20px;width:100%;max-width:400px;box-shadow:0 2px 12px rgba(0,0,0,.08);margin-bottom:14px}
h1{font-size:18px;font-weight:700;color:#1a202c;margin-bottom:4px}
.sub{font-size:13px;color:#718096;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;color:#4a5568;margin-bottom:4px}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid #cbd5e0;border-radius:8px;font-size:14px;outline:none;font-family:inherit}
input:focus,select:focus,textarea:focus{border-color:#3182ce}
.field{margin-bottom:14px}
.btn{display:block;width:100%;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;transition:opacity .2s;margin-top:4px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:#3182ce;color:#fff}
.btn-sm{padding:7px 12px;font-size:13px;border-radius:8px;width:auto;display:inline-block}
.btn-outline{background:#fff;color:#3182ce;border:1px solid #3182ce}
.msg{text-align:center;font-size:14px;padding:12px;border-radius:8px;margin-bottom:12px}
.msg-success{background:#c6f6d5;color:#22543d}
.msg-error{background:#fed7d7;color:#742a2a}
.msg-info{background:#bee3f8;color:#2a4365}
#loadingMsg{text-align:center;color:#718096;padding:40px;font-size:15px}
.expense-item{padding:10px 0;border-bottom:1px solid #e2e8f0;font-size:13px}
.expense-item:last-child{border-bottom:none}
.exp-top{display:flex;justify-content:space-between;align-items:center}
.exp-title{font-weight:600;color:#2d3748}
.exp-amount{font-weight:700;color:#2d3748}
.exp-sub{color:#718096;margin-top:3px;font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
.badge-draft{background:#e2e8f0;color:#4a5568}
.badge-submitted{background:#bee3f8;color:#2c5282}
.badge-mgr_approved{background:#c6f6d5;color:#276749}
.badge-owner_approved{background:#c6f6d5;color:#22543d}
.badge-settled{background:#e9d8fd;color:#553c9a}
.badge-rejected{background:#fed7d7;color:#742a2a}
.amt-prefix{font-size:18px;font-weight:700;color:#718096;padding:9px 10px 9px 0;line-height:1}
.amt-row{display:flex;align-items:center}
.amt-row input{flex:1}
</style>
</head>
<body>
<div id="loadingMsg">載入中...</div>
<div id="app" style="display:none;width:100%;max-width:400px">

  <div class="card">
    <h1>費用申請</h1>
    <p class="sub" id="empName">—</p>
    <div id="formMsg"></div>
    <div class="field">
      <label>費用日期</label>
      <input type="date" id="fDate">
    </div>
    <div class="field">
      <label>費用科目</label>
      <select id="fCategory"><option value="">-- 請選擇 --</option></select>
    </div>
    <div class="field">
      <label>金額（元）</label>
      <div class="amt-row"><span class="amt-prefix">$</span><input type="number" id="fAmount" min="1" placeholder="0" inputmode="numeric"></div>
    </div>
    <div class="field">
      <label>說明（選填）</label>
      <textarea id="fDesc" rows="2" placeholder="補充說明…"></textarea>
    </div>
    <button class="btn btn-primary" id="btnSubmit" disabled>送出申請</button>
  </div>

  <div class="card" id="historyCard" style="display:none">
    <div style="font-weight:700;font-size:15px;margin-bottom:12px">我的申請記錄</div>
    <div id="historyList"></div>
  </div>

</div>
<script>
const LIFF_ID = '${liffId}';
const STATUS_LABELS = {draft:'草稿',submitted:'待店長審核',mgr_approved:'待老闆審核',owner_approved:'待匯款',settled:'已匯款',rejected:'已退回'};
let accessToken = null;

function showFormMsg(text, type='info') {
  const el = document.getElementById('formMsg');
  el.className = 'msg msg-' + type;
  el.textContent = text;
}

function clearFormMsg() {
  const el = document.getElementById('formMsg');
  el.className = '';
  el.textContent = '';
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

async function apiFetch(path, method, body) {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-LIFF-Token': accessToken },
    body: body ? JSON.stringify(body) : undefined
  });
  return r;
}

async function loadCategories() {
  const r = await apiFetch('/api/expenses/liff/categories', 'POST', { access_token: accessToken });
  if (!r.ok) return;
  const cats = await r.json();
  const sel = document.getElementById('fCategory');
  cats.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    sel.appendChild(o);
  });
}

async function loadHistory() {
  const r = await apiFetch('/api/expenses/liff/list', 'POST', { access_token: accessToken });
  if (!r.ok) return;
  const list = await r.json();
  if (!list.length) return;
  document.getElementById('historyCard').style.display = '';
  document.getElementById('historyList').innerHTML = list.map(e => {
    const status = STATUS_LABELS[e.status] || e.status;
    return '<div class="expense-item">' +
      '<div class="exp-top">' +
      '<span class="exp-title">' + (e.category_name || '') + '</span>' +
      '<span class="exp-amount">$' + Number(e.amount).toLocaleString() + '</span>' +
      '</div>' +
      '<div class="exp-sub">' + (e.expense_date || '') + '　' +
      '<span class="badge badge-' + e.status + '">' + status + '</span>' +
      (e.description ? '　' + e.description : '') +
      '</div>' +
      '</div>';
  }).join('');
}

async function doSubmit() {
  const date = document.getElementById('fDate').value;
  const catId = document.getElementById('fCategory').value;
  const amount = document.getElementById('fAmount').value;
  const desc = document.getElementById('fDesc').value.trim();
  if (!date || !catId || !amount) { showFormMsg('請填寫日期、科目與金額', 'error'); return; }
  if (Number(amount) <= 0) { showFormMsg('金額必須大於 0', 'error'); return; }

  document.getElementById('btnSubmit').disabled = true;
  showFormMsg('送出中…', 'info');

  const r = await apiFetch('/api/expenses/liff/submit', 'POST', {
    access_token: accessToken,
    expense_date: date,
    category_id: Number(catId),
    amount: Number(amount),
    description: desc || null
  });
  const data = await r.json();
  if (r.ok) {
    showFormMsg('✅ 申請已送出！', 'success');
    document.getElementById('fDate').value = todayStr();
    document.getElementById('fCategory').value = '';
    document.getElementById('fAmount').value = '';
    document.getElementById('fDesc').value = '';
    await loadHistory();
  } else {
    showFormMsg(data.error || '送出失敗，請重試', 'error');
  }
  document.getElementById('btnSubmit').disabled = false;
}

async function init() {
  if (!LIFF_ID) {
    document.getElementById('loadingMsg').textContent = '⚠️ LIFF 尚未設定，請聯絡管理員';
    return;
  }
  try {
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    accessToken = liff.getAccessToken();

    const r = await apiFetch('/api/expenses/liff/categories', 'POST', { access_token: accessToken });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      document.getElementById('loadingMsg').textContent = d.error || '驗證失敗，請確認您已綁定系統帳號';
      return;
    }
    const cats = await r.json();
    const sel = document.getElementById('fCategory');
    cats.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    });

    // 取使用者名稱
    const authR = await apiFetch('/api/expenses/liff/me', 'POST', { access_token: accessToken });
    if (authR.ok) {
      const me = await authR.json();
      document.getElementById('empName').textContent = me.name || '—';
    }

    document.getElementById('fDate').value = todayStr();
    document.getElementById('btnSubmit').disabled = false;
    document.getElementById('btnSubmit').addEventListener('click', doSubmit);

    document.getElementById('loadingMsg').style.display = 'none';
    document.getElementById('app').style.display = '';

    await loadHistory();
  } catch(e) {
    document.getElementById('loadingMsg').textContent = '載入失敗：' + e.message;
  }
}

init();
</script>
</body>
</html>`);
});

// ── 自動打卡（每分鐘檢查，18:00 台灣時間自動補下班卡）────────
const db = require('./db');
let autoClockOutDoneDate = '';
setInterval(() => {
  const now = new Date();
  const twTime = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
  const [twDate, twClock] = twTime.split(' ');
  const hm = twClock.slice(0, 5);
  if (hm === '18:00' && autoClockOutDoneDate !== twDate) {
    autoClockOutDoneDate = twDate;
    const missing = db.prepare(`SELECT id FROM attendance WHERE work_date=? AND clock_in IS NOT NULL AND (clock_out IS NULL OR clock_out='')`).all(twDate);
    for (const r of missing) {
      db.prepare(`UPDATE attendance SET clock_out='18:00', work_end='18:00', auto_clock_out=1 WHERE id=?`).run(r.id);
    }
    if (missing.length) console.log(`[auto-clockout] ${twDate} 自動補下班卡 ${missing.length} 筆`);
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`繪新管理系統已啟動：http://localhost:${PORT}`);
});
