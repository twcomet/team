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
const PUBLIC_HTML = new Set(['login.html', 'survey-sign.html', 'quote-sign.html']);
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
app.use('/api/marketing',         require('./routes/marketing'));

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
  calendar:         'page_calendar',
  payments:         'page_payments',
  ledger:           'page_ledger',
  'line-inquiries': 'page_line_inquiries',
  'dispatch-detail':'page_cases',
  'survey-form':    'page_cases',
  'quote-form':     'page_cases',
  admin:            'manage_users',
  materials:        'page_materials',
  reports:          'page_reports',
  performance:      'page_performance',
  'dispatch-pool':  'page_dispatch_pool',
  marketing:        'page_marketing',
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
      const HQ = ['owner','vp','hq_cs','hq_sales','hq_tech','hq_accounting','hq_hr'];
      allowed = p.page_cases_deal !== undefined ? p.page_cases_deal === true : HQ.includes(u.role);
    } else if (key === 'page_materials') {
      allowed = p.page_materials !== undefined ? p.page_materials === true : !!u.manage_users;
    } else if (key === 'page_reports') {
      allowed = p.page_reports !== undefined ? p.page_reports === true : !!u.manage_users;
    } else if (key === 'page_performance') {
      allowed = p.page_performance !== undefined ? p.page_performance === true : !!u.manage_users;
    } else if (key === 'page_marketing') {
      allowed = p.page_marketing !== undefined ? p.page_marketing === true : !!u.manage_users;
    } else {
      allowed = p[key] === true;
    }
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

const pages = ['dashboard', 'cases', 'cases-inquiry', 'cases-survey', 'cases-deal', 'case-detail', 'calendar', 'payments', 'ledger', 'performance', 'reports', 'marketing', 'admin', 'clients', 'survey-form', 'quote-form', 'my-tasks', 'my-calendar', 'dispatch-detail', 'materials', 'marketplace', 'line-inquiries', 'dispatch-pool'];
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

// 公開報價單頁（客戶用，不需登入）
app.get('/quote/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quote-sign.html'));
});

app.listen(PORT, () => {
  console.log(`繪新管理系統已啟動：http://localhost:${PORT}`);
});
