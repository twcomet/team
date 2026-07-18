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
                    CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','material_sale','other')),
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
    status          TEXT DEFAULT 'inquiry',  -- 不設 CHECK：狀態值由應用層管理（與遷移後 schema 一致，避免全新 DB 誤觸發 cases 表重建）
    priority        TEXT DEFAULT 'normal'
                    CHECK(priority IN ('low','normal','high','urgent')),
    notes           TEXT,
    -- Google 雲端資料夾（每案一個）
    drive_folder_id  TEXT,
    drive_folder_url TEXT,
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

// ── 暫定事項（未關聯案件的行事曆備忘：洽談中/估價中先 memo）──────────
db.exec(`
  CREATE TABLE IF NOT EXISTS adhoc_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    event_date    DATE NOT NULL,
    event_time    TEXT,
    note          TEXT,
    org_id        INTEGER REFERENCES orgs(id),
    created_by    INTEGER REFERENCES users(id),
    gcal_event_id TEXT DEFAULT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
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
_addCol('cases', 'drive_folder_id',  'TEXT');
_addCol('cases', 'drive_folder_url', 'TEXT');
// 客服對話備份用的獨立資料夾樹「系統客服對話紀錄」（跟案件資料夾分開、權限隔離）
_addCol('cases',   'drive_cs_folder_id',  'TEXT');
_addCol('cases',   'drive_cs_folder_url', 'TEXT');
_addCol('clients', 'drive_cs_folder_id',  'TEXT');
// 對話備份去重複：對話 PDF 的 Drive 檔案 id(每次覆蓋同一份) + 上次備份時的訊息數(沒新訊息就不重傳)
_addCol('cases',   'cs_backup_pdf_id',    'TEXT');
_addCol('cases',   'cs_backup_msgcount',  'INTEGER');
// 已備份過的照片(依訊息 id 去重，傳過不再傳)
db.exec(`CREATE TABLE IF NOT EXISTS cs_backup_photos (
  case_id INTEGER NOT NULL,
  msg_id  INTEGER NOT NULL,
  drive_file_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (case_id, msg_id)
)`);
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
_addCol('clients',    'contact_phone',     'TEXT');  // 聯絡人電話（市話/公司線）
_addCol('clients',    'contact_mobile',    'TEXT');  // 聯絡人手機
_addCol('clients',    'company_address',   'TEXT');  // 公司地址/送貨地址（與發票地址可不同）
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
_addCol('cases',     'survey_fee_report',     'TEXT');     // 師傅回報：paid=已收 / unpaid=沒收到 / NULL=未回報
_addCol('cases',     'survey_site_absent',    'INTEGER DEFAULT 0');  // 1=現場沒有人（無法收費、無法簽收）
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
_addCol('cases',     'retention_paid',         'REAL');              // 已收到保留款金額
_addCol('cases',     'retention_paid_date',    'DATE');              // 保留款已收日期
_addCol('cases',     'retention_paid_method',  'TEXT');              // 保留款收款方式
_addCol('cases',     'retention_verified',     'INTEGER DEFAULT 0'); // 會計是否已核銷（核銷後才入流水帳）
_addCol('cases',     'retention_verified_at',  'TEXT');
_addCol('cases',     'retention_verified_by',  'INTEGER');
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
// 申領核銷實扣庫存時，記下這筆異動屬於哪張申領單（供刪除時還原庫存）
_addCol('material_logs', 'requisition_id', 'INTEGER');

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

// ── 庫存批次匯入紀錄（可整批還原）────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS material_import_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER REFERENCES orgs(id),
  filename    TEXT,
  summary     TEXT,
  affected    TEXT,
  row_count   INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'applied',
  created_by  INTEGER REFERENCES users(id),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  reverted_at DATETIME
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
    case_type TEXT DEFAULT 'other' CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','material_sale','other')),
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
           CASE WHEN case_type IN ('home','commercial','elevator','glass','extra','outsource','output','material_sale','other')
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
    case_type TEXT DEFAULT 'other' CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','material_sale','other')),
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
           CASE WHEN case_type IN ('home','commercial','elevator','glass','extra','outsource','output','material_sale','other')
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
// ledger_entries 補欄位（必須在 CREATE TABLE 之後，全新 DB 才不會 "no such table"）
_addCol('ledger_entries', 'hidden',       "INTEGER DEFAULT 0");
_addCol('ledger_entries', 'pay_status',   "TEXT DEFAULT NULL");
_addCol('ledger_entries', 'paid_at',      "DATE DEFAULT NULL");
_addCol('ledger_entries', 'paid_note',    "TEXT DEFAULT NULL");
_addCol('ledger_entries', 'pay_due_date', "DATE DEFAULT NULL");
_addCol('ledger_entries', 'vendor',       "TEXT DEFAULT NULL");
_addCol('ledger_entries', 'client_id',    "INTEGER REFERENCES clients(id) DEFAULT NULL");
_addCol('ledger_entries', 'sub_category', "TEXT DEFAULT NULL");  // 種類/部位（內部分析用）
_addCol('ledger_entries', 'review_status', "TEXT DEFAULT 'approved'");  // approved=已入帳 / pending=待會計審核 / rejected=已退回；自動產生的帳預設pending、會計手動帳approved
_addCol('ledger_entries', 'brand',        "TEXT DEFAULT NULL");  // 品牌（內部分析用）
_addCol('ledger_entries', 'payee_info',   "TEXT DEFAULT NULL");  // 廠商收款資訊（手動填寫，付款時參考：匯款帳號/收款方式等）

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

// 科目凍結旗標：使用者在 UI 自訂科目名稱/排序後會設 settings.ledger_cats_frozen='1'，
// 凍結所有「科目 seed/重建」migration，避免部署把自訂內容洗掉（首次完整建立後自動設定）。
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
const _catsFrozen = !!db.prepare(`SELECT value FROM settings WHERE key='ledger_cats_frozen'`).get();

// 新增損益表專用科目（來自業務分類；若已存在則跳過）
if (!_catsFrozen) {
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
_addCol('cases', 'outsource_types', "TEXT DEFAULT '[]'");

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

// 合約欄位須在下方 PRESIGN UPDATE 之前先補上（全新 DB 才不會 "no such column"）
_addCol('users', 'contract_signed_at',  'DATETIME DEFAULT NULL');
_addCol('users', 'contract_type',       "TEXT DEFAULT NULL");
_addCol('users', 'contract_signature',  'TEXT DEFAULT NULL');

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
_addCol('cases', 'prev_status', 'TEXT');         // 須在下方 UPDATE 之前（全新 DB）
_addCol('cases', 'case_group', 'TEXT DEFAULT NULL');  // 同上
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

// 記事本：與該 LINE 用戶之間的內部多筆備註（比照 LINE OA「記事本」；客人看不到）
db.exec(`
  CREATE TABLE IF NOT EXISTS line_inquiry_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER NOT NULL REFERENCES line_inquiries(id) ON DELETE CASCADE,
    content    TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_linq_notes ON line_inquiry_notes(inquiry_id, id)`);

// 案件所屬模組（用於 invalid 案件的歸屬）
_addCol('cases', 'case_group', 'TEXT DEFAULT NULL');
// 依現有狀態補值（冪等）
db.exec(`UPDATE cases SET case_group='deal'    WHERE case_group IS NULL AND status IN ('contracted','dispatched','constructing','payment','closed','invalid')`);
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
// 客服手動改過顯示名稱後鎖定：新訊息進來不再用 LINE 名稱覆蓋 display_name
_addCol('line_inquiries', 'name_locked', 'INTEGER DEFAULT 0');
// 負責業務 / 負責客服
_addCol('line_inquiries', 'sales_id',   'INTEGER REFERENCES users(id)');
_addCol('line_inquiries', 'cs_id',      'INTEGER REFERENCES users(id)');
// 加好友來源管道（從 LINE OAT 追蹤連結識別）
_addCol('line_inquiries', 'add_source', 'TEXT');
_addCol('line_inquiries', 'updated_at', 'DATETIME');
_addCol('line_inquiries', 'tags', 'TEXT');   // 客戶標籤（JSON 字串陣列）
// AI 草稿回覆（草稿模式：AI 擬稿存後台，客服審核後才送）
_addCol('line_inquiries', 'ai_draft',              'TEXT');
_addCol('line_inquiries', 'ai_draft_at',           'DATETIME');
_addCol('line_inquiries', 'ai_needs_human',        'INTEGER DEFAULT 0');
_addCol('line_inquiries', 'ai_needs_human_reason', 'TEXT');
// 群組訊息：詢問是否為 LINE 群組/多人聊天室；訊息記下群組發話者名稱
_addCol('line_inquiries',         'is_group',       'INTEGER DEFAULT 0');
_addCol('line_inquiry_messages',  'sender_display', 'TEXT');
// 「✓ 已回覆」標記時間：同事在官方帳號後台回覆、系統收不到時，人工清掉待回覆紅燈
_addCol('line_inquiries',         'replied_at',     'DATETIME');
// LINE 大頭照：詢問層級（1對1=客人頭像、群組=群組圖示）＋訊息層級（群組發話者頭像）
_addCol('line_inquiries',         'avatar_url',     'TEXT');
_addCol('line_inquiry_messages',  'sender_avatar',  'TEXT');
// 針對某則訊息回覆（LINE 引用回覆）：入站訊息存 quote_token；出站訊息存回覆的來源訊息 id + 內容快照
_addCol('line_inquiry_messages',  'quote_token',      'TEXT');
_addCol('line_inquiry_messages',  'reply_to_id',      'INTEGER');
_addCol('line_inquiry_messages',  'reply_to_preview', 'TEXT');

// ── 客服知識庫（常見問答 / 制式回覆 / 資源連結，餵給 LINE AI）──────
db.exec(`
  CREATE TABLE IF NOT EXISTS cs_knowledge (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT DEFAULT '常見問題',
    question   TEXT,
    answer     TEXT,
    link_url   TEXT,
    link_label TEXT,
    keywords   TEXT,
    active     INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    updated_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// 空表才 seed 起始資料（使用者改動不覆蓋）
if (db.prepare(`SELECT COUNT(*) c FROM cs_knowledge`).get().c === 0) {
  const seed = db.prepare(`INSERT INTO cs_knowledge (category, question, answer, link_url, link_label, keywords, sort_order) VALUES (?,?,?,?,?,?,?)`);
  seed.run('電商', '有沒有電商／線上購買／網購／賣場？', '有的！我們有線上電商賣場，可以直接選購喔～有需要也可以再幫您介紹適合的膜料 😊', 'https://shop.twcomet.com/', '繪新電商賣場', '電商,網購,線上,賣場,購買,商城', 10);
  seed.run('官網／資源', '想看產品介紹／型錄／更多資訊', '這邊有我們的產品指南，各種材質與應用都有介紹，您可以先參考看看～', 'https://twcomet-guide.pages.dev/', '繪新產品指南', '型錄,產品,介紹,官網,資訊,指南', 20);
  seed.run('常見問題', '（範例）營業時間／聯絡方式 — 請編輯成實際內容', '（這是範例條目，請點編輯改成你們實際的營業時間與聯絡方式，或直接刪除。）', '', '', '營業時間,電話,聯絡', 90);
}
// 一次性補入「起始知識包」（對外、安全的公司資訊；機密不放；不確定的標待補）。以隱藏標記避免重複、不覆蓋既有。
if (!db.prepare(`SELECT 1 FROM cs_knowledge WHERE keywords='__kbpack_v1__'`).get()) {
  const kp = db.prepare(`INSERT INTO cs_knowledge (category, question, answer, link_url, link_label, keywords, active, sort_order) VALUES (?,?,?,?,?,?,?,?)`);
  kp.run('系統', '（知識包標記，請勿刪除）', '', '', '', '__kbpack_v1__', 0, 999);
  kp.run('公司資訊', '你們是做什麼的？', '繪新國際是專業的裝潢貼膜公司，提供牆面、系統櫃門片、造型、玻璃、電梯、天花板等貼膜施工，讓空間換上新面貌 😊', '', '', '公司,做什麼,服務,貼膜,介紹', 1, 5);
  kp.run('服務範圍', '有到府施工嗎／服務地區？', '我們有到府丈量與施工服務～您方便提供施工地點嗎？我幫您確認能不能安排喔！（實際服務範圍以客服確認為準）', '', '', '到府,施工,地區,範圍,服務', 1, 30);
  kp.run('材質', '有哪些膜料品牌／花色？', '我們主要使用韓國膜（BODAQ／BENIF）、PAROI、3M 等品牌，花色有木紋、石紋、皮革、亮面、金屬、素面等，也有防焰款可選 😊要不要我依您的空間幫您推薦？', '', '', '品牌,花色,材質,防焰,BODAQ,BENIF,PAROI,3M', 1, 35);
  kp.run('報價', '怎麼報價／費用怎麼算？', '費用會依施工位置、面積與材質而定，通常需要現場丈量後由專人為您報價喔～可以先傳幾張照片和大概尺寸，我們幫您做初步評估！', '', '', '報價,費用,價格,多少錢,估價', 1, 40);
  kp.run('展間', '可以參觀展間嗎？', '可以喔！我們有實體展間，能看到實際材質與貼膜效果，很歡迎您預約參觀～（展間地址與可參觀時段請客服提供）', '', '', '展間,參觀,看樣品,實體', 1, 45);
  kp.run('自媒體／影片', '有沒有作品或教學影片可以看？', '有的！我們在 YouTube、Instagram、Facebook、TikTok、小紅書 都有分享實際案例短影音，您可以參考看看～需要的話我幫您找對應主題的影片！（各連結陸續建置中）', '', '', '影片,作品,案例,短影音,youtube,ig,tiktok,小紅書', 1, 50);
  kp.run('保固／售後', '有保固嗎？', '關於保固與售後服務的細節，我幫您轉由專人為您完整說明，好嗎？😊（保固條件以客服/合約為準）', '', '', '保固,售後,維修,保障', 1, 60);
}
// 知識包 v2：實際影片對應題目（示範「影片→知識庫→AI 丟給客人」）
if (!db.prepare(`SELECT 1 FROM cs_knowledge WHERE keywords='__kbpack_v2__'`).get()) {
  const kp2 = db.prepare(`INSERT INTO cs_knowledge (category, question, answer, link_url, link_label, keywords, active, sort_order) VALUES (?,?,?,?,?,?,?,?)`);
  kp2.run('系統', '（知識包標記，請勿刪除）', '', '', '', '__kbpack_v2__', 0, 998);
  kp2.run('材質／施工', '這種門片（凹凸造型多）可以貼嗎？例如巧克力門片', '像六格立體、凹凸線條很多的門片（俗稱巧克力門片），因為凹槽太深、膜服貼不進去、邊角容易翹，通常「不建議貼」喔～建議您傳張照片，我幫您看是不是好施工的表面！這邊也有支影片說明👇', 'https://youtube.com/shorts/qGdqmmg3OQQ', '影片：為什麼不貼巧克力門片', '巧克力門片,凹凸,造型門片,六格門,能不能貼,可以貼嗎', 1, 55);
}
// 修復：先前知識包漏傳 active 導致 sort_order 值跑進 active 欄（AI 的 WHERE active=1 因此撈不到）
// 把誤植的值搬回 sort_order 並把 active 設回 1（標記列 active=0、正常列 active=1 不受影響）
db.exec(`UPDATE cs_knowledge SET sort_order=active, active=1 WHERE active NOT IN (0,1)`);

// 罐頭訊息示範（category='罐頭訊息' → LINE 詢問回覆框「常用語」快捷；空缺時才 seed）
if (!db.prepare(`SELECT 1 FROM cs_knowledge WHERE keywords='__canned_v1__'`).get()) {
  const kc = db.prepare(`INSERT INTO cs_knowledge (category, question, answer, link_url, link_label, keywords, active, sort_order) VALUES (?,?,?,?,?,?,?,?)`);
  kc.run('系統', '（罐頭訊息標記，請勿刪除）', '', '', '', '__canned_v1__', 0, 997);
  kc.run('罐頭訊息', '營業時間', '您好😊 我們的客服服務時間為週一至週五 09:00–18:00，非服務時間收到的訊息會在上班後盡快回覆您，謝謝您的耐心 🙏', '', '', '營業時間,幾點,上班', 1, 1);
  kc.run('罐頭訊息', '感謝結尾', '感謝您的詢問😊 後續有任何問題都歡迎再告訴我們，很高興為您服務 🙏', '', '', '感謝,謝謝,結尾', 1, 2);
}

// 暫存 follow 事件的 OAT 來源（在首則訊息建立詢問前橋接用）
db.exec(`
  CREATE TABLE IF NOT EXISTS line_follow_sources (
    line_user_id TEXT PRIMARY KEY,
    add_source   TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── AI 用量監控：每次呼叫 Anthropic API 記一筆（功能、使用者、token、估算花費）──
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    feature       TEXT,
    user_id       INTEGER,
    model         TEXT,
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    est_cost_usd  REAL    DEFAULT 0,
    created_at    DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON ai_usage_log(feature);
  CREATE TABLE IF NOT EXISTS ai_usage_settings (
    id             INTEGER PRIMARY KEY CHECK (id=1),
    daily_limit_usd REAL   DEFAULT 5,
    alert_enabled   INTEGER DEFAULT 1
  );
`);
if (!db.prepare(`SELECT 1 FROM ai_usage_settings WHERE id=1`).get()) {
  db.prepare(`INSERT INTO ai_usage_settings (id, daily_limit_usd, alert_enabled) VALUES (1, 5, 1)`).run();
}

// ── AI 顧問對話保存（純文字，很小；跳頁不再消失）──
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_advisor_chats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    advisor      TEXT,
    title        TEXT,
    messages_json TEXT,
    created_at   DATETIME DEFAULT (datetime('now','localtime')),
    updated_at   DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_advisor_chats_user ON ai_advisor_chats(user_id, advisor);
`);

// ── 一次性遷移：合併同一客人的重複詢問視窗（每客一視窗）──────────────
// 過去轉案後新訊息會另開一筆，導致同一 line_user_id 有多個視窗、也難以統計客人數。
// 這裡把每個 (line_user_id, channel_id) 群組收斂成一條：保留「狀態最進階、最近有活動」
// 的那筆當主視窗，其餘視窗的訊息全部搬進去後刪除（先搬再刪，避免 CASCADE 連帶刪訊息）。
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT (datetime('now','localtime')))`);
_addCol('_migrations', 'detail', 'TEXT');   // 存遷移結果（合併統計等），供事後查詢
if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get('merge_dup_inquiries_v1')) {
  try {
    const groups = db.prepare(`
      SELECT line_user_id, COALESCE(channel_id,-1) AS chan, COUNT(*) n
      FROM line_inquiries WHERE line_user_id IS NOT NULL
      GROUP BY line_user_id, COALESCE(channel_id,-1) HAVING n > 1
    `).all();
    let mergedGroups = 0, deletedThreads = 0, movedMsgs = 0;
    const keepIds = [];
    db.exec('BEGIN');
    for (const g of groups) {
      const rows = db.prepare(`
        SELECT id FROM line_inquiries
        WHERE line_user_id=? AND COALESCE(channel_id,-1)=?
        ORDER BY CASE status WHEN 'converted' THEN 5 WHEN 'in_progress' THEN 4 WHEN 'new' THEN 3
                             WHEN 'hidden' THEN 2 WHEN 'invalid' THEN 1 ELSE 0 END DESC,
                 COALESCE(last_message_at, created_at) DESC, id DESC
      `).all(g.line_user_id, g.chan);
      if (rows.length < 2) continue;
      const keep = rows[0].id;
      const dups = rows.slice(1).map(r => r.id);
      const ph = dups.map(() => '?').join(',');
      movedMsgs += db.prepare(`UPDATE line_inquiry_messages SET inquiry_id=? WHERE inquiry_id IN (${ph})`).run(keep, ...dups).changes;
      db.prepare(`DELETE FROM line_inquiries WHERE id IN (${ph})`).run(...dups);
      deletedThreads += dups.length; mergedGroups++; keepIds.push(keep);
    }
    // 重算保留視窗的彙總（訊息數、最後訊息文字與時間）
    for (const id of keepIds) {
      db.prepare(`
        UPDATE line_inquiries SET
          message_count = (SELECT COUNT(*) FROM line_inquiry_messages m WHERE m.inquiry_id=?),
          last_message_at = COALESCE((SELECT MAX(created_at) FROM line_inquiry_messages m WHERE m.inquiry_id=?), last_message_at),
          last_message = COALESCE((SELECT CASE WHEN m.msg_type='image' THEN '[照片]' ELSE substr(m.content,1,200) END
                                   FROM line_inquiry_messages m WHERE m.inquiry_id=? ORDER BY m.id DESC LIMIT 1), last_message)
        WHERE id=?`).run(id, id, id, id);
    }
    db.exec('COMMIT');
    db.prepare(`INSERT INTO _migrations (name, detail) VALUES (?, ?)`)
      .run('merge_dup_inquiries_v1', JSON.stringify({ mergedGroups, deletedThreads, movedMsgs }));
    console.log(`✅ 合併重複詢問視窗：${mergedGroups} 位客人、刪 ${deletedThreads} 個重複視窗、搬移 ${movedMsgs} 則訊息`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('⚠️ 合併重複詢問視窗失敗（已回滾，不影響系統）:', e.message);
  }
}

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

// 場勘單：師傅回報現場搬運/停車資訊（供施工派工參考）
_addCol('survey_forms', 'access_method',      'TEXT DEFAULT NULL');   // 'stairs'=爬樓梯 / 'elevator'=有電梯
_addCol('survey_forms', 'access_note',        'TEXT DEFAULT NULL');   // 樓層/搬運備註
_addCol('survey_forms', 'parking_location',   'TEXT DEFAULT NULL');   // 附近停車位置
_addCol('survey_forms', 'parking_fee_hourly', 'REAL DEFAULT NULL');   // 每小時停車費
_addCol('survey_forms', 'parking_fee_has_cap','INTEGER DEFAULT 0');   // 有無收費上限
_addCol('survey_forms', 'parking_fee_cap',    'REAL DEFAULT NULL');   // 收費上限金額

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

// 派工：售後維修費用（必須在 migration 之後，避免 migration 重建 table 時欄位遺失）
_addCol('dispatches', 'warranty_covered', 'INTEGER DEFAULT 1'); // 1=保固免費, 0=收費
_addCol('dispatches', 'service_fee',      'REAL DEFAULT NULL'); // 收費金額
_addCol('dispatches', 'day_index',        'INTEGER DEFAULT NULL'); // 多日施工第幾天(1=第1天)；NULL=未標記/單日
_addCol('dispatches', 'leader_id',        'INTEGER REFERENCES users(id) DEFAULT NULL'); // 小組長（從指派人員中選一位，負責完工回報）
_addCol('dispatches', 'gcal_event_id',    'TEXT DEFAULT NULL'); // 對應的 Google 行事曆事件 ID（派單同步用）
_addCol('dispatches', 'drive_subfolder_id',   'TEXT DEFAULT NULL'); // 派工在案件資料夾內的子資料夾 ID（場勘/施工/維修夾）
_addCol('dispatches', 'drive_subfolder_url',  'TEXT DEFAULT NULL'); // 子資料夾網址
_addCol('dispatches', 'drive_subfolder_name', 'TEXT DEFAULT NULL'); // 子資料夾目前名稱（改人員/日期時據此判斷是否需改名）
_addCol('cases',      'survey_gcal_event_id', 'TEXT DEFAULT NULL'); // 場勘(非派工)對應的 Google 行事曆事件 ID
// 場勘單（客服填寫區流程，非派工）也建場勘子資料夾
_addCol('survey_forms', 'drive_subfolder_id',   'TEXT DEFAULT NULL');
_addCol('survey_forms', 'drive_subfolder_url',  'TEXT DEFAULT NULL');
_addCol('survey_forms', 'drive_subfolder_name', 'TEXT DEFAULT NULL');

// 一次性修正：已核准且已預扣(有有效 reserve log)的「案件材料保留」若被標成 archived(已完成)，改回 reserved(保留中)
// 只動「確實有作用中預扣紀錄」的，沒預扣過的舊保留不碰(需重新核准才會預扣)，避免誤判
try {
  db.prepare(`UPDATE material_requisitions SET status='reserved'
    WHERE purpose_code='case_reserve' AND status='archived'
      AND id IN (SELECT requisition_id FROM material_logs
                 WHERE log_type='reserve' AND status='active' AND requisition_id IS NOT NULL)`).run();
} catch (_) {}

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

// 施工完工回報（第二階段 2a）：師傅從「我的任務」填、辦公室看得到。獨立表，不碰既有派工/計價/庫存
db.exec(`
  CREATE TABLE IF NOT EXISTS work_reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id        INTEGER REFERENCES cases(id),
    dispatch_id    INTEGER,
    report_date    DATE,
    reporter_id    INTEGER REFERENCES users(id),
    driver_ids       TEXT,   -- 誰開車（JSON 使用者id陣列）
    prepper_ids      TEXT,   -- 誰準備材料
    photographer_ids TEXT,   -- 誰拍照
    photos_uploaded  INTEGER DEFAULT 0,  -- 照片已上傳雲端
    progress_pct     INTEGER,            -- 整體完工進度%
    notes            TEXT,
    status         TEXT DEFAULT 'submitted',
    submitted_at   DATETIME,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dispatch_id, reporter_id)
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
    // 場勘費不自動匯入收支：客服 key 的是「預估值」非實收，只能由「預收款核銷+老闆確認」
    // 或會計手動登記才入帳，否則會重複計算（2026-06-15 移除 survey_fee 自動匯入）
    const entries = [
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

// ── 一次性清理：移除過去「開機自動匯入」誤計入的場勘費收入（2026-06-15）──
// 客服 key 的場勘費是預估值非實收，曾被自動寫入 ledger 造成重複計算。
// 只刪 source_ref 形如 case_<id>_survey_fee 的帳（GLOB 精準鎖定），
// 不影響訂金/尾款、預收款核銷確認、會計手動登記的帳。
try {
  const ph = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM ledger_entries WHERE source_ref GLOB 'case_*_survey_fee'`).get();
  if (ph.n > 0) {
    db.prepare(`DELETE FROM ledger_entries WHERE source_ref GLOB 'case_*_survey_fee'`).run();
    console.log(`🧹 已清除誤匯入的場勘費收入 ${ph.n} 筆，共 $${ph.total}（客服預估值，非實收）`);
  }
} catch (e) { console.warn('場勘費清理略過:', e.message.slice(0,80)); }

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
_addCol('attendance', 'clock_type', "TEXT DEFAULT NULL");    // 'ontime' | 'late' | 'special'

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
  if (_csFix && /CHECK\s*\(case_type\s+IN\s*\(/.test(_csFix.sql) && !_csFix.sql.includes("'material_sale'")) {
    db.exec(`PRAGMA foreign_keys=OFF`);
    db.exec(`DROP TABLE IF EXISTS _cases_output_fix`);
    const _allCols = db.prepare(`PRAGMA table_info(cases)`).all();
    const _newDef = _csFix.sql
      // 連同開頭括號一起換掉表名（含可能的引號），避免殘留 stray 引號
      .replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["'`]?cases["'`]?\s*\(/i, 'CREATE TABLE _cases_output_fix (')
      // 把雙引號字串預設（如 DEFAULT "[]"）轉成單引號，否則重建 CREATE 會被當識別字→語法錯誤
      .replace(/DEFAULT\s+"([^"]*)"/g, "DEFAULT '$1'")
      .replace(/CHECK\s*\(case_type\s+IN\s*\([^)]+\)\)/,
               `CHECK(case_type IN ('home','commercial','elevator','glass','extra','outsource','output','material_sale','other'))`);
    db.exec(_newDef);
    // 補上後來 _addCol 加入的欄位（原 CREATE TABLE 不含這些）
    const _newFixCols = new Set(db.prepare(`PRAGMA table_info(_cases_output_fix)`).all().map(c => c.name));
    for (const col of _allCols) {
      if (!_newFixCols.has(col.name)) {
        const typeDef = (col.type || 'TEXT') + (col.dflt_value != null ? ` DEFAULT ${col.dflt_value}` : '');
        try { db.exec(`ALTER TABLE _cases_output_fix ADD COLUMN "${col.name}" ${typeDef}`); } catch(_) {}
      }
    }
    const _cols = _allCols.map(c => `"${c.name}"`);
    db.exec(`INSERT INTO _cases_output_fix (${_cols.join(',')}) SELECT ${_cols.join(',')} FROM cases`);
    db.exec(`DROP TABLE cases`);
    db.exec(`ALTER TABLE _cases_output_fix RENAME TO cases`);
    db.exec(`PRAGMA foreign_keys=ON`);
    console.log('✅ case_type CHECK 約束已修復（補上 material_sale）');
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

// ── 公司公告（簽核引擎：發佈→指定→閱讀/簽名→簽收追蹤）──────────
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT NOT NULL,
    content           TEXT,
    require_signature INTEGER DEFAULT 0,   -- 1=需手寫簽名, 0=只需已讀
    force_on_login    INTEGER DEFAULT 0,   -- 1=必讀/必簽, 登入強制（保留，後續啟用）
    audience_type     TEXT DEFAULT 'all',  -- all | users
    active            INTEGER DEFAULT 1,
    org_id            INTEGER REFERENCES orgs(id),
    created_by        INTEGER REFERENCES users(id),
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS announcement_recipients (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    announcement_id   INTEGER NOT NULL REFERENCES announcements(id),
    user_id           INTEGER NOT NULL REFERENCES users(id),
    read_at           DATETIME,
    signed_at         DATETIME,
    signature         TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(announcement_id, user_id)
  );
`);

// ── 客服關懷紀錄（每個案件可多筆，保留完整歷史）──────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS case_care_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    cs_user_id  INTEGER REFERENCES users(id),   -- 哪位客服人員處理
    action      TEXT,                            -- 處理事項：message(訊息)/call(電聯)/other
    memo        TEXT,                            -- 備註 Memo
    created_by  INTEGER REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
_addCol('case_care_logs', 'next_follow_up', 'TEXT');  // 下次關懷時間(YYYY-MM-DD)，到期顯示在該客服「我的任務」

// ── 自訂處理狀態標籤（內建 4 個寫死，這裡只存客服自訂的）────────
db.exec(`
  CREATE TABLE IF NOT EXISTS case_intent_tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL UNIQUE,
    sort_order  INTEGER DEFAULT 0,
    active      INTEGER DEFAULT 1,
    created_by  INTEGER REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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

// ── 請購單（辦公用品／耗材採購申請；與膜料採購 purchase_orders 不同）──────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS purchase_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id         INTEGER REFERENCES orgs(id),
    user_id        INTEGER NOT NULL REFERENCES users(id),
    title          TEXT,
    need_date      DATE,
    status         TEXT DEFAULT 'draft',
    est_total      REAL DEFAULT 0,
    actual_total   REAL DEFAULT 0,
    reviewer_id    INTEGER REFERENCES users(id),
    reviewed_at    DATETIME,
    review_note    TEXT,
    reject_reason  TEXT,
    rejected_by    INTEGER REFERENCES users(id),
    rejected_at    DATETIME,
    purchaser_id   INTEGER REFERENCES users(id),
    purchasing_at  DATETIME,
    received_at    DATETIME,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();
db.prepare(`
  CREATE TABLE IF NOT EXISTS purchase_request_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    quantity     REAL DEFAULT 1,
    unit         TEXT,
    est_price    REAL,
    actual_price REAL,
    note         TEXT,
    sort_order   INTEGER DEFAULT 0
  )
`).run();

// ── 廠商資料表 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,
    category          TEXT,
    contact           TEXT,
    phone             TEXT,
    email             TEXT,
    address           TEXT,
    bank_name         TEXT,
    bank_account      TEXT,
    bank_branch       TEXT,
    bank_account_name TEXT,
    payment_terms     TEXT,
    notes             TEXT,
    active            INTEGER DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
_addCol('vendors', 'bank_name',         'TEXT DEFAULT NULL');
_addCol('vendors', 'bank_account',      'TEXT DEFAULT NULL');
_addCol('vendors', 'bank_branch',       'TEXT DEFAULT NULL');
_addCol('vendors', 'bank_account_name', 'TEXT DEFAULT NULL');
_addCol('vendors', 'payment_terms',     'TEXT DEFAULT NULL');
_addCol('vendors', 'email',             'TEXT DEFAULT NULL');
_addCol('vendors', 'address',           'TEXT DEFAULT NULL');
_addCol('vendors', 'category',          "TEXT DEFAULT 'other'");

// ── 協力外包（非簽約外包人力）────────────────────────────────────
// 狀態不存欄位，由 work_date vs 今天 + paid_at 動態判斷（待施工/已完工待付款/已完工已付款）
db.exec(`
  CREATE TABLE IF NOT EXISTS subcontract_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id        INTEGER REFERENCES orgs(id),
    case_id       INTEGER REFERENCES cases(id),
    category      TEXT,
    worker        TEXT,
    vendor        TEXT,
    work_date     DATE,
    hours         REAL,
    staff_amount  REAL,
    owner_cost    REAL,
    paid_at       DATE,
    paid_by       INTEGER REFERENCES users(id),
    note          TEXT,
    created_by    INTEGER REFERENCES users(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subcontract_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS subcontract_workers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1
  );
`);
// 預設外包類別（只在空的時候 seed）
if (!db.prepare(`SELECT id FROM subcontract_categories LIMIT 1`).get()) {
  const insSc = db.prepare(`INSERT INTO subcontract_categories (name, sort_order) VALUES (?, ?)`);
  ['貼膜','油漆','矽利康','拆除','清潔'].forEach((n, i) => insSc.run(n, i));
}

// ── 膜料使用紀錄（領用→歸檔；倉管審核）────────────────────────────
// 狀態：pending_pickup待領用審核 / picked已領用 / pending_return待歸檔審核 / archived已歸檔 / rejected已駁回
// 第一階段純紀錄，不動 material_rolls 庫存（歸檔實扣為第二階段）
db.exec(`
  CREATE TABLE IF NOT EXISTS material_requisitions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id          INTEGER REFERENCES orgs(id),
    material_label  TEXT,
    material_id     INTEGER REFERENCES materials(id),
    roll_id         INTEGER REFERENCES material_rolls(id),
    case_id         INTEGER REFERENCES cases(id),
    purpose         TEXT,
    est_meters      REAL,
    est_usage_meters REAL,
    actual_meters   REAL,
    remaining_meters REAL,
    archive_location TEXT,
    purpose_code    TEXT,
    needs_return    INTEGER DEFAULT 0,
    cat_add         REAL,
    cat_loss        REAL,
    cat_recut       REAL,
    cat_redo        REAL,
    cat_wrongmat    REAL,
    cat_other_note  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending_pickup',
    note            TEXT,
    applicant_id        INTEGER REFERENCES users(id),
    applied_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    pickup_approver_id  INTEGER REFERENCES users(id),
    pickup_approved_at  DATETIME,
    returned_at         DATETIME,
    archive_approver_id INTEGER REFERENCES users(id),
    archived_at         DATETIME,
    reject_note     TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
_addCol('material_requisitions', 'cat_redo', 'REAL');  // 料差原因（既有DB補欄）
_addCol('material_requisitions', 'purpose_code',   'TEXT');
_addCol('material_requisitions', 'needs_return',   'INTEGER DEFAULT 0');
_addCol('material_requisitions', 'cat_wrongmat',   'REAL');
_addCol('material_requisitions', 'cat_other',      'REAL');
_addCol('material_requisitions', 'cat_other_note', 'TEXT');
_addCol('material_requisitions', 'est_usage_meters', 'REAL');  // 領用時預計使用米數（既有DB補欄，漏補會讓送出領用單502）

// 依名稱關鍵字自動補上分類（只補尚未分類的，包在 try-catch 避免欄位不存在時崩潰）
try {
  db.prepare(`UPDATE vendors SET category='logistics'  WHERE (category IS NULL OR category='other') AND (name LIKE '%物流%' OR name LIKE '%快遞%' OR name LIKE '%便利袋%' OR name LIKE '%大榮%' OR name LIKE '%順豐%' OR name LIKE '%郵寄%' OR name LIKE '%Lalamove%' OR name LIKE '%i郵箱%')`).run();
  db.prepare(`UPDATE vendors SET category='government' WHERE (category IS NULL OR category='other') AND (name LIKE '%健保%' OR name LIKE '%勞保%' OR name LIKE '%保險%' OR name LIKE '%保全%' OR name LIKE '%政府%' OR name LIKE '%國稅局%')`).run();
  db.prepare(`UPDATE vendors SET category='expense'    WHERE (category IS NULL OR category='other') AND (name LIKE '%電信%' OR name LIKE '%電力%' OR name LIKE '%郵政%' OR name LIKE '%中華電%' OR name LIKE '%台灣電%' OR name LIKE '%網路%')`).run();
} catch (e) { console.warn('[vendor category migration]', e.message); }

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
// 採購單膜料寬度（公分）
_addCol('purchase_orders', 'width_cm', 'REAL');

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

if (_needCatV3 && !_catsFrozen) {
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

if (_needCatV6 && !_catsFrozen) {
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

if (_needCatV7 && !_catsFrozen) {
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

// ── 收入科目調整（v10：加「車體施工」、「外快施工」改名「外快案」）──────
// 皆 idempotent：全新 DB 與既有正式站重複執行都安全
// 凍結後跳過（使用者已自訂科目名稱，避免在此補建出無「收入」後綴的重複科目）
if (!_catsFrozen) {
  // 1) 新增收入科目（不存在才加）：車體施工、飯店貼膜
  const _addIncomeCat = (name) => {
    if (!db.prepare(`SELECT id FROM ledger_categories WHERE name=? LIMIT 1`).get(name)) {
      const _ord = db.prepare(`SELECT COALESCE(MAX(sort_order),0) m FROM ledger_categories WHERE section='income'`).get().m;
      db.prepare(`INSERT INTO ledger_categories (type, section, name, sort_order, active, sensitive) VALUES ('income','income',?,?,1,0)`).run(name, _ord + 1);
      console.log(`✅ v10：新增收入科目「${name}」`);
    }
  };
  _addIncomeCat('車體施工');
  _addIncomeCat('飯店貼膜');
  _addIncomeCat('學校');
  _addIncomeCat('政府/醫療');
  // 2) 「外快施工」改名「外快案」；同步更新既有流水帳的分類字串（避免舊帳變孤兒）
  if (db.prepare(`SELECT id FROM ledger_categories WHERE name='外快施工' LIMIT 1`).get()) {
    db.exec(`UPDATE ledger_categories SET name='外快案' WHERE name='外快施工'`);
    db.exec(`UPDATE ledger_entries    SET category='外快案' WHERE category='外快施工'`);
    console.log('✅ v10：收入科目改名「外快施工」→「外快案」（含既有帳目）');
  }
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
// ⚠️ 必須保留「migration 判斷標記科目」：這些舊科目被當作 _needCatReset/V2/V3/V4/V6/Academy
//    的 !exists 判斷依據，一旦被刪，對應舊 migration 會誤判「沒跑過」而重跑、把科目洗回舊版（惡性循環）。
//    故排除這些標記名稱（保留為 active=0，讓判斷恆為「已跑過」）。
const _catMarkers = [
  '施工服務收入', '裝漠貼膜施工收入', '裝潢貼膜施工-Para',
  '連工帶料收入', '實體銷售', '居家施工', '學院-課程費',
];
const _needCatV9 = !!db.prepare(`SELECT id FROM ledger_categories WHERE active=0 AND name NOT IN (${_catMarkers.map(()=>'?').join(',')}) LIMIT 1`).get(..._catMarkers);
if (_needCatV9) {
  const { changes } = db.prepare(`DELETE FROM ledger_categories WHERE active=0 AND name NOT IN (${_catMarkers.map(()=>'?').join(',')})`).run(..._catMarkers);
  console.log(`✅ 停用科目已刪除（v9，共 ${changes} 筆；保留標記科目）`);
}

// ── 收入科目補正（v11）──────────────────────────────────────────
// 必須放在 v9「刪除 active=0」之後：先前部署曾發生新科目被某 migration 停用後被 v9 刪掉。
// 此區塊在最後重新「確保存在＋啟用」並統一排序，後面已無刪除科目邏輯，保證存活。
// 凍結後（使用者已自訂科目）整段跳過，不覆蓋使用者的命名/排序。
if (!_catsFrozen) {
  // 正規收入科目（依顯示順序）：確保「存在＋啟用＋section/type 正確＋排序」
  const incomeOrder = ['居家施工','商空施工','建案/建設公司','飯店貼膜','學校','政府/醫療','電梯施工','玻璃施工','車體施工','輸出施工','外快案','外包施工','其他施工','實體銷售','電商銷售','貼膜學院-課程費','貼膜學院-材料銷售','貼膜學院-認證考試','場勘費','設計費','樣本費','膜料本','其他收入'];
  const _find = db.prepare(`SELECT id FROM ledger_categories WHERE name=? LIMIT 1`);
  const _updI = db.prepare(`UPDATE ledger_categories SET active=1, section='income', type='income', sort_order=? WHERE id=?`);
  const _insI = db.prepare(`INSERT INTO ledger_categories (type,section,name,sort_order,active,sensitive) VALUES ('income','income',?,?,1,0)`);
  incomeOrder.forEach((name, i) => { const ex = _find.get(name); if (ex) _updI.run(i + 1, ex.id); else _insI.run(name, i + 1); });

  // 停用所有舊版/重複的收入科目（含 migration 標記科目）。標記科目由 v9 保留列存在、此處停用，
  // 使 _needCatReset/V2/V3/V4/Academy 永遠判定「已跑過」，舊 migration 不再重跑、不再洗回舊科目。
  const legacyIncome = [
    '連工帶料收入','施工服務收入','裝漠貼膜施工收入','裝潢貼膜施工-Para',
    '裝漠貼膜-bodaq','裝漠貼膜-LG','裝漠貼膜-3M','裝漠貼膜-PAROI','裝漠貼膜-保護膜','裝漠貼膜-其他',
    '電梯貼膜-改色','電梯貼膜-保護膜','電梯貼膜-改色貼膜','電梯貼膜-保護貼膜',
    '車體貼膜','車體貼膜施工收入','廣告輸出-自產','廣告輸出-外包','廣告輸出收入',
    '玻璃膜施工','玻璃貼膜施工收入','隔熱紙施工','防爆膜','其他施工服務收入','施工代工',
    '銷售膜料-bodaq','銷售膜料-LG','銷售膜料-3M','銷售膜料-翰可','銷售膜料-隔熱紙','銷售膜料-其他','膜料實體銷售',
    'DS彩貼','穩得','調控薄膜','無框畫',
    '學院-課程費','學院-材料銷售','學院-認證考試','學院-其他',
  ];
  const _deact = db.prepare(`UPDATE ledger_categories SET active=0 WHERE name=? AND section='income'`);
  legacyIncome.forEach(n => _deact.run(n));
  console.log('✅ 收入科目補正完成（v11：啟用正規 23 科目＋排序、停用舊重複科目）');
}

// 首次完整建立科目後，設定凍結旗標：之後部署不再 seed/重建科目，交由使用者於 UI 自訂。
if (!_catsFrozen) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ledger_cats_frozen', '1')`).run();
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
_addCol('quote_sheet_items', 'size_text',    'TEXT'); // 報價單/場勘用的單一「尺寸規格」文字欄(才數計算才用寬×高,報價單用文字即可)

// ── 報價單 v2 重建：品項欄位 ──────────────────────────────────────────────
// 計價方式：unit=座計價(單價×數量) / cai=才數計價(才數×單價/才) / material=材料販售(每米×米數)
_addCol('quote_sheet_items', 'calc_mode',      "TEXT DEFAULT 'unit'");
_addCol('quote_sheet_items', 'unit_price_cai', 'REAL');            // 單價/才(才數計價用；座計價的建議報價參考單價也存這)
_addCol('quote_sheet_items', 'item_disc',      'REAL DEFAULT 100'); // 逐項折扣 %(100=不折，舊資料不受影響)
_addCol('quote_sheet_items', 'promo_price',    'REAL');            // 逐項優惠價(折後)
_addCol('quote_sheet_items', 'area_photos',    "TEXT DEFAULT '[]'"); // 現場貼膜照多張(JSON array of url)；沿用 area_photo_url 為主圖
_addCol('quote_sheet_items', 'row_kind',       "TEXT DEFAULT 'item'"); // item=品項 / text=自由文字列
_addCol('quote_sheet_items', 'suggested_price','REAL');            // 客服內部估價的建議報價(參考，內部)
_addCol('quote_sheet_items', 'workers',        'INTEGER');         // 內部成本：人數
_addCol('quote_sheet_items', 'work_days',      'INTEGER');         // 內部成本：天數

// ── 報價單範本（骨架）：只存報價品項內容，不含客戶/案件資料，可存多種版本（電梯/門片…）
db.exec(`
  CREATE TABLE IF NOT EXISTS quote_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    items_json  TEXT NOT NULL DEFAULT '[]',
    item_count  INTEGER DEFAULT 0,
    created_by  INTEGER REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// 範本也可連同報價單底部文字（a/b/c/d 條款 + 帶入的圖片）一起存
_addCol('quote_templates', 'blocks_json', "TEXT DEFAULT '{}'");

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

// ── 報價單 v2 重建：報價主表欄位 ─────────────────────────────────────────
_addCol('quote_sheets', 'mkt_mode',    "TEXT DEFAULT 'pct'"); // 行銷優惠(PAROI)：pct=再打折 / amt=再折抵金額
_addCol('quote_sheets', 'mkt_value',   'REAL');               // 行銷優惠數值(pct:90=9折 / amt:金額)；空=不套用
_addCol('quote_sheets', 'flex_deducts','TEXT DEFAULT \'[]\''); // 彈性折抵 JSON: [{label,amount}]（預付金折抵走 client_deposits）
_addCol('quote_sheets', 'notes_notice',      'TEXT');         // 貼膜前須知(整單層級，可套範本)
_addCol('quote_sheets', 'notes_inspection',  'TEXT');         // 驗收須知
_addCol('quote_sheets', 'engine',      "TEXT DEFAULT 'v1'");  // v1=舊算法 / v2=逐項優惠+行銷優惠+折抵(重建版)
_addCol('quote_sheets', 'day_rate',    'REAL DEFAULT 2800');  // 內部成本：每人天日薪(v2)
_addCol('quote_sheets', 'client_viewed_at', 'DATETIME');     // 客戶首次開啟報價單連結的時間（列表顯示「客戶已打開」）
_addCol('quote_sheets', 'block_images', "TEXT DEFAULT '{}'"); // 各條款區塊附圖 JSON：{terms:[url],notice:[],inspection:[],acceptance:[銀行帳號圖]}
_addCol('quote_sheets', 'party_json', 'TEXT'); // 本報價單客戶/案場覆寫(per-quote 快照，不動 clients/cases 母檔)：{client_name,client_tax_id,client_contact,client_phone,site_address,site_note}
_addCol('quote_sheets', 'no_invoice', 'INTEGER DEFAULT 0'); // 1=不開發票（免 5% 稅金，應付＝未稅金額）
_addCol('quote_sheets', 'short_url',  'TEXT'); // 客戶連結短網址（複製連結時產生並快取）

// ── 報價單條款/須知範本：擴充成四大區塊都能套範本，並可帶一張圖(如(d)銀行帳號圖)──
_addCol('film_notice_templates', 'block',     "TEXT DEFAULT 'notice'"); // terms(a)/notice(b)/inspection(c)/acceptance(d)
_addCol('film_notice_templates', 'image_url', 'TEXT');                    // 範本附圖（例：回簽/付款區塊的銀行帳號圖）
_addCol('film_notice_templates', 'is_default', 'INTEGER DEFAULT 0');      // 每個 block 的預設範本（套範本時預先勾選）

// ── 甲方（總部）公司抬頭：統編／地址／電話，供報價確認單顯示 ──────────────
_addCol('orgs', 'tax_id', 'TEXT'); // 統一編號
try {
  // 補齊總部(hq)的公司抬頭資訊；只在欄位為空時填入，不覆蓋既有設定
  db.prepare(`UPDATE orgs SET
      tax_id  = COALESCE(NULLIF(tax_id,''),  ?),
      address = COALESCE(NULLIF(address,''), ?),
      phone   = COALESCE(NULLIF(phone,''),   ?)
    WHERE type='hq'`)
    .run('45917816', '新北市鶯歌區中山路166巷2號', '02-8678-1229');
} catch (e) { /* non-critical */ }

// ── 報價單 v2：貼膜前須知範本種子(若空)──────────────────────────────────
try {
  const _cnt = db.prepare(`SELECT COUNT(*) n FROM film_notice_templates`).get().n;
  if (!_cnt) {
    const _ins = db.prepare(`INSERT INTO film_notice_templates (name,category,content,sort_order) VALUES (?,?,?,?)`);
    ([
      ['裝潢膜 · 一般','裝潢膜','1. 複雜物件需多張搭接（約 3–5mm 搭接痕），轉角處做 45 度斜刀。\n2. 寬幅超過 120cm 僅能交疊拼接（大圖輸出貼法）。\n3. 表面平整度由客戶自行處理；亮面材質建議張貼面 100% 平坦。\n4. 不含補土打磨、不含矽利康收邊。',1],
      ['玻璃／隔熱紙','玻璃隔熱紙','1. 玻璃須先清潔乾淨，施工後 3 天內請勿擦拭或碰水。\n2. 貼膜後短期內可能有水氣霧感，屬正常現象，約 1–2 週自然消散。\n3. 邊緣預留約 1–2mm 退邊，避免翹邊。',2],
      ['電梯','電梯','1. 施工需配合大樓管委會核准之停梯時段，當日請電梯專業人員協助操控。\n2. 轎廂面板轉角、按鈕面板邊緣做細部收邊。\n3. 施工期間電梯暫停使用，請事先公告住戶。\n4. 不含範圍：不鏽鋼壓條／防撞條／地板／鏡子／按鍵面板。',3],
      ['汽車隔熱紙','汽車隔熱紙','1. 施工後 3–7 天內請勿升降車窗，避免膜料位移。\n2. 短期內玻璃可能出現水霧或小水泡，屬正常乾燥現象。\n3. 清潔請用軟布與中性清潔劑，勿用含氨清潔劑。',4],
    ]).forEach(t => _ins.run(t[0],t[1],t[2],t[3]));
    console.log('🌱 已建立貼膜前須知範本種子 4 筆');
  }
} catch (e) { console.warn('須知範本種子略過:', e.message.slice(0,80)); }

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
// 是否上電商（要不要跟電商平台連動數字）；既有用 ec_key 對接過的型號自動回填為 1
_addCol('materials', 'on_ecommerce',  'INTEGER DEFAULT 0');
try { db.prepare(`UPDATE materials SET on_ecommerce=1 WHERE ec_key IS NOT NULL AND TRIM(ec_key)!='' AND (on_ecommerce IS NULL OR on_ecommerce=0)`).run(); } catch (e) {}

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

// ── hq_tech 角色預設權限（技術人員合理最小化）────────────────────────────
{
  const HQ_TECH_PERMS = {
    page_dashboard:     false,
    page_cases:         false,
    page_line_inquiries:false,
    page_clients:       false,
    page_calendar:      true,   // 派單行事曆：看自己的派工
    page_payments:      false,
    page_ledger:        false,
    page_expenses:      true,   // 費用申請
    page_dispatch_pool: false,
    page_cases_deal:    false,
    page_materials:     false,
    page_material_calc: false,
    page_performance:   false,
    page_reports:       false,
    page_marketing:     false,
    my_tasks:           true,   // 我的任務
  };
  const existing = db.prepare(`SELECT role_value FROM role_defaults WHERE role_value='hq_tech'`).get();
  if (!existing) {
    db.prepare(`INSERT INTO role_defaults (role_value, default_perms) VALUES ('hq_tech', ?)`)
      .run(JSON.stringify(HQ_TECH_PERMS));
    console.log('✅ hq_tech 角色預設權限已設定');
  }
}

// ── 登入 Session 日誌 ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS login_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    login_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_at        DATETIME DEFAULT NULL,
    duration_seconds INTEGER DEFAULT NULL,
    ip               TEXT DEFAULT NULL
  );
`);

// ── cases 修改人追蹤 ────────────────────────────────────────────────────────────
_addCol('cases', 'updated_by', 'INTEGER REFERENCES users(id)');

// ── 發票開立記錄 ────────────────────────────────────────────────────────────────
_addCol('cases', 'invoice_issued',      'INTEGER DEFAULT 0');
_addCol('cases', 'invoice_issued_date', 'DATE DEFAULT NULL');

// ── 行銷優惠折抵（如 Google 好評折抵，不影響發票金額）────────────────────────
_addCol('cases', 'marketing_discount', 'INTEGER DEFAULT 0');

// ── 採購單關聯案件 ───────────────────────────────────────────────────────────
_addCol('purchase_orders', 'case_id', 'INTEGER REFERENCES cases(id)');

// ── 到貨登記：貨運公司 / 稅金(純備註不進帳) / 運費 ───────────────────────────
_addCol('purchase_receipts', 'carrier',        'TEXT');
_addCol('purchase_receipts', 'tax',            'REAL');
_addCol('purchase_receipts', 'shipping_fee',   'REAL');
_addCol('purchase_receipts', 'payment_method', 'TEXT');  // 運費/貨款付款方式（到貨時填）
_addCol('purchase_receipts', 'payer_id',       'INTEGER'); // 付款人（零用金墊付者，到貨時填）
_addCol('cases',             'purchase_tax_cost', 'REAL DEFAULT NULL'); // 該案採購到貨稅金加總（計入成本/毛利）
_addCol('cases',             'purchase_shipping_cost', 'REAL DEFAULT NULL'); // 該案採購到貨運費加總（計入成本/毛利）

// ── 採購單：通知訂貨人 + 訂貨狀態（與到貨狀態獨立）───────────────────────────
_addCol('purchase_orders', 'ordered_by',   'INTEGER REFERENCES users(id)');  // 指派的訂貨人
_addCol('purchase_orders', 'order_status', "TEXT DEFAULT 'pending'");          // pending=待訂貨 / ordered=已訂貨
_addCol('purchase_orders', 'ordered_at',   'DATETIME');                        // 訂貨人確認時間

// ── 預收款會計核銷欄位 + 場勘費關聯案件 ─────────────────────────────────────
_addCol('client_deposits', 'linked_case_id',         'INTEGER REFERENCES cases(id)');
_addCol('client_deposits', 'accounting_verified',    'INTEGER DEFAULT 0');
_addCol('client_deposits', 'accounting_verified_at', 'TEXT');
_addCol('client_deposits', 'accounting_verified_by', 'INTEGER REFERENCES users(id)');

// ── 案件往來文件（報價單、合約等） ───────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS case_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL DEFAULT 'quote'
              CHECK(doc_type IN ('quote','contract','other')),
  filename    TEXT NOT NULL,
  file_url    TEXT NOT NULL,
  public_id   TEXT,
  notes       TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── 申訴及意見回饋 ────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS feedback_tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  category   TEXT NOT NULL DEFAULT 'feedback',
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS feedback_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── 寄件管理 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shipments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    shipped_at        TEXT,
    client_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_name       TEXT,
    line_id_name      TEXT,
    case_id           INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    recipient_name    TEXT,
    recipient_phone   TEXT,
    postal_code       TEXT,
    recipient_address TEXT,
    recipient_note    TEXT,
    content           TEXT,
    tracking_no       TEXT,
    carrier           TEXT,
    org_id            INTEGER REFERENCES orgs(id),
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
_addCol('users', 'can_ship', 'INTEGER DEFAULT 0');
_addCol('users', 'can_layout', 'INTEGER DEFAULT 0');   // 排版工具權限（可開給學員/經銷商）
_addCol('users', 'clock_exempt', 'INTEGER DEFAULT 0'); // 免打卡（測試/特殊帳號；老闆/副總/外包另由角色自動免）

// ── 排版工具：專案（整包資料以 JSON 存）────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS layout_projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER REFERENCES orgs(id),
    name        TEXT NOT NULL,
    data        TEXT,                         -- JSON: { materials, areas, settings, layouts }
    archived    INTEGER DEFAULT 0,
    created_by  INTEGER REFERENCES users(id),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
_addCol('client_deposits', 'verify_signature',   'TEXT DEFAULT NULL');
_addCol('client_deposits', 'owner_confirmed',    'INTEGER DEFAULT 0');
_addCol('client_deposits', 'owner_confirmed_at', 'DATETIME DEFAULT NULL');
_addCol('client_deposits', 'owner_confirmed_by', 'INTEGER DEFAULT NULL');
_addCol('client_deposits', 'owner_signature',    'TEXT DEFAULT NULL');
// 核銷款項流向勾稽：經手人(現金 給誰)／入帳帳戶(匯款)／其他收款狀況
_addCol('client_deposits', 'settle_handler',     'TEXT DEFAULT NULL');
_addCol('client_deposits', 'settle_account',     'TEXT DEFAULT NULL');
_addCol('client_deposits', 'settle_note',        'TEXT DEFAULT NULL');

// ── 缺失管理 ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS deficiencies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id       INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    type          TEXT NOT NULL DEFAULT 'other'
                  CHECK(type IN ('missing_material','lost_tool','construction_damage','other')),
    title         TEXT NOT NULL,
    description   TEXT,
    damage_amount REAL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','in_review','resolved')),
    org_id        INTEGER REFERENCES orgs(id),
    created_by    INTEGER REFERENCES users(id),
    resolved_at   DATETIME,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS deficiency_persons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    deficiency_id   INTEGER NOT NULL REFERENCES deficiencies(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    acknowledged_at DATETIME,
    improvement     TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(deficiency_id, user_id)
  )
`);
// 嘉獎缺失：類別(reward/penalty)、等級、考核分數（須在 CREATE TABLE 之後）
_addCol('deficiencies', 'category', "TEXT DEFAULT 'penalty'");  // reward | penalty
_addCol('deficiencies', 'level',    'TEXT DEFAULT NULL');        // 嘉獎/小功/大功 ‧ 警告/申誡/小過/大過
_addCol('deficiencies', 'points',   'REAL DEFAULT 0');           // 考核分數
// 嘉獎/懲罰原因（可手動新增，依類別）
db.exec(`
  CREATE TABLE IF NOT EXISTS rp_reasons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,   -- reward | penalty
    label      TEXT NOT NULL,
    org_id     INTEGER REFERENCES orgs(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category, label)
  );
`);

// 追款提醒日
_addCol('cases', 'followup_date', 'DATE DEFAULT NULL');

// 派工人工成本（從 hours × daily_cost 自動計算）
_addCol('cases', 'labor_cost', 'REAL');
// 派工膜料成本（從 dispatch_materials 自動計算，獨立於報價材料成本）
_addCol('cases', 'dispatch_material_cost', 'REAL');
_addCol('assets', 'location', 'TEXT DEFAULT NULL');

// 補算所有施工派工的人工成本（含歷史資料）
try {
  const _cases = db.prepare(`SELECT DISTINCT case_id FROM dispatches WHERE dispatch_type='install'`).all();
  const _updD = db.prepare(`UPDATE dispatches SET labor_cost=? WHERE id=?`);
  const _updC = db.prepare(`UPDATE cases SET labor_cost=? WHERE id=?`);
  _cases.forEach(({ case_id }) => {
    const _rows = db.prepare(`
      SELECT d.id,
        COALESCE(d.actual_hours, d.estimated_hours, 0) AS hrs,
        COALESCE(SUM(u.daily_cost), 0) AS total_daily_cost
      FROM dispatches d
      LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
      LEFT JOIN users u ON u.id = du.user_id
      WHERE d.case_id=? AND d.dispatch_type='install'
      GROUP BY d.id
    `).all(case_id);
    let _total = 0;
    _rows.forEach(r => {
      const cost = (r.hrs > 0 && r.total_daily_cost > 0)
        ? Math.round(r.total_daily_cost * r.hrs / 8.0 * 100) / 100 : null;
      _updD.run(cost, r.id);
      if (cost) _total += cost;
    });
    _updC.run(_total || null, case_id);
  });
} catch(e) { console.warn('[labor_cost backfill]', e.message); }

// 補算所有案件的膜料成本（dispatch_materials + material_logs 兩個來源）
try {
  const _matCaseIds = new Set([
    ...db.prepare(`SELECT DISTINCT case_id FROM dispatch_materials WHERE case_id IS NOT NULL`).all().map(r => r.case_id),
    ...db.prepare(`SELECT DISTINCT case_id FROM material_logs WHERE case_id IS NOT NULL AND log_type IN ('case_cut','case_loss')`).all().map(r => r.case_id),
  ]);
  _matCaseIds.forEach(case_id => {
    const fromD = db.prepare(`SELECT COALESCE(SUM(meters_used * unit_cost), 0) AS t FROM dispatch_materials WHERE case_id=?`).get(case_id).t || 0;
    const fromL = db.prepare(`SELECT COALESCE(SUM(ABS(ml.meters) * mr.unit_cost), 0) AS t FROM material_logs ml LEFT JOIN material_rolls mr ON mr.id=ml.roll_id WHERE ml.case_id=? AND ml.log_type IN ('case_cut','case_loss') AND ml.status!='cancelled' AND mr.unit_cost IS NOT NULL`).get(case_id).t || 0;
    db.prepare(`UPDATE cases SET dispatch_material_cost=? WHERE id=?`).run((fromD + fromL) || null, case_id);
  });
} catch(e) { console.warn('[dispatch_material_cost backfill]', e.message); }

// ── 估價價目表（預設值可由「價目設定後台」手動修改；空表才 seed，不覆蓋使用者改動）──
db.exec(`
  CREATE TABLE IF NOT EXISTS est_films (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grp_key TEXT, grp_label TEXT, origin TEXT, width INTEGER, flat_price INTEGER DEFAULT 0,
    sys TEXT, per_m REAL, plane REAL, cabinet REAL, shape REAL,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS est_glass (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cat_key TEXT, cat_label TEXT, sys TEXT,
    owner_price REAL, designer_price REAL, width INTEGER DEFAULT 122, roll_len REAL DEFAULT 50,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS est_doors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    door_key TEXT, label TEXT, frame_only INTEGER DEFAULT 0,
    origin TEXT, layers TEXT, opt INTEGER, price REAL,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS est_freight (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT UNIQUE, amount REAL,
    survey_fee REAL DEFAULT 0, overnight_fee REAL DEFAULT 0, night_surcharge REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  );
`);
// 既有 DB 補車馬費 4 欄（_addCol 須在 CREATE TABLE 之後；同步寫進上方 CREATE TABLE 定義，全新 DB 才不缺欄）
_addCol('est_freight', 'survey_fee',      'REAL DEFAULT 0');
_addCol('est_freight', 'overnight_fee',   'REAL DEFAULT 0');
_addCol('est_freight', 'night_surcharge', 'REAL DEFAULT 0');
_addCol('est_glass',   'width',           'INTEGER DEFAULT 122'); // 玻璃膜寬（拼料用）
_addCol('est_glass',   'roll_len',        'REAL DEFAULT 50');     // 長度（米）
try {
  const _estSeed = require('./lib/estimator-seed');
  if (!db.prepare(`SELECT COUNT(*) n FROM est_films`).get().n) {
    const ins = db.prepare(`INSERT INTO est_films (grp_key,grp_label,origin,width,flat_price,sys,per_m,plane,cabinet,shape,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [gk, g] of Object.entries(_estSeed.FILMS))
      g.items.forEach(it => ins.run(gk, g.label, g.origin, g.width, g.flatPrice ? 1 : 0, it.sys, it.perM, it.plane, it.cabinet, it.shape, so++));
  }
  if (!db.prepare(`SELECT COUNT(*) n FROM est_glass`).get().n) {
    const ins = db.prepare(`INSERT INTO est_glass (cat_key,cat_label,sys,owner_price,designer_price,sort_order) VALUES (?,?,?,?,?,?)`);
    let so = 0;
    for (const [ck, c] of Object.entries(_estSeed.GLASS))
      c.items.forEach(it => ins.run(ck, c.label, it.sys, it.owner, it.designer, so++));
  }
  if (!db.prepare(`SELECT COUNT(*) n FROM est_doors`).get().n) {
    const ins = db.prepare(`INSERT INTO est_doors (door_key,label,frame_only,origin,layers,opt,price,sort_order) VALUES (?,?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [dk, d] of Object.entries(_estSeed.DOOR)) {
      if (d.frameOnly) {
        ins.run(dk, d.label, 1, 'kr', null, null, d.kr, so++);
        ins.run(dk, d.label, 1, 'jp', null, null, d.jp, so++);
      } else {
        for (const origin of ['kr', 'jp'])
          for (const layers of ['1', '2'])
            for (const opt of [0, 1])
              ins.run(dk, d.label, 0, origin, layers, opt, d[origin][layers][opt], so++);
      }
    }
  }
  if (!db.prepare(`SELECT COUNT(*) n FROM est_freight`).get().n) {
    const ins = db.prepare(`INSERT OR IGNORE INTO est_freight (region,survey_fee,amount,overnight_fee,night_surcharge,sort_order) VALUES (?,?,?,?,?,?)`);
    let so = 0;
    for (const [region, f] of Object.entries(_estSeed.FREIGHT)) ins.run(region, f.survey_fee, f.amount, f.overnight_fee, f.night_surcharge, so++);
  }
  // 一次性把車馬費 3 新欄真實牌價填進既有資料（旗標只跑一次；amount 既有值不動，不覆蓋使用者後續改動）
  if (!db.prepare(`SELECT 1 FROM settings WHERE key='est_freight_v2'`).get()) {
    const updFr = db.prepare(`UPDATE est_freight SET survey_fee=?, overnight_fee=?, night_surcharge=? WHERE region=?`);
    for (const [region, f] of Object.entries(_estSeed.FREIGHT)) updFr.run(f.survey_fee, f.overnight_fee, f.night_surcharge, region);
    db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES ('est_freight_v2','1')`).run();
  }
  db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES ('est_lowmin_owner',?)`).run(String(_estSeed.LOWMIN.owner));
  db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES ('est_lowmin_designer',?)`).run(String(_estSeed.LOWMIN.designer));
  console.log('✅ 估價價目表就緒（est_films/glass/doors/freight；空表才 seed 預設值，使用者改動不覆蓋）');
} catch (e) { console.warn('[est pricing seed]', e.message); }

// ── 估價「重設計版」真實牌價（新表，不動舊 est_films；CREATE TABLE IF NOT EXISTS 最安全）──
// est_film_catalog：裝潢膜 品牌×防焰×膜款，三種連工帶料每才價（plane牆面/cabinet系統櫃/shape造型）
// est_door_catalog：門 大門/房門/防火門 三類固定價
db.exec(`
  CREATE TABLE IF NOT EXISTS est_film_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT, asia_code TEXT, kr_code TEXT, color TEXT, model_note TEXT, fireproof TEXT DEFAULT '',
    per_m REAL DEFAULT 0, ecom_price REAL DEFAULT 0, cost_per_m REAL DEFAULT 0,
    plane REAL, cabinet REAL, shape REAL, width INTEGER DEFAULT 122, roll_len REAL DEFAULT 50,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS est_door_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cat TEXT, size TEXT, origin TEXT, side TEXT, frame TEXT, price REAL,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
`);
// 既有 DB 補欄（_addCol 須在 CREATE TABLE 之後；同步寫進上方 CREATE TABLE 定義）
_addCol('est_film_catalog', 'per_m',      'REAL DEFAULT 0');   // 未稅牌價/米（＝電商÷1.05；估價材料以此為準）
_addCol('est_film_catalog', 'ecom_price', 'REAL DEFAULT 0');   // 電商含稅牌價/米（整數進位50；折扣從此往下折）
_addCol('est_film_catalog', 'cost_per_m', 'REAL DEFAULT 0');   // 完全成本/米（機密，只老闆）
_addCol('est_film_catalog', 'fireproof',  "TEXT DEFAULT ''");  // 防焰／不防焰（連工帶料不分防焰）
_addCol('est_film_catalog', 'roll_len',   'REAL DEFAULT 50');  // 長度（米，1米=100cm）
_addCol('est_film_catalog', 'region',     "TEXT DEFAULT ''");  // 版本/產地：''=亞洲/一般、'韓國'=韓版（各自獨立列、獨立價）

// 韓版 BODAQ 另建一組（不防焰/防焰各自獨立列，值獨立；model_note＝對應亞洲碼備註）。一次性、_migrations 守衛。
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
try {
  const MIG = 'bodaq_kr_seed_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    // [韓版系列碼, 卷長, 不防焰含稅, 防焰含稅(0=無), 備註]
    const KR = [
      ['W/S/LS/LM',50,1050,1450,'對應亞洲 SS/BA'],['PTW/ZSW',50,1100,1500,'對應亞洲 BC'],
      ['ZX',50,1150,1500,'韓國限定'],['HS/RM',50,1250,1750,'對應亞洲 AA/SH'],['CP',50,1250,1750,'韓國限定'],
      ['SMT',50,1200,1550,'對應亞洲 ST'],['PNT',40,1250,1650,'對應亞洲 BT'],['PNC',40,1350,1700,'對應亞洲 AP'],
      ['NS',50,1200,1700,'對應亞洲 AA'],['SL',50,1250,1700,'韓國限定'],['SF',50,1250,1750,'韓國限定'],
      ['VM',50,1400,1800,'對應亞洲 AT'],['PM',50,1350,1800,'對應亞洲 AB'],['SPW',50,1350,1800,'對應亞洲 BM'],
      ['LW',50,1600,1900,'韓國限定'],['OGW',50,1600,0,'韓國限定'],['APZ',50,1600,2100,'韓國限定'],
      ['UMI',50,2100,0,'對應亞洲 AU'],['RF/NF',30,3150,3550,'對應亞洲 AF'],['EXF',50,2100,0,'韓國限定'],['ECF',50,2100,0,'韓國限定'],
    ];
    let so = db.prepare(`SELECT COALESCE(MAX(sort_order),0) n FROM est_film_catalog`).get().n;
    const ins = db.prepare(`INSERT INTO est_film_catalog (brand,region,asia_code,kr_code,color,model_note,fireproof,per_m,ecom_price,cost_per_m,plane,cabinet,shape,width,roll_len,sort_order,active) VALUES ('bodaq','韓國','',?,'',?,?,?,?,0,0,0,0,122,?,?,1)`);
    for (const [code, roll, nf, fp, note] of KR) {
      if (nf) { so++; ins.run(code, note, '不防焰', Math.round(nf/1.05), nf, roll, so); }
      if (fp) { so++; ins.run(code, note, '防焰',   Math.round(fp/1.05), fp, roll, so); }
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log('✅ 韓版 BODAQ 已建入 est_film_catalog（21 系列・不防焰/防焰各自獨立列）');
  }
} catch (e) { console.warn('[bodaq kr seed]', e.message); }

// 補韓版 BODAQ 花色 + 成本（成本＝未稅牌價×0.3，即以韓國膜目標毛利 70% 回推；老闆可再覆蓋真實進價成本）
try {
  const MIG = 'bodaq_kr_fill_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const COLOR = {
      'W/S/LS/LM':'素面／木紋','PTW/ZSW':'木紋','ZX':'木紋（限定）','HS/RM':'金屬／皮革','CP':'限定花色（待補）',
      'SMT':'超霧面','PNT':'木紋（油漆）','PNC':'塗料／水泥','NS':'金屬','SL':'限定花色（待補）','SF':'限定花色（待補）',
      'VM':'絨面金屬','PM':'大理石／石紋','SPW':'木紋','LW':'限定花色（待補）','OGW':'限定花色（待補）',
      'APZ':'限定花色（待補）','UMI':'炫彩幻彩','RF/NF':'真布紋','EXF':'限定花色（待補）','ECF':'限定花色（待補）',
    };
    const upC = db.prepare(`UPDATE est_film_catalog SET color=? WHERE region='韓國' AND kr_code=? AND (color IS NULL OR color='')`);
    for (const [code, col] of Object.entries(COLOR)) upC.run(col, code);
    // 成本回推：未稅牌價 × 0.3（70% 毛利）
    db.prepare(`UPDATE est_film_catalog SET cost_per_m=ROUND(per_m*0.3) WHERE region='韓國' AND (cost_per_m IS NULL OR cost_per_m=0)`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log('✅ 韓版 BODAQ 已補花色＋成本(70%毛利回推)');
  }
} catch (e) { console.warn('[bodaq kr fill]', e.message); }

