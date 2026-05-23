const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const router  = express.Router();

const CHANNEL_SECRET = () => process.env.LINE_CHANNEL_SECRET || '';
const ACCESS_TOKEN   = () => process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

// ── 工具函式 ──────────────────────────────────────────────────

function verifySignature(rawBody, signature) {
  const hash = crypto.createHmac('SHA256', CHANNEL_SECRET()).update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature)); }
  catch { return false; }
}

async function lineGet(path) {
  const res = await fetch(`https://api.line.me${path}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN()}` }
  });
  return res.ok ? res.json() : null;
}

async function replyMessage(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_TOKEN()}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
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

// ── Webhook 端點 ──────────────────────────────────────────────

// express.raw 必須在 express.json() 之前掛載，server.js 裡已排序
router.post('/line', express.raw({ type: '*/*' }), (req, res) => {
  res.status(200).end(); // 必須立即回應 200

  const sig = req.headers['x-line-signature'];
  if (!sig || !CHANNEL_SECRET()) return;
  if (!verifySignature(req.body, sig)) {
    console.warn('LINE webhook: signature mismatch');
    return;
  }

  let payload;
  try { payload = JSON.parse(req.body.toString()); }
  catch { return; }

  for (const event of (payload.events || [])) {
    if (event.type === 'message' && event.message?.type === 'text') {
      handleText(event).catch(err => console.error('LINE webhook error:', err));
    }
    if (event.type === 'follow') {
      handleFollow(event).catch(err => console.error('LINE follow error:', err));
    }
  }
});

// ── 處理文字訊息 ───────────────────────────────────────────────

async function handleText(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  const text    = event.message.text.trim();
  const msgDate = new Date(event.timestamp).toISOString().slice(0, 10);

  // 取得 LINE 顯示名稱
  const profile     = await lineGet(`/v2/bot/profile/${userId}`);
  const displayName = profile?.displayName || 'LINE用戶';

  // 取得預設 org / 系統使用者
  const hqOrg  = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const sysUser = db.prepare(`SELECT id FROM users WHERE role='owner' LIMIT 1`).get();
  const orgId  = hqOrg?.id  || null;
  const userId_ = sysUser?.id || null;

  // 找或建立客戶（以 line_user_id 識別）
  let client = db.prepare(`SELECT * FROM clients WHERE line_user_id=?`).get(userId);
  if (!client) {
    const r = db.prepare(`
      INSERT INTO clients (org_id, name, source, line_user_id, created_by)
      VALUES (?, ?, 'LINE', ?, ?)
    `).run(orgId, displayName, userId, userId_);
    client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(r.lastInsertRowid);
  }

  // 建立詢問案件
  const caseNumber = genCaseNumber();
  db.prepare(`
    INSERT INTO cases (
      case_number, org_id, case_type, client_id,
      title, description, line_source,
      status, priority, created_by, updated_at
    ) VALUES (?, ?, 'other', ?, ?, ?, ?, 'initial_estimate', 'normal', ?, CURRENT_TIMESTAMP)
  `).run(
    caseNumber, orgId, client.id,
    `LINE詢問｜${displayName}`,
    text.slice(0, 500),
    userId,
    userId_
  );

  console.log(`LINE inquiry created: ${caseNumber} from ${displayName} (${userId})`);

  // 回覆客戶
  await replyMessage(event.replyToken,
    `您好 ${displayName}！已收到您的詢問 🙏\n` +
    `案件編號：${caseNumber}\n\n` +
    `我們的客服人員將在工作時間內盡快與您聯繫，感謝您的耐心等候！`
  );
}

// ── 加好友事件 ─────────────────────────────────────────────────

async function handleFollow(event) {
  const userId = event.source?.userId;
  if (!userId) return;
  const profile = await lineGet(`/v2/bot/profile/${userId}`);
  const name    = profile?.displayName || 'LINE用戶';
  await replyMessage(event.replyToken,
    `您好 ${name}！歡迎加入繪新國際 🎨\n\n` +
    `有任何裝潢貼膜需求，直接傳訊息給我們，我們會立即為您建立詢問單並安排客服聯繫！`
  );
}

module.exports = router;
