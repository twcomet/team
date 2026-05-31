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
_addCol('cases', 'line_source',        'TEXT');
_addCol('cases', 'line_display_name', 'TEXT');
_addCol('cases', 'client_category',   'TEXT');
_addCol('cases', 'desired_entry_date','TEXT');
_addCol('cases', 'cs_id',             'INTEGER REFERENCES users(id)');
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
_addCol('clients',    'invoice_email',     'TEXT');
_addCol('clients',    'invoice_needs',     'TEXT');
_addCol('clients',    'invoice_title',     'TEXT');  // 公司抬頭（發票用，可與客戶名稱不同）
_addCol('clients',    'updated_at',        'DATETIME');
_addCol('users',      'permissions',       'TEXT DEFAULT "{}"');
_addCol('users',      'sort_order',        'INTEGER DEFAULT 0');
_addCol('users',      'daily_cost',        'REAL');
_addCol('users',      'line_notify_token', 'TEXT');
_addCol('users',      'line_user_id',      'TEXT');
// 僅在欄位不存在時才新增，並對技術類角色設預設 1
const _hasDispatch = db.prepare(`PRAGMA table_info(users)`).all().some(c => c.name === 'accept_dispatch');
if (!_hasDispatch) {
  db.exec(`ALTER TABLE users ADD COLUMN accept_dispatch INTEGER DEFAULT 0`);
  db.exec(`UPDATE users SET accept_dispatch = 1
    WHERE role IN ('hq_tech','branch_tech','contractor_install','contractor_sales')`);
}
_addCol('cases',     'survey_fee_paid',       'INTEGER DEFAULT 0');
_addCol('cases',     'survey_fee_required',   'INTEGER');  // 1=需收, 0=不需收, NULL=未設定
_addCol('cases',     'survey_fee_waive_note', 'TEXT');     // 不需收原因
_addCol('cases',     'survey_fee_actual',     'REAL');     // 師傅實收金額
_addCol('cases',     'entry_info',        'TEXT');
_addCol('cases',     'photo_upload_url',  'TEXT');
_addCol('cases',     'outsource_cost',    'REAL');
_addCol('cases',     'shipping_cost',     'REAL');
_addCol('cases',     'other_cost',        'REAL');
_addCol('cases',     'balance_paid',         'REAL');
_addCol('cases',     'survey_fee_date',      'DATE');
_addCol('cases',     'survey_fee_note',      'TEXT');
_addCol('cases',     'survey_fee_method',    'TEXT');
_addCol('cases',     'deposit_date',         'DATE');
_addCol('cases',     'deposit_note',         'TEXT');
_addCol('cases',     'deposit_method',       'TEXT');
_addCol('cases',     'deposit_category',     'TEXT DEFAULT NULL');
_addCol('cases',     'balance_paid_date',    'DATE');
_addCol('cases',     'balance_paid_note',    'TEXT');
_addCol('cases',     'balance_paid_method',  'TEXT');
_addCol('cases',     'balance_category',     'TEXT DEFAULT NULL');
_addCol('cases',     'actual_entry_date',    'DATE');
_addCol('cases',     'retention_amount',     'REAL');
_addCol('cases',     'retention_due_date',   'TEXT');
_addCol('cases',     'retention_invoiced',   'REAL');
_addCol('cases',     'needs_invoice',        'INTEGER DEFAULT 0');
_addCol('cases',     'invoice_contact',      'TEXT');
_addCol('cases',     'invoice_phone',        'TEXT');
_addCol('cases',     'survey_preferred_time','TEXT');

// ── 確保所有在職內部員工都有 page_expenses 權限（不覆蓋已明確設為 false 的值）──
{
  const SKIP_ROLES = ['owner','contractor_install','contractor_sales','dealer'];
  const rows = db.prepare(`SELECT id, permissions FROM users WHERE active=1 AND role NOT IN (${SKIP_ROLES.map(()=>'?').join(',')})`)
    .all(...SKIP_ROLES);
  const upd = db.prepare(`UPDATE users SET permissions=? WHERE id=?`);
  for (const u of rows) {
    let p = {}; try { p = JSON.parse(u.permissions || '{}'); } catch {}
    if (p.page_expenses === undefined) {
      p.page_expenses = true;
      upd.run(JSON.stringify(p), u.id);
    }
  }
}

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

// ── 膜料異動紀錄（資料更動 Log）────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS material_change_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  org_id      INTEGER REFERENCES orgs(id),
  action      TEXT NOT NULL,
  detail      TEXT,
  changed_by  INTEGER REFERENCES users(id),
  changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);`);

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
_addCol('ledger_categories', 'section',      "TEXT DEFAULT NULL");
_addCol('ledger_categories', 'sensitive',   "INTEGER DEFAULT 0");
_addCol('ledger_categories', 'product_line',"TEXT DEFAULT NULL");
_addCol('ledger_entries',    'hidden',       "INTEGER DEFAULT 0");
_addCol('ledger_entries',    'pay_status',   "TEXT DEFAULT NULL");
_addCol('ledger_entries',    'paid_at',      "DATE DEFAULT NULL");
_addCol('ledger_entries',    'paid_note',    "TEXT DEFAULT NULL");
_addCol('ledger_entries',    'pay_due_date', "DATE DEFAULT NULL");
_addCol('ledger_entries',    'vendor',       "TEXT DEFAULT NULL");

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

// 薪資相關科目標記為私密（僅老闆可見）
db.exec(`UPDATE ledger_categories SET sensitive=1 WHERE sensitive=0 AND name IN (
  '成本-員工薪水','成本-員工獎金',
  '費用-零用金-Flora','費用-零用金-Dan','費用-零用金-恰吉'
)`);
// 停用員工費用申請系列科目（已由費用申請系統取代）
db.exec(`UPDATE ledger_categories SET active=0 WHERE name LIKE '員工費用申請%'`);

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

// ── 學員接案申請 ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS case_applications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    applicant_id INTEGER NOT NULL REFERENCES users(id),
    apply_type   TEXT NOT NULL CHECK(apply_type IN ('full','survey','install')),
    status       TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    hq_note      TEXT,
    reviewed_by  INTEGER REFERENCES users(id),
    reviewed_at  DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(case_id, applicant_id)
  );
`);

// ── 客戶對學員評分 ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS case_ratings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id    INTEGER NOT NULL REFERENCES cases(id),
    student_id INTEGER NOT NULL REFERENCES users(id),
    score      INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
    comment    TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(case_id, student_id)
  );
`);

_addCol('cases', 'outsource_open',  'INTEGER DEFAULT 0');
_addCol('cases', 'outsource_types', 'TEXT DEFAULT "[]"');

// ── 系統設定 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);
// 預設推播模式（manual = 人工推播，auto = 主動推播）
if (!db.prepare(`SELECT key FROM settings WHERE key='push_mode'`).get()) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('push_mode', 'manual')`).run();
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