// 韓版 BODAQ 重整：同價系列歸類成分組列（不防焰一組、防焰一組），從~38列縮成23列，較簡潔。成本＝未稅×0.3。
try {
  const MIG = 'bodaq_kr_regroup_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    db.prepare(`DELETE FROM est_film_catalog WHERE brand='bodaq' AND region='韓國'`).run();
    // [韓國碼(合併), 防焰, 電商含稅, 卷長, 花色, 備註]
    const G = [
      ['W/S/LS/LM','不防焰',1050,50,'素面／木紋','對應亞洲 SS/BA'],['PTW/ZSW','不防焰',1100,50,'木紋','對應亞洲 BC'],
      ['ZX','不防焰',1150,50,'木紋','韓國限定'],['SMT, NS','不防焰',1200,50,'超霧面／金屬','對應亞洲 ST/AA'],
      ['HS/RM, CP, SL, SF','不防焰',1250,50,'金屬／皮革（含限定）','對應 AA/SH；CP/SL/SF 限定'],['PNT','不防焰',1250,40,'木紋（油漆）','對應亞洲 BT'],
      ['PNC','不防焰',1350,40,'塗料／水泥','對應亞洲 AP'],['PM, SPW','不防焰',1350,50,'大理石／木紋','對應亞洲 AB/BM'],
      ['VM','不防焰',1400,50,'絨面金屬','對應亞洲 AT'],['LW, OGW, APZ','不防焰',1600,50,'限定花色（待補）','韓國限定'],
      ['UMI, EXF, ECF','不防焰',2100,50,'炫彩（含限定）','對應 AU；EXF/ECF 限定'],['RF/NF','不防焰',3150,30,'真布紋','對應亞洲 AF'],
      ['W/S/LS/LM','防焰',1450,50,'素面／木紋','對應亞洲 SS/BA'],['PTW/ZSW, ZX','防焰',1500,50,'木紋（含限定）','對應 BC；ZX 限定'],
      ['SMT','防焰',1550,50,'超霧面','對應亞洲 ST'],['PNT','防焰',1650,40,'木紋（油漆）','對應亞洲 BT'],
      ['NS, SL','防焰',1700,50,'金屬（含限定）','對應 AA；SL 限定'],['PNC','防焰',1700,40,'塗料／水泥','對應亞洲 AP'],
      ['HS/RM, CP, SF','防焰',1750,50,'金屬／皮革（含限定）','對應 AA/SH；CP/SF 限定'],['VM, PM, SPW','防焰',1800,50,'石紋／木紋／金屬','對應亞洲 AT/AB/BM'],
      ['LW','防焰',1900,50,'限定花色（待補）','韓國限定'],['APZ','防焰',2100,50,'限定花色（待補）','韓國限定'],['RF/NF','防焰',3550,30,'真布紋','對應亞洲 AF'],
    ];
    let so = db.prepare(`SELECT COALESCE(MAX(sort_order),0) n FROM est_film_catalog`).get().n;
    const ins = db.prepare(`INSERT INTO est_film_catalog (brand,region,asia_code,kr_code,color,model_note,fireproof,per_m,ecom_price,cost_per_m,plane,cabinet,shape,width,roll_len,sort_order,active) VALUES ('bodaq','韓國','',?,?,?,?,?,?,?,0,0,0,122,?,?,1)`);
    for (const [code, fp, ecom, roll, color, note] of G) {
      const perm = Math.round(ecom/1.05), cost = Math.round(perm*0.3);
      so++; ins.run(code, color, note, fp, perm, ecom, cost, roll, so);
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 韓版 BODAQ 已重整為 ${G.length} 分組列（同價歸類）`);
  }
} catch (e) { console.warn('[bodaq kr regroup]', e.message); }

// 統一成單一「系列/型號」欄：韓國對應碼併進備註，不再分亞洲碼/韓國碼兩欄（避免 PAROI/3M 空欄）
try {
  const MIG = 'film_code_unify_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    // 韓版：系列碼＝原韓國碼(kr_code)→移進 asia_code
    db.prepare(`UPDATE est_film_catalog SET asia_code=kr_code WHERE region='韓國' AND (asia_code IS NULL OR asia_code='') AND kr_code<>''`).run();
    // 亞洲/一般：韓國對應碼 kr_code→併進備註(model_note)
    db.prepare(`UPDATE est_film_catalog SET model_note = CASE WHEN model_note IS NULL OR model_note='' THEN '對應韓碼 '||kr_code ELSE model_note||'（韓碼 '||kr_code||'）' END WHERE (region IS NULL OR region='') AND kr_code<>''`).run();
    // 清空 kr_code（不再使用該欄）
    db.prepare(`UPDATE est_film_catalog SET kr_code='' WHERE kr_code<>''`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log('✅ 膜料代碼統一為單一系列欄（韓碼併入備註）');
  }
} catch (e) { console.warn('[film code unify]', e.message); }

// 連工帶料（元/才）依公式定義：系統櫃＝牌價/才+100、牆面＝牌價/才+70、造型＝牌價/才+125。牌價/才＝含稅牌價÷才數(寬×100/900)
try {
  const MIG = 'connect_work_formula_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const CAI = `ROUND((CASE WHEN ecom_price>0 THEN ecom_price ELSE per_m END)/(COALESCE(NULLIF(width,0),122)*100.0/900))`;
    db.prepare(`UPDATE est_film_catalog SET plane=${CAI}+70, cabinet=${CAI}+100, shape=${CAI}+125 WHERE brand IN ('bodaq','benif','paroi') AND (per_m>0 OR ecom_price>0)`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log('✅ 連工帶料已依公式重算（牆+70/櫃+100/造型+125）');
  }
} catch (e) { console.warn('[connect work formula]', e.message); }

// 3M 連工帶料：比韓/PAROI 公式每才再 +20 → 牆面+90、系統櫃+120、造型+145
try {
  const MIG = 'connect_work_3m_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const CAI = `ROUND((CASE WHEN ecom_price>0 THEN ecom_price ELSE ROUND(per_m*1.05/50)*50 END)/(COALESCE(NULLIF(width,0),122)*100.0/900))`;
    db.prepare(`UPDATE est_film_catalog SET plane=${CAI}+90, cabinet=${CAI}+120, shape=${CAI}+145 WHERE brand='3m' AND (per_m>0 OR ecom_price>0)`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log('✅ 3M 連工帶料已重算（牆+90/櫃+120/造型+145）');
  }
} catch (e) { console.warn('[connect work 3m]', e.message); }

// 連工帶料改用「牌價/才無條件進位到5」為基底重算（韓/PAROI；3M 照官方精確值不進位，維持不動）
try {
  const MIG = 'connect_work_round5_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const rows = db.prepare(`SELECT id,per_m,ecom_price,width FROM est_film_catalog WHERE brand IN ('bodaq','benif','paroi') AND (per_m>0 OR ecom_price>0)`).all();
    const upd = db.prepare(`UPDATE est_film_catalog SET plane=?,cabinet=?,shape=? WHERE id=?`);
    for (const r of rows) {
      const ecom = r.ecom_price > 0 ? r.ecom_price : Math.round(r.per_m * 1.05 / 50) * 50;
      const factor = (r.width || 122) * 100 / 900;
      const cai5 = Math.ceil((ecom / factor) / 5) * 5;   // 牌價/才 進位到5
      upd.run(cai5 + 70, cai5 + 100, cai5 + 125, r.id);
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 連工帶料改用「牌價/才進位到5」重算 ${rows.length} 筆（3M 不進位）`);
  }
} catch (e) { console.warn('[connect work round5]', e.message); }

