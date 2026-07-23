const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const cloudinary = require('cloudinary').v2;
const router  = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 訊息類型 → 清單預覽用的標籤
const MSG_LABEL = { image:'[照片]', sticker:'[貼圖]', video:'[影片]', audio:'[語音]', file:'[檔案]', location:'[位置]' };

// 下載 LINE 訊息的圖片內容 → 上傳 Cloudinary，回傳網址（失敗回 null）
async function fetchLineImageToCloudinary(messageId, token) {
  try {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${(token||'').replace(/\s/g,'')}` }
    });
    if (!res.ok) { console.error(`[LINE-IMG] 下載失敗 msg=${messageId} status=${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'line-inquiries', resource_type: 'image', transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }] },
        (err, r) => err ? reject(err) : resolve(r)
      ).end(buf);
    });
    return result.secure_url;
  } catch (e) { console.error('[LINE-IMG] 例外', e.message); return null; }
}

// ── 繪新國際（客戶用）────────────────────────────────────────
const CLIENT_SECRET = () => process.env.LINE_CHANNEL_SECRET || '';
const CLIENT_TOKEN  = () => process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

// ── 繪新派單客服（員工／學員用）──────────────────────────────
const STAFF_SECRET  = () => process.env.LINE_STAFF_CHANNEL_SECRET || '';
const STAFF_TOKEN   = () => process.env.LINE_STAFF_CHANNEL_ACCESS_TOKEN || '';

// ── LINE OAT 加好友管道對照表 ──────────────────────────────────
const OAT_SOURCE_MAP = {
  '6736785': 'Instagram · bio連結',
  '6736811': 'Instagram · 限時動態',
  '6737158': 'Instagram · 貼文留言',
  '6736822': 'Facebook · 粉絲頁',
  '6737168': 'Facebook · 貼文',
  '6737262': 'Facebook · 私訊',
  '6737171': 'YouTube · 影片說明欄',
  '6737177': 'TikTok · 個人頁bio',
  '6737183': 'Threads · 個人頁bio',
  '6737187': '官網 · 首頁按鈕',
  '6737192': '實體 · 名片',
  '6737193': '實體 · 海報DM',
};

// ── 共用工具 ──────────────────────────────────────────────────

function verifySignature(rawBody, signature, secret) {
  if (!secret) return false;
  const hash = crypto.createHmac('SHA256', secret).update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature)); }
  catch { return false; }
}

async function lineGet(path, token) {
  try {
    const res = await fetch(`https://api.line.me${path}`, {
      headers: { Authorization: `Bearer ${(token||'').replace(/\s/g,'')}` }
    });
    if (!res.ok) { console.warn(`[LINE-GET] ${path} → HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (e) { console.warn(`[LINE-GET] ${path} 例外：${e.message}`); return null; }   // 永不丟例外，避免中斷後續存訊息
}

async function reply(replyToken, text, token) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(token||'').replace(/\s/g,'')}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  }).catch(err => console.error('LINE reply error:', err));
}

// 推播給員工／學員（使用派單客服頻道）
async function pushMessage(lineUserId, text) {
  if (!lineUserId || !STAFF_TOKEN()) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STAFF_TOKEN()}` },
    body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] })
  }).catch(err => console.error('LINE push error:', err));
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

// ══════════════════════════════════════════════════════════════
// Webhook 1：客戶頻道（支援多分店 LINE OA）
// 所有分店的 LINE Developer Console Webhook URL 都設為：/webhook/line
// ══════════════════════════════════════════════════════════════

