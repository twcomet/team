// AI 顧問（第一版：特助 AI 顧問）── 彙整全系統案件現況快照，交給 Claude 洞察風險/機會/待跟進
const express = require('express');
const db = require('../db');
const { requireAuth, orgFilterSQL } = require('../middleware/auth');
const router = express.Router();

const MODEL = 'claude-sonnet-5';

const STATUS_LABEL = {
  inquiry:'詢價需初步估價', initial_estimate:'已初步估價', quote_needed:'需出估價單', quote_sent:'已出估價單',
  survey_pending:'待排場勘', survey_scheduled:'已排場勘', surveyed:'已場勘', quote_draft:'已建報價資料',
  quoted:'已發報價單', contracted:'成交待派工', dispatched:'已派工待施工', constructing:'施工中',
  payment:'完工請款', closed:'結案保存', invalid:'無效保存'
};

// 只有老闆／管理者能用（涉及全公司經營資料）
function canUse(me) { return me.role === 'owner' || !!me.manage_users || !!me.is_manager; }

// 彙整現況快照（尊重分店權限範圍）
function gatherSnapshot(me) {
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const orgCond = orgSql ? ` AND ${orgSql}` : '';
  const q = (sql) => { try { return db.prepare(sql).all(...orgPs); } catch (e) { return []; } };

  // 進行中案件狀態分佈（數量＋金額）
  const byStatus = q(`SELECT c.status, COUNT(*) n, COALESCE(SUM(c.final_price),0) amt
    FROM cases c WHERE c.status NOT IN ('closed','invalid') ${orgCond} GROUP BY c.status`)
    .map(r => ({ status: r.status, label: STATUS_LABEL[r.status] || r.status, n: r.n, amt: Math.round(r.amt || 0) }));

  // 卡關：非施工/結案/無效，且超過 7 天沒更新（越久越前面）
  const stuck = q(`SELECT c.case_number, c.title, c.status, cl.name client,
      CAST(julianday('now')-julianday(c.updated_at) AS INT) days, COALESCE(c.final_price,c.quoted_price,0) price, c.priority
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status NOT IN ('closed','invalid','constructing','dispatched')
      AND julianday('now')-julianday(c.updated_at) > 7 ${orgCond}
    ORDER BY days DESC LIMIT 20`)
    .map(r => ({ ...r, label: STATUS_LABEL[r.status] || r.status, price: Math.round(r.price || 0) }));

  // 成交但尚未排施工派工（待派工風險）
  const contractedNoInstall = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.final_price,0) price,
      CAST(julianday('now')-julianday(c.updated_at) AS INT) days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status='contracted' ${orgCond}
      AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.case_id=c.id AND d.dispatch_type='install' AND d.status!='cancelled')
    ORDER BY days DESC LIMIT 20`)
    .map(r => ({ ...r, price: Math.round(r.price || 0) }));

  // 已發報價單未回簽（quote_sheets sent 未 signed）
  const quotesSentUnsigned = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.quoted_price,c.final_price,0) price,
      CAST(julianday('now')-julianday(qs.updated_at) AS INT) days
    FROM quote_sheets qs JOIN cases c ON c.id=qs.case_id LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE qs.status='sent' ${orgCond}
    ORDER BY days DESC LIMIT 20`)
    .map(r => ({ ...r, price: Math.round(r.price || 0) }));

  // 未來 7 天要施工的案子
  const upcomingInstalls = q(`SELECT c.case_number, c.title, cl.name client, d.scheduled_date
    FROM dispatches d JOIN cases c ON c.id=d.case_id LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE d.dispatch_type='install' AND d.status!='cancelled'
      AND d.scheduled_date BETWEEN date('now') AND date('now','+7 day') ${orgCond}
    ORDER BY d.scheduled_date LIMIT 30`);

  // 逾期/待收款
  const overduePayments = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.final_price,0) price, c.payment_status, c.payment_due_date
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE (c.payment_status='overdue' OR (c.payment_status IN ('unpaid','partial') AND c.payment_due_date IS NOT NULL AND c.payment_due_date < date('now')))
      AND c.status NOT IN ('invalid') ${orgCond}
    ORDER BY c.payment_due_date LIMIT 20`)
    .map(r => ({ ...r, price: Math.round(r.price || 0) }));

  // 有機會的案子：成交/報價階段、金額較高、近 30 天有動靜
  const opportunities = q(`SELECT c.case_number, c.title, c.status, cl.name client, COALESCE(c.final_price,c.quoted_price,0) price
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status IN ('quoted','quote_draft','surveyed','contracted','quote_sent','quote_needed')
      AND COALESCE(c.final_price,c.quoted_price,0) > 0 ${orgCond}
    ORDER BY price DESC LIMIT 15`)
    .map(r => ({ ...r, label: STATUS_LABEL[r.status] || r.status, price: Math.round(r.price || 0) }));

  return { generatedAt: new Date().toISOString().slice(0,16).replace('T',' '),
    byStatus, stuck, contractedNoInstall, quotesSentUnsigned, upcomingInstalls, overduePayments, opportunities };
}

const SYSTEM_PROMPT = `你是「繪新國際」（貼膜/裝潢膜施工公司）管理系統的特助 AI 顧問，服務對象是老闆與管理者。
你會收到一份「目前案件現況快照」(JSON)。請像一位精明、主動的營運特助，用繁體中文、條理清楚地：
1. 先用 2-3 句話點出「現在最該注意的重點」。
2. 分區塊給出洞察與具體行動建議，優先順序由高到低：
   - 🔴 風險/卡關：哪些案子停太久、成交沒排施工、報價沒回簽、逾期收款 → 建議誰去跟進、怎麼跟。
   - 🟢 機會：哪些案子金額高、接近成交，值得優先推進。
   - 🗓️ 近期施工：未來幾天要施工的，提醒準備。
