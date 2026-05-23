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
                    CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','other')),
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

// ── 系統通知 ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    body       TEXT,
    type       TEXT DEFAULT 'dispatch',
    entity     TEXT,
    entity_id  INTEGER,
    url        TEXT,
    is_read    INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
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
_addCol('clients',    'tax_id',            'TEXT');
_addCol('clients',    'contact_person',    'TEXT');
_addCol('clients',    'capital',           'TEXT');
_addCol('clients',    'einvoice_code',     'TEXT');
_addCol('clients',    'client_level',      'TEXT');
_addCol('clients',    'payment_terms',     'TEXT');
_addCol('clients',    'discount_terms',    'TEXT');
_addCol('clients',    'referrer',          'TEXT');
_addCol('clients',    'line_group_name',   'TEXT');
_addCol('users',      'permissions',       'TEXT DEFAULT "{}"');
_addCol('users',      'sort_order',        'INTEGER DEFAULT 0');
_addCol('users',      'daily_cost',        'REAL');
_addCol('users',      'line_notify_token', 'TEXT');
_addCol('cases',     'survey_fee_paid',   'INTEGER DEFAULT 0');
_addCol('cases',     'entry_info',        'TEXT');
_addCol('cases',     'photo_upload_url',  'TEXT');
_addCol('cases',     'outsource_cost',    'REAL');
_addCol('cases',     'shipping_cost',     'REAL');
_addCol('cases',     'other_cost',        'REAL');
// materials.location 移到 CREATE TABLE 之後處理（避免全新 DB 的 ALTER TABLE 時序錯誤）

// ── 個別捲料 ──────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS material_rolls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id     INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  org_id          INTEGER REFERENCES orgs(id),
  roll_no         TEXT,
  initial_meters  REAL DEFAULT 0,
  remaining_meters REAL DEFAULT 0,
  purchase_date   DATE,
  unit_cost       REAL DEFAULT 0,
  location        TEXT,
  branch          TEXT NOT NULL DEFAULT '總部',
  status          TEXT DEFAULT 'active' CHECK(status IN ('active','finished','lost')),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);`);
_addCol('material_rolls', 'branch', "TEXT NOT NULL DEFAULT '總部'");

// ── 膜料流水帳 ────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS material_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  roll_id     INTEGER REFERENCES material_rolls(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  org_id      INTEGER REFERENCES orgs(id),
  log_type    TEXT NOT NULL CHECK(log_type IN (
                'purchase','case_cut','case_loss','store_sale','academy','ecommerce','adjust','reserve'
              )),
  case_id     INTEGER REFERENCES cases(id),
  meters      REAL NOT NULL,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  logged_by   INTEGER REFERENCES users(id),
  logged_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);`);

// 若舊 DB 的 material_logs 尚未含 reserve 與 status → 重建
const _matLogsSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='material_logs'`).get();
if (_matLogsSchema && !_matLogsSchema.sql.includes("'reserve'")) {
  db.exec(`PRAGMA foreign_keys=OFF`);
  db.exec(`CREATE TABLE material_logs_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_id     INTEGER REFERENCES material_rolls(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    org_id      INTEGER REFERENCES orgs(id),
    log_type    TEXT NOT NULL CHECK(log_type IN (
                  'purchase','case_cut','case_loss','store_sale','academy','ecommerce','adjust','reserve'
                )),
    case_id     INTEGER REFERENCES cases(id),
    meters      REAL NOT NULL,
    notes       TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    logged_by   INTEGER REFERENCES users(id),
    logged_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`INSERT INTO material_logs_new (id,roll_id,material_id,org_id,log_type,case_id,meters,notes,status,logged_by,logged_at)
    SELECT id,roll_id,material_id,org_id,log_type,case_id,meters,notes,'active',logged_by,logged_at FROM material_logs`);
  db.exec(`DROP TABLE material_logs`);
  db.exec(`ALTER TABLE material_logs_new RENAME TO material_logs`);
  db.exec(`PRAGMA foreign_keys=ON`);
}

