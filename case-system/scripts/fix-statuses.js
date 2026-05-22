/**
 * 一次性狀態修正腳本
 * 在 Zeabur 指令終端執行：node scripts/fix-statuses.js
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'huixin.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON;');

// 1. 場勘案件：匯入自 Excel 的，狀態改為 survey
const r1 = db.prepare(
  "UPDATE cases SET status='survey' WHERE case_type='survey' AND notes LIKE '匯入自Excel%' AND status != 'survey'"
).run();
console.log('場勘案件修正：', r1.changes, '筆 → survey');

// 2. 成交案件：confirmed/dispatched → contracted
const r2 = db.prepare(
  "UPDATE cases SET status='contracted' WHERE case_type='contract' AND notes LIKE '匯入自成交Sheet%' AND status='initial_estimate'"
).run();
console.log('成交案件修正：', r2.changes, '筆 → contracted');

// 3. Row 20 (知研設計 追款) → payment
const r3 = db.prepare(
  "UPDATE cases SET status='payment' WHERE notes LIKE '匯入自成交Sheet Row20%'"
).run();
console.log('完工請款修正：', r3.changes, '筆 → payment');

// 確認結果
const summary = db.prepare("SELECT status, COUNT(*) as n FROM cases GROUP BY status ORDER BY n DESC").all();
console.log('\n目前狀態分佈：');
summary.forEach(r => console.log(' ', r.status, ':', r.n, '筆'));
console.log('\n總計：', db.prepare("SELECT COUNT(*) as n FROM cases").get().n, '筆');