3. 具體、可執行，直接點名案號/客戶，不要空泛。金額用新台幣。
4. 若某區塊沒有資料就簡短帶過或省略，不要硬湊。
用 Markdown 輸出，善用標題與清單，簡潔有力。`;

async function callClaude(messages, maxTokens = 2000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('系統尚未設定 ANTHROPIC_API_KEY，請老闆到 Zeabur 環境變數設定');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages }),
  });
  const data = await resp.json();
  if (!resp.ok || data.type === 'error') throw new Error(data.error?.message || `API 錯誤 ${resp.status}`);
  return data.content?.[0]?.text?.trim() || '（沒有回應）';
}

// GET 現況快照（前端也可單獨顯示數字）
router.get('/snapshot', requireAuth, (req, res) => {
  if (!canUse(req.session.user)) return res.status(403).json({ error: '此功能限老闆／管理者使用' });
  res.json(gatherSnapshot(req.session.user));
});

// POST 主動簡報：把快照交給 Claude 產出洞察
router.post('/brief', requireAuth, async (req, res) => {
  if (!canUse(req.session.user)) return res.status(403).json({ error: '此功能限老闆／管理者使用' });
  try {
    const snap = gatherSnapshot(req.session.user);
    const text = await callClaude([{ role: 'user', content:
      `這是目前的案件現況快照，請給我今天的營運洞察與行動建議：\n\n${JSON.stringify(snap)}` }]);
    res.json({ ok: true, brief: text, snapshot: snap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST 追問：帶著快照與對話歷史，回答老闆的問題
router.post('/chat', requireAuth, async (req, res) => {
  if (!canUse(req.session.user)) return res.status(403).json({ error: '此功能限老闆／管理者使用' });
  const history = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!history.length) return res.status(400).json({ error: '缺少訊息' });
  try {
    const snap = gatherSnapshot(req.session.user);
    // 把最新快照塞進第一則使用者訊息前面當背景（每次都用最新資料）
    const msgs = [{ role: 'user', content: `【目前案件現況快照，供你參考回答】\n${JSON.stringify(snap)}` },
                  { role: 'assistant', content: '好的，我已掌握目前現況，請問您想了解什麼？' },
                  ...history.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))];
    const text = await callClaude(msgs);
    res.json({ ok: true, reply: text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