// 進位精修：進位到5，但剛超過整十≤1就取整十（如151→150、140.1→140）。韓/PAROI；3M不進位
try {
  const MIG = 'connect_work_nice_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const nice = raw => { const f10 = Math.floor(raw/10)*10; return (raw - f10 <= 1) ? f10 : Math.ceil(raw/5)*5; };
    const rows = db.prepare(`SELECT id,per_m,ecom_price,width FROM est_film_catalog WHERE brand IN ('bodaq','benif','paroi') AND (per_m>0 OR ecom_price>0)`).all();
    const upd = db.prepare(`UPDATE est_film_catalog SET plane=?,cabinet=?,shape=? WHERE id=?`);
    for (const r of rows) {
      const ecom = r.ecom_price > 0 ? r.ecom_price : Math.round(r.per_m * 1.05 / 50) * 50;
      const cai = nice(ecom / ((r.width || 122) * 100 / 900));
      upd.run(cai + 70, cai + 100, cai + 125, r.id);
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 連工帶料進位精修完成 ${rows.length} 筆（151→150 型）`);
  }
} catch (e) { console.warn('[connect work nice]', e.message); }

// 3M 對齊官方牌價表(2026/5/1)：官方是「元/才、未稅」。牌價/才＝官方值；連工帶料＝官方+90/120/145；成本＝牌價×0.8
try {
  const MIG = '3m_official_price_2026_05';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const OFF = { AE:170,'AE-MT':235,AM:385,AR:235,CA:235,CH:160,CN:235,'DW-MT':205,ET:460,EX:300,FA:220,FE:235,FW:155,HG:235,HS:235,LE:235,LW:235,LZ:235,ME:160,'ME-MT':235,MW:235,NU:190,'NU-MT':235,PA:155,PC:235,PG:235,PS:140,'PS-MT':235,'PS-MTRC':235,PT:235,'PW-MT':265,RS:235,RT:235,SE:235,SI:235,ST:215,'ST-MT':235,'SU-MT':235,TE:235,VM:375,'VM-MT':460,WG:140,WH:205 };
    const rows = db.prepare(`SELECT id, asia_code, width FROM est_film_catalog WHERE brand='3m'`).all();
    const upd = db.prepare(`UPDATE est_film_catalog SET per_m=?, cost_per_m=?, plane=?, cabinet=?, shape=? WHERE id=?`);
    let n = 0;
    for (const r of rows) {
      const off = OFF[r.asia_code];
      if (off == null) continue;
      const factor = (r.width || 122) * 100 / 900;
      const perm = Math.round(off * factor);        // per_m 使 牌價/才(=per_m/factor)=官方元/才
      const cost = Math.round(perm * 0.8);           // 3M 成本＝牌價×8折
      upd.run(perm, cost, off + 90, off + 120, off + 145, r.id);
      n++;
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 3M 已對齊官方元/才 ${n} 筆`);
  }
} catch (e) { console.warn('[3m official]', e.message); }

