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
app.use('/api/tags',       require('./routes/tags'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/my-tasks',        require('./routes/my-tasks'));
app.use('/api/dispatch-detail',   require('./routes/dispatch-detail'));
app.use('/api/materials',         require('./routes/materials'));
app.use('/api/reports',           require('./routes/reports'));
app.use('/api/notifications',     require('./routes/notifications'));
app.use('/api/settings',          require('./routes/settings'));
app.use('/api/marketplace',       require('./routes/marketplace'));
app.use('/api/line-inquiries',    require('./routes/line-inquiries'));

// ── 頁面路由 ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 頁面 → 對應的 permission key（owner 永遠放行）
const PAGE_PERMS = {
  dashboard:        'page_dashboard',
  cases:            'page_cases',
  'case-detail':    'page_cases',
  clients:          'page_clients',
  calendar:         'page_calendar',
  payments:         'page_payments',
  ledger:           'page_payments',
  'line-inquiries': 'page_cases',
  'dispatch-detail':'page_cases',
  'survey-form':    'page_cases',
  'quote-form':     'page_cases',
  admin:            'manage_users',
  materials:        'manage_users',
  reports:          'manage_users',
  performance:      'manage_users',
  'dispatch-pool':  'manage_users',
};

function requirePagePerm(page) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.redirect('/');
    if (u.role === 'owner') return next();
    const key = PAGE_PERMS[page];
    if (!key) return next();
    // page_xxx 存在 u.permissions；manage_users 直接在 u
    const p = u.permissions || {};
    const allowed = key === 'manage_users' ? !!u.manage_users : (p[key] === true);
    if (!allowed) return res.redirect('/my-tasks');
    next();
  };
}

// 合約簽署頁（已登入但未簽約才可進入）
app.get('/contract', requireAuth, (req, res) => {
  if (req.session.user.contract_signed_at) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'contract.html'));
});

function requireContract(req, res, next) {
  const u = req.session?.user;
  if (u && !u.contract_signed_at) return res.redirect('/contract');
  next();
}

const pages = ['dashboard', 'cases', 'case-detail', 'calendar', 'payments', 'ledger', 'performance', 'reports', 'admin', 'clients', 'survey-form', 'quote-form', 'my-tasks', 'dispatch-detail', 'materials', 'marketplace', 'line-inquiries', 'dispatch-pool'];
pages.forEach(page => {
  app.get(`/${page}`, requireAuth, requireContract, requirePagePerm(page), (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
});

// 公開場勘簽名頁（客戶用，不需登入）
app.get('/sign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'survey-sign.html'));
});

// 公開報價單頁（客戶用，不需登入）
app.get('/quote/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quote-sign.html'));
});

app.listen(PORT, () => {
  console.log(`繪新管理系統已啟動：http://localhost:${PORT}`);
});
