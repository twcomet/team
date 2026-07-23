// 客戶 LINE 綁定共用工具：產碼、選 OA、組深連結、產 token、組分享連結
// 由 routes/clients.js 與 routes/line-inquiries.js 共用（單一真實來源）
const crypto = require('crypto');
const db = require('../db');

const _B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 綁定碼：HXB + 6 碼 base62（與 webhook 攔截的 /HXB[0-9A-Za-z]{6}/ 對應）
function genBindCode() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += _B62[bytes[i] % 62];
  return 'HXB' + s;
}

// 這位客戶該綁哪個官方帳號：已綁的優先，其次該店有 basic_id 的，再其次該店任一啟用中的
function channelForClient(client) {
  if (client.line_channel_id) {
    const c = db.prepare(`SELECT * FROM line_channels WHERE id=? AND active=1`).get(client.line_channel_id);
    if (c) return c;
  }
  if (client.org_id) {
    const c = db.prepare(`SELECT * FROM line_channels WHERE org_id=? AND active=1 ORDER BY (basic_id IS NULL), id LIMIT 1`).get(client.org_id);
    if (c) return c;
  }
  return null;
}

// 一鍵深連結：客人點了 → 開啟該 OA 對話框、預填「綁定 HXBxxxxxx」，按傳送即完成
function bindDeepLink(basicId, code) {
  if (!basicId) return null;
  const id = basicId.startsWith('@') ? basicId : '@' + basicId;
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent('綁定 ' + code)}`;
}

// 為某客戶產生新綁定碼（先作廢該客戶其他未使用的舊碼、30 天有效），回傳 code 或 null
function createBindToken(clientId, orgId, createdBy) {
  db.prepare(`DELETE FROM client_bind_tokens WHERE client_id=? AND used_at IS NULL`).run(clientId);
  for (let i = 0; i < 6; i++) {
    const cand = genBindCode();
    try {
      db.prepare(`INSERT INTO client_bind_tokens (code, client_id, org_id, created_by, expires_at)
                  VALUES (?,?,?,?, datetime('now','+30 days'))`).run(cand, clientId, orgId || null, createdBy || null);
      return cand;
    } catch (e) { /* 撞碼重試 */ }
  }
  return null;
}

// 組出可分享連結：有 basic_id → 一鍵深連結；否則中轉頁 /bind/:code
function buildBindLink(client, code, origin) {
  const ch = channelForClient(client);
  const deep_link = ch ? bindDeepLink(ch.basic_id, code) : null;
  const page_url  = `${origin}/bind/${code}`;
  return { link: deep_link || page_url, deep_link, page_url, via: deep_link ? 'deeplink' : 'page', oa_name: ch ? ch.channel_name : null };
}

// 把 lineUserId 綁到 targetClientId：合併去重（清掉先前自動建的重複客戶、對話併過去）
// + 寫入 line_channel_id / org（以實際 OA 為準）/ bound_at / bind_org_mismatch。
// channel = { id, org_id } 或 null；filedOrgId = 建檔店別（跨店提醒用，省略則取該客戶現有 org）。
function applyBind(targetClientId, lineUserId, channel, filedOrgId) {
  const target = db.prepare(`SELECT id, org_id FROM clients WHERE id=?`).get(targetClientId);
  if (!target) return null;

  const dups = db.prepare(`SELECT * FROM clients WHERE line_user_id=? AND id<>?`).all(lineUserId, targetClientId);
  for (const d of dups) {
    db.prepare(`UPDATE line_inquiries SET client_id=? WHERE client_id=?`).run(targetClientId, d.id);
    const autoCreated = d.source === 'LINE' && !d.phone && !d.email && !d.address && !d.tax_id;
    // 自動建的空殼客戶：試著刪掉；若已被其他資料(案件/報價/收款…)參照而刪不掉(外鍵限制)，
    // 就退而把它的 line_user_id 清空、保留該筆客戶，避免整個關聯動作 500 失敗。
    let removed = false;
    if (autoCreated) { try { db.prepare(`DELETE FROM clients WHERE id=?`).run(d.id); removed = true; } catch (e) { removed = false; } }
    if (!removed) db.prepare(`UPDATE clients SET line_user_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(d.id);
  }

  const chId  = channel && channel.id     != null ? channel.id     : null;
  const chOrg = channel && channel.org_id != null ? channel.org_id : null;
  const filed = filedOrgId != null ? filedOrgId : target.org_id;
  const mismatch = (filed && chOrg && filed !== chOrg) ? 1 : 0;
  db.prepare(`
    UPDATE clients
    SET line_user_id=?, line_channel_id=COALESCE(?, line_channel_id), org_id=COALESCE(?, org_id),
        bind_org_mismatch=?, bound_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(lineUserId, chId, chOrg, mismatch, targetClientId);
  return { targetId: targetClientId, mismatch };
}

module.exports = { genBindCode, channelForClient, bindDeepLink, createBindToken, buildBindLink, applyBind };
