const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

// Zeabur volume 掛載在 /data，本機開發用專案目錄
const DB_DIR  = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname;
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'huixin.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

// ── 組織（總部 + 分店）──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    type    TEXT NOT NULL CHECK(type IN ('hq','branch')),
    address TEXT,
    phone   TEXT,
    active  INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 使用者 ──────────────────────────────────────────────────
// role 定義：
//   owner              最高管理（Flora / Dan）
//   hq_cs              客服人員（總部）
//   hq_sales           業務人員（總部）
//   hq_tech            技術人員（總部）
//   hq_accounting      會計（總部）
//   hq_hr              人事（總部）
//   branch_manager     分店負責人
//   branch_sales       分店業務
//   branch_tech        分店技術
//   contractor_install 約聘施工（學員）
//   contractor_sales   約聘業務
//   dealer             材料經銷商
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    username        TEXT UNIQUE NOT NULL,
    password        TEXT NOT NULL,
    role            TEXT NOT NULL,
    org_id          INTEGER REFERENCES orgs(id),
    department      TEXT,
    is_manager      INTEGER DEFAULT 0,
    can_see_amounts INTEGER DEFAULT 0,
    service_areas   TEXT DEFAULT '[]',
    active          INTEGER DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 客戶 ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER REFERENCES orgs(id),
    name       TEXT NOT NULL,
    phone      TEXT,
    email      TEXT,
    address    TEXT,
    discount   REAL DEFAULT 1.0,
    source     TEXT,
    notes      TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 案件 ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number     TEXT UNIQUE NOT NULL,
    org_id          INTEGER REFERENCES orgs(id),
    case_type       TEXT DEFAULT 'other'
                    CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','other')),
    client_id       INTEGER REFERENCES clients(id),
    title           TEXT NOT NULL,
    description     TEXT,
    location        TEXT,

    -- 金額欄位（受權限控制）
    quoted_price    REAL,
    final_price     REAL,
    material_cost   REAL,
    survey_fee      REAL,
    install_fee     REAL,

    -- 收款
    payment_status  TEXT DEFAULT 'unpaid'
                    CHECK(payment_status IN ('unpaid','partial','paid','overdue')),
    payment_received REAL DEFAULT 0,
    payment_due_date DATE,
    payment_notes   TEXT,

    -- 人員
    sales_id        INTEGER REFERENCES users(id),

    -- 外包給學員
    is_outsourced   INTEGER DEFAULT 0,
    outsource_type  TEXT CHECK(outsource_type IN ('full','survey_only','install_only')),

    -- 狀態
    status          TEXT DEFAULT 'inquiry'
                    CHECK(status IN ('inquiry','quoted','survey_scheduled',
                                     'surveyed','confirmed','scheduled',
                                     'in_progress','completed','aftersales','closed')),
    priority        TEXT DEFAULT 'normal'
                    CHECK(priority IN ('low','normal','high','urgent')),
    notes           TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 報價明細（每案可有多個施作物件）────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS case_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id          INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    sort_order       INTEGER DEFAULT 0,
    item_type        TEXT NOT NULL,
    description      TEXT,
    -- 尺寸（公分）
    width_cm         REAL,
    height_cm        REAL,
    length_cm        REAL,
    quantity         REAL DEFAULT 1,
    unit             TEXT DEFAULT '才' CHECK(unit IN ('才','平方公尺','件','米','式','其他')),
    area             REAL,          -- 計算後的施作數量（才數或平方數）
    -- 材料
    material_brand   TEXT,
    material_model   TEXT,
    material_unit_cost REAL DEFAULT 0,   -- 每才/每件 材料成本
    material_total   REAL DEFAULT 0,
    -- 施工
    install_unit_price REAL DEFAULT 0,   -- 每才/每件 施工費
    install_total    REAL DEFAULT 0,
    -- 小計
    subtotal         REAL DEFAULT 0,
    notes            TEXT
  );