// 韓版 RF/NF（真布紋）毛利 70%→60%：價格×0.75（成本不變）。不防焰 2400、防焰 2700（電商含稅）
try {
  const MIG = 'kr_rf_margin60_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const nice = raw => { const f10 = Math.floor(raw/10)*10; return (raw - f10 <= 1) ? f10 : Math.ceil(raw/5)*5; };
    const rf = db.prepare(`SELECT id, fireproof, width FROM est_film_catalog WHERE brand='bodaq' AND region='韓國' AND asia_code='RF/NF'`).all();
    const upd = db.prepare(`UPDATE est_film_catalog SET ecom_price=?, per_m=?, cost_per_m=?, plane=?, cabinet=?, shape=? WHERE id=?`);
    for (const r of rf) {
      const ecom = r.fireproof === '防焰' ? 2700 : 2400;
      const perm = Math.round(ecom / 1.05);
      const cost = Math.round(perm * 0.4);              // 60% 毛利回推成本
      const cai = nice(ecom / ((r.width || 122) * 100 / 900));
      upd.run(ecom, perm, cost, cai + 70, cai + 100, cai + 125, r.id);
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 韓版 RF/NF 已下修為 60% 毛利（${rf.length} 筆）`);
  }
} catch (e) { console.warn('[kr rf margin60]', e.message); }

// 韓國膜(BODAQ含韓版/BENIF)牌價/才改用「未稅」為基底重算連工帶料（PAROI維持含稅抓高、3M維持官方，皆不動）
try {
  const MIG = 'connect_work_untaxed_kr_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const nice = raw => { const f10 = Math.floor(raw/10)*10; return (raw - f10 <= 1) ? f10 : Math.ceil(raw/5)*5; };
    const rows = db.prepare(`SELECT id, per_m, width FROM est_film_catalog WHERE brand IN ('bodaq','benif') AND per_m>0`).all();
    const upd = db.prepare(`UPDATE est_film_catalog SET plane=?,cabinet=?,shape=? WHERE id=?`);
    for (const r of rows) {
      const cai = nice(r.per_m / ((r.width || 122) * 100 / 900));   // 未稅牌價/才
      upd.run(cai + 70, cai + 100, cai + 125, r.id);
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 韓國膜連工帶料改用未稅基底重算 ${rows.length} 筆`);
  }
} catch (e) { console.warn('[connect work untaxed kr]', e.message); }

