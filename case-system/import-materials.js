/**
 * 從 Python 生成的 JSON 匯入膜料庫存到 SQLite
 * 執行：node import-materials.js
 */
require('./db');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const jsonFile = path.join(__dirname, 'materials-import.json');
if (!fs.existsSync(jsonFile)) {
  console.error('找不到 materials-import.json，請先執行 python3 export-materials.py');
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const orgId = db.prepare(`SELECT id FROM orgs LIMIT 1`).get()?.id;
if (!orgId) { console.error('找不到 org'); process.exit(1); }

// 已有資料 → 補 location（不重複插入）
const existing = db.prepare(`SELECT COUNT(*) as n FROM materials WHERE org_id = ?`).get(orgId).n;
if (existing > 0) {
  console.log(`⚠️  materials 表已有 ${existing} 筆，改為更新貨架位置…`);
  const upd = db.prepare(`UPDATE materials SET location=?, spec=? WHERE org_id=? AND brand=? AND model=?`);
  let updated = 0;
  db.prepare('BEGIN').run();
  for (const r of rows) {
    const res = upd.run(r.location || null, r.spec || null, orgId, r.brand, r.model);
    if (res.changes) updated++;
  }
  db.prepare('COMMIT').run();
  console.log(`✅ 已更新 ${updated} 筆貨架位置`);
  process.exit(0);
}

const insert = db.prepare(`
  INSERT INTO materials (org_id, brand, model, spec, location, stock_meters, unit_cost, unit_price)
  VALUES (?, ?, ?, ?, ?, ?, 0, 0)
`);

let count = 0;
db.prepare('BEGIN').run();
try {
  for (const r of rows) {
    insert.run(orgId, r.brand, r.model, r.spec || null, r.location || null, r.stock || 0);
    count++;
  }
  db.prepare('COMMIT').run();
} catch (e) {
  db.prepare('ROLLBACK').run();
  throw e;
}

console.log(`✅ 匯入完成：${count} 種膜料`);
