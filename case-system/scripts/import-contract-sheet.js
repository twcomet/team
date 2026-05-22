/**
 * 生產環境一次性資料匯入：案件成交進行（Sheet2）
 * 在 Zeabur 指令終端執行：node scripts/import-contract-sheet.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_FILE   = process.env.DB_PATH || path.join(__dirname, '..', 'huixin.db');
const JSON_FILE = path.join(__dirname, 'import-contract.json');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

// 確保新欄位存在（若 db.js 尚未升級）
const _addCol = (table, col, def) => {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
_addCol('cases', 'survey_date',  'DATE');
_addCol('cases', 'surveyor_id',  'INTEGER REFERENCES users(id)');

// 如果舊 CHECK 約束存在，遷移 cases 表格
const _casesSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cases'`).get();
const _needsMigrate = _casesSchema && !_casesSchema.sql.includes("'contracted'");
if (_needsMigrate) {
  console.log('升級案件狀態至 7 階段...');
  db.exec(`PRAGMA foreign_keys=OFF`);
  db.exec(`CREATE TABLE _cases_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_number TEXT UNIQUE NOT NULL,
    org_id INTEGER REFERENCES orgs(id),
    case_type TEXT DEFAULT 'inquiry' CHECK(case_type IN ('inquiry','survey','contract','repair')),
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
    SELECT id,case_number,org_id,case_type,client_id,title,description,location,
           quoted_price,final_price,material_cost,survey_fee,install_fee,
           payment_status,payment_received,payment_due_date,payment_notes,
           sales_id,is_outsourced,outsource_type,
           CASE status
             WHEN 'inquiry' THEN 'initial_estimate'
             WHEN 'text_quoted' THEN 'initial_estimate'
             WHEN 'survey_scheduled' THEN 'survey'
             WHEN 'surveyed' THEN 'survey'
             WHEN 'quoted' THEN 'quoted'
             WHEN 'draft_quoted' THEN 'quoted'
             WHEN 'formal_quoted' THEN 'quoted'
             WHEN 'quote_framework' THEN 'quoted'
             WHEN 'quote_no_survey' THEN 'quoted'
             WHEN 'confirmed' THEN 'contracted'
             WHEN 'scheduled' THEN 'contracted'
             WHEN 'in_progress' THEN 'contracted'
             WHEN 'dispatched' THEN 'contracted'
             WHEN 'pending_payment' THEN 'payment'
             WHEN 'aftersales' THEN 'payment'
             WHEN 'completed' THEN 'closed'
             WHEN 'closed' THEN 'closed'
             WHEN 'invalid' THEN 'invalid'
             ELSE 'initial_estimate'
           END,
           priority,notes,created_by,created_at,updated_at,
           line_source,keyword,deposit_amount,material_ordered,
           invoice_company,invoice_tax_id,invoice_address,invoice_email,invoice_item_desc,
           scheduled_date,survey_date,surveyor_id
    FROM cases`);
  db.exec(`DROP TABLE cases; ALTER TABLE _cases_new RENAME TO cases`);
  db.exec(`PRAGMA foreign_keys=ON`);
  console.log('✅ 案件狀態升級完成');
}

function genCaseNumber() {
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(-2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `HX${yy}${mm}`;
  const last = db.prepare(`SELECT case_number FROM cases WHERE case_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  const seq  = last ? (parseInt(last.case_number.split('-')[1]) || 0) + 1 : 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

function parseContact(name, phone) {
  if (!name) return null;
  return name.replace(/\t/g,'').trim().slice(0,50);
}

function main() {
  // 防重複匯入
  const alreadyImported = db.prepare(`SELECT id FROM cases WHERE notes LIKE '匯入自成交Sheet%' LIMIT 1`).get();
  if (alreadyImported) {
    console.log('⚠️  偵測到已匯入的成交資料，跳過（防止重複）');
    process.exit(0);
  }

  if (!fs.existsSync(JSON_FILE)) {
    console.error('❌ 找不到 import-contract.json');
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  console.log(`讀取 ${rows.length} 筆成交案件，開始匯入...\n`);

  const hqOrg   = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const orgId   = hqOrg?.id || null;
  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const sysUid  = sysUser?.id || null;

  // 建立人員名稱對照表（含常見別名）
  const userMap = {};
  db.prepare(`SELECT id, name FROM users`).all().forEach(u => {
    userMap[u.name] = u.id;
  });
  // 常見別名
  const aliases = { '佳樺': 'flora', '恰吉': '恰吉', '天鈞': '天鈞', '傳恩': '傳恩', '名汎': '名汎', 'Andy': 'Andy', 'Ken哥': 'Ken哥' };

  let created = 0;

  // 舊狀態 → 新 7 階段
  const statusMap = {
    confirmed: 'contracted', dispatched: 'contracted',
    pending_payment: 'payment', completed: 'closed', invalid: 'invalid',
    survey: 'survey', quoted: 'quoted', initial_estimate: 'initial_estimate',
  };

  for (const row of rows) {
    const dbStatus = statusMap[row.status] || 'contracted';
    // 場勘人對應
    const surveyorId = row.surveyor_name ? (userMap[row.surveyor_name] || null) : null;

    // 找或建立客戶
    let clientId = null;
    if (row.contact_phone) {
      const existing = db.prepare(`SELECT id FROM clients WHERE phone=? LIMIT 1`).get(row.contact_phone);
      if (existing) {
        clientId = existing.id;
      } else if (row.contact_name) {
        const r = db.prepare(`INSERT INTO clients (org_id, name, phone, source, created_by) VALUES (?,?,?,?,?)`)
          .run(orgId, parseContact(row.contact_name), row.contact_phone, '匯入', sysUid);
        clientId = r.lastInsertRowid;
        console.log(`  + 客戶：${row.contact_name} ${row.contact_phone}`);
      }
    }

    const notes = `匯入自成交Sheet Row${row.row}\n原始狀態：${row.status_raw || row.status}\n材料：${row.material_note || '—'}\n說明：${row.description || '—'}`;
    const caseNumber = genCaseNumber();

    db.prepare(`
      INSERT INTO cases (
        case_number, org_id, case_type, client_id, title,
        location, final_price, survey_fee, surveyor_id, sales_id,
        status, priority, notes,
        survey_date, scheduled_date, created_by, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'normal',?,?,?,?,CURRENT_TIMESTAMP)
    `).run(
      caseNumber, orgId, row.case_type || 'contract', clientId, row.title,
      row.location, row.final_price, row.survey_fee, surveyorId, surveyorId || sysUid,
      dbStatus, notes,
      row.survey_date, row.scheduled_date, sysUid
    );

    console.log(`✓ ${caseNumber} | [${dbStatus}] ${row.title.slice(0,35)} | $${row.final_price ? row.final_price.toLocaleString() : '—'}`);
    created++;
  }

  console.log(`\n✅ 完成：新建 ${created} 筆成交案件`);
}

main();
