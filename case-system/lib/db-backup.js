// 資料庫異地備份：用 SQLite「VACUUM INTO」做一致性快照（即使有寫入也安全），
// 上傳到 Google Drive 的「繪新系統備份（資料庫）」資料夾，只保留最近 KEEP 份。
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const db     = require('../db');
const gdrive = require('./gdrive');

const KEEP = 60;   // 保留最近 60 份（≈ 15 天 × 一天 4 次）

// 產生一致性快照到暫存檔，回傳 { name, tmp }。檔名用台灣時間：huixin-YYYY-MM-DD-HHMM.db
function _snapshot() {
  const tw    = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }); // "YYYY-MM-DD HH:MM:SS"
  const stamp = tw.slice(0, 16).replace(' ', '-').replace(':', '');              // YYYY-MM-DD-HHMM
  const name  = `huixin-${stamp}.db`;
  const tmp   = path.join(os.tmpdir(), name);
  try { fs.unlinkSync(tmp); } catch (e) {}                 // VACUUM INTO 目標檔不能已存在
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  return { name, tmp };
}

// 執行一次備份：快照 → 上傳 Google Drive → 清理舊檔。回傳結果摘要
async function runBackup() {
  if (!gdrive.isConnected()) throw new Error('尚未連接 Google 雲端，無法備份');
  const { name, tmp } = _snapshot();
  try {
    const buf  = fs.readFileSync(tmp);
    const up   = await gdrive.uploadBackup(name, buf);
    const pruned = await gdrive.pruneBackups(KEEP);
    return { name, size: buf.length, fileId: up.id, pruned };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

// 供「下載資料庫」用：回傳一份即時快照的內容
function snapshotBuffer() {
  const { name, tmp } = _snapshot();
  try { return { name, buf: fs.readFileSync(tmp) }; }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

module.exports = { runBackup, snapshotBuffer, KEEP };
