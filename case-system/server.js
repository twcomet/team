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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// ── 頁面路由 ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const pages = ['dashboard', 'cases', 'case-detail', 'calendar', 'payments', 'admin', 'clients', 'survey-form', 'quote-form'];
pages.forEach(page => {
  app.get(`/${page}`, requireAuth, (req, res) => {
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