// ── 膜料庫存目錄 ─────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS materials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       INTEGER REFERENCES orgs(id),
  brand        TEXT NOT NULL,
  model        TEXT NOT NULL,
  color        TEXT,
  spec         TEXT,
  location     TEXT,
  unit_cost    REAL DEFAULT 0,
  unit_price   REAL DEFAULT 0,
  stock_meters REAL DEFAULT 0,
  notes        TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);`);
_addCol('materials', 'location', 'TEXT');  // 舊 DB 補欄位

// ── 膜料使用紀錄 ─────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS dispatch_materials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id  INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  material_id  INTEGER REFERENCES materials(id),
  film_brand   TEXT,
  film_model   TEXT NOT NULL,
  meters_used  REAL DEFAULT 0,
  unit_cost    REAL DEFAULT 0,
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);`);
_addCol('dispatch_materials', 'material_id', 'INTEGER REFERENCES materials(id)');
_addCol('dispatches', 'labor_cost', 'REAL');

// ── 案件狀態升級 → 7 階段流程 ────────────────────────────────
// 條件：只有舊 schema 含 survey_scheduled（舊 CHECK 枚舉值）才需遷移
const _casesSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cases'`).get();
if (_casesSchema && _casesSchema.sql.includes('survey_scheduled')) {
  db.exec(`PRAGMA foreign_keys=OFF`);
  db.exec(`CREATE TABLE _cases_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_number TEXT UNIQUE NOT NULL,
    org_id INTEGER REFERENCES orgs(id),
    case_type TEXT DEFAULT 'other' CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','other')),
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
    case_type TEXT DEFAULT 'other' CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','other')),
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

// ── 自訂角色 ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS custom_roles (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    code              TEXT UNIQUE NOT NULL,
    label             TEXT NOT NULL,
    default_perms     TEXT DEFAULT '{}',
    view_all_branches INTEGER DEFAULT 0,
    active            INTEGER DEFAULT 1,
    sort_order        INTEGER DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 流水帳科目 ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ledger_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL CHECK(type IN ('income','expense')),
    name       TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1,
    section    TEXT DEFAULT NULL
  );
`);
_addCol('ledger_categories', 'section', "TEXT DEFAULT NULL");

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
  const ins = db.prepare(`INSERT INTO ledger_categories (type, section, name, sort_order) VALUES (?, ?, ?, ?)`);
  incomes.forEach((n,i)  => ins.run('income',  'income',  n, i));
  expenses.forEach((n,i) => ins.run('expense', 'expense', n, i));
}

// 更新舊資料的 section 欄位（migration：idempotent）
db.exec(`UPDATE ledger_categories SET section='income'  WHERE type='income'  AND section IS NULL`);
db.exec(`UPDATE ledger_categories SET section='expense' WHERE type='expense' AND section IS NULL`);