`);

// ── 派工紀錄（單一案件可有多筆、多天）──────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dispatches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id         INTEGER NOT NULL REFERENCES cases(id),
    dispatch_type   TEXT NOT NULL CHECK(dispatch_type IN ('survey','install','aftersales')),
    scheduled_date  DATE NOT NULL,
    scheduled_time  TEXT,
    estimated_hours REAL,
    actual_hours    REAL,
    material        TEXT,
    material_used   REAL,
    status          TEXT DEFAULT 'pending'
                    CHECK(status IN ('pending','confirmed','done','cancelled')),
    notes           TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 派工人員（一筆派工可有多人）────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dispatch_users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    role_in_dispatch TEXT CHECK(role_in_dispatch IN ('lead','assistant','supervisor'))
  );
`);

// ── 分潤設定 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS profit_shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id       INTEGER REFERENCES cases(id),
    user_id       INTEGER REFERENCES users(id),
    role_in_case  TEXT,
    share_pct     REAL NOT NULL,
    share_amount  REAL,
    paid          INTEGER DEFAULT 0,
    paid_at       DATETIME,
    notes         TEXT
  );
`);

// ── 每日業績目標 ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_targets (
    org_id        INTEGER REFERENCES orgs(id),
    date          TEXT NOT NULL,
    target_amount REAL NOT NULL DEFAULT 100000,
    PRIMARY KEY (org_id, date)
  );
`);

// ── 操作日誌 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id),
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  INTEGER,
    detail     TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 欄位遷移（舊資料庫補欄位）────────────────────────────────
