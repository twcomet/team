const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const router  = express.Router();

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
  const res = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.ok ? res.json() : null;
}

async function reply(replyToken, text, token) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
  if (!sig) return;

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

  // fallback：環境變數（原有頻道，視為總部）
  if (!matchedChannel && verifySignature(rawBody, sig, CLIENT_SECRET())) {
    const hqOrg = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
    matchedChannel = { id: null, org_id: hqOrg?.id || null, channel_token: CLIENT_TOKEN(), welcome_msg: null };
  }

  if (!matchedChannel) return;

  let payload;
  try { payload = JSON.parse(rawBody.toString()); } catch { return; }

  for (const event of (payload.events || [])) {
    if (event.type === 'message' && event.message?.type === 'text') {
      handleClientText(event, matchedChannel).catch(err => console.error('CLIENT webhook error:', err));
    }
    if (event.type === 'follow') {
      handleClientFollow(event, matchedChannel).catch(err => console.error('CLIENT follow error:', err));
    }
  }
});

// 客戶傳訊 → 建立／追加 LINE 詢問單
async function handleClientText(event, channel) {
  // 只處理個人 1 對 1 訊息；群組 / 多人聊天室訊息一律忽略
  if (event.source?.type !== 'user') return;

  const userId = event.source?.userId;
  if (!userId) return;
  const text = event.message.text.trim();

  const profile     = await lineGet(`/v2/bot/profile/${userId}`, channel.channel_token);
  const displayName = profile?.displayName || 'LINE用戶';

  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const orgId   = channel.org_id || null;
  const sysId   = sysUser?.id || null;

  // 確保 clients 記錄存在，並同步最新 LINE 顯示名稱
  let client = db.prepare(`SELECT * FROM clients WHERE line_user_id=?`).get(userId);
  if (!client) {
    const r = db.prepare(`
      INSERT INTO clients (org_id, name, source, line_user_id, created_by)
      VALUES (?, ?, 'LINE', ?, ?)
    `).run(orgId, displayName, userId, sysId);
    client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(r.lastInsertRowid);
  } else if (client.name !== displayName) {
    // LINE 用戶改名 → 同步更新 clients 顯示名稱
    db.prepare(`UPDATE clients SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(displayName, client.id);
    client = { ...client, name: displayName };
  }

  // 找同一頻道最近一筆開放中的詢問，若無則建新的
  const openInquiry = db.prepare(`
    SELECT * FROM line_inquiries
    WHERE line_user_id=? AND status IN ('new','in_progress')
      AND (channel_id IS ? OR channel_id IS NULL)
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, channel.id || null);

  let inquiryId;
  if (openInquiry) {
    // 既有進行中詢問 → 追加訊息
    inquiryId = openInquiry.id;
    db.prepare(`
      UPDATE line_inquiries
      SET last_message=?, last_message_at=CURRENT_TIMESTAMP,
          message_count=message_count+1, display_name=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(text.slice(0, 200), displayName, inquiryId);
  } else {
    // 檢查是否已有尚未結案的案件（透過 line_source 或 client_id 關聯）
    const activeCase = db.prepare(`
      SELECT id FROM cases
      WHERE status NOT IN ('closed','invalid')
        AND (line_source=? OR client_id=?)
      LIMIT 1
    `).get(userId, client.id);

    if (activeCase) {
      // 已有進行中案件，不建立新詢問，訊息附掛到最近一筆已轉案的詢問
      const convertedInquiry = db.prepare(`
        SELECT id FROM line_inquiries
        WHERE line_user_id=? AND status='converted'
        ORDER BY updated_at DESC LIMIT 1
      `).get(userId);
      if (convertedInquiry) {
        db.prepare(`
          INSERT INTO line_inquiry_messages (inquiry_id, direction, msg_type, content)
          VALUES (?, 'in', 'text', ?)
        `).run(convertedInquiry.id, text);
      }
      return; // 不建立新詢問
    }

    // 真正的新詢問 → 建立（帶入 OAT 來源管道）
    const followSrc = db.prepare(`SELECT add_source FROM line_follow_sources WHERE line_user_id=?`).get(userId);
    const addSource = followSrc?.add_source || null;
    const r = db.prepare(`
      INSERT INTO line_inquiries (line_user_id, client_id, display_name, line_original_name, last_message, message_count, org_id, channel_id, add_source)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(userId, client.id, displayName, displayName, text.slice(0, 200), orgId, channel.id || null, addSource);
    inquiryId = r.lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO line_inquiry_messages (inquiry_id, direction, msg_type, content)
    VALUES (?, 'in', 'text', ?)
  `).run(inquiryId, text);

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
    const valid = ['特休','病假','事假','公假','婚假','喪假','補休','其他'];
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
      ? `📅 請假申請格式：\n\n請假 假別 日期 時數 原因\n\n例：請假 特休 2026-06-01 8 出遊\n\n可用假別：特休、病假、事假、公假、婚假、喪假、補休、其他`
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
    ? `${emp.name} 您好！可用指令：\n\n【請假】\n請假 假別 日期 時數 原因\n例：請假 特休 2026-06-01 8 出遊\n\n假別：特休、病假、事假、公假、婚假、喪假、補休、其他\n\n【補打卡】\n補打卡 日期 原因\n例：補打卡 2026-06-01 忘記打卡`
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