router.post('/line', express.raw({ type: '*/*' }), (req, res) => {
  res.status(200).end();

  const sig = req.headers['x-line-signature'];
  if (!sig) { console.warn('[LINE-WEBHOOK] 缺少 x-line-signature header'); return; }

  const rawBody = req.body;

  // 先嘗試 DB 裡的多頻道設定，再 fallback 到環境變數
  const dbChannels = db.prepare(`SELECT * FROM line_channels WHERE active=1`).all();
  let matchedChannel = null;

  for (const ch of dbChannels) {
    if (verifySignature(rawBody, sig, ch.channel_secret)) {
      matchedChannel = ch;
      break;
    }
  }

  // fallback：繪新臺中環境變數
  if (!matchedChannel && process.env.LINE_TAICHUNG_CHANNEL_SECRET &&
      verifySignature(rawBody, sig, process.env.LINE_TAICHUNG_CHANNEL_SECRET)) {
    const tcOrg = db.prepare(`SELECT id FROM orgs WHERE name LIKE '%台中%' LIMIT 1`).get();
    matchedChannel = { id: null, org_id: tcOrg?.id || null, channel_token: process.env.LINE_TAICHUNG_CHANNEL_TOKEN || '', welcome_msg: null, channel_name: '繪新臺中-env' };
  }

  // fallback：環境變數（原有頻道，視為總部）
  if (!matchedChannel && verifySignature(rawBody, sig, CLIENT_SECRET())) {
    const hqOrg = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
    matchedChannel = { id: null, org_id: hqOrg?.id || null, channel_token: CLIENT_TOKEN(), welcome_msg: null };
  }

  if (!matchedChannel) {
    // 簽名沒對到任何頻道 → 訊息會被丟掉。印出這批事件的來源類型，方便判斷是不是群組訊息被擋在門外
    let srcInfo = '?';
    try { const p = JSON.parse(rawBody.toString()); srcInfo = (p.events||[]).map(e=>`${e.type}/${e.source?.type||'-'}`).join(','); } catch {}
    console.error(`[LINE-WEBHOOK] 簽名驗證失敗（訊息丟棄）— DB頻道數:${dbChannels.length} CLIENT_SECRET長度:${CLIENT_SECRET().length} 事件:[${srcInfo}]`);
    return;
  }

  let payload;
  try { payload = JSON.parse(rawBody.toString()); } catch (e) { console.error('[LINE-WEBHOOK] JSON parse error:', e.message); return; }

  console.log(`[LINE-WEBHOOK] 收到 ${payload.events?.length || 0} 個事件，頻道: ${matchedChannel.channel_name || 'env-fallback'}，來源:[${(payload.events||[]).map(e=>`${e.type}/${e.source?.type||'-'}`).join(',')}]`);

  for (const event of (payload.events || [])) {
    if (event.type === 'message') {
      // 收所有訊息類型（文字/照片/貼圖/影片/檔案/定位），不再只收文字
      handleClientMessage(event, matchedChannel).catch(err => console.error('CLIENT webhook error:', err));
    }
    if (event.type === 'follow') {
      handleClientFollow(event, matchedChannel).catch(err => console.error('CLIENT follow error:', err));
    }
  }
});

