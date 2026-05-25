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

  // 確保 clients 記錄存在
  let client = db.prepare(`SELECT * FROM clients WHERE line_user_id=?`).get(userId);
  if (!client) {
    const r = db.prepare(`
      INSERT INTO clients (org_id, name, source, line_user_id, created_by)
      VALUES (?, ?, 'LINE', ?, ?)
    `).run(orgId, displayName, userId, sysId);
    client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(r.lastInsertRowid);
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
    inquiryId = openInquiry.id;
    db.prepare(`
      UPDATE line_inquiries
      SET last_message=?, last_message_at=CURRENT_TIMESTAMP,
          message_count=message_count+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(text.slice(0, 200), inquiryId);
  } else {
    const r = db.prepare(`
      INSERT INTO line_inquiries (line_user_id, client_id, display_name, line_original_name, last_message, message_count, org_id, channel_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(userId, client.id, displayName, displayName, text.slice(0, 200), orgId, channel.id || null);
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
    const username = bindMatch[1];
    const emp = db.prepare(`SELECT id, name, role FROM users WHERE username=? AND active=1`).get(username);
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

  // 其他訊息
  await reply(event.replyToken,
    `您好！這是繪新派單系統。\n\n若要綁定帳號接收通知，請傳送：\n綁定 你的系統帳號\n\n例如：綁定 flora`,
    STAFF_TOKEN()
  );
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