// ── 批次建帳號 seed（2026-05-24）─────────────────────────────
{
  const hqOrg = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const hqId  = hqOrg?.id || null;

  const seedUsers = [
    // 工程部
    { name: '陳怡仲', username: 'VP01', pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 1 },
    { name: '呂紹銘', username: 'A01',  pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 0 },
    { name: '李傳恩', username: 'A02',  pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 0 },
    { name: '劉申鴻', username: 'A03',  pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 0 },
    { name: '林天鈞', username: 'A04',  pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 0 },
    { name: '鄭名汎', username: 'A05',  pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 0 },
    { name: '黃維宏', username: 'A06',  pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 0 },
    { name: '林冠捷', username: 'A07',  pw: '45917816', role: 'hq_tech',            dept: '工程部',       mgr: 0 },
    { name: '吳坤陽', username: 'A08',  pw: '45917816', role: 'contractor_install', dept: '工程部',       mgr: 0 },
    { name: '鍾矞傑', username: 'A09',  pw: '45917816', role: 'contractor_install', dept: '工程部',       mgr: 0 },
    // 業務
    { name: '王洪義', username: 'S01',  pw: '45917816', role: 'hq_sales',           dept: '總公司業務部', mgr: 1 },
    // 客服
    { name: '劉珮琪', username: 'C01',  pw: '45917816', role: 'hq_cs',             dept: '客服部',       mgr: 1 },
    { name: '林君忻', username: 'C02',  pw: '45917816', role: 'hq_cs',             dept: '客服部',       mgr: 0 },
    { name: '葉宛亭', username: 'C03',  pw: '45917816', role: 'hq_cs',             dept: '客服部',       mgr: 0 },
    // 行銷
    { name: '戴玉娟', username: 'M01',  pw: '45917816', role: 'hq_sales',           dept: '行銷部',       mgr: 1 },
    { name: '王智民', username: 'M02',  pw: '45917817', role: 'hq_sales',           dept: '行銷部',       mgr: 0 },
    // 台北店
    { name: 'Ken',   username: 'T01',  pw: '45917817', role: 'branch_sales',       dept: '台北業務部',   mgr: 1 },
  ];

  const ins = db.prepare(`
    INSERT OR IGNORE INTO users (name, username, password, role, org_id, department, is_manager, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);
  let created = 0;
  for (const u of seedUsers) {
    const exists = db.prepare(`SELECT id FROM users WHERE username = ?`).get(u.username);
    if (!exists) {
      ins.run(u.name, u.username, bcrypt.hashSync(u.pw, 8), u.role, hqId, u.dept, u.mgr);
      created++;
    }
  }
  if (created > 0) console.log(`批次建帳號完成：新增 ${created} 個帳號`);

  // 修正 A09 姓名錯字
  db.prepare(`UPDATE users SET name='鍾矞傑' WHERE username='A09' AND name='鍾畚傑'`).run();
}

// ── 權限修正（2026-05-25）────────────────────────────────────
// 陳怡仲為技術副總，角色應為 vp（才有管理員權限、可看金額）
db.prepare(`UPDATE users SET role='vp' WHERE username='VP01' AND role='hq_tech'`).run();

// 行銷部（M01 戴玉娟、M02 王智民）：hq_sales 預設看不到行銷頁面，需額外開通
for (const uname of ['M01', 'M02']) {
  const u = db.prepare(`SELECT id, permissions FROM users WHERE username=?`).get(uname);
  if (u) {
    const p = u.permissions ? JSON.parse(u.permissions) : {};
    if (!p.page_marketing) {
      p.page_marketing = true;
      db.prepare(`UPDATE users SET permissions=? WHERE id=?`).run(JSON.stringify(p), u.id);
    }
  }
}

// ── 測試用：預先簽署新帳號合約，測試完畢後清除 ───────────────
// 狀態：PRESIGN = 測試中（跳過合約頁）；NULL = 正式上線時需簽署
// 切換：將下方 PRESIGN_FOR_TESTING 改為 false 後部署即可清除
const PRESIGN_FOR_TESTING = true;
const TEST_ACCOUNTS = ['VP01','A01','A02','A03','A04','A05','A06','A07','A08','A09',
                       'S01','C01','C02','C03','M01','M02','T01'];
if (PRESIGN_FOR_TESTING) {
  const stmt = db.prepare(`UPDATE users SET contract_signed_at=CURRENT_TIMESTAMP, contract_type='employee' WHERE username=? AND contract_signed_at IS NULL`);
  for (const u of TEST_ACCOUNTS) stmt.run(u);
} else {
  // 清除測試簽署，讓使用者正式登入時重新簽署
  const stmt = db.prepare(`UPDATE users SET contract_signed_at=NULL, contract_signature=NULL, contract_type=NULL WHERE username=?`);
  for (const u of TEST_ACCOUNTS) stmt.run(u);
}

// ══════════════════════════════════════════════════════════════
// 派案系統擴充 v3.0 — Phase 1 Schema
// ══════════════════════════════════════════════════════════════

// ── 區域 ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS regions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'direct' CHECK(type IN ('direct','partner')),
    parent_id       INTEGER REFERENCES regions(id),
    manager_user_id INTEGER REFERENCES users(id),
    keywords        TEXT DEFAULT '[]',
    status          TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 預設 6 個直營區域
{
  const regExists = db.prepare(`SELECT id FROM regions LIMIT 1`).get();
  if (!regExists) {
    const insReg = db.prepare(`INSERT INTO regions (name, type, keywords) VALUES (?, 'direct', ?)`);
    insReg.run('臺北', JSON.stringify(['台北','臺北','北市','士林','天母','內湖','南港','信義','大安','中正','萬華','中山','大同','松山','文山','北投']));
    insReg.run('鶯歌', JSON.stringify(['鶯歌','三峽','樹林','土城','板橋','新莊','泰山','林口','八里','淡水','三重','蘆洲','五股','新北']));
    insReg.run('新竹', JSON.stringify(['新竹','竹北','竹東','苗栗','桃園','中壢','平鎮','龍潭','楊梅','新豐']));
    insReg.run('臺中', JSON.stringify(['台中','臺中','豐原','大甲','清水','沙鹿','彰化','南投','烏日','太平']));
    insReg.run('臺南', JSON.stringify(['台南','臺南','善化','新化','永康','歸仁','嘉義','新營','麻豆']));
    insReg.run('高雄', JSON.stringify(['高雄','鳳山','左營','三民','苓雅','前鎮','屏東','旗山','岡山','楠梓']));
    console.log('✅ 預設直營區域建立完成（臺北/鶯歌/新竹/臺中/臺南/高雄）');
  }
}

// ── 技師檔案 ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS technician_profiles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id),
    region_id        INTEGER REFERENCES regions(id),
    level            INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 4),
    acceptance_rate  REAL DEFAULT 1.0,
    complaint_rate   REAL DEFAULT 0,
    certified_at     DATETIME,
    status           TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','deactivated')),
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 派案佇列（自動遞補用）──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dispatch_queue (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id           INTEGER NOT NULL REFERENCES cases(id),
    technician_id     INTEGER NOT NULL REFERENCES users(id),
    queue_position    INTEGER DEFAULT 1,
    notified_at       DATETIME,
    response_deadline DATETIME,
    status            TEXT DEFAULT 'pending'
                      CHECK(status IN ('pending','accepted','declined','timeout')),
    decline_reason    TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 場勘記錄 ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS site_surveys (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id             INTEGER NOT NULL REFERENCES cases(id),
    technician_id       INTEGER REFERENCES users(id),
    area_sqm            REAL,
    dimensions          TEXT,
    materials_needed    TEXT DEFAULT '[]',
    difficulty_level    INTEGER DEFAULT 1 CHECK(difficulty_level BETWEEN 1 AND 5),
    estimated_work_days INTEGER DEFAULT 1,
    photos              TEXT DEFAULT '[]',
    notes               TEXT,
    submitted_at        DATETIME,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 內部報價估算（不同於 quote_sheets 的客戶簽收單）──────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS quotations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id        INTEGER NOT NULL REFERENCES cases(id),
    version        INTEGER DEFAULT 1,
    total_amount   REAL,
    material_cost  REAL,
    labor_cost     REAL,
    survey_fee     REAL DEFAULT 0,
    qa_cost        REAL DEFAULT 0,
    gross_profit   REAL,
    gross_margin   REAL,
    status         TEXT DEFAULT 'draft'
                   CHECK(status IN ('draft','sent','approved','rejected')),
    notes          TEXT,
    created_by     INTEGER REFERENCES users(id),
    approved_by    INTEGER REFERENCES users(id),
    approved_at    DATETIME,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 材料訂單（技師下單，綁定案件）──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS material_orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code     TEXT UNIQUE,
    case_id        INTEGER REFERENCES cases(id),
    technician_id  INTEGER REFERENCES users(id),
    region_id      INTEGER REFERENCES regions(id),
    status         TEXT DEFAULT 'pending'
                   CHECK(status IN ('pending','confirmed','preparing','shipped','delivered','cancelled')),
    payment_status TEXT DEFAULT 'unpaid'
                   CHECK(payment_status IN ('unpaid','paid','credited')),
    total_amount   REAL DEFAULT 0,
    notes          TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS material_order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES material_orders(id) ON DELETE CASCADE,
    material_id  INTEGER REFERENCES materials(id),
    sku          TEXT,
    name         TEXT,
    quantity     REAL NOT NULL,
    unit_price   REAL,
    subtotal     REAL,
    batch_number TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 品保驗收 ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS quality_checks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id         INTEGER NOT NULL REFERENCES cases(id),
    inspector_id    INTEGER REFERENCES users(id),
    type            TEXT DEFAULT 'final' CHECK(type IN ('pre','mid','final')),
    quality_score   INTEGER CHECK(quality_score BETWEEN 1 AND 5),
    photos          TEXT DEFAULT '[]',
    issues          TEXT DEFAULT '[]',
    passed          INTEGER DEFAULT 0,
    customer_signed INTEGER DEFAULT 0,
    notes           TEXT,
    checked_at      DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 保固案 ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS warranty_cases (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    original_case_id    INTEGER REFERENCES cases(id),
    client_id           INTEGER REFERENCES clients(id),
    technician_id       INTEGER REFERENCES users(id),
    issue_description   TEXT,
    issue_type          TEXT CHECK(issue_type IN ('material','installation','other')),
    responsibility_type TEXT CHECK(responsibility_type IN ('technician','material','customer')),
    status              TEXT DEFAULT 'open'
                        CHECK(status IN ('open','rework','resolved','rejected')),
    repair_cost         REAL DEFAULT 0,
    resolved_at         DATETIME,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 技師評分（比 case_ratings 更細）──────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ratings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id           INTEGER NOT NULL REFERENCES cases(id),
    technician_id     INTEGER NOT NULL REFERENCES users(id),
    rated_by          INTEGER REFERENCES users(id),
    quality_score     INTEGER CHECK(quality_score BETWEEN 1 AND 5),
    punctuality_score INTEGER CHECK(punctuality_score BETWEEN 1 AND 5),
    response_score    INTEGER CHECK(response_score BETWEEN 1 AND 5),
    cooperation_score INTEGER CHECK(cooperation_score BETWEEN 1 AND 5),
    customer_score    INTEGER CHECK(customer_score BETWEEN 1 AND 5),
    overall_score     REAL,
    notes             TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 分潤規則 ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_share_rules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    project_type     TEXT,
    region_id        INTEGER REFERENCES regions(id),
    technician_level INTEGER,
    rule_type        TEXT NOT NULL DEFAULT 'fixed_percent'
                     CHECK(rule_type IN ('fixed_percent','fixed_amount','tiered')),
    conditions       TEXT DEFAULT '{}',
    shares           TEXT NOT NULL DEFAULT '{}',
    status           TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── 分潤明細（每案拆帳）─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_shares (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id          INTEGER REFERENCES cases(id),
    user_id          INTEGER REFERENCES users(id),
    role_type        TEXT NOT NULL,
    share_type       TEXT NOT NULL CHECK(share_type IN ('percent','fixed','deduction')),
    amount           REAL NOT NULL,
    rule_id          INTEGER REFERENCES revenue_share_rules(id),
    status           TEXT DEFAULT 'pending'
                     CHECK(status IN ('pending','confirmed','settled')),
    settlement_month TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

_addCol('material_orders', 'case_id', 'INTEGER');
_addCol('revenue_shares',  'case_id', 'INTEGER');

// ── 月結 ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS settlements (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_month   TEXT NOT NULL,
    user_id            INTEGER NOT NULL REFERENCES users(id),
    role_type          TEXT NOT NULL,
    total_income       REAL DEFAULT 0,
    material_deduction REAL DEFAULT 0,
    penalty_deduction  REAL DEFAULT 0,
    warranty_deduction REAL DEFAULT 0,
    net_amount         REAL DEFAULT 0,
    status             TEXT DEFAULT 'draft'
                       CHECK(status IN ('draft','pending_approval','approved','paid')),
    approved_by        INTEGER REFERENCES users(id),
    approved_at        DATETIME,
    notes              TEXT,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(settlement_month, user_id)
  );
`);

// ── 擴充現有表欄位（_addCol 必須在 CREATE TABLE 之後）──────────
// users
_addCol('users', 'region_id',         'INTEGER REFERENCES regions(id)');
_addCol('users', 'technician_level',  'INTEGER DEFAULT 0');
_addCol('users', 'rating_avg',        'REAL DEFAULT 0');
_addCol('users', 'completed_cases',   'INTEGER DEFAULT 0');
_addCol('users', 'suspended_at',      'TEXT');
_addCol('users', 'suspension_reason', 'TEXT');
_addCol('users', 'can_delete',        'INTEGER DEFAULT 0');
// 授予客服主管(C01)、會計(C02)、客服(C03) 刪除權限
db.prepare(`UPDATE users SET can_delete=1 WHERE username IN ('C01','C02','C03') AND can_delete=0`).run();
_addCol('users', 'is_sales',          'INTEGER DEFAULT 0');
// 預設將現有業務相關角色標記為可派業務
db.prepare(`UPDATE users SET is_sales=1 WHERE role IN ('owner','hq_sales','hq_cs','branch_manager','branch_sales','contractor_sales') AND is_sales=0`).run();
// 已有施工日期的成交待派工 → 升為已派工待施工
db.prepare(`UPDATE cases SET status='dispatched', prev_status='contracted', updated_at=CURRENT_TIMESTAMP
            WHERE status='contracted' AND case_group='deal' AND scheduled_date IS NOT NULL AND scheduled_date != ''`).run();
// clients
_addCol('clients', 'region_id',      'INTEGER REFERENCES regions(id)');
_addCol('clients', 'owner_type',     "TEXT DEFAULT 'hq'");
_addCol('clients', 'owner_user_id',  'INTEGER REFERENCES users(id)');
// cases
_addCol('cases', 'region_id',              'INTEGER REFERENCES regions(id)');
_addCol('cases', 'source_type',            "TEXT DEFAULT 'line'");
_addCol('cases', 'assigned_technician_id', 'INTEGER REFERENCES users(id)');
_addCol('cases', 'regional_partner_id',    'INTEGER REFERENCES users(id)');
_addCol('cases', 'requires_survey',        'INTEGER DEFAULT 0');
_addCol('cases', 'dispatch_deadline',      'TEXT');
_addCol('cases', 'quotation_amount',       'REAL');
_addCol('cases', 'gross_profit',           'REAL');
// materials
_addCol('materials', 'sku',                  'TEXT');
_addCol('materials', 'technician_price',     'REAL');
_addCol('materials', 'locked_quantity',      'INTEGER DEFAULT 0');
_addCol('materials', 'ecommerce_product_id', 'TEXT');
// notifications（擴充現有表，加 channel / msg_status / sent_at / read_at）
_addCol('notifications', 'channel',    "TEXT DEFAULT 'system'");
_addCol('notifications', 'msg_status', "TEXT DEFAULT 'read'");
_addCol('notifications', 'sent_at',    'DATETIME');
_addCol('notifications', 'read_at',    'DATETIME');

// ── LINE OA 詢問管理 ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS line_inquiries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id      TEXT NOT NULL,
    client_id         INTEGER REFERENCES clients(id),
    display_name      TEXT,
    status            TEXT DEFAULT 'new'
                      CHECK(status IN ('new','in_progress','converted','invalid','hidden')),
    staff_note        TEXT,
    converted_case_id INTEGER REFERENCES cases(id),
    converted_at      DATETIME,
    converted_by      INTEGER REFERENCES users(id),
    last_message      TEXT,
    last_message_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    message_count     INTEGER DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS line_inquiry_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER NOT NULL REFERENCES line_inquiries(id) ON DELETE CASCADE,
    direction  TEXT NOT NULL CHECK(direction IN ('in','out')),
    msg_type   TEXT DEFAULT 'text',
    content    TEXT,
    sent_by    INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 案件所屬模組（用於 invalid 案件的歸屬）
_addCol('cases', 'case_group', 'TEXT DEFAULT NULL');
// 依現有狀態補值（冪等）
db.exec(`UPDATE cases SET case_group='deal'    WHERE case_group IS NULL AND status IN ('contracted','payment','closed','invalid')`);
db.exec(`UPDATE cases SET case_group='survey'  WHERE case_group IS NULL AND status IN ('survey','quoted')`);
db.exec(`UPDATE cases SET case_group='inquiry' WHERE case_group IS NULL`);
// initial_estimate 歸屬詢價管理（從 survey 移至 inquiry）
db.exec(`UPDATE cases SET case_group='inquiry' WHERE status='initial_estimate' AND case_group='survey'`);

// 合約簽署
_addCol('users', 'contract_signed_at',  'DATETIME DEFAULT NULL');
_addCol('users', 'contract_type',       "TEXT DEFAULT NULL");
_addCol('users', 'contract_signature',  'TEXT DEFAULT NULL');
// 可視店別（JSON 陣列，null=只看自己）
_addCol('users', 'allowed_org_ids',     'TEXT DEFAULT NULL');

// 場勘單指派欄位
_addCol('survey_forms', 'survey_time',   'TEXT DEFAULT NULL');
_addCol('survey_forms', 'dispatch_note', 'TEXT DEFAULT NULL');

// 派案任務進度追蹤
_addCol('dispatch_queue', 'task_progress',      "TEXT DEFAULT 'pending'");
_addCol('dispatch_queue', 'completion_notes',   'TEXT DEFAULT NULL');
_addCol('dispatch_queue', 'completion_photos',  "TEXT DEFAULT '[]'");
_addCol('dispatch_queue', 'progress_updated_at','DATETIME DEFAULT NULL');

// LINE 多頻道管理
db.exec(`
  CREATE TABLE IF NOT EXISTS line_channels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id        INTEGER REFERENCES orgs(id),
    channel_name  TEXT NOT NULL,
    channel_secret TEXT NOT NULL,
    channel_token  TEXT NOT NULL,
    welcome_msg    TEXT,
    active         INTEGER DEFAULT 1,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
_addCol('line_inquiries', 'org_id',             'INTEGER REFERENCES orgs(id)');
_addCol('line_inquiries', 'channel_id',         'INTEGER REFERENCES line_channels(id)');
_addCol('line_inquiries', 'line_original_name', 'TEXT');
// 舊紀錄補寫 line_original_name（只補 NULL 且 display_name 有值的）
db.exec(`UPDATE line_inquiries SET line_original_name=display_name WHERE line_original_name IS NULL AND display_name IS NOT NULL`);
// 負責業務 / 負責客服
_addCol('line_inquiries', 'sales_id',   'INTEGER REFERENCES users(id)');
_addCol('line_inquiries', 'cs_id',      'INTEGER REFERENCES users(id)');
// 加好友來源管道（從 LINE OAT 追蹤連結識別）
_addCol('line_inquiries', 'add_source', 'TEXT');
_addCol('line_inquiries', 'updated_at', 'DATETIME');

// 暫存 follow 事件的 OAT 來源（在首則訊息建立詢問前橋接用）
db.exec(`
  CREATE TABLE IF NOT EXISTS line_follow_sources (
    line_user_id TEXT PRIMARY KEY,
    add_source   TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 系統內建角色的預設權限設定
db.exec(`
  CREATE TABLE IF NOT EXISTS role_defaults (
    role_value   TEXT PRIMARY KEY,
    default_perms TEXT NOT NULL DEFAULT '{}',
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 初步估價紀錄
_addCol('cases', 'initial_estimate_data', 'TEXT DEFAULT NULL');

// 場勘單：客服備註 + 施作檢查清單 + 客服場勘資訊備註
_addCol('survey_forms', 'cs_notes',         'TEXT DEFAULT NULL');
_addCol('survey_forms', 'checklist_data',   'TEXT DEFAULT NULL');
_addCol('survey_forms', 'cs_service_note',  'TEXT DEFAULT NULL');
_addCol('survey_forms', 'worker_token',     'TEXT DEFAULT NULL');

// 派工：進場資訊欄位
_addCol('dispatches', 'unloading_location', 'TEXT DEFAULT NULL');
_addCol('dispatches', 'has_parking',        'TEXT DEFAULT NULL');
_addCol('dispatches', 'work_until',         'TEXT DEFAULT NULL');
_addCol('dispatches', 'access_code',        'TEXT DEFAULT NULL');

// 擴充 dispatch_type 允許值（含裁切材料、廠勘、其他）
const _dispSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='dispatches'`).get();
if (_dispSql && !_dispSql.sql.includes("'cut_material'")) {
  db.exec(`PRAGMA foreign_keys=OFF`);
  db.exec(`CREATE TABLE dispatches_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id         INTEGER NOT NULL REFERENCES cases(id),
    dispatch_type   TEXT NOT NULL DEFAULT 'install',
    scheduled_date  DATE NOT NULL,
    scheduled_time  TEXT,
    estimated_hours REAL,
    actual_hours    REAL,
    material        TEXT,
    material_used   REAL,
    status          TEXT DEFAULT 'pending'
                    CHECK(status IN ('pending','confirmed','done','cancelled')),
    notes           TEXT,
    labor_cost      REAL,
    unloading_location TEXT,
    has_parking     TEXT,
    work_until      TEXT,
    access_code     TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`INSERT INTO dispatches_new SELECT id,case_id,dispatch_type,scheduled_date,scheduled_time,
    estimated_hours,actual_hours,material,material_used,status,notes,
    COALESCE(labor_cost,NULL),
    COALESCE(unloading_location,NULL),COALESCE(has_parking,NULL),COALESCE(work_until,NULL),COALESCE(access_code,NULL),
    created_by,created_at FROM dispatches`);
  db.exec(`DROP TABLE dispatches`);
  db.exec(`ALTER TABLE dispatches_new RENAME TO dispatches`);
  db.exec(`PRAGMA foreign_keys=ON`);
}

// 場勘備註模板庫
db.exec(`
  CREATE TABLE IF NOT EXISTS survey_note_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT '一般',
    keyword    TEXT NOT NULL,
    content    TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 施作項目檢查清單模板庫
db.exec(`
  CREATE TABLE IF NOT EXISTS survey_checklist_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    item       TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
`);

// 預設模板資料（僅首次建表時插入）
const _hasNoteTemplates = db.prepare(`SELECT COUNT(*) as n FROM survey_note_templates`).get().n;
if (!_hasNoteTemplates) {
  const insNote = db.prepare(`INSERT INTO survey_note_templates (category, keyword, content, sort_order) VALUES (?,?,?,?)`);
  [
    ['除膜', '除舊膜',    '注意事項：現場需先除舊膜，請確認除殘膠工具已備齊，並告知客戶可能有輕微痕跡。', 1],
    ['骨料', '骨料打磨',  '注意事項：牆面或物件有骨料，場勘時請確認打磨程度，並評估是否需額外收費。', 2],
    ['矽利康', '矽利康',  '注意事項：玻璃四周矽利康老化或黴斑，建議先更換再施作，請現場確認並告知客戶。', 3],
    ['貼膜', '貼膜注意',  '注意事項：施作面是否乾淨平整？有油漬、灰塵請先處理。貼膜後請勿碰水 24 小時。', 4],
    ['電梯', '電梯注意',  '注意事項：請確認電梯尺寸（寬×高×深）、材質（不鏽鋼/烤漆/木紋）、及可使用時段。', 5],
    ['隔熱', '隔熱紙',    '注意事項：量測玻璃尺寸時請含框架內緣，確認是否有Low-E玻璃（隔熱紙需對應膜種）。', 6],
  ].forEach(([cat, kw, content, ord]) => insNote.run(cat, kw, content, ord));
}

const _hasChecklists = db.prepare(`SELECT COUNT(*) as n FROM survey_checklist_templates`).get().n;
if (!_hasChecklists) {
  const insCk = db.prepare(`INSERT INTO survey_checklist_templates (category, item, sort_order) VALUES (?,?,?)`);
  [
    ['玻璃膜', '確認玻璃尺寸（含四邊框邊）',       1],
    ['玻璃膜', '確認玻璃是否有裂痕或破損',          2],
    ['玻璃膜', '確認矽利康狀況（是否需更換）',       3],
    ['玻璃膜', '確認玻璃是否為 Low-E 玻璃',        4],
    ['玻璃膜', '確認採光方向（東/南/西/北向）',      5],
    ['門框',   '確認門框材質（不鏽鋼/鋁/木/烤漆）', 1],
    ['門框',   '確認門框尺寸（含轉角弧度）',         2],
    ['門框',   '確認是否需倒角或熱貼',              3],
    ['門框',   '確認舊膜狀況（是否需除膜）',         4],
    ['牆面',   '確認牆面材質（油漆/壁紙/磁磚/RC）', 1],
    ['牆面',   '確認牆面是否有骨料或凹凸不平',       2],
    ['牆面',   '確認油漆附著力（用膠帶測試）',       3],
    ['牆面',   '確認施作面積（寬×高）',             4],
    ['電梯',   '確認電梯廂尺寸（寬×高×深）',        1],
    ['電梯',   '確認材質（不鏽鋼/烤漆/木紋貼皮）',  2],
    ['電梯',   '確認可施作時段與管委會許可',         3],
    ['電梯',   '確認是否有舊膜需先除去',             4],
    ['電梯',   '確認電梯門板（外門/內門/雙面）',     5],
    ['一般',   '確認客戶聯絡方式正確',              1],
    ['一般',   '確認進場時間與停車方式',             2],
    ['一般',   '確認是否需搭電梯或有限制樓層',       3],
  ].forEach(([cat, item, ord]) => insCk.run(cat, item, ord));
}

// 我的任務：使用者手動標記已完成
db.exec(`
  CREATE TABLE IF NOT EXISTS user_task_dismissals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    case_id      INTEGER NOT NULL,
    dismissed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, case_id)
  )
`);

// 狀態流程追蹤欄位（步驟時間戳記 + 承辦人）
_addCol('cases', 'surveyed_at',         'DATETIME');
_addCol('cases', 'quote_draft_at',      'DATETIME');
_addCol('cases', 'quote_drafted_by',    'INTEGER REFERENCES users(id)');
_addCol('cases', 'quoted_at',           'DATETIME');
_addCol('cases', 'quoted_by',           'INTEGER REFERENCES users(id)');
_addCol('cases', 'contracted_at',       'DATETIME');
_addCol('cases', 'payment_at',          'DATETIME');
_addCol('cases', 'closed_at',           'DATETIME');
_addCol('cases', 'external_quote_url',  'TEXT');
_addCol('cases', 'invalid_reason',      'TEXT');
_addCol('cases', 'invalid_reason_tags', 'TEXT');
_addCol('cases', 'invalid_at',          'DATETIME');
_addCol('cases', 'invalided_by',        'INTEGER REFERENCES users(id)');
_addCol('cases', 'prev_status',         'TEXT');
_addCol('cases', 'initial_estimate_at', 'DATETIME');
_addCol('cases', 'survey_pending_at',  'DATETIME');

// 無效原因標籤庫
db.exec(`
  CREATE TABLE IF NOT EXISTS invalid_reason_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER REFERENCES orgs(id),
    name       TEXT NOT NULL,
    is_preset  INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
{
  const hasPresets = db.prepare(`SELECT COUNT(*) as n FROM invalid_reason_tags WHERE is_preset=1`).get();
  if (!hasPresets.n) {
    const ins = db.prepare(`INSERT INTO invalid_reason_tags (org_id, name, is_preset) VALUES (NULL, ?, 1)`);
    ['預算不符','暫緩或擱置','選擇其他廠商','聯繫不到客戶','施工地點無法進行','材料或工法不符需求','重複詢問','非真實詢問']
      .forEach(name => ins.run(name));
  }
}

// 初步估價紀錄（支援多種快速報價工具）
db.exec(`
  CREATE TABLE IF NOT EXISTS initial_estimates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id        INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    tool_type      TEXT NOT NULL DEFAULT 'material_calc',
    film_type      TEXT,
    film_width     INTEGER,
    calc_mode      TEXT,
    roll_length_m  INTEGER,
    items          TEXT DEFAULT '[]',
    total_cai      REAL,
    unit_price     REAL,
    total_price    REAL,
    discount       REAL,
    discount_price REAL,
    note           TEXT,
    created_by     INTEGER REFERENCES users(id),
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 收支表自動帶入用：追蹤案件付款的來源識別碼
_addCol('ledger_entries', 'source_ref', 'TEXT');

// ── 回填現有案件的收款記錄到收支表（idempotent：依 source_ref 避免重複）
{
  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const sysId   = sysUser?.id || null;

  // 包含：有金額（不論有無日期），日期留空時以 contracted_at 或 updated_at 備用
  const cases = db.prepare(`
    SELECT id, org_id, case_number, title,
           survey_fee, survey_fee_date,
           deposit_amount, deposit_date,
           balance_paid, balance_paid_date,
           contracted_at, updated_at
    FROM cases
    WHERE survey_fee IS NOT NULL OR deposit_amount IS NOT NULL OR balance_paid IS NOT NULL
  `).all();

  const existing = new Set(
    db.prepare(`SELECT source_ref FROM ledger_entries WHERE source_ref IS NOT NULL`).all().map(r => r.source_ref)
  );

  const ins = db.prepare(`
    INSERT INTO ledger_entries (date, type, category, amount, case_id, description, org_id, created_by, source_ref)
    VALUES (?, 'income', ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of cases) {
    // 備用日期：成交日 or 更新日 or 今天
    const fallback = (c.contracted_at || c.updated_at || new Date().toISOString()).slice(0, 10);
    const label = `${c.case_number || ''} ${c.title || ''}`.trim();
    const entries = [
      { ref: `case_${c.id}_survey_fee`, date: c.survey_fee_date   || fallback, amount: c.survey_fee,     cat: '場勘費', desc: `場勘費｜${label}` },
      { ref: `case_${c.id}_deposit`,    date: c.deposit_date      || fallback, amount: c.deposit_amount, cat: '訂金',   desc: `訂金｜${label}` },
      { ref: `case_${c.id}_balance`,    date: c.balance_paid_date || fallback, amount: c.balance_paid,   cat: '尾款',   desc: `尾款｜${label}` },
    ];
    for (const e of entries) {
      if (e.amount && !existing.has(e.ref)) {
        ins.run(e.date, e.cat, e.amount, c.id, e.desc, c.org_id || null, sysId, e.ref);
      }
    }
  }
}

// ── 刪除舊版 survey 狀態案件（2026-05-26）──────────────────────────────────
{
  const ids = db.prepare(`SELECT id FROM cases WHERE status='survey'`).all().map(r => r.id);
  if (ids.length > 0) {
    const nums = ids.join(',');
    const safeExec = (sql) => { try { db.exec(sql); } catch(e) { console.warn('  略過:', e.message.slice(0,80)); } };
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      const dids = db.prepare(`SELECT id FROM dispatches WHERE case_id IN (${nums})`).all().map(r => r.id);
      if (dids.length) safeExec(`DELETE FROM dispatch_users WHERE dispatch_id IN (${dids.join(',')})`);
    } catch(e) { /* dispatches 不存在 */ }
    safeExec(`DELETE FROM dispatches           WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM notifications        WHERE entity='cases' AND entity_id IN (${nums})`);
    safeExec(`DELETE FROM profit_shares        WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM material_logs        WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM ledger_entries       WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM case_ratings         WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM dispatch_queue       WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM site_surveys         WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM quotations           WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM quality_checks       WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM ratings              WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM user_task_dismissals WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM revenue_shares       WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM material_orders      WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM case_items           WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM dispatch_materials   WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM quote_sheets         WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM survey_forms         WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM case_applications    WHERE case_id IN (${nums})`);
    safeExec(`DELETE FROM initial_estimates    WHERE case_id IN (${nums})`);
    safeExec(`UPDATE line_inquiries SET converted_case_id=NULL WHERE converted_case_id IN (${nums})`);
    safeExec(`UPDATE warranty_cases  SET original_case_id=NULL  WHERE original_case_id  IN (${nums})`);
    db.exec(`DELETE FROM cases WHERE id IN (${nums})`);
    db.exec('PRAGMA foreign_keys=ON');
    console.log(`✅ 刪除舊版 survey 案件 ${ids.length} 筆（ID: ${nums}）`);
  }
}

// ── 舊「匯款」收款方式轉為「匯款至臺灣企銀」（2026-05-26）────────────────────
db.exec(`UPDATE cases SET survey_fee_method='匯款至臺灣企銀' WHERE survey_fee_method='匯款'`);
db.exec(`UPDATE cases SET deposit_method='匯款至臺灣企銀'   WHERE deposit_method='匯款'`);
db.exec(`UPDATE cases SET balance_paid_method='匯款至臺灣企銀' WHERE balance_paid_method='匯款'`);

// ── 人事資料欄位（users）────────────────────────────────────────────────────
_addCol('users', 'hire_date',          'DATE');
_addCol('users', 'id_number',          'TEXT');
_addCol('users', 'bank_account',       'TEXT');
_addCol('users', 'bank_name',          'TEXT');
_addCol('users', 'birthday',           'DATE');
_addCol('users', 'home_address',       'TEXT');
_addCol('users', 'emergency_contact',  'TEXT');
_addCol('users', 'emergency_phone',    'TEXT');
_addCol('users', 'hr_notes',           'TEXT');

// ── 案件座標（自動 Geocoding 用）───────────────────────────────────────────
_addCol('cases', 'lat', 'REAL');
_addCol('cases', 'lng', 'REAL');

// ── 打卡記錄 ────────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS attendance (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  work_date      DATE NOT NULL,
  clock_in       TEXT,
  clock_out      TEXT,
  work_start     TEXT,
  work_end       TEXT,
  is_late        INTEGER DEFAULT 0,
  auto_clock_out INTEGER DEFAULT 0,
  clock_in_lat   REAL,
  clock_in_lng   REAL,
  clock_out_lat  REAL,
  clock_out_lng  REAL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, work_date)
)`);

// ── 請假申請 ────────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS leave_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  leave_date     DATE NOT NULL,
  leave_end_date DATE,
  leave_type     TEXT NOT NULL,
  hours          REAL DEFAULT 8,
  reason         TEXT,
  status         TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    DATETIME,
  review_note    TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── 特休手動調整記錄 ─────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS leave_adjustments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  year           INTEGER NOT NULL,
  days           REAL NOT NULL,
  reason         TEXT NOT NULL,
  adjusted_by    INTEGER NOT NULL REFERENCES users(id),
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── 補打卡申請 ───────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS makeup_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  makeup_date    DATE NOT NULL,
  reason         TEXT,
  status         TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    DATETIME,
  review_note    TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// attendance 補欄位
_addCol('attendance', 'location_type', "TEXT DEFAULT NULL"); // 'company' | 'site'

// ── 客戶預收款（膜料本、其他預收）─────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS client_deposits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id       INTEGER NOT NULL REFERENCES clients(id),
    type            TEXT NOT NULL DEFAULT 'catalog',
    amount          REAL NOT NULL DEFAULT 0,
    collected_at    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','applied','forfeited','refunded')),
    applied_case_id INTEGER REFERENCES cases(id),
    applied_at      TEXT,
    waive_note      TEXT,
    note            TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 場勘費是否已折抵到案件最終收款
_addCol('cases', 'survey_fee_credited',  'INTEGER DEFAULT 0');
_addCol('cases', 'survey_fee_category', 'TEXT DEFAULT NULL');

// 客戶預收款：樣本品名（type='sample' 時填寫）
_addCol('client_deposits', 'product_name', 'TEXT DEFAULT NULL');

// 客戶官方 Line 顯示名稱（可手動填寫）
_addCol('cases', 'line_official_name', 'TEXT');
_addCol('cases', 'deal_intent', 'TEXT'); // hot | warm | cool | cold

// ── 修復 case_type CHECK 約束：補上 'output' ────────────────────────────────
try {
  const _csFix = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cases'`).get();
  if (_csFix && /CHECK\s*\(case_type\s+IN\s*\(/.test(_csFix.sql) && !_csFix.sql.includes("'output'")) {
    db.exec(`PRAGMA foreign_keys=OFF`);
    db.exec(`DROP TABLE IF EXISTS _cases_output_fix`);
    const _cols = db.prepare(`PRAGMA table_info(cases)`).all().map(c => c.name);
    const _newDef = _csFix.sql
      .replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?cases"?\b/i, 'CREATE TABLE _cases_output_fix')
      .replace(/CHECK\s*\(case_type\s+IN\s*\([^)]+\)\)/,
               `CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','other'))`);
    db.exec(_newDef);
    db.exec(`INSERT INTO _cases_output_fix (${_cols.join(',')}) SELECT ${_cols.join(',')} FROM cases`);
    db.exec(`DROP TABLE cases`);
    db.exec(`ALTER TABLE _cases_output_fix RENAME TO cases`);
    db.exec(`PRAGMA foreign_keys=ON`);
    console.log('✅ case_type CHECK 約束已修復（新增 output）');
  }
} catch(e) {
  db.exec(`PRAGMA foreign_keys=ON`);
  console.error('⚠️ case_type 約束修復失敗（不影響啟動）:', e.message);
}

// ── 回填 survey_date：從 survey_forms 同步至 cases ────────────────────────────
try {
  db.exec(`
    UPDATE cases SET survey_date = (
      SELECT sf.survey_date FROM survey_forms sf
      WHERE sf.case_id = cases.id AND sf.survey_date IS NOT NULL
      ORDER BY sf.id DESC LIMIT 1
    )
    WHERE survey_date IS NULL AND EXISTS (
      SELECT 1 FROM survey_forms sf
      WHERE sf.case_id = cases.id AND sf.survey_date IS NOT NULL
    )
  `);
} catch(e) { /* 欄位不存在時忽略 */ }

// ── 合約管理系統 ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    description   TEXT,
    content       TEXT,
    filename      TEXT,
    original_name TEXT,
    active        INTEGER DEFAULT 1,
    created_by    INTEGER REFERENCES users(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
_addCol('contracts', 'content', 'TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS contract_assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES contracts(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    assigned_by INTEGER REFERENCES users(id),
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notified_at DATETIME,
    UNIQUE(contract_id, user_id)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS contract_signatures (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES contracts(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    signed_name TEXT NOT NULL,
    signature   TEXT,
    signed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address  TEXT,
    UNIQUE(contract_id, user_id)
  );
`);
_addCol('contract_signatures', 'signature', 'TEXT');

// ── 費用申請系統 ──────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS expense_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS expense_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    org_id          INTEGER REFERENCES orgs(id),
    expense_date    DATE NOT NULL,
    category_id     INTEGER REFERENCES expense_categories(id),
    amount          REAL NOT NULL,
    description     TEXT,
    case_id         INTEGER REFERENCES cases(id),
    status          TEXT DEFAULT 'draft',
    mgr_id          INTEGER REFERENCES users(id),
    mgr_action_at   DATETIME,
    mgr_note        TEXT,
    owner_action_at DATETIME,
    owner_note      TEXT,
    reject_reason   TEXT,
    rejected_by     INTEGER REFERENCES users(id),
    rejected_at     DATETIME,
    settlement_id   INTEGER,
    settled_at      DATETIME,
    settled_by      INTEGER REFERENCES users(id),
    ledger_entry_id INTEGER REFERENCES ledger_entries(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS expense_settlements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    month         TEXT NOT NULL,
    total_amount  REAL NOT NULL,
    request_count INTEGER NOT NULL,
    settled_by    INTEGER REFERENCES users(id),
    settled_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    ledger_entry_id INTEGER REFERENCES ledger_entries(id),
    notes         TEXT
  )
`).run();

// 預設費用科目
{
  const cats = ['交通費','加油費','停車費','餐費','住宿費','工具費','材料費','代墊費'];
  const ins = db.prepare(`INSERT OR IGNORE INTO expense_categories (name, sort_order) VALUES (?,?)`);
  cats.forEach((n, i) => ins.run(n, i + 1));
}

// ── 廠商資料表 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,
    category       TEXT,
    contact        TEXT,
    phone          TEXT,
    email          TEXT,
    bank_name      TEXT,
    bank_account   TEXT,
    bank_branch    TEXT,
    payment_terms  TEXT,
    notes          TEXT,
    active         INTEGER DEFAULT 1,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
_addCol('vendors', 'bank_name',         'TEXT DEFAULT NULL');
_addCol('vendors', 'bank_account',      'TEXT DEFAULT NULL');
_addCol('vendors', 'bank_branch',       'TEXT DEFAULT NULL');
_addCol('vendors', 'bank_account_name', 'TEXT DEFAULT NULL');
_addCol('vendors', 'payment_terms',     'TEXT DEFAULT NULL');
_addCol('vendors', 'email',             'TEXT DEFAULT NULL');

db.exec(`
  CREATE TABLE IF NOT EXISTS vendor_brands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id  INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    brand      TEXT NOT NULL,
    notes      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(vendor_id, brand)
  )
`);

// ── 採購單與收貨系統 ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          INTEGER REFERENCES orgs(id),
    material_id     INTEGER REFERENCES materials(id),
    vendor_id       INTEGER REFERENCES vendors(id),
    brand           TEXT,
    series_code     TEXT,
    quantity_meters REAL NOT NULL,
    unit_cost       REAL DEFAULT 0,
    total_cost      REAL DEFAULT 0,
    shipping_type   TEXT DEFAULT 'domestic'
                    CHECK(shipping_type IN ('air','express','sea','domestic')),
    shipping_cost   REAL DEFAULT 0,
    expected_date   DATE,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','partial','received','cancelled')),
    notes           TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchase_receipts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    material_roll_id  INTEGER REFERENCES material_rolls(id),
    received_date     DATE NOT NULL,
    quantity_meters   REAL NOT NULL,
    batch_note        TEXT,
    created_by        INTEGER REFERENCES users(id),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── 資產借用系統 ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id       INTEGER REFERENCES orgs(id),
    name         TEXT NOT NULL,
    category     TEXT,
    is_consumable INTEGER DEFAULT 0,
    quantity     INTEGER DEFAULT 0,
    unit         TEXT DEFAULT '個',
    notes        TEXT,
    active       INTEGER DEFAULT 1,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS asset_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    org_id       INTEGER REFERENCES orgs(id),
    asset_id     INTEGER NOT NULL REFERENCES assets(id),
    quantity     INTEGER NOT NULL DEFAULT 1,
    purpose      TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    approved_by  INTEGER REFERENCES users(id),
    approved_at  DATETIME,
    due_date     DATE,
    returned_at  DATETIME,
    returned_by  INTEGER REFERENCES users(id),
    reject_reason TEXT,
    notes        TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── 科目重整 migration（2026-05 簡化版，27 個科目）─────────────
// 條件：新版「施工服務收入」尚未建立才執行
const _needCatReset =
  !db.prepare(`SELECT id FROM ledger_categories WHERE name='施工服務收入' LIMIT 1`).get();

if (_needCatReset) {
  db.exec(`UPDATE ledger_categories SET active=0 WHERE active=1`);
  const _catIns0 = db.prepare(
    `INSERT INTO ledger_categories (type, section, name, sort_order, active, sensitive) VALUES (?,?,?,?,1,?)`
  );
  [
    ['income',  'income',         '施工服務收入',    1,   0],
    ['income',  'income',         '膜料實體銷售',    2,   0],
    ['income',  'income',         '電商銷售',        3,   0],
    ['income',  'income',         '場勘費',          4,   0],
    ['expense', 'cost',           '材料採購成本',  101,   0],
    ['expense', 'cost',           '外包施工費',    102,   0],
    ['expense', 'cost',           '電商進貨成本',  103,   0],
    ['expense', 'cost',           '電商平台/物流費',104,  0],
    ['expense', 'expense',        '薪資費用',      201,   0],
    ['expense', 'expense',        '員工獎金',      202,   1],
    ['expense', 'expense',        '零用金-Flora',  203,   1],
    ['expense', 'expense',        '零用金-Dan',    204,   1],
    ['expense', 'expense',        '租金費用',      205,   0],
    ['expense', 'expense',        '水電費',        206,   0],
    ['expense', 'expense',        '電話/網路費',   207,   0],
    ['expense', 'expense',        '行銷費用',      208,   0],
    ['expense', 'expense',        '型錄/樣品寄送費',209,  0],
    ['expense', 'expense',        '交通費',        210,   0],
    ['expense', 'expense',        '保險費',        211,   0],
    ['expense', 'expense',        '稅費',          212,   0],
    ['expense', 'expense',        '設備/維修費',   213,   0],
    ['expense', 'expense',        '利息費用',      214,   0],
    ['expense', 'expense',        '辦公雜費',      215,   0],
    ['income',  'asset_liability','銀行貸款借入',  301,   0],
    ['expense', 'asset_liability','銀行貸款還款',  302,   0],
    ['expense', 'asset_liability','押金/保證金',   303,   0],
    ['expense', 'asset_liability','股東往來款',    304,   0],
  ].forEach(r => _catIns0.run(...r));
  console.log('✅ 科目重整完成（27 個精簡科目）');
}

// ── 科目擴充 migration（2026-05 v2：依業務線細分 + 貼膜學院）──────
// 條件：「裝漠貼膜施工收入」尚未建立才執行
const _needCatV2 =
  !db.prepare(`SELECT id FROM ledger_categories WHERE name='裝漠貼膜施工收入' LIMIT 1`).get();

if (_needCatV2) {
  // 停用 v1 的 4 個粗分收入科目與 4 個粗分成本科目
  db.exec(`UPDATE ledger_categories SET active=0 WHERE name IN (
    '施工服務收入','膜料實體銷售','電商銷售','場勘費',
    '材料採購成本','外包施工費','電商進貨成本','電商平台/物流費'
  )`);

  const _catIns2 = db.prepare(
    `INSERT INTO ledger_categories (type, section, name, sort_order, active, sensitive) VALUES (?,?,?,?,1,?)`
  );
  [
    // 收入（14 個，依施工類型細分）
    ['income',  'income',  '裝漠貼膜施工收入',       1,  0],
    ['income',  'income',  '玻璃貼膜施工收入',        2,  0],  // 隔熱紙/玻璃膜/防爆膜
    ['income',  'income',  '電梯貼膜施工收入',        3,  0],
    ['income',  'income',  '車體貼膜施工收入',        4,  0],
    ['income',  'income',  '廣告輸出收入',            5,  0],
    ['income',  'income',  '其他施工服務收入',        6,  0],
    ['income',  'income',  '膜料實體銷售',            7,  0],
    ['income',  'income',  '電商銷售',                8,  0],
    ['income',  'income',  '貼膜學院-課程費',         9,  0],
    ['income',  'income',  '貼膜學院-材料銷售',      10,  0],
    ['income',  'income',  '貼膜學院-認證考試',      11,  0],
    ['income',  'income',  '場勘費',                 12,  0],
    ['income',  'income',  '設計費',                 13,  0],
    ['income',  'income',  '其他收入',               14,  0],
    // 成本（8 個）
    ['expense', 'cost',    '膜料採購成本',          101,  0],
    ['expense', 'cost',    '廣告輸出材料成本',      102,  0],
    ['expense', 'cost',    '技術施工成本',          103,  0],  // 自有技術人員施工人力成本
    ['expense', 'cost',    '外包施工費',            104,  0],
    ['expense', 'cost',    '電商進貨成本',          105,  0],
    ['expense', 'cost',    '電商平台/物流費',       106,  0],
    ['expense', 'cost',    '貼膜學院材料成本',      107,  0],
    ['expense', 'cost',    '其他直接成本',          108,  0],
  ].forEach(r => _catIns2.run(...r));
  console.log('✅ 科目擴充完成（v2：14 個收入 + 8 個成本，含貼膜學院）');
}

// ── 科目細化 migration（v3：依品牌分施工/銷售/電商 + 電梯細分）──
// 條件：「裝潢貼膜施工-Para」尚未建立才執行
const _needCatV3 =
  !db.prepare(`SELECT id FROM ledger_categories WHERE name='裝潢貼膜施工-Para' LIMIT 1`).get();

if (_needCatV3) {
  // 停用 v2 中即將被細化的科目（保留歷史記帳資料）
  db.exec(`UPDATE ledger_categories SET active=0 WHERE name IN (
    '裝漠貼膜施工收入','施工服務收入',
    '膜料實體銷售','電商銷售',
    '電梯貼膜施工收入'
  )`);

  const _ins3 = db.prepare(
    `INSERT INTO ledger_categories (type, section, name, sort_order, active, sensitive) VALUES ('income','income',?,?,1,0)`
  );
  const _updOrd = db.prepare(`UPDATE ledger_categories SET sort_order=? WHERE name=? AND section='income'`);

  // ── 施工收入（依品牌）
  const _brands = ['Paroi','Bodaq','LX','AICA','3M','穩得'];
  _brands.forEach((b, i) => _ins3.run(`裝潢貼膜施工-${b}`, i + 1));

  // 玻璃貼膜、車體、廣告、其他 → 更新排序
  _updOrd.run(7,  '玻璃貼膜施工收入');
  // 電梯細分
  _ins3.run('電梯貼膜-改色貼膜', 8);
  _ins3.run('電梯貼膜-保護貼膜', 9);
  _updOrd.run(10, '車體貼膜施工收入');
  _updOrd.run(11, '廣告輸出收入');
  _updOrd.run(12, '其他施工服務收入');

  // ── 實體銷售（依品牌）
  _brands.forEach((b, i) => _ins3.run(`實體銷售-${b}`, 20 + i));

  // ── 電商銷售（依品牌）
  _brands.forEach((b, i) => _ins3.run(`電商銷售-${b}`, 30 + i));

  // ── 穩得施工收入（原 Wunder磨料 對應施工）已由 v4 連工帶料收入涵蓋，不另設科目

  // 學院、場勘費、設計費、其他 → 更新排序
  _updOrd.run(40, '貼膜學院-課程費');
  _updOrd.run(41, '貼膜學院-材料銷售');
  _updOrd.run(42, '貼膜學院-認證考試');
  _updOrd.run(50, '場勘費');
  _updOrd.run(51, '設計費');
  _updOrd.run(60, '其他收入');

  console.log('✅ 科目細化完成（v3：品牌分類施工/銷售/電商 + 電梯改色/保護細分）');
}

// ── 科目調整 migration（v4：施工收入改為「連工帶料收入」，移除品牌細分）──
const _needCatV4 =
  !db.prepare(`SELECT id FROM ledger_categories WHERE name='連工帶料收入' LIMIT 1`).get();

if (_needCatV4) {
  // 停用 v3 的品牌施工科目（新舊名稱都停用，避免遺漏）
  ['Paroi','Bodaq','LX','AICA','3M','穩得','Para','Boda','LG','iCar','Wunder磨料'].forEach(b => {
    db.prepare(`UPDATE ledger_categories SET active=0 WHERE name=?`).run(`裝潢貼膜施工-${b}`);
  });

  // 插入新的單一施工收入科目
  db.prepare(`INSERT INTO ledger_categories (type, section, name, sort_order, active, sensitive) VALUES ('income','income','連工帶料收入',1,1,0)`).run();

  // 確保其他施工科目排序正確
  const _updOrd4 = db.prepare(`UPDATE ledger_categories SET sort_order=? WHERE name=? AND section='income'`);
  _updOrd4.run(2, '玻璃貼膜施工收入');
  _updOrd4.run(3, '電梯貼膜-改色貼膜');
  _updOrd4.run(4, '電梯貼膜-保護貼膜');
  _updOrd4.run(5, '車體貼膜施工收入');
  _updOrd4.run(6, '廣告輸出收入');
  _updOrd4.run(7, '其他施工服務收入');

  console.log('✅ 科目調整完成（v4：連工帶料收入，移除品牌細分）');
}

// ── 品牌名稱修正 migration（v5：Para→Paroi, Boda→Bodaq, LG→LX, iCar→AICA, Wunder磨料→穩得）──
const _needCatV5 =
  db.prepare(`SELECT id FROM ledger_categories WHERE name='實體銷售-Para' LIMIT 1`).get() ||
  db.prepare(`SELECT id FROM ledger_categories WHERE name='實體銷售-LG'  LIMIT 1`).get();

if (_needCatV5) {
  const _ren = db.prepare(`UPDATE ledger_categories SET name=? WHERE name=?`);
  const _renames = [
    ['實體銷售-Para',     '實體銷售-Paroi'],
    ['實體銷售-Boda',     '實體銷售-Bodaq'],
    ['實體銷售-LG',       '實體銷售-LX'],
    ['實體銷售-iCar',     '實體銷售-AICA'],
    ['實體銷售-Wunder磨料','實體銷售-穩得'],
    ['電商銷售-Para',     '電商銷售-Paroi'],
    ['電商銷售-Boda',     '電商銷售-Bodaq'],
    ['電商銷售-LG',       '電商銷售-LX'],
    ['電商銷售-iCar',     '電商銷售-AICA'],
    ['電商銷售-Wunder磨料','電商銷售-穩得'],
    ['裝潢貼膜施工-Para',  '裝潢貼膜施工-Paroi'],
    ['裝潢貼膜施工-Boda',  '裝潢貼膜施工-Bodaq'],
    ['裝潢貼膜施工-LG',    '裝潢貼膜施工-LX'],
    ['裝潢貼膜施工-iCar',  '裝潢貼膜施工-AICA'],
    ['裝潢貼膜施工-Wunder磨料','裝潢貼膜施工-穩得'],
  ];
  _renames.forEach(([from, to]) => _ren.run(to, from));
  console.log('✅ 品牌名稱修正完成（v5）');
}

// ── 銷售科目簡化 migration（v6：移除品牌細分，只留實體銷售/電商銷售）──
const _needCatV6 =
  !db.prepare(`SELECT id FROM ledger_categories WHERE name='實體銷售' AND section='income' LIMIT 1`).get();

if (_needCatV6) {
  const _brands6 = ['Paroi','Bodaq','LX','AICA','3M','穩得','Para','Boda','LG','iCar','Wunder磨料'];
  _brands6.forEach(b => {
    db.prepare(`UPDATE ledger_categories SET active=0 WHERE name=?`).run(`實體銷售-${b}`);
    db.prepare(`UPDATE ledger_categories SET active=0 WHERE name=?`).run(`電商銷售-${b}`);
  });
  // 同時停用 v2 留下的單一「電商銷售」（section=income，若存在）
  db.prepare(`UPDATE ledger_categories SET active=0 WHERE name='電商銷售' AND section='income'`).run();

  const _ins6 = db.prepare(
    `INSERT INTO ledger_categories (type, section, name, sort_order, active, sensitive) VALUES ('income','income',?,?,1,0)`
  );
  _ins6.run('實體銷售', 20);
  _ins6.run('電商銷售',  21);
  console.log('✅ 銷售科目簡化完成（v6：實體銷售 + 電商銷售）');
}

// ── 施工收入依案件類型 migration（v7）──────────────────────────
const _needCatV7 =
  !db.prepare(`SELECT id FROM ledger_categories WHERE name='居家施工' LIMIT 1`).get();

if (_needCatV7) {
  // 停用舊的施工科目
  [
    '連工帶料收入','玻璃貼膜施工收入',
    '電梯貼膜-改色貼膜','電梯貼膜-保護貼膜',
    '車體貼膜施工收入','廣告輸出收入','其他施工服務收入',
  ].forEach(n => db.prepare(`UPDATE ledger_categories SET active=0 WHERE name=?`).run(n));

  const _ins7 = db.prepare(
    `INSERT INTO ledger_categories (type, section, name, sort_order, active, sensitive) VALUES ('income','income',?,?,1,0)`
  );
  ['居家施工','商空施工','電梯施工','玻璃施工','外快施工','外包施工','輸出施工','其他施工']
    .forEach((n, i) => _ins7.run(n, i + 1));

  console.log('✅ 施工科目更新完成（v7：依案件類型 8 個）');
}

// ── 品牌科目強制清除 migration（v8：用 LIKE 一次清掉所有殘留品牌科目）──
// 條件：任何含品牌名稱的科目還是 active=1 就執行
const _needCatV8 = !!db.prepare(`
  SELECT id FROM ledger_categories WHERE active=1 AND (
    name LIKE '裝潢貼膜施工-%' OR name LIKE '實體銷售-%' OR name LIKE '電商銷售-%'
  ) LIMIT 1
`).get();

if (_needCatV8) {
  db.exec(`
    UPDATE ledger_categories SET active=0 WHERE active=1 AND (
      name LIKE '裝潢貼膜施工-%' OR name LIKE '實體銷售-%' OR name LIKE '電商銷售-%'
    )
  `);
  console.log('✅ 品牌科目強制清除完成（v8）');
}

// ── 停用科目永久刪除 migration（v9）──
// 條件：還有任何 active=0 的科目就執行
const _needCatV9 = !!db.prepare(`SELECT id FROM ledger_categories WHERE active=0 LIMIT 1`).get();
if (_needCatV9) {
  const { changes } = db.prepare(`DELETE FROM ledger_categories WHERE active=0`).run();
  console.log(`✅ 停用科目已刪除（v9，共 ${changes} 筆）`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 報價系統 v2：公規品目錄、貼膜須知模板、折扣規則、車馬費、品項明細
// ══════════════════════════════════════════════════════════════════════════════

// 難度等級費率（1～10 級）
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_levels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    level               INTEGER UNIQUE NOT NULL,
    label               TEXT,
    internal_daily_rate REAL DEFAULT 0,
    external_daily_rate REAL DEFAULT 0,
    notes               TEXT,
    active              INTEGER DEFAULT 1,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 公規品目錄（房間門/大門/防火門/電梯門等）
db.exec(`
  CREATE TABLE IF NOT EXISTS catalog_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id             INTEGER REFERENCES orgs(id),
    category           TEXT NOT NULL,
    name               TEXT NOT NULL,
    material           TEXT,
    sides              TEXT,
    includes_frame     INTEGER DEFAULT 0,
    size_spec          TEXT,
    base_price         REAL NOT NULL DEFAULT 0,
    default_difficulty INTEGER DEFAULT 3,
    film_width_cm      REAL DEFAULT 122,
    notice_template_id INTEGER,
    sort_order         INTEGER DEFAULT 0,
    active             INTEGER DEFAULT 1,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 加價項目庫（補土/除矽利康/造型加價等）
db.exec(`
  CREATE TABLE IF NOT EXISTS catalog_addons (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id         INTEGER REFERENCES orgs(id),
    name           TEXT NOT NULL,
    description    TEXT,
    price_type     TEXT DEFAULT 'fixed' CHECK(price_type IN ('fixed','range','per_chi')),
    base_price     REAL DEFAULT 0,
    max_price      REAL,
    requires_photo INTEGER DEFAULT 0,
    applies_to     TEXT DEFAULT 'all',
    sort_order     INTEGER DEFAULT 0,
    active         INTEGER DEFAULT 1,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 貼膜須知模板庫
db.exec(`
  CREATE TABLE IF NOT EXISTS film_notice_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER REFERENCES orgs(id),
    name       TEXT NOT NULL,
    category   TEXT,
    content    TEXT NOT NULL DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 折扣規則（客戶分類 × 案量門檻）
db.exec(`
  CREATE TABLE IF NOT EXISTS discount_rules (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id             INTEGER REFERENCES orgs(id),
    client_category_id INTEGER REFERENCES client_categories(id),
    min_amount         REAL DEFAULT 0,
    discount_rate      REAL NOT NULL DEFAULT 1.0,
    label              TEXT,
    notes              TEXT,
    active             INTEGER DEFAULT 1,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 車馬費地區表
db.exec(`
  CREATE TABLE IF NOT EXISTS travel_fees (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          INTEGER REFERENCES orgs(id),
    region_name     TEXT NOT NULL,
    keywords        TEXT,
    survey_fee      REAL DEFAULT 0,
    install_fee     REAL DEFAULT 0,
    overnight_fee   REAL DEFAULT 0,
    night_surcharge REAL DEFAULT 0,
    notes           TEXT,
    sort_order      INTEGER DEFAULT 0,
    active          INTEGER DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 膜料價格矩陣（按才計算的裝漢貼膜，BODAQ/PAROI/LX等）
db.exec(`
  CREATE TABLE IF NOT EXISTS film_price_matrix (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          INTEGER REFERENCES orgs(id),
    brand           TEXT NOT NULL,
    series_code     TEXT,
    series_name     TEXT,
    flame_resistant INTEGER DEFAULT 0,
    film_width_cm   REAL DEFAULT 122,
    cost_per_meter  REAL DEFAULT 0,
    price_flat      REAL DEFAULT 0,
    price_cabinet   REAL DEFAULT 0,
    price_custom    REAL DEFAULT 0,
    sort_order      INTEGER DEFAULT 0,
    active          INTEGER DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 報價品項明細（綁 quote_sheets.id，支援多版本）
db.exec(`
  CREATE TABLE IF NOT EXISTS quote_sheet_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id           INTEGER NOT NULL REFERENCES quote_sheets(id) ON DELETE CASCADE,
    sort_order         INTEGER DEFAULT 0,
    item_type          TEXT DEFAULT 'film'
                       CHECK(item_type IN ('film','catalog','service','travel','freight')),
    location           TEXT,
    description        TEXT,
    film_brand         TEXT,
    film_model         TEXT,
    film_spec          TEXT,
    film_width_cm      REAL DEFAULT 122,
    surface_type       TEXT DEFAULT 'flat'
                       CHECK(surface_type IN ('flat','cabinet','custom')),
    length_cm          REAL,
    width_cm           REAL,
    area_sqchi         REAL,
    catalog_item_id    INTEGER REFERENCES catalog_items(id),
    catalog_config     TEXT DEFAULT '{}',
    difficulty_level   INTEGER DEFAULT 3,
    addon_ids          TEXT DEFAULT '[]',
    addon_total        REAL DEFAULT 0,
    unit               TEXT DEFAULT '才',
    quantity           REAL DEFAULT 1,
    unit_price         REAL DEFAULT 0,
    subtotal           REAL DEFAULT 0,
    notice_template_id INTEGER REFERENCES film_notice_templates(id),
    notice_text        TEXT,
    material_photo_url TEXT,
    area_photo_url     TEXT,
    notes              TEXT,
    cost_per_meter     REAL,
    estimated_meters   REAL,
    material_cost      REAL,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 擴充 quote_sheet_items
_addCol('quote_sheet_items', 'display_mode', "TEXT DEFAULT 'detail'");
_addCol('quote_sheet_items', 'simple_price', 'REAL');
_addCol('quote_sheet_items', 'material_id',  'INTEGER REFERENCES materials(id)');

// 擴充 quote_sheets
_addCol('quote_sheets', 'subtotal',                'REAL DEFAULT 0');
_addCol('quote_sheets', 'discount_rule_id',        'INTEGER');
_addCol('quote_sheets', 'discount_rate',           'REAL DEFAULT 1.0');
_addCol('quote_sheets', 'marketing_rate',          'REAL DEFAULT 1.0');
_addCol('quote_sheets', 'marketing_total',         'REAL DEFAULT 0');
_addCol('quote_sheets', 'tax_rate',                'REAL DEFAULT 0.05');
_addCol('quote_sheets', 'tax_amount',              'REAL DEFAULT 0');
_addCol('quote_sheets', 'final_total',             'REAL DEFAULT 0');
_addCol('quote_sheets', 'travel_fee',              'REAL DEFAULT 0');
_addCol('quote_sheets', 'freight_fee',             'REAL DEFAULT 0');
_addCol('quote_sheets', 'client_marketing_consent','INTEGER DEFAULT 0');
_addCol('quote_sheets', 'notes_terms',             'TEXT');
_addCol('quote_sheets', 'notes_acceptance',        'TEXT');

// ── P1 成本權限系統 ────────────────────────────────────────────────────────
// 材料成本可見性：老闆 + 會計
_addCol('users', 'can_see_cost',       'INTEGER DEFAULT 0');
// 人事成本可見性：僅老闆
_addCol('users', 'can_see_labor_cost', 'INTEGER DEFAULT 0');
// 資產倉管權限：可審核資產借用申請
_addCol('users', 'can_manage_assets',  'INTEGER DEFAULT 0');

// 自動設定：owner 角色 → 兩個成本權限都開
db.prepare(`UPDATE users SET can_see_cost=1, can_see_labor_cost=1 WHERE role='owner' AND can_see_cost=0`).run();
// 自動設定：hq_accounting 角色 → 只開材料成本
db.prepare(`UPDATE users SET can_see_cost=1 WHERE role='hq_accounting' AND can_see_cost=0`).run();

// ── P1 材料表擴充 ──────────────────────────────────────────────────────────
// 材料分類：film/tool/consumable/other
_addCol('materials', 'category',      "TEXT DEFAULT 'film'");
// EC 系統代碼（手動回填）
_addCol('materials', 'ec_key',        'TEXT');
_addCol('materials', 'ec_synced_at',  'DATETIME');
_addCol('materials', 'fire_retardant','INTEGER DEFAULT 0');
_addCol('materials', 'width_cm',      'REAL DEFAULT 122');
_addCol('materials', 'image_url',     'TEXT');
_addCol('materials', 'image_public_id','TEXT');

// ── P1 膜料價格矩陣 FK ─────────────────────────────────────────────────────
_addCol('film_price_matrix', 'material_id', 'INTEGER REFERENCES materials(id)');

// ── 庫存保留 ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS material_reservations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id     INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    quote_id        INTEGER NOT NULL REFERENCES quote_sheets(id) ON DELETE CASCADE,
    quote_item_id   INTEGER REFERENCES quote_sheet_items(id) ON DELETE CASCADE,
    case_id         INTEGER REFERENCES cases(id),
    org_id          INTEGER REFERENCES orgs(id),
    quantity_sqchi  REAL DEFAULT 0,
    quantity_meters REAL DEFAULT 0,
    status          TEXT DEFAULT 'pending'
                    CHECK(status IN ('pending','committed','released')),
    reserved_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    released_at     DATETIME,
    notes           TEXT
  )
`);

// ── 施工類型（動態化，取代硬編碼 flat/cabinet/custom） ─────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS service_types (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active  INTEGER DEFAULT 1
  )
`);
// 種入三個預設類型（已存在時跳過）
db.prepare(`INSERT OR IGNORE INTO service_types (key,name,sort_order) VALUES (?,?,?)`).run('flat',    '平面牆',       1);
db.prepare(`INSERT OR IGNORE INTO service_types (key,name,sort_order) VALUES (?,?,?)`).run('cabinet', '系統櫃/門片',  2);
db.prepare(`INSERT OR IGNORE INTO service_types (key,name,sort_order) VALUES (?,?,?)`).run('custom',  '造型/異形',    3);

// 膜料施工定價（取代 price_flat/cabinet/custom 三欄）
db.exec(`
  CREATE TABLE IF NOT EXISTS film_service_prices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    matrix_id       INTEGER NOT NULL REFERENCES film_price_matrix(id) ON DELETE CASCADE,
    service_type_id INTEGER NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
    price           REAL DEFAULT 0,
    UNIQUE(matrix_id, service_type_id)
  )
`);

// 遷移舊的 price_flat/cabinet/custom → film_service_prices（只跑一次）
if (!db.prepare(`SELECT value FROM settings WHERE key='svc_price_migrated'`).get()) {
  const stFlat = db.prepare(`SELECT id FROM service_types WHERE key='flat'`).get();
  const stCab  = db.prepare(`SELECT id FROM service_types WHERE key='cabinet'`).get();
  const stCust = db.prepare(`SELECT id FROM service_types WHERE key='custom'`).get();
  if (stFlat && stCab && stCust) {
    db.prepare(`INSERT OR IGNORE INTO film_service_prices (matrix_id,service_type_id,price)
      SELECT id,?,price_flat    FROM film_price_matrix WHERE price_flat    > 0`).run(stFlat.id);
    db.prepare(`INSERT OR IGNORE INTO film_service_prices (matrix_id,service_type_id,price)
      SELECT id,?,price_cabinet FROM film_price_matrix WHERE price_cabinet > 0`).run(stCab.id);
    db.prepare(`INSERT OR IGNORE INTO film_service_prices (matrix_id,service_type_id,price)
      SELECT id,?,price_custom  FROM film_price_matrix WHERE price_custom  > 0`).run(stCust.id);
  }
  db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES ('svc_price_migrated','1')`).run();
}

// 報價品項加 service_type_id 欄位 + 遷移現有紀錄
_addCol('quote_sheet_items', 'service_type_id', 'INTEGER REFERENCES service_types(id)');
if (!db.prepare(`SELECT value FROM settings WHERE key='qsi_svc_migrated'`).get()) {
  const stMap = {};
  db.prepare(`SELECT id,key FROM service_types`).all().forEach(r => { stMap[r.key] = r.id; });
  if (stMap.flat && stMap.cabinet && stMap.custom) {
    db.prepare(`UPDATE quote_sheet_items SET service_type_id=? WHERE surface_type='flat'    AND service_type_id IS NULL`).run(stMap.flat);
    db.prepare(`UPDATE quote_sheet_items SET service_type_id=? WHERE surface_type='cabinet' AND service_type_id IS NULL`).run(stMap.cabinet);
    db.prepare(`UPDATE quote_sheet_items SET service_type_id=? WHERE surface_type='custom'  AND service_type_id IS NULL`).run(stMap.custom);
  }
  db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES ('qsi_svc_migrated','1')`).run();
}

// ── 設計師查詢存取碼 ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS designer_access_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    code        TEXT NOT NULL UNIQUE,
    pin         TEXT NOT NULL,
    note        TEXT,
    is_active   INTEGER DEFAULT 1,
    expires_at  DATETIME,
    created_by  INTEGER REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;
