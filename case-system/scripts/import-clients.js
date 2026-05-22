/**
 * 客戶名片資料匯入（1663 筆）
 * 在 Zeabur 指令終端執行：node scripts/import-clients.js
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_FILE   = process.env.DB_PATH || path.join(__dirname, '..', 'huixin.db');
const JSON_FILE = path.join(__dirname, 'import-clients.json');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

if (!fs.existsSync(JSON_FILE)) {
  console.error('❌ 找不到 import-clients.json');
  process.exit(1);
}

// 防重複：已有超過 10 筆非匯入案件的客戶就跳過
const existing = db.prepare("SELECT COUNT(*) as n FROM clients WHERE notes NOT LIKE '匯入%' OR notes IS NULL").get();
const alreadyImported = db.prepare("SELECT COUNT(*) as n FROM clients WHERE notes LIKE '匯入自名片資料表%'").get();
if (alreadyImported.n > 0) {
  console.log(`⚠️  偵測到已匯入的客戶資料（${alreadyImported.n} 筆），跳過`);
  process.exit(0);
}

const hqOrg   = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
const orgId   = hqOrg?.id || null;
const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
const sysUid  = sysUser?.id || null;

const rows = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
console.log(`讀取 ${rows.length} 筆客戶資料，開始匯入...\n`);

const stmt = db.prepare(`
  INSERT INTO clients (
    org_id, name, contact_person, phone, email, address, source,
    tax_id, capital, einvoice_code, client_level, payment_terms, discount_terms, referrer,
    notes, created_by
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

let created = 0, skipped = 0;

for (const row of rows) {
  // 以電話或公司名防重複
  let existing = null;
  if (row.phone) {
    existing = db.prepare('SELECT id FROM clients WHERE phone=? LIMIT 1').get(row.phone);
  }
  if (!existing && row.name) {
    existing = db.prepare('SELECT id FROM clients WHERE name=? LIMIT 1').get(row.name);
  }
  if (existing) { skipped++; continue; }

  stmt.run(
    orgId, row.name, row.contact_person, row.phone, row.email, row.address, row.source,
    row.tax_id, row.capital, row.einvoice_code, row.client_level,
    row.payment_terms, row.discount_terms, row.referrer,
    `匯入自名片資料表`, sysUid
  );
  console.log(`✓ ${row.name}${row.contact_person ? ' / '+row.contact_person : ''}${row.phone ? ' '+row.phone : ''}`);
  created++;
}

console.log(`\n✅ 完成：新建 ${created} 筆，跳過重複 ${skipped} 筆`);