// 客戶送出綁定碼（HXBxxxxxx）→ 把 line_user_id 綁到客服建的客戶檔
// 含：店別歸屬（以實際送碼的 OA 為準）＋去重合併（客人先前自動建的客戶檔）
// 回傳 true = 這是綁定碼訊息（已處理／已回覆），呼叫端不要再存成詢問
async function handleClientBind(text, userId, channel, replyToken) {
  const m = (text || '').match(/HXB[0-9A-Za-z]{6}/);
  if (!m) return false;
  const code  = m[0];
  const token = db.prepare(`SELECT * FROM client_bind_tokens WHERE code=?`).get(code);

  if (!token) {
    await reply(replyToken, `找不到這組綁定碼，可能已失效。請向繪新客服索取新的綁定連結。`, channel.channel_token);
    return true;
  }
  if (token.used_at) {
    await reply(replyToken, `這組綁定碼已經使用過囉。若需重新綁定，請向客服索取新的綁定連結。`, channel.channel_token);
    return true;
  }
  if (token.expires_at && db.prepare(`SELECT datetime(?) < datetime('now') AS x`).get(token.expires_at).x) {
    await reply(replyToken, `這組綁定碼已過期，請向繪新客服索取新的綁定連結。`, channel.channel_token);
    return true;
  }

  const target = db.prepare(`SELECT * FROM clients WHERE id=?`).get(token.client_id);
  if (!target) {
    await reply(replyToken, `綁定失敗：找不到對應的客戶資料，請聯繫客服。`, channel.channel_token);
    return true;
  }

  // 去重合併：客人先前傳訊時系統可能已自動建過一筆客戶（同 line_user_id）
  const dups = db.prepare(`SELECT * FROM clients WHERE line_user_id=? AND id<>?`).all(userId, target.id);
  for (const d of dups) {
    db.prepare(`UPDATE line_inquiries SET client_id=? WHERE client_id=?`).run(target.id, d.id);
    const autoCreated = d.source === 'LINE' && !d.phone && !d.email && !d.address && !d.tax_id;
    if (autoCreated) db.prepare(`DELETE FROM clients WHERE id=?`).run(d.id);
    else             db.prepare(`UPDATE clients SET line_user_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(d.id);
  }

  // 店別歸屬：以客人實際送碼的 OA 為準；與建檔店別不同 → 標記提醒客服確認
  const mismatch = (token.org_id && channel.org_id && token.org_id !== channel.org_id) ? 1 : 0;
  db.prepare(`
    UPDATE clients
    SET line_user_id=?, line_channel_id=?, org_id=COALESCE(?, org_id),
        bind_org_mismatch=?, bound_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(userId, channel.id || null, channel.org_id || null, mismatch, target.id);

  db.prepare(`UPDATE client_bind_tokens SET used_at=CURRENT_TIMESTAMP, bound_line_user_id=?, bound_channel_id=? WHERE id=?`)
    .run(userId, channel.id || null, token.id);

  console.log(`[CLIENT-BIND] ✅ client=${target.id}(${target.name}) line=${userId} ch=${channel.channel_name || channel.id || 'env'} mismatch=${mismatch}`);
  await reply(replyToken,
    `✅ 綁定成功！\n${target.name} 您好，之後我們會直接透過這裡傳送報價單、場勘與驗收等資料給您。`,
    channel.channel_token);
  return true;
}

// 客戶傳訊 → 建立／追加 LINE 詢問單（收所有訊息類型與 1對1／群組，一律不丟）
async function handleClientMessage(event, channel) {
  const srcType = event.source?.type;            // 'user' | 'group' | 'room'
  const isGroup = srcType === 'group' || srcType === 'room';
  const userId  = event.source?.userId || null;  // 群組裡的發話者（用戶可能關閉分享 → null）
  const convId  = event.source?.groupId || event.source?.roomId || null;
  const threadKey = isGroup ? convId : userId;   // 對話線 key：1對1用 userId、群組用 groupId
  const msg = event.message || {};
  console.log(`[LINE-MSG] 進入處理 srcType=${srcType} conv=${convId||'-'} sender=${userId||'-'} type=${msg.type} ch=${channel.channel_name||channel.id||'env'}`);
  if (!threadKey) { console.warn(`[LINE-MSG] 丟棄：無 threadKey（群組沒 groupId？）srcType=${srcType}`); return; }

  // 綁定碼攔截：1對1文字命中綁定碼 → 完成綁定並結束，不存成詢問
  if (!isGroup && userId && msg.type === 'text') {
    try {
      if (await handleClientBind(msg.text, userId, channel, event.replyToken)) return;
    } catch (e) { console.error('[CLIENT-BIND] 例外', e.message); }
  }

  // 依訊息類型決定：儲存型別 / 內容 / 清單預覽字
  let msgType = 'text', content = null, preview = '';
  if (msg.type === 'text') {
    content = (msg.text || '').trim();
    if (!content) { console.warn('[LINE-MSG] 丟棄：空白文字'); return; }
    preview = content.slice(0, 200);
  } else if (msg.type === 'image') {
    const url = await fetchLineImageToCloudinary(msg.id, channel.channel_token);
    if (url) { msgType = 'image'; content = url; }
    else     { msgType = 'text'; content = '[照片]（系統未能下載，請於 LINE 查看或請客戶重傳）'; }
    preview = '[照片]';
  } else {
    // 貼圖 / 影片 / 語音 / 檔案 / 定位：存佔位文字，讓時間軸不斷、客服知道有東西進來
    preview = MSG_LABEL[msg.type] || `[${msg.type || '訊息'}]`;
    content = preview;
  }

  // 顯示名稱 + 大頭照 + 群組發話者：1對1抓個人檔案；群組抓群名＋成員名
  // 注意：這段「加值」用 try 包住，任何 LINE API 問題都不可中斷後面的「存訊息」（否則群組/1對1訊息會遺失）
  let displayName = isGroup ? (srcType === 'room' ? 'LINE 多人聊天室' : 'LINE 群組') : 'LINE用戶';
  let senderDisplay = isGroup ? '群組成員' : null, avatarUrl = null, senderAvatar = null;
  try {
    if (isGroup) {
      const summary = srcType === 'group' ? await lineGet(`/v2/bot/group/${convId}/summary`, channel.channel_token) : null;
      if (summary?.groupName) displayName = summary.groupName;
      avatarUrl = summary?.pictureUrl || null;   // 群組大頭照
      if (userId) {
        const base = srcType === 'group' ? `/v2/bot/group/${convId}` : `/v2/bot/room/${convId}`;
        const mp = await lineGet(`${base}/member/${userId}/profile`, channel.channel_token);
        senderDisplay = mp?.displayName || '群組成員';
        senderAvatar  = mp?.pictureUrl || null;    // 群組發話者大頭照
      }
    } else {
      const profile = await lineGet(`/v2/bot/profile/${userId}`, channel.channel_token);
      displayName = profile?.displayName || 'LINE用戶';
      avatarUrl   = profile?.pictureUrl || null;   // 客人大頭照
    }
  } catch (e) { console.warn(`[LINE-MSG] 名稱/頭貼加值失敗（不影響存訊息）：${e.message}`); }

  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const orgId   = channel.org_id || null;
  const sysId   = sysUser?.id || null;

  // clients 記錄：只有 1 對 1 才建/同步（群組不建 client）
  let clientId = null;
  if (!isGroup) {
    let client = db.prepare(`SELECT * FROM clients WHERE line_user_id=?`).get(userId);
    if (!client) {
      const r = db.prepare(`INSERT INTO clients (org_id, name, source, line_user_id, created_by) VALUES (?, ?, 'LINE', ?, ?)`)
        .run(orgId, displayName, userId, sysId);
      client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(r.lastInsertRowid);
    } else if (client.name !== displayName) {
      db.prepare(`UPDATE clients SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(displayName, client.id);
    }
    clientId = client.id;
  }

  // 每個客人只有「一個對話視窗」：一律掛到這位客人（同頻道）最近的那一筆詢問，
  // 不論狀態（new / in_progress / converted 都直接接續），避免轉案後又多開一筆。
  const existing = db.prepare(`
    SELECT id, status, converted_case_id FROM line_inquiries
    WHERE line_user_id=? AND (channel_id IS ? OR channel_id IS NULL)
    ORDER BY id DESC LIMIT 1
  `).get(threadKey, channel.id || null);

  let inquiryId = existing?.id || null;

  if (existing) {
    // 這條先前被結束（無效／隱藏，或已轉案但案件已結案/無效）→ 收到新訊息就「復活」回新詢問，
    // 用同一個視窗、不另開；已轉案且案件仍進行中 → 維持已轉案，直接接續訊息。
    let revive = existing.status === 'invalid' || existing.status === 'hidden';
    if (!revive && existing.status === 'converted' && existing.converted_case_id) {
      const cc = db.prepare(`SELECT status FROM cases WHERE id=?`).get(existing.converted_case_id);
      if (cc && (cc.status === 'closed' || cc.status === 'invalid')) revive = true;
    }
    if (revive) {
      db.prepare(`UPDATE line_inquiries SET status='new', converted_case_id=NULL, converted_at=NULL WHERE id=?`).run(inquiryId);
    }
  }

  if (!inquiryId) {
    const addSource = !isGroup
      ? (db.prepare(`SELECT add_source FROM line_follow_sources WHERE line_user_id=?`).get(threadKey)?.add_source || null)
      : null;
    const r = db.prepare(`
      INSERT INTO line_inquiries (line_user_id, client_id, display_name, line_original_name, last_message, message_count, org_id, channel_id, add_source, is_group, avatar_url)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(threadKey, clientId, displayName, displayName, preview, orgId, channel.id || null, addSource, isGroup ? 1 : 0, avatarUrl);
    inquiryId = r.lastInsertRowid;
  }

  // 存訊息（群組帶發話者＋發話者大頭照＋引用回覆用的 quoteToken）
  db.prepare(`INSERT INTO line_inquiry_messages (inquiry_id, direction, msg_type, content, sender_display, sender_avatar, quote_token) VALUES (?, 'in', ?, ?, ?, ?, ?)`)
    .run(inquiryId, msgType, content, senderDisplay, senderAvatar, msg.quoteToken || null);
  db.prepare(`
    UPDATE line_inquiries
    SET last_message=?, last_message_at=CURRENT_TIMESTAMP,
        message_count=message_count+1,
        line_original_name=?,
        display_name=CASE WHEN name_locked=1 THEN display_name ELSE ? END,
        avatar_url=COALESCE(?, avatar_url), updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    isGroup && senderDisplay ? `${senderDisplay}：${preview}`.slice(0, 200) : preview,
    displayName,   // 一律更新「LINE 原始名稱」(唯讀欄)
    displayName,   // 只有未鎖定時才覆蓋手動輸入的 display_name
    avatarUrl, inquiryId);

  console.log(`[LINE-MSG] ✅ 已存入 LINE 詢問 inquiryId=${inquiryId} isGroup=${isGroup?1:0} name="${displayName}"`);

  // AI 草稿改為「手動觸發」以節省 API credit：客服在 LINE 詢問按「🤖 產生 AI 建議回覆」才跑
  // （原本每則客人私訊都自動擬稿，是最大的背景消耗來源；改成按鈕才跑）

  // 自動回覆已關閉：訊息收進系統但不主動回覆客戶
}

// 客戶加好友歡迎語
async function handleClientFollow(event, channel) {
  if (event.source?.type !== 'user') return;
  const userId = event.source?.userId;
  if (!userId) return;
  const profile = await lineGet(`/v2/bot/profile/${userId}`, channel.channel_token);
  const name    = profile?.displayName || 'LINE用戶';
  const welcome = channel.welcome_msg ||
    `您好 ${name}！歡迎加入繪新國際 🎨\n\n有任何裝潢貼膜需求，直接傳訊息給我們，我們會立即為您安排客服聯繫！`;
  await reply(event.replyToken, welcome, channel.channel_token);

  // 記錄 OAT 來源管道，等首則訊息時帶入詢問單
  const oatId = event.referralInfo?.oatId?.toString();
  const sourceName = oatId ? OAT_SOURCE_MAP[oatId] : null;
  console.log(`[FOLLOW] userId=${userId} referralInfo=${JSON.stringify(event.referralInfo||null)} oatId=${oatId||'無'} source=${sourceName||'未對應'}`);
  if (sourceName) {
    db.prepare(`INSERT OR REPLACE INTO line_follow_sources (line_user_id, add_source) VALUES (?, ?)`)
      .run(userId, sourceName);
  }
}

// ══════════════════════════════════════════════════════════════
// Webhook 2：繪新派單客服（員工／學員頻道）
// LINE Developer Console Webhook URL：/webhook/line-staff
// ══════════════════════════════════════════════════════════════

router.post('/line-staff', express.raw({ type: '*/*' }), (req, res) => {
  res.status(200).end();

  const sig = req.headers['x-line-signature'];
  if (!sig || !verifySignature(req.body, sig, STAFF_SECRET())) return;

  let payload;
  try { payload = JSON.parse(req.body.toString()); } catch { return; }

  for (const event of (payload.events || [])) {
    if (event.type === 'message' && event.message?.type === 'text') {
      handleStaffText(event).catch(err => console.error('STAFF webhook error:', err));
    }
    if (event.type === 'follow') {
      handleStaffFollow(event).catch(err => console.error('STAFF follow error:', err));
    }
  }
});

// 員工／學員傳訊：「綁定 帳號」指令
async function handleStaffText(event) {
  if (event.source?.type !== 'user') return;
  const userId = event.source?.userId;
  if (!userId) return;
  const text = event.message.text.trim();

  // 綁定指令
  const bindMatch = text.match(/^綁定\s+(\S+)$/);
  if (bindMatch) {
    const username = bindMatch[1].trim();
    console.log(`[BIND] userId=${userId} username="${username}"`);
    const emp = db.prepare(`SELECT id, name, role FROM users WHERE username=? AND active=1 COLLATE NOCASE`).get(username);
    if (!emp) {
      await reply(event.replyToken,
        `找不到帳號「${username}」，請確認系統登入帳號後再試。`,
        STAFF_TOKEN()
      );
      return;
    }
    db.prepare(`UPDATE users SET line_user_id=? WHERE id=?`).run(userId, emp.id);
    await reply(event.replyToken,
      `✅ 綁定成功！\n帳號：${username}（${emp.name}）\n\n之後派工通知與接案審核結果將直接傳送到這裡。`,
      STAFF_TOKEN()
    );
    return;
  }

  // 查詢員工帳號
  const emp = db.prepare(`SELECT id, name FROM users WHERE line_user_id=? AND active=1`).get(userId);

  // 請假指令：請假 特休 2026-06-01 8 請假原因
  const leaveMatch = text.match(/^請假\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d+(?:\.\d+)?)(.*)?$/);
  if (leaveMatch) {
    if (!emp) { await reply(event.replyToken, '請先綁定帳號才能使用請假功能。\n指令：綁定 你的系統帳號', STAFF_TOKEN()); return; }
    const [, leave_type, leave_date, hours, reasonRaw] = leaveMatch;
    const valid = ['特休','病假','事假','生理假','家庭照顧假','公假','婚假','喪假','產假','產檢假','補休/調休','其他'];
    if (!valid.includes(leave_type)) {
      await reply(event.replyToken, `假別不正確，可用：${valid.join('、')}`, STAFF_TOKEN()); return;
    }
    const reason = (reasonRaw || '').trim() || null;
    db.prepare(`INSERT INTO leave_requests (user_id, leave_type, leave_date, hours, reason) VALUES (?,?,?,?,?)`)
      .run(emp.id, leave_type, leave_date, parseFloat(hours), reason);
    const hrs = db.prepare(`SELECT id FROM users WHERE role IN ('owner','hq_hr') AND active=1`).all();
    const insN = db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'leave','users',?,?)`);
    for (const h of hrs) insN.run(h.id, `${emp.name} 申請請假`, `${leave_type}｜${leave_date}｜${hours}小時${reason?'\n'+reason:''}`, emp.id, '/hr');
    await reply(event.replyToken, `✅ 請假申請已送出！\n假別：${leave_type}\n日期：${leave_date}\n時數：${hours} 小時\n審核結果將通知您。`, STAFF_TOKEN());
    return;
  }

  // 補打卡指令：補打卡 2026-06-01 原因說明
  const makeupMatch = text.match(/^補打卡\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/);
  if (makeupMatch) {
    if (!emp) { await reply(event.replyToken, '請先綁定帳號才能使用補打卡功能。\n指令：綁定 你的系統帳號', STAFF_TOKEN()); return; }
    const [, makeup_date, reason] = makeupMatch;
    db.prepare(`INSERT INTO makeup_requests (user_id, makeup_date, reason) VALUES (?,?,?)`)
      .run(emp.id, makeup_date, reason);
    const hrs = db.prepare(`SELECT id FROM users WHERE role IN ('owner','hq_hr') AND active=1`).all();
    const insN = db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'makeup','users',?,?)`);
    for (const h of hrs) insN.run(h.id, `${emp.name} 申請補打卡`, `補打卡日期：${makeup_date}\n${reason}`, emp.id, '/hr');
    await reply(event.replyToken, `✅ 補打卡申請已送出！\n日期：${makeup_date}\n審核結果將通知您。`, STAFF_TOKEN());
    return;
  }

  // 請假申請（圖文選單按鈕）
  if (text === '請假申請') {
    const msg = emp
      ? `📅 請假申請格式：\n\n請假 假別 日期 時數 原因\n\n例：請假 特休 2026-06-01 8 出遊\n\n可用假別：特休、病假、事假、生理假、家庭照顧假、公假、婚假、喪假、產假、產檢假、補休/調休、其他`
      : '請先綁定帳號。\n指令：綁定 你的系統帳號\n例：綁定 flora';
    await reply(event.replyToken, msg, STAFF_TOKEN()); return;
  }

  // 補打卡申請（圖文選單按鈕）
  if (text === '補打卡申請') {
    const msg = emp
      ? `✏️ 補打卡申請格式：\n\n補打卡 日期 原因\n\n例：補打卡 2026-06-01 忘記打卡`
      : '請先綁定帳號。\n指令：綁定 你的系統帳號\n例：綁定 flora';
    await reply(event.replyToken, msg, STAFF_TOKEN()); return;
  }

  // 說明
  const helpText = emp
    ? `${emp.name} 您好！可用指令：\n\n【請假】\n請假 假別 日期 時數 原因\n例：請假 特休 2026-06-01 8 出遊\n\n假別：特休、病假、事假、生理假、家庭照顧假、公假、婚假、喪假、產假、產檢假、補休/調休、其他\n\n【補打卡】\n補打卡 日期 原因\n例：補打卡 2026-06-01 忘記打卡`
    : `您好！這是繪新派單系統。\n\n若要綁定帳號，請傳送：\n綁定 你的系統帳號\n\n例如：綁定 flora`;
  await reply(event.replyToken, helpText, STAFF_TOKEN());
}

// 員工／學員加好友歡迎語
async function handleStaffFollow(event) {
  if (event.source?.type !== 'user') return;
  const userId = event.source?.userId;
  if (!userId) return;
  const profile = await lineGet(`/v2/bot/profile/${userId}`, STAFF_TOKEN());
  const name    = profile?.displayName || '夥伴';
  await reply(event.replyToken,
    `${name} 您好！歡迎加入繪新派單系統 🏗️\n\n` +
    `請傳送以下指令綁定您的系統帳號：\n綁定 你的帳號\n\n` +
    `例如：綁定 flora\n\n綁定後即可接收派工通知與接案審核結果。`,
    STAFF_TOKEN()
  );
}

module.exports = router;
module.exports.pushMessage = pushMessage;
