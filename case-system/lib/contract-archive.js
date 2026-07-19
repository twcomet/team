// 已簽合約備份：簽署完成→組出「合約內容＋手寫簽名」PDF→上傳 Google Drive「合約簽署 → 合約標題」。
// best-effort：任何失敗都不影響簽署本身（呼叫端 fire-and-forget）。
const db = require('../db');
const gdrive = require('./gdrive');
const { renderPdfFromHtml } = require('./pdf-render');

function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _safe(s) { return String(s || '').replace(/[\\/?%*:|"<>\r\n]+/g, ' ').trim().slice(0, 120); }
function _fmtDt(s) { return String(s || '').replace('T', ' ').slice(0, 19); }

function _buildHtml(c, sig) {
  return `<div style="font-family:'Noto Sans TC','Noto Sans CJK TC',sans-serif;padding:36px 40px;max-width:820px;margin:0 auto;color:#111827">
    <h1 style="font-size:22px;text-align:center;margin:0 0 24px;letter-spacing:1px">${_esc(c.title)}</h1>
    <div style="font-size:14px;line-height:1.9">${c.content || '<p style="color:#9ca3af">（無內文）</p>'}</div>
    <hr style="margin:28px 0 20px;border:none;border-top:1px solid #d1d5db">
    <div style="font-size:14px;line-height:2.1">
      <div><b>簽署人：</b>${_esc(sig.signed_name)}</div>
      <div><b>簽署日期：</b>${_esc(_fmtDt(sig.signed_at))}</div>
      ${sig.ip_address ? `<div><b>簽署 IP：</b>${_esc(sig.ip_address)}</div>` : ''}
      <div style="margin-top:14px"><b>手寫電子簽名：</b></div>
      ${sig.signature ? `<img src="${sig.signature}" style="max-width:340px;max-height:160px;border:1px solid #e5e7eb;border-radius:8px;margin-top:8px">` : '<div style="color:#9ca3af">（無簽名影像）</div>'}
    </div>
    <p style="font-size:12px;color:#9ca3af;margin-top:24px;line-height:1.6">本文件為系統於簽署完成時自動產生之電子簽署存證。依當事人簽署時之確認，電子簽章與親筆簽名具同等法律效力。</p>
  </div>`;
}

async function _doBackup(contractId, userId) {
  if (!gdrive.isConnected || !gdrive.isConnected()) return;          // 未連 Google Drive → 略過
  const c   = db.prepare('SELECT id, title, content FROM contracts WHERE id=?').get(contractId);
  const sig = db.prepare('SELECT signed_name, signature, signed_at, ip_address FROM contract_signatures WHERE contract_id=? AND user_id=?').get(contractId, userId);
  if (!c || !sig) return;
  const pdf = await renderPdfFromHtml(_buildHtml(c, sig), { title: c.title });   // 本機無 Chromium 會 throw → 上層 catch
  if (!pdf) return;
  const folderId = await gdrive.ensureContractFolder(c.id, c.title);              // 母夾「合約簽署」→ 標題分類夾
  const fname = (_safe(`${sig.signed_name}_${c.title}`) || ('合約' + c.id)) + '.pdf';   // 檔名含簽署人＋合約標題
  await gdrive.uploadFileToFolder(folderId, fname, pdf, 'application/pdf');
  console.log(`[contract-archive] 已備份簽署合約：${fname}`);
}

function backupSignedContract(contractId, userId) {
  _doBackup(contractId, userId).catch(e => console.error('[contract-archive] 備份失敗:', e.message));
}

module.exports = { backupSignedContract };