// 新增損益表專用科目（來自業務分類；若已存在則跳過）
{
  const getCat = db.prepare(`SELECT id FROM ledger_categories WHERE name=? LIMIT 1`);
  const insCat = db.prepare(`INSERT INTO ledger_categories (type, section, name, sort_order, active) VALUES (?, ?, ?, ?, 1)`);
  const plCats = [
    // ── 收入（27 個，確認版 2026-05）──
    ['income','income','裝漠貼膜-bodaq',  1],
    ['income','income','裝漠貼膜-LG',     2],
    ['income','income','裝漠貼膜-3M',     3],
    ['income','income','裝漠貼膜-PAROI',  4],
    ['income','income','裝漠貼膜-保護膜', 5],
    ['income','income','裝漠貼膜-其他',   6],
    ['income','income','電梯貼膜-改色',   7],
    ['income','income','電梯貼膜-保護膜', 8],
    ['income','income','車體貼膜',        9],
    ['income','income','廣告輸出-自產',   10],
    ['income','income','廣告輸出-外包',   11],
    ['income','income','玻璃膜施工',      12],
    ['income','income','隔熱紙施工',      13],
    ['income','income','防爆膜',          14],
    ['income','income','銷售膜料-bodaq',  15],
    ['income','income','銷售膜料-LG',     16],
    ['income','income','銷售膜料-3M',     17],
    ['income','income','銷售膜料-翰可',   18],
    ['income','income','銷售膜料-隔熱紙', 19],
    ['income','income','銷售膜料-其他',   20],
    ['income','income','施工代工',        21],
    ['income','income','學院-課程費',     22],
    ['income','income','學院-材料銷售',   23],
    ['income','income','學院-認證考試',   24],
    ['income','income','學院-其他',       25],
    ['income','income','DS彩貼',          26],
    ['income','income','穩得',            27],
    ['income','income','調控薄膜',        28],
    ['income','income','無框畫',          29],
    ['income','income','設計費',          30],
    ['income','income','其他收入',        31],
    // ── 成本（依品牌/產品邏輯，對應收入科目）──
    ['expense','cost','進貨-bodaq',        101],
    ['expense','cost','進貨-LG',           102],
    ['expense','cost','進貨-3M',           103],
    ['expense','cost','進貨-PAROI',        104],
    ['expense','cost','進貨-保護膜',       105],
    ['expense','cost','進貨-隔熱紙',       106],
    ['expense','cost','進貨-翰可',         107],
    ['expense','cost','進貨-其他膜料',     108],
    ['expense','cost','成本-輸出材料',     109],
    ['expense','cost','成本-廣告外包',     110],
    ['expense','cost','成本-DS彩貼',       111],
    ['expense','cost','成本-穩得',         112],
    ['expense','cost','成本-車貼材料',     113],
    ['expense','cost','成本-人力外包',     114],
    ['expense','cost','成本-員工薪水',     115],
    ['expense','cost','成本-員工獎金',     116],
    ['expense','cost','成本-學院材料',     117],
    ['expense','cost','成本-學院講師費',   118],
    ['expense','cost','成本-機器設備',     119],
    ['expense','cost','成本-施工耗材',     120],
    ['expense','cost','成本-其他',         121],
    // ── 費用（依性質分群，統一前綴）──
    // 場地
    ['expense','expense','費用-租金',           201],
    ['expense','expense','費用-電費',           202],
    ['expense','expense','費用-修繕費',         203],
    ['expense','expense','費用-公司裝漠',       204],
    // 交通
    ['expense','expense','費用-交通費',         205],
    ['expense','expense','費用-停車費',         206],
    ['expense','expense','費用-燃料費',         207],
    ['expense','expense','費用-汽車修繕',       208],
    ['expense','expense','費用-牌照稅',         209],
    // 物流進口
    ['expense','expense','費用-進口關稅',       210],
    ['expense','expense','費用-進口運費',       211],
    ['expense','expense','費用-運費',           212],
    // 行銷
    ['expense','expense','費用-廣告費',         213],
    ['expense','expense','費用-交際費',         214],
    ['expense','expense','費用-BNI',            215],
    // 行政
    ['expense','expense','費用-文具用品',       216],
    ['expense','expense','費用-郵電費',         217],
    ['expense','expense','費用-電話網路費',     218],
    ['expense','expense','費用-雜項購置',       219],
    ['expense','expense','費用-零用金-Flora',   220],
    ['expense','expense','費用-零用金-Dan',     221],
    ['expense','expense','費用-零用金-恰吉',    222],
    // 保險
    ['expense','expense','保險費-勞保',         223],
    ['expense','expense','保險費-勞退',         224],
    ['expense','expense','保險費-健保',         225],
    ['expense','expense','保險費-其他',         226],
    // 職工福利
    ['expense','expense','費用-教育訓練',       227],
    ['expense','expense','費用-員工聚餐',       228],
    ['expense','expense','費用-外業務佣金',     229],
    // 會計稅務
    ['expense','expense','費用-記帳費',         230],
    ['expense','expense','費用-稅捐',           231],
    ['expense','expense','費用-營業稅',         232],
    // 貸款
    ['expense','expense','貸款-聯邦車貸',       233],
    ['expense','expense','貸款-台企銀',         234],
    ['expense','expense','貸款-富邦',           235],
    ['expense','expense','貸款-華銀',           236],
    ['expense','expense','費用-利息支出',       237],
    // 其他
    ['expense','expense','費用-損耗虧損',       238],
    ['expense','expense','費用-退費退貨',       239],
    ['expense','expense','費用-捐款',           240],
    ['expense','expense','費用-專業委外',       241],
    ['expense','expense','費用-非公司五趴',     242],
    ['expense','expense','費用-其他',           243],
    // ── 資產/負債 ──
    ['expense','asset_liability','押金/保證金',301],
    ['expense','asset_liability','車輛設備',302],
    ['expense','asset_liability','系統設備',303],
    ['expense','asset_liability','資產-聯邦車貸',304],
  ];
  for (const [type, section, name, order] of plCats) {
    if (!getCat.get(name)) insCat.run(type, section, name, order);
  }

  // 停用舊 seed 通用科目（已由上方 plCats 取代）
  db.exec(`UPDATE ledger_categories SET active=0 WHERE name IN ('施工款','訂金','尾款','材料銷售') AND section='income'`);
  db.exec(`UPDATE ledger_categories SET active=0 WHERE name IN ('材料費','人工費（外包）','油資/交通','工具耗材','水電費','租金','廣告費','辦公費','稅費','其他支出') AND section='expense'`);

  // 確保 sort_order 與 plCats 定義一致（seed 可能設了錯誤的初始值）
  const _syncOrder = db.prepare(`UPDATE ledger_categories SET sort_order=? WHERE name=?`);
  for (const [,, name, order] of plCats) _syncOrder.run(order, name);
}

