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
    ['income','income','銷售膜料-bodaq',  14],
    ['income','income','銷售膜料-LG',     15],
    ['income','income','銷售膜料-3M',     16],
    ['income','income','銷售膜料-翰可',   17],
    ['income','income','銷售膜料-隔熱紙', 18],
    ['income','income','銷售膜料-其他',   19],
    ['income','income','施工代工',        20],
    ['income','income','學院課程',        21],
    ['income','income','DS彩貼',          22],
    ['income','income','穩得',            23],
    ['income','income','調控薄膜',        24],
    ['income','income','無框畫',          25],
    ['income','income','設計費',          26],
    ['income','income','其他收入',        27],
    // ── 成本 ──
    ['expense','cost','成本-大陸陳總',101],
    ['expense','cost','成本-LINTEC',102],
    ['expense','cost','成本-製作外包',103],
    ['expense','cost','成本-輸出材料',104],
    ['expense','cost','成本-機器設備',105],
    ['expense','cost','成本-可米亞',106],
    ['expense','cost','成本-翰可',107],
    ['expense','cost','成本-其他裝漠膜',108],
    ['expense','cost','成本-3M裝漠膜',109],
    ['expense','cost','成本-LG裝漠膜',110],
    ['expense','cost','成本-車貼材料',111],
    ['expense','cost','成本-隔熱紙',112],
    ['expense','cost','成本-穩得',113],
    ['expense','cost','成本-犀牛皮',114],
    ['expense','cost','成本-人力外包',115],
    ['expense','cost','成本-日本琳得科材料',116],
    ['expense','cost','成本-施工耗材',117],
    ['expense','cost','成本-員工薪水',118],
    ['expense','cost','成本-員工獎金',119],
    // ── 費用 ──
    ['expense','expense','費用-租金支出',201],
    ['expense','expense','費用-專業委外',202],
    ['expense','expense','費用-公司裝漠',203],
    ['expense','expense','費用-施工耗材',204],
    ['expense','expense','費用-文具用品',205],
    ['expense','expense','費用-運費',206],
    ['expense','expense','費用-進口關稅',207],
    ['expense','expense','費用-進口運費',208],
    ['expense','expense','費用-交通費',209],
    ['expense','expense','費用-停車費',210],
    ['expense','expense','費用-汽車修繕',211],
    ['expense','expense','費用-郵電費',212],
    ['expense','expense','費用-電話網路費',213],
    ['expense','expense','費用-電費',214],
    ['expense','expense','費用-燃料費',215],
    ['expense','expense','費用-牌照稅',216],
    ['expense','expense','費用-修繕費',217],
    ['expense','expense','費用-廣告費',218],
    ['expense','expense','費用-雜項購置',219],
    ['expense','expense','費用-損耗虧損',220],
    ['expense','expense','保險費-勞保',221],
    ['expense','expense','保險費-勞退',222],
    ['expense','expense','保險費-健保',223],
    ['expense','expense','保險費-其他',224],
    ['expense','expense','職工福利費-教育訓練',225],
    ['expense','expense','職工福利費-員工聚餐',226],
    ['expense','expense','會計費用-記帳費用',227],
    ['expense','expense','會計費用-稅捐',228],
    ['expense','expense','會計費用-營業稅',229],
    ['expense','expense','聯邦車貸-費用',230],
    ['expense','expense','台企銀青年創業貸款',231],
    ['expense','expense','富邦貸款',232],
    ['expense','expense','華銀貸款',233],
    ['expense','expense','利息支出',234],
    ['expense','expense','零用金費用-Flora',235],
    ['expense','expense','零用金費用-Dan',236],
    ['expense','expense','零用金費用-恰吉',237],
    ['expense','expense','交際費',238],
    ['expense','expense','BNI',239],
    ['expense','expense','其他費用',240],
    ['expense','expense','非公司費用只是抵五趴',241],
    ['expense','expense','退費退貨',242],
    ['expense','expense','外業務佣金',243],
    ['expense','expense','捐款',244],
    // ── 資產/負債 ──
    ['expense','asset_liability','押金/保證金',301],
    ['expense','asset_liability','車輛設備',302],
    ['expense','asset_liability','系統設備',303],
    ['expense','asset_liability','資產-聯邦車貸',304],
  ];
  for (const [type, section, name, order] of plCats) {
    if (!getCat.get(name)) insCat.run(type, section, name, order);
  }
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
    '玻璃膜施工','隔熱紙施工',
    '銷售膜料-bodaq','銷售膜料-LG','銷售膜料-3M',
    '銷售膜料-翰可','銷售膜料-隔熱紙','銷售膜料-其他',
    '施工代工','學院課程',
    'DS彩貼','穩得','調控薄膜','無框畫','設計費','其他收入',
  ];
  const _updOrder = db.prepare(`UPDATE ledger_categories SET sort_order=?,active=1 WHERE name=? AND section='income'`);
  _finalOrder.forEach((n, i) => _updOrder.run(i + 1, n));
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