// 3M 依「牌價/才」由低到高排序，讓同價位的系列排在一起
try {
  const MIG = '3m_sort_by_price_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const rows = db.prepare(`SELECT id, asia_code, per_m, width FROM est_film_catalog WHERE brand='3m' AND per_m>0`).all();
    rows.forEach(r => { r.cai = Math.round(r.per_m / ((r.width || 122) * 100 / 900)); });
    rows.sort((a, b) => (a.cai - b.cai) || String(a.asia_code || '').localeCompare(String(b.asia_code || '')));
    const upd = db.prepare(`UPDATE est_film_catalog SET sort_order=? WHERE id=?`);
    let so = 1;
    rows.forEach(r => upd.run(so++, r.id));
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 3M 已依牌價/才排序（同價聚在一起）${rows.length} 筆`);
  }
} catch (e) { console.warn('[3m sort by price]', e.message); }

// 3M 同價位（同牌價/才＋同寬＋同卷長）併成一列，型號用「、」串起
try {
  const MIG = '3m_merge_same_price_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const rows = db.prepare(`SELECT id, asia_code, per_m, width, roll_len FROM est_film_catalog WHERE brand='3m' AND per_m>0`).all();
    const groups = {};
    rows.forEach(r => {
      const cai = Math.round(r.per_m / ((r.width || 122) * 100 / 900));
      const key = cai + '|' + (r.width || 122) + '|' + (r.roll_len || 50);
      (groups[key] = groups[key] || { cai, list: [] }).list.push(r);
    });
    const updCode = db.prepare(`UPDATE est_film_catalog SET asia_code=?, sort_order=? WHERE id=?`);
    const del = db.prepare(`DELETE FROM est_film_catalog WHERE id=?`);
    let so = 1, merged = 0;
    Object.values(groups).sort((a, b) => a.cai - b.cai).forEach(g => {
      g.list.sort((a, b) => String(a.asia_code || '').localeCompare(String(b.asia_code || '')));
      const codes = g.list.map(r => r.asia_code).join('、');
      updCode.run(codes, so++, g.list[0].id);
      g.list.slice(1).forEach(r => { del.run(r.id); merged++; });
    });
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 3M 同價位已併列（併掉 ${merged} 列、剩 ${Object.keys(groups).length} 列）`);
  }
} catch (e) { console.warn('[3m merge same price]', e.message); }

