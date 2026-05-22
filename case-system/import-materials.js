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

// 檢查是否已有資料
const existing = db.prepare(`SELECT COUNT(*) as n FROM materials WHERE org_id = ?`).get(orgId).n;
if (existing > 0) {
  console.log(`⚠️  materials 表已有 ${existing} 筆，跳過匯入`);
  console.log('若要重新匯入，請先在 Zeabur terminal 執行：DELETE FROM materials WHERE org_id = ' + orgId);
  process.exit(0);
}

const insert = db.prepare(`
  INSERT INTO materials (org_id, brand, model, spec, stock_meters, unit_cost, unit_price)
  VALUES (?, ?, ?, ?, ?, 0, 0)
`);

let count = 0;
db.prepare('BEGIN').run();
try {
  for (const r of rows) {
    insert.run(orgId, r.brand, r.model, r.spec || null, r.stock || 0);
    count++;
  }
  db.prepare('COMMIT').run();
} catch (e) {
  db.prepare('ROLLBACK').run();
  throw e;
}

console.log(`✅ 匯入完成：${count} 種膜料`);