// ── 收入科目整理 migration（偵測舊版才執行）────────────────────
// 條件：舊版有 '裝漠貼膜-翰可' 或 'PAROI'（獨立科目，非 裝漠貼膜-PAROI）
const _needIncomeMigration =
  db.prepare(`SELECT id FROM ledger_categories WHERE name='裝漠貼膜-翰可' AND section='income' LIMIT 1`).get() ||
  db.prepare(`SELECT id FROM ledger_categories WHERE name='PAROI' AND section='income' LIMIT 1`).get();

if (_needIncomeMigration) {
  // 刪除舊名稱 / 錯誤科目
  const _delOld = [
    '裝漠貼膜-翰可', 'PAROI',
    '電梯貼膜-保護', '隔熱紙-收入', '玻璃膜-收入', '穩得-收入',
    '銷售膜料',       // 舊的通用銷售科目，已細分品牌
  ];
  _delOld.forEach(n => db.prepare(`DELETE FROM ledger_categories WHERE name=? AND section='income'`).run(n));

  // 停用舊通用科目（有人用過就不刪，改停用）
  ['施工款','訂金','尾款','材料銷售'].forEach(n =>
    db.prepare(`UPDATE ledger_categories SET active=0 WHERE name=? AND section='income'`).run(n)
  );

  // 重新設定排序（確保損益表顯示順序正確）
  const _finalOrder = [
    '裝漠貼膜-bodaq','裝漠貼膜-LG','裝漠貼膜-3M','裝漠貼膜-PAROI',
    '裝漠貼膜-保護膜','裝漠貼膜-其他',
    '電梯貼膜-改色','電梯貼膜-保護膜',
    '車體貼膜',
    '廣告輸出-自產','廣告輸出-外包',
    '玻璃膜施工','隔熱紙施工','防爆膜',
    '銷售膜料-bodaq','銷售膜料-LG','銷售膜料-3M',
    '銷售膜料-翰可','銷售膜料-隔熱紙','銷售膜料-其他',
    '施工代工',
    '學院-課程費','學院-材料銷售','學院-認證考試','學院-其他',
    'DS彩貼','穩得','調控薄膜','無框畫','設計費','其他收入',
  ];
  const _updOrder = db.prepare(`UPDATE ledger_categories SET sort_order=?,active=1 WHERE name=? AND section='income'`);
  _finalOrder.forEach((n, i) => _updOrder.run(i + 1, n));
}

// ── 學院業務展開 migration（「學院課程」→ 4 個子科目）───────────
const _needAcademyMigration =
  db.prepare(`SELECT id FROM ledger_categories WHERE name='學院課程' AND section='income' LIMIT 1`).get() &&
  !db.prepare(`SELECT id FROM ledger_categories WHERE name='學院-課程費' AND section='income' LIMIT 1`).get();

if (_needAcademyMigration) {
  db.prepare(`DELETE FROM ledger_categories WHERE name='學院課程' AND section='income'`).run();
  // DS彩貼(23)以後全部 +3，騰出 22-25 給學院
  db.prepare(`UPDATE ledger_categories SET sort_order=sort_order+3 WHERE section='income' AND sort_order>=22`).run();
  const _insAcad = db.prepare(`INSERT INTO ledger_categories (type,section,name,sort_order,active) VALUES ('income','income',?,?,1)`);
  _insAcad.run('學院-課程費',   22);
  _insAcad.run('學院-材料銷售', 23);
  _insAcad.run('學院-認證考試', 24);
  _insAcad.run('學院-其他',     25);
  console.log('✅ 學院業務展開完成（4 子科目）');
}

// ── 成本科目整理 migration（依品牌/產品邏輯）───────────────────
// 條件：舊版有「成本-大陸陳總」或「成本-犀牛皮」才執行
const _needCostMigration =
  db.prepare(`SELECT id FROM ledger_categories WHERE name='成本-大陸陳總' AND section='cost' LIMIT 1`).get() ||
  db.prepare(`SELECT id FROM ledger_categories WHERE name='成本-犀牛皮'   AND section='cost' LIMIT 1`).get();