// PAROI 系列補齊（依 LINTEC 原廠報價表）：綜合層「…」補完整、並補漏掉的 CM/SP(3100)、JH(4500)
try {
  const MIG = 'paroi_full_series_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    db.prepare(`UPDATE est_film_catalog SET asia_code=? WHERE brand='paroi' AND ecom_price=2550`)
      .run('GA、GM、LE、ME、MES、PCO、PFM、PGA、PGM、PLE、PME、PMI、PRE、PSE、PSH、PST、PSU、PWH、PWO、PWY、ST、WH、WO、WY');
    db.prepare(`UPDATE est_film_catalog SET asia_code=? WHERE brand='paroi' AND ecom_price=3100`)
      .run('PGW、WSP、WHG、CM、SP');
    db.prepare(`UPDATE est_film_catalog SET asia_code=? WHERE brand='paroi' AND ecom_price=4500`)
      .run('JS、JH');
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log('✅ PAROI 系列已補齊（綜合層完整＋CM/SP/JH）');
  }
} catch (e) { console.warn('[paroi full series]', e.message); }
try {
  const _cat = require('./lib/estimator-catalog');
  if (!db.prepare(`SELECT COUNT(*) n FROM est_film_catalog`).get().n) {
    const ins = db.prepare(`INSERT INTO est_film_catalog (brand,asia_code,kr_code,color,model_note,fireproof,per_m,ecom_price,cost_per_m,plane,cabinet,shape,width,roll_len,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [brand, b] of Object.entries(_cat.FILMS))
      b.items.forEach(it => ins.run(brand, it.asia, it.kr, it.color, it.model || '', it.fireproof || '', it.perM || 0, it.ecom || 0, it.cost || 0, it.plane, it.cabinet, it.shape, it.width || 122, it.rollLen || 50, so++));
  }
  // 一次性回填 2026-07 新定價（未稅牌價/電商/完全成本/防焰/花色）到既有列。
  // 守衛：全表 ecom_price 皆空才跑 → 只在「舊表升級」時執行一次；跑過後（含新 seed）老闆的手改不再被覆蓋。
  if (!db.prepare(`SELECT COUNT(*) n FROM est_film_catalog WHERE ecom_price>0`).get().n) {
    const upd = db.prepare(`UPDATE est_film_catalog SET per_m=?, ecom_price=?, cost_per_m=?, fireproof=?, color=? WHERE brand=? AND asia_code=?`);
    for (const [brand, b] of Object.entries(_cat.FILMS))
      b.items.forEach(it => upd.run(it.perM || 0, it.ecom || 0, it.cost || 0, it.fireproof || '', it.color || '', brand, it.asia));
    console.log('✅ 估價牌價表已回填 2026-07 新定價（成本/電商/防焰/牌價；一次性）');
  } else {
    // 日常啟動：只補仍為空的 per_m，不覆蓋老闆手改
    const updPm = db.prepare(`UPDATE est_film_catalog SET per_m=? WHERE brand=? AND asia_code=? AND (per_m IS NULL OR per_m=0)`);
    for (const [brand, b] of Object.entries(_cat.FILMS)) b.items.forEach(it => updPm.run(it.perM || 0, brand, it.asia));
  }
  // 補列：FILMS 中任何「品牌＋系列」在表中不存在就插入（idempotent、不覆蓋既有）。
  // 新品牌（如 3M）或既有品牌新增系列（如 3M 補 Fasara）都適用；不管是否已 seed 過皆安全。
  { const insNew = db.prepare(`INSERT INTO est_film_catalog (brand,asia_code,kr_code,color,model_note,fireproof,per_m,ecom_price,cost_per_m,plane,cabinet,shape,width,roll_len,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const exists = db.prepare(`SELECT 1 FROM est_film_catalog WHERE brand=? AND asia_code=? LIMIT 1`);
    let added = 0;
    for (const [brand, b] of Object.entries(_cat.FILMS)) b.items.forEach(it => {
      if (exists.get(brand, it.asia)) return;
      const so = db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 n FROM est_film_catalog`).get().n;
      insNew.run(brand, it.asia, it.kr, it.color || '', it.model || '', it.fireproof || '', it.perM || 0, it.ecom || 0, it.cost || 0, it.plane, it.cabinet, it.shape, it.width || 122, it.rollLen || 50, so);
      added++;
    });
    if (added) console.log('✅ est_film_catalog 補進 ' + added + ' 個新系列（品牌/系列缺列補齊）');
  }
  if (!db.prepare(`SELECT COUNT(*) n FROM est_door_catalog`).get().n) {
    const ins = db.prepare(`INSERT INTO est_door_catalog (cat,size,origin,side,frame,price,sort_order) VALUES (?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [c, d] of Object.entries(_cat.DOORS)) {
      if (d.sized) {
        for (const size of ['small', 'large', 'double'])
          for (const origin of ['kr', 'jp'])
            for (const side of ['single', 'double'])
              ins.run('fire', size, origin, side, null, d[size][origin][side], so++);
      } else {
        for (const origin of ['kr', 'jp'])
          for (const side of ['single', 'double'])
            for (const frame of ['no', 'yes'])
              ins.run(c, null, origin, side, frame, d[origin][side][frame], so++);
      }
    }
  }
  console.log('✅ 估價重設計版牌價表就緒（est_film_catalog/est_door_catalog；空表才 seed）');
} catch (e) { console.warn('[est catalog seed]', e.message); }

// ── 亞洲 BODAQ 補三個缺的系列 BC/SM/BT（依供應商 RMB×繪新成本公式；牌價回推70%毛利）──
// 成本/米 = 5.6×供應商RMB + 5050/卷長（此公式完全吻合現有 SS/AU/AP/AF 的成本）。
// 連工帶料/才 = 牌價/才 + 70/100/125（牆面/系統櫃/造型）；牌價/才 = 未稅牌價/米 ÷ 13.556 進位到5。
// quote 引擎只吃 plane/cabinet/shape+width，故此三欄必須正確。守衛：_migrations 只跑一次；已存在的系列不重複插。
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
try {
  const MIG = 'bodaq_asia_add_bc_sm_bt_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    // 沿用既有亞洲 BODAQ 的 region 值（避免 NULL/'' 不一致造成分區跑掉）
    const asiaRegion = db.prepare(`SELECT region FROM est_film_catalog WHERE brand='bodaq' AND asia_code='BA' LIMIT 1`).get()?.region ?? null;
    // asia, kr_code, color, model_note, per_m(未稅), ecom(含稅), cost, plane(牆), cabinet(櫃), shape(造型), roll_len
    const NEW = [
      ['BC', 'BZ,HZ,PTW,Z,DW', '木紋',   '對應韓碼 BZ、HZ、PTW、Z、DW', 1063, 1100, 319, 150, 180, 205, 50],
      ['SM', 'DM',             '素面',   '對應韓碼 DM',                 1120, 1200, 336, 155, 185, 210, 50],
      ['BT', 'PNT',            '皮革/素面','對應韓碼 PNT（40米/卷）',      1260, 1300, 378, 165, 195, 220, 40],
    ];
    const exists = db.prepare(`SELECT 1 FROM est_film_catalog WHERE brand='bodaq' AND asia_code=? AND (region IS NULL OR region<>'韓國') LIMIT 1`);
    const ins = db.prepare(`INSERT INTO est_film_catalog (brand,region,asia_code,kr_code,color,model_note,fireproof,per_m,ecom_price,cost_per_m,plane,cabinet,shape,width,roll_len,sort_order,active) VALUES ('bodaq',?,?,?,?,?,'不防焰',?,?,?,?,?,?,122,?,0,1)`);
    for (const r of NEW) if (!exists.get(r[0])) ins.run(asiaRegion, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]);
    // 依牌價/米重排「亞洲 BODAQ」sort_order，讓 BC/SM/BT 落在正確價格順位（只動 bodaq 亞洲，不影響其他品牌）
    const rows = db.prepare(`SELECT id FROM est_film_catalog WHERE brand='bodaq' AND (region IS NULL OR region<>'韓國') ORDER BY per_m, id`).all();
    let so = 0; const updSo = db.prepare(`UPDATE est_film_catalog SET sort_order=? WHERE id=?`);
    for (const row of rows) updSo.run(so++, row.id);
    // 修 BC903 膜料庫存成本（此前手建打成 480，實為 BC 系列＝319）
    db.prepare(`UPDATE materials SET unit_cost=319 WHERE UPPER(brand) IN ('BODAQ','BODA') AND model LIKE 'BC903%' AND unit_cost=480`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log('✅ 亞洲 BODAQ 補入 BC/SM/BT、依價重排，並修 BC903 材料成本 480→319');
  }
} catch (e) { console.warn('[bodaq asia add bc/sm/bt]', e.message); }

// ── 一次性：依估價定價表更新膜料庫存 售價/成本（2026-07，老闆指示直接更新，不做預覽按鈕）──
// 售價：有電商價(BODAQ/LX/PAROI)取 ecom_price(含稅)、3M 取 per_m(未稅牌價)；成本=cost_per_m(完全成本)。
// 只更新「品牌＋系列」精準對到定價表者；對不到的(Carlife 隔熱紙、AICA、穩得…)一律不動。守衛：_migrations 只跑一次。
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
try {
  const MIG = 'mat_apply_catalog_price_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    // 庫存品牌 → 定價表品牌鍵（大寫比對；含常見別名）
    const B2C = { 'BODAQ':'bodaq','BODA':'bodaq','LG':'benif','LX':'benif','BENIF':'benif','PAROI':'paroi','PARA':'paroi','3M':'3m' };
    const catRows = db.prepare(`SELECT brand, asia_code, per_m, ecom_price, cost_per_m FROM est_film_catalog WHERE active=1`).all();
    const idx = {};
    for (const r of catRows) {
      const codes = String(r.asia_code || '').toUpperCase().split(',').map(s => s.replace(/…/g, '').trim()).filter(Boolean);
      (idx[r.brand] || (idx[r.brand] = [])).push({ codes, row: r });
    }
    const catOf = b => B2C[String(b || '').toUpperCase().trim()];
    const matchRow = (brand, model) => {
      const cat = catOf(brand); if (!cat || !idx[cat]) return null;
      const M = String(model || '').toUpperCase().trim();
      const lead = (M.match(/^[A-Z]+/) || [''])[0]; if (!lead) return null;
      const tries = []; if (/MT/.test(M)) tries.push(lead + '-MT'); tries.push(lead);
      for (const t of tries) { const hit = idx[cat].find(c => c.codes.includes(t)); if (hit) return hit.row; }
      return null;
    };
    const priceOf = row => (row.ecom_price && row.ecom_price > 0) ? Math.round(row.ecom_price) : Math.round(row.per_m || 0);
    const mats = db.prepare(`SELECT id, brand, model, unit_price, unit_cost FROM materials WHERE category='film' OR category IS NULL`).all();
    const upd = db.prepare(`UPDATE materials SET unit_price=?, unit_cost=? WHERE id=?`);
    let n = 0; const sample = [];
    for (const m of mats) {
      const row = matchRow(m.brand, m.model); if (!row) continue;
      const np = priceOf(row), nc = Math.round(row.cost_per_m || 0);
      if ((m.unit_price || 0) === np && (m.unit_cost || 0) === nc) continue;
      upd.run(np, nc, m.id); n++;
      if (sample.length < 80) sample.push(`${m.brand} ${m.model}: 售價 ${m.unit_price || 0}→${np}、成本 ${m.unit_cost || 0}→${nc}`);
    }
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ 膜料庫存依定價表更新 ${n} 筆售價/成本（一次性）；以下為前 ${sample.length} 筆明細：`);
    sample.forEach(s => console.log('   ·', s));
  }
} catch (e) { console.warn('[mat apply catalog price]', e.message); }

// AF(BODAQ 亞洲版 真布紋) 毛利 70%→60% 下修（2026-07-11 老闆決定）：電商含稅 3600→2700、未稅牌價 3429→2571，成本不變。一次性、不覆蓋日後手改。
try {
  const MIG = 'bodaq_af_margin60_2026_07';
  if (!db.prepare(`SELECT 1 FROM _migrations WHERE name=?`).get(MIG)) {
    const r = db.prepare(`UPDATE est_film_catalog SET ecom_price=2700, per_m=2571 WHERE brand='bodaq' AND asia_code='AF'`).run();
    db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(MIG);
    console.log(`✅ AF 毛利改 60% 下修：ecom 2700 / per_m 2571（更新 ${r.changes} 筆）`);
  }
} catch (e) { console.warn('[bodaq af margin60]', e.message); }

// ── 估價單儲存（新表，獨立模組；items/photos 存 JSON，金額由引擎重算後存）──
db.exec(`
  CREATE TABLE IF NOT EXISTS est_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER,
    project_name TEXT,
    customer_type TEXT DEFAULT 'owner',
    region TEXT,
    customer_name TEXT, phone TEXT, address TEXT, community TEXT,
    line_replied INTEGER DEFAULT 0,
    items_json TEXT DEFAULT '[]',
    photos_json TEXT DEFAULT '[]',
    customer_note TEXT,
    disc REAL DEFAULT 1,
    subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, items_final REAL DEFAULT 0,
    freight REAL DEFAULT 0, fut REAL DEFAULT 0, total REAL DEFAULT 0,
    status TEXT DEFAULT 'draft',
    created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME
  );
`);
// 估價單客戶連結／PDF：分享 token（比照 quote_sheets.share_token）＋客戶開啟時間
_addCol('est_quotes', 'share_token',      'TEXT');
_addCol('est_quotes', 'client_viewed_at', 'DATETIME');
// 客戶可見明細：1=含明細（材料/寬高/才），0=只顯示總額。分享連結＋PDF＋客戶檢視都跟著走
_addCol('est_quotes', 'show_detail',      'INTEGER DEFAULT 1');
// 計料方式：0=寬鬆(多報)、1=拼料省料。存起來讓存檔總額＋客戶頁與估價機顯示一致
_addCol('est_quotes', 'combine',          'INTEGER DEFAULT 0');
// 客戶頁顯示設定(JSON)：{detail,photo,material,size,cai,range}——勾選要顯示哪些欄；range=用拼料省料~寬鬆區間
_addCol('est_quotes', 'cust_view',        'TEXT');
// 客戶連結的短網址（複製連結時一併產生並快取，客服要傳給客人）
_addCol('est_quotes', 'short_url',        'TEXT');
// token 唯一（允許多筆 NULL：舊資料未產生前為空）
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_est_quotes_token ON est_quotes(share_token) WHERE share_token IS NOT NULL`);

// ── 估價單版本快照（手動「存為新版本」時各存一筆；items/photos+金額整包留存）──
db.exec(`
  CREATE TABLE IF NOT EXISTS est_quote_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL,
    case_id INTEGER,
    ver_no INTEGER NOT NULL,
    note TEXT,
    project_name TEXT, customer_name TEXT, customer_type TEXT, region TEXT,
    items_json TEXT DEFAULT '[]',
    photos_json TEXT DEFAULT '[]',
    disc REAL DEFAULT 1,
    subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, items_final REAL DEFAULT 0,
    freight REAL DEFAULT 0, fut REAL DEFAULT 0, total REAL DEFAULT 0,
    created_by INTEGER, created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_est_qver_quote ON est_quote_versions(quote_id, ver_no)`);

module.exports = db;