const _addCol = (table, col, def) => {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
_addCol('cases', 'line_source',      'TEXT');
_addCol('cases', 'keyword',          'TEXT');
_addCol('cases', 'deposit_amount',   'REAL');
_addCol('cases', 'material_ordered', 'INTEGER DEFAULT 0');
_addCol('cases', 'invoice_company',  'TEXT');
_addCol('cases', 'invoice_tax_id',   'TEXT');
_addCol('cases', 'invoice_address',  'TEXT');
_addCol('cases', 'invoice_email',    'TEXT');
_addCol('cases', 'invoice_item_desc','TEXT');
_addCol('cases', 'scheduled_date',   'DATE');
_addCol('cases', 'survey_date',      'DATE');
_addCol('cases', 'surveyor_id',      'INTEGER REFERENCES users(id)');
_addCol('case_items', 'client_unit_price', 'REAL');
_addCol('case_items', 'client_subtotal',   'REAL DEFAULT 0');
_addCol('case_items', 'location',          'TEXT');
_addCol('clients',    'line_user_id',      'TEXT');

// ── 案件狀態升級 → 7 階段流程 ────────────────────────────────
// 條件：只有舊 schema 含 survey_scheduled（舊 CHECK 枚舉值）才需遷移
const _casesSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cases'`).get();
if (_casesSchema && _casesSchema.sql.includes('survey_scheduled')) {
  db.exec(`PRAGMA foreign_keys=OFF`);
  db.exec(`CREATE TABLE _cases_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_number TEXT UNIQUE NOT NULL,
    org_id INTEGER REFERENCES orgs(id),
    case_type TEXT DEFAULT 'other' CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','other')),
    client_id INTEGER REFERENCES clients(id), title TEXT NOT NULL,
    description TEXT, location TEXT, quoted_price REAL, final_price REAL,
    material_cost REAL, survey_fee REAL, install_fee REAL,
    payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','partial','paid','overdue')),
    payment_received REAL DEFAULT 0, payment_due_date DATE, payment_notes TEXT,
    sales_id INTEGER REFERENCES users(id), is_outsourced INTEGER DEFAULT 0,
    outsource_type TEXT CHECK(outsource_type IN ('full','survey_only','install_only')),
    status TEXT DEFAULT 'initial_estimate',
    priority TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
    notes TEXT, created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    line_source TEXT, keyword TEXT, deposit_amount REAL, material_ordered INTEGER DEFAULT 0,
    invoice_company TEXT, invoice_tax_id TEXT, invoice_address TEXT,
    invoice_email TEXT, invoice_item_desc TEXT,
    scheduled_date DATE, survey_date DATE, surveyor_id INTEGER REFERENCES users(id)
  )`);
  db.exec(`INSERT INTO _cases_new
    SELECT id, case_number, org_id,
           CASE WHEN case_type IN ('home','commercial','elevator','glass','extra','outsource','other')
                THEN case_type ELSE 'other' END,
           client_id, title, description, location,
           quoted_price, final_price, material_cost, survey_fee, install_fee,
           payment_status, payment_received, payment_due_date, payment_notes,
           sales_id, is_outsourced, outsource_type,
           CASE status
             WHEN 'inquiry'          THEN 'initial_estimate'
             WHEN 'text_quoted'      THEN 'initial_estimate'
             WHEN 'survey_scheduled' THEN 'survey'
             WHEN 'surveyed'         THEN 'survey'
             WHEN 'quoted'           THEN 'quoted'
             WHEN 'draft_quoted'     THEN 'quoted'
             WHEN 'formal_quoted'    THEN 'quoted'
             WHEN 'quote_framework'  THEN 'quoted'
             WHEN 'quote_no_survey'  THEN 'quoted'
             WHEN 'confirmed'        THEN 'contracted'
             WHEN 'scheduled'        THEN 'contracted'
             WHEN 'in_progress'      THEN 'contracted'
             WHEN 'dispatched'       THEN 'contracted'
             WHEN 'pending_payment'  THEN 'payment'
             WHEN 'aftersales'       THEN 'payment'
             WHEN 'completed'        THEN 'closed'
             WHEN 'closed'           THEN 'closed'
             WHEN 'invalid'          THEN 'invalid'
             ELSE 'initial_estimate'
           END,
           priority, notes, created_by, created_at, updated_at,
           line_source, keyword, deposit_amount, material_ordered,
           invoice_company, invoice_tax_id, invoice_address, invoice_email, invoice_item_desc,
           scheduled_date, survey_date, surveyor_id
    FROM cases`);
  db.exec(`DROP TABLE cases; ALTER TABLE _cases_new RENAME TO cases`);
  db.exec(`PRAGMA foreign_keys=ON`);
  console.log('✅ 案件狀態升級完成（7 階段流程）');
}

// ── 案件類型升級 → 7 大類（居家/商空/電梯/玻璃/外快/外包/其他）──
// 條件：舊 schema 含 'inquiry','survey','contract','repair' 才需遷移
const _casesSchema2 = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cases'`).get();
if (_casesSchema2 && _casesSchema2.sql.includes("'inquiry','survey','contract','repair'")) {
  db.exec(`PRAGMA foreign_keys=OFF`);
  db.exec(`CREATE TABLE _cases_new2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_number TEXT UNIQUE NOT NULL,
    org_id INTEGER REFERENCES orgs(id),
    case_type TEXT DEFAULT 'other' CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','other')),
    client_id INTEGER REFERENCES clients(id), title TEXT NOT NULL,
    description TEXT, location TEXT, quoted_price REAL, final_price REAL,
    material_cost REAL, survey_fee REAL, install_fee REAL,
    payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','partial','paid','overdue')),
    payment_received REAL DEFAULT 0, payment_due_date DATE, payment_notes TEXT,
    sales_id INTEGER REFERENCES users(id), is_outsourced INTEGER DEFAULT 0,
    outsource_type TEXT CHECK(outsource_type IN ('full','survey_only','install_only')),
    status TEXT DEFAULT 'initial_estimate',
    priority TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
    notes TEXT, created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    line_source TEXT, keyword TEXT, deposit_amount REAL, material_ordered INTEGER DEFAULT 0,
    invoice_company TEXT, invoice_tax_id TEXT, invoice_address TEXT,
    invoice_email TEXT, invoice_item_desc TEXT,
    scheduled_date DATE, survey_date DATE, surveyor_id INTEGER REFERENCES users(id)
  )`);
  db.exec(`INSERT INTO _cases_new2
    SELECT id, case_number, org_id,
           CASE WHEN case_type IN ('home','commercial','elevator','glass','extra','outsource','other')
                THEN case_type ELSE 'other' END,
           client_id, title, description, location,
           quoted_price, final_price, material_cost, survey_fee, install_fee,
           payment_status, payment_received, payment_due_date, payment_notes,
           sales_id, is_outsourced, outsource_type, status,
           priority, notes, created_by, created_at, updated_at,
           line_source, keyword, deposit_amount, material_ordered,
           invoice_company, invoice_tax_id, invoice_address, invoice_email, invoice_item_desc,
           scheduled_date, survey_date, surveyor_id
    FROM cases`);
  db.exec(`DROP TABLE cases; ALTER TABLE _cases_new2 RENAME TO cases`);
  db.exec(`PRAGMA foreign_keys=ON`);
  console.log('✅ 案件類型升級完成（居家/商空/電梯/玻璃/外快/外包/其他）');
}

// ── 報價單 ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS quote_sheets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id             INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    version             INTEGER DEFAULT 1,
    share_token         TEXT UNIQUE NOT NULL,
    valid_days          INTEGER DEFAULT 30,
    payment_terms       TEXT,
    client_notes        TEXT,
    discount_type       TEXT DEFAULT 'none'
                        CHECK(discount_type IN ('none','percent','amount','marketing')),
    discount_value      REAL DEFAULT 0,
    marketing_label     TEXT,
    status              TEXT DEFAULT 'draft'
                        CHECK(status IN ('draft','sent','accepted','rejected')),
    client_signature    TEXT,
    client_accepted_at  DATETIME,
    created_by          INTEGER REFERENCES users(id),
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
_addCol('quote_sheets', 'client_type', 'TEXT DEFAULT "owner"');

// ── 場勘單 ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS survey_forms (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id         INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    share_token     TEXT UNIQUE NOT NULL,
    surveyor_id     INTEGER REFERENCES users(id),
    survey_date     DATE,
    site_contact    TEXT,
    site_phone      TEXT,
    site_address    TEXT,
    findings        TEXT,           -- JSON array of finding items
    photos_note     TEXT,
    extra_notes     TEXT,
    status          TEXT DEFAULT 'draft'
                    CHECK(status IN ('draft','sent','signed','cancelled')),
    client_signed_at DATETIME,
    client_signature TEXT,          -- base64 canvas image
    created_by      INTEGER REFERENCES users(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 流水帳科目 ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ledger_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL CHECK(type IN ('income','expense')),
    name       TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1
  );
`);

// ── 流水帳 ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        DATE NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('income','expense')),
    category    TEXT NOT NULL,
    amount      REAL NOT NULL,
    case_id     INTEGER REFERENCES cases(id),
    description TEXT,
    org_id      INTEGER REFERENCES orgs(id),
    created_by  INTEGER REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 初始會計科目（只在空的時候 seed）
const catExists = db.prepare(`SELECT id FROM ledger_categories LIMIT 1`).get();
if (!catExists) {
  const incomes  = ['施工款','訂金','尾款','材料銷售','設計費','其他收入'];
  const expenses = ['材料費','人工費（外包）','油資/交通','工具耗材','水電費','租金','廣告費','辦公費','稅費','其他支出'];
  const ins = db.prepare(`INSERT INTO ledger_categories (type, name, sort_order) VALUES (?, ?, ?)`);
  incomes.forEach((n,i)  => ins.run('income',  n, i));
  expenses.forEach((n,i) => ins.run('expense', n, i));
}

// ── 初始資料：總部 + Flora + Dan ────────────────────────────
const hqExists = db.prepare(`SELECT id FROM orgs WHERE type = 'hq' LIMIT 1`).get();
if (!hqExists) {
  db.prepare(`INSERT INTO orgs (name, type, address) VALUES (?, ?, ?)`)
    .run('繪新國際有限公司（總部）', 'hq', '新北市鶯歌區中山路166巷2號');

  const hqId = db.prepare(`SELECT id FROM orgs WHERE type = 'hq'`).get().id;
  const hash = bcrypt.hashSync('huixin2024', 10);

  db.prepare(`INSERT INTO users (name, username, password, role, org_id, can_see_amounts, is_manager) VALUES (?, ?, ?, ?, ?, 1, 1)`)
    .run('佳樺', 'flora', hash, 'owner', hqId);
  db.prepare(`INSERT INTO users (name, username, password, role, org_id, can_see_amounts, is_manager) VALUES (?, ?, ?, ?, ?, 1, 1)`)
    .run('Dan', 'dan', hash, 'owner', hqId);

  console.log('初始帳號建立完成：');
  console.log('  flora / huixin2024  （佳樺）');
  console.log('  dan   / huixin2024  （Dan）');
  console.log('請登入後至「人員管理」修改密碼。');
}

module.exports = db;