if (_needCostMigration) {
  // 刪除舊名稱（新名稱已由 plCats 建立）
  [
    '成本-大陸陳總','成本-可米亞','成本-日本琳得科材料','成本-LINTEC',
    '成本-LG裝漠膜','成本-3M裝漠膜','成本-犀牛皮','成本-隔熱紙',
    '成本-翰可','成本-其他裝漠膜','成本-製作外包',
  ].forEach(n => db.prepare(`DELETE FROM ledger_categories WHERE name=?`).run(n));

  // 重設排序
  const _costOrder = [
    '進貨-bodaq','進貨-LG','進貨-3M','進貨-PAROI',
    '進貨-保護膜','進貨-隔熱紙','進貨-翰可','進貨-其他膜料',
    '成本-輸出材料','成本-廣告外包',
    '成本-DS彩貼','成本-穩得','成本-車貼材料',
    '成本-人力外包','成本-員工薪水','成本-員工獎金',
    '成本-學院材料','成本-學院講師費',
    '成本-機器設備','成本-施工耗材','成本-其他',
  ];
  const _updC = db.prepare(`UPDATE ledger_categories SET sort_order=?,active=1 WHERE name=? AND section='cost'`);
  _costOrder.forEach((n, i) => _updC.run(i + 101, n));

  console.log('✅ 成本科目整理完成（依品牌/產品邏輯）');
}

// ── 費用科目整理 migration（依性質分群、統一前綴）──────────────
// 條件：舊版有「聯邦車貸-費用」或「會計費用-記帳費用」才執行
const _needExpenseMigration =
  db.prepare(`SELECT id FROM ledger_categories WHERE name='聯邦車貸-費用'     AND section='expense' LIMIT 1`).get() ||
  db.prepare(`SELECT id FROM ledger_categories WHERE name='會計費用-記帳費用' AND section='expense' LIMIT 1`).get();

if (_needExpenseMigration) {
  // 停用重複項（施工耗材已在成本段）
  db.prepare(`UPDATE ledger_categories SET active=0 WHERE name='費用-施工耗材' AND section='expense'`).run();

  // 刪除舊名稱（新名稱已由 plCats 建立）
  [
    '費用-租金支出',
    '職工福利費-教育訓練','職工福利費-員工聚餐',
    '會計費用-記帳費用','會計費用-稅捐','會計費用-營業稅',
    '聯邦車貸-費用','台企銀青年創業貸款','富邦貸款','華銀貸款','利息支出',
    '零用金費用-Flora','零用金費用-Dan','零用金費用-恰吉',
    '交際費','BNI','其他費用','非公司費用只是抵五趴','退費退貨','外業務佣金','捐款',
  ].forEach(n => db.prepare(`DELETE FROM ledger_categories WHERE name=?`).run(n));

  // 重設排序
  const _expFinalOrder = [
    '費用-租金','費用-電費','費用-修繕費','費用-公司裝漠',
    '費用-交通費','費用-停車費','費用-燃料費','費用-汽車修繕','費用-牌照稅',
    '費用-進口關稅','費用-進口運費','費用-運費',
    '費用-廣告費','費用-交際費','費用-BNI',
    '費用-文具用品','費用-郵電費','費用-電話網路費','費用-雜項購置',
    '費用-零用金-Flora','費用-零用金-Dan','費用-零用金-恰吉',
    '保險費-勞保','保險費-勞退','保險費-健保','保險費-其他',
    '費用-教育訓練','費用-員工聚餐','費用-外業務佣金',
    '費用-記帳費','費用-稅捐','費用-營業稅',
    '貸款-聯邦車貸','貸款-台企銀','貸款-富邦','貸款-華銀','費用-利息支出',
    '費用-損耗虧損','費用-退費退貨','費用-捐款',
    '費用-專業委外','費用-非公司五趴','費用-其他',
  ];
  const _updE = db.prepare(`UPDATE ledger_categories SET sort_order=?,active=1 WHERE name=? AND section='expense'`);
  _expFinalOrder.forEach((n, i) => _updE.run(i + 201, n));

  console.log('✅ 費用科目整理完成（依性質分群）');
}

// ── 客戶分類（含折扣設定）───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS client_categories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id        INTEGER REFERENCES orgs(id),
    name          TEXT NOT NULL,
    discount_rate REAL DEFAULT 1.0,
    notes         TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
_addCol('clients', 'category_id', 'INTEGER REFERENCES client_categories(id)');

// ── 客戶標籤 ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER REFERENCES orgs(id),
    name       TEXT NOT NULL,
    color      TEXT DEFAULT '#6b7280',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS client_tags (
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (client_id, tag_id)
  );
`);

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
