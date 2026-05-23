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
// Webhook 1：繪新國際（客戶頻道）
// LINE Developer Console Webhook URL：/webhook/line
// ══════════════════════════════════════════════════════════════

router.post('/line', express.raw({ type: '*/*' }), (req, res) => {
  res.status(200).end();

  const sig = req.headers['x-line-signature'];
  if (!sig || !verifySignature(req.body, sig, CLIENT_SECRET())) return;

  let payload;
  try { payload = JSON.parse(req.body.toString()); } catch { return; }

  for (const event of (payload.events || [])) {
    if (event.type === 'message' && event.message?.type === 'text') {
      handleClientText(event).catch(err => console.error('CLIENT webhook error:', err));
    }
    if (event.type === 'follow') {
      handleClientFollow(event).catch(err => console.error('CLIENT follow error:', err));
    }
  }
});

// 客戶傳訊 → 自動建案
async function handleClientText(event) {
  const userId = event.source?.userId;
  if (!userId) return;
  const text = event.message.text.trim();

  const profile     = await lineGet(`/v2/bot/profile/${userId}`, CLIENT_TOKEN());
  const displayName = profile?.displayName || 'LINE用戶';

  const hqOrg   = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const orgId   = hqOrg?.id   || null;
  const sysId   = sysUser?.id || null;

  let client = db.prepare(`SELECT * FROM clients WHERE line_user_id=?`).get(userId);
  if (!client) {
    const r = db.prepare(`
      INSERT INTO clients (org_id, name, source, line_user_id, created_by)
      VALUES (?, ?, 'LINE', ?, ?)
    `).run(orgId, displayName, userId, sysId);
    client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(r.lastInsertRowid);
  }

  const caseNumber = genCaseNumber();
  db.prepare(`
    INSERT INTO cases (
      case_number, org_id, case_type, client_id,
      title, description, line_source,
      status, priority, created_by, updated_at
    ) VALUES (?, ?, 'other', ?, ?, ?, ?, 'initial_estimate', 'normal', ?, CURRENT_TIMESTAMP)
  `).run(caseNumber, orgId, client.id,
    `LINE詢問｜${displayName}`, text.slice(0, 500), userId, sysId);

  console.log(`LINE客戶詢問建案：${caseNumber} from ${displayName}`);

  await reply(event.replyToken,
    `您好 ${displayName}！已收到您的詢問 🙏\n` +
    `案件編號：${caseNumber}\n\n` +
    `我們的客服人員將在工作時間內盡快與您聯繫，感謝您的耐心等候！`,
    CLIENT_TOKEN()
  );
}

// 客戶加好友歡迎語
async function handleClientFollow(event) {
  const userId = event.source?.userId;
  if (!userId) return;
  const profile = await lineGet(`/v2/bot/profile/${userId}`, CLIENT_TOKEN());
  const name    = profile?.displayName || 'LINE用戶';
  await reply(event.replyToken,
    `您好 ${name}！歡迎加入繪新國際 🎨\n\n` +
    `有任何裝潢貼膜需求，直接傳訊息給我們，我們會立即為您建立詢問單並安排客服聯繫！`,
    CLIENT_TOKEN()
  );
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
