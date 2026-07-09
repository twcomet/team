// AI 顧問 ── 多顧問統一入口。每個顧問各自驗權限、各自彙整專屬資料快照，交給 Claude 產出洞察。
//   特助顧問 assistant：全公司營運＋金額/毛利 → 限老闆
//   會計顧問 accounting：財務（應收/待審費用/收支/預收款）→ 老闆＋會計
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

// ── 各顧問權限 ─────────────────────────────────────────────
// 特助顧問權限最大（可看全公司金額/毛利分析）→ 限老闆
function canAssistant(me) { return me.role === 'owner'; }
// 會計顧問（財務）→ 老闆、會計角色，或被授予財務頁權限者
function canAccounting(me) {
  return me.role === 'owner' || me.role === 'hq_accounting' || me.permissions?.page_ledger === true;
}
// 派單顧問（排工）→ 老闆、副總、客服(主管)，或被授予行事曆權限者
function canDispatch(me) {
  return me.role === 'owner' || me.role === 'vp'
    || me.role === 'hq_cs' || me.role === 'hq_cs_manager'
    || me.permissions?.page_calendar === true;
}
function canAny(me) { return canAssistant(me) || canAccounting(me) || canDispatch(me); }

// ── 特助顧問：全系統案件現況快照（尊重分店權限範圍）──────────
function gatherAssistantSnapshot(me) {
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const orgCond = orgSql ? ` AND ${orgSql}` : '';
  const q = (sql) => { try { return db.prepare(sql).all(...orgPs); } catch (e) { return []; } };

  const byStatus = q(`SELECT c.status, COUNT(*) n, COALESCE(SUM(c.final_price),0) amt
    FROM cases c WHERE c.status NOT IN ('closed','invalid') ${orgCond} GROUP BY c.status`)
    .map(r => ({ status: r.status, label: STATUS_LABEL[r.status] || r.status, n: r.n, amt: Math.round(r.amt || 0) }));

  const stuck = q(`SELECT c.case_number, c.title, c.status, cl.name client,
      CAST(julianday('now')-julianday(c.updated_at) AS INT) days, COALESCE(c.final_price,c.quoted_price,0) price, c.priority
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status NOT IN ('closed','invalid','constructing','dispatched')
      AND julianday('now')-julianday(c.updated_at) > 7 ${orgCond}
    ORDER BY days DESC LIMIT 20`)
    .map(r => ({ ...r, label: STATUS_LABEL[r.status] || r.status, price: Math.round(r.price || 0) }));

  const contractedNoInstall = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.final_price,0) price,
      CAST(julianday('now')-julianday(c.updated_at) AS INT) days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status='contracted' ${orgCond}
      AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.case_id=c.id AND d.dispatch_type='install' AND d.status!='cancelled')
    ORDER BY days DESC LIMIT 20`)
    .map(r => ({ ...r, price: Math.round(r.price || 0) }));

  const quotesSentUnsigned = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.quoted_price,c.final_price,0) price,
      CAST(julianday('now')-julianday(qs.updated_at) AS INT) days
    FROM quote_sheets qs JOIN cases c ON c.id=qs.case_id LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE qs.status='sent' ${orgCond}
    ORDER BY days DESC LIMIT 20`)
    .map(r => ({ ...r, price: Math.round(r.price || 0) }));

  const upcomingInstalls = q(`SELECT c.case_number, c.title, cl.name client, d.scheduled_date
    FROM dispatches d JOIN cases c ON c.id=d.case_id LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE d.dispatch_type='install' AND d.status!='cancelled'
      AND d.scheduled_date BETWEEN date('now') AND date('now','+7 day') ${orgCond}
    ORDER BY d.scheduled_date LIMIT 30`);

  const overduePayments = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.final_price,0) price, c.payment_status, c.payment_due_date
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE (c.payment_status='overdue' OR (c.payment_status IN ('unpaid','partial') AND c.payment_due_date IS NOT NULL AND c.payment_due_date < date('now')))
      AND c.status NOT IN ('invalid') ${orgCond}
    ORDER BY c.payment_due_date LIMIT 20`)
    .map(r => ({ ...r, price: Math.round(r.price || 0) }));

  const opportunities = q(`SELECT c.case_number, c.title, c.status, cl.name client, COALESCE(c.final_price,c.quoted_price,0) price
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status IN ('quoted','quote_draft','surveyed','contracted','quote_sent','quote_needed')
      AND COALESCE(c.final_price,c.quoted_price,0) > 0 ${orgCond}
    ORDER BY price DESC LIMIT 15`)
    .map(r => ({ ...r, label: STATUS_LABEL[r.status] || r.status, price: Math.round(r.price || 0) }));

  return { generatedAt: _now(),
    byStatus, stuck, contractedNoInstall, quotesSentUnsigned, upcomingInstalls, overduePayments, opportunities };
}

// ── 會計顧問：財務快照 ─────────────────────────────────────
function gatherAccountingSnapshot(me) {
  const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return []; } };
  const one = (sql) => { try { return db.prepare(sql).get() || {}; } catch (e) { return {}; } };

  // 本月收支（分類帳）
  const cashByType = q(`SELECT type, COALESCE(SUM(amount),0) amt, COUNT(*) n
    FROM ledger_entries WHERE strftime('%Y-%m',date)=strftime('%Y-%m','now') GROUP BY type`);
  const income = Math.round(cashByType.find(r => r.type === 'income')?.amt || 0);
  const expense = Math.round(cashByType.find(r => r.type === 'expense')?.amt || 0);
  const monthCashflow = { month: _now().slice(0, 7), income, expense, net: income - expense };

  // 本月支出前幾大分類
  const topExpenseCats = q(`SELECT category, COALESCE(SUM(amount),0) amt, COUNT(*) n
    FROM ledger_entries WHERE type='expense' AND strftime('%Y-%m',date)=strftime('%Y-%m','now')
    GROUP BY category ORDER BY amt DESC LIMIT 8`).map(r => ({ ...r, amt: Math.round(r.amt || 0) }));

  // 待審核／待結算的費用申請（submitted=待主管、mgr_approved=待老闆、owner_approved=待結算撥款）
  const pendingExpenses = q(`SELECT er.status, COUNT(*) n, COALESCE(SUM(er.amount),0) amt
    FROM expense_requests er WHERE er.status IN ('submitted','mgr_approved','owner_approved')
    GROUP BY er.status`).map(r => ({
      status: r.status,
      label: r.status === 'submitted' ? '待主管審核' : r.status === 'mgr_approved' ? '待老闆核准' : '已核准待結算撥款',
      n: r.n, amt: Math.round(r.amt || 0)
    }));
  const pendingExpenseList = q(`SELECT er.id, er.expense_date, er.amount, er.description, er.status,
      u.name applicant, ec.name category
    FROM expense_requests er LEFT JOIN users u ON u.id=er.user_id LEFT JOIN expense_categories ec ON ec.id=er.category_id
    WHERE er.status IN ('submitted','mgr_approved','owner_approved')
    ORDER BY er.expense_date ASC LIMIT 25`).map(r => ({ ...r, amount: Math.round(r.amount || 0) }));

  // 逾期／待收應收款
  const overdueReceivables = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.final_price,0) price,
      COALESCE(c.payment_received,0) received, c.payment_status, c.payment_due_date,
      CAST(julianday('now')-julianday(c.payment_due_date) AS INT) overdue_days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE (c.payment_status='overdue' OR (c.payment_status IN ('unpaid','partial') AND c.payment_due_date IS NOT NULL AND c.payment_due_date < date('now')))
      AND c.status NOT IN ('invalid')
    ORDER BY c.payment_due_date ASC LIMIT 25`).map(r => ({
      ...r, price: Math.round(r.price || 0), received: Math.round(r.received || 0),
      outstanding: Math.round((r.price || 0) - (r.received || 0))
    }));

  // 應收總覽（未收/部分收）
  const receivableSummary = q(`SELECT c.payment_status, COUNT(*) n,
      COALESCE(SUM(COALESCE(c.final_price,0)-COALESCE(c.payment_received,0)),0) outstanding
    FROM cases c WHERE c.payment_status IN ('unpaid','partial','overdue') AND c.status NOT IN ('invalid')
    GROUP BY c.payment_status`).map(r => ({ ...r, outstanding: Math.round(r.outstanding || 0) }));

  // 預收款（客戶訂金）未沖銷
  const depositsPending = one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt
    FROM client_deposits WHERE status='pending'`);
  const depositList = q(`SELECT cd.amount, cd.status, cl.name client
    FROM client_deposits cd LEFT JOIN clients cl ON cl.id=cd.client_id
    WHERE cd.status='pending' ORDER BY cd.amount DESC LIMIT 15`).map(r => ({ ...r, amount: Math.round(r.amount || 0) }));

  return {
    generatedAt: _now(),
    monthCashflow, topExpenseCats,
    pendingExpenses, pendingExpenseList,
    overdueReceivables, receivableSummary,
    depositsPending: { n: depositsPending.n || 0, amt: Math.round(depositsPending.amt || 0) }, depositList,
  };
}

// ── 派單顧問：排工現況快照（尊重分店權限範圍）──────────────
const DTYPE_LABEL = { survey:'場勘', install:'施工', aftersales:'維修' };
function gatherDispatchSnapshot(me) {
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const orgCond = orgSql ? ` AND ${orgSql}` : '';
  const q = (sql) => { try { return db.prepare(sql).all(...orgPs); } catch (e) { return []; } };
  const crewSub = `(SELECT GROUP_CONCAT(u.name,'、') FROM dispatch_users du JOIN users u ON u.id=du.user_id WHERE du.dispatch_id=d.id)`;

  // 成交但還沒排施工派工（待派工）
  const toDispatch = q(`SELECT c.case_number, c.title, cl.name client, COALESCE(c.final_price,0) price,
      c.desired_entry_date, CAST(julianday('now')-julianday(c.updated_at) AS INT) days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status='contracted' ${orgCond}
      AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.case_id=c.id AND d.dispatch_type='install' AND d.status!='cancelled')
    ORDER BY days DESC LIMIT 25`).map(r => ({ ...r, price: Math.round(r.price || 0) }));

  // 待排場勘（帶地點，供就近併場勘 / 排順序）
  const toSurvey = q(`SELECT c.case_number, c.title, cl.name client, cl.phone,
      c.location, c.desired_entry_date,
      CAST(julianday('now')-julianday(c.updated_at) AS INT) days
    FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE c.status='survey_pending' ${orgCond}
      AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.case_id=c.id AND d.dispatch_type='survey' AND d.status!='cancelled' AND d.scheduled_date>=date('now'))
    ORDER BY days DESC LIMIT 30`)
    .map(r => ({ ...r, location: r.location || '（未填地點）' }));

  // 未來 14 天排程（場勘/施工/維修）
  const upcoming = q(`SELECT d.scheduled_date, d.scheduled_time, d.dispatch_type, d.status,
      c.case_number, c.title, cl.name client, ld.name leader, ${crewSub} crew
    FROM dispatches d JOIN cases c ON c.id=d.case_id LEFT JOIN clients cl ON cl.id=c.client_id
    LEFT JOIN users ld ON ld.id=d.leader_id
    WHERE d.status!='cancelled' AND d.scheduled_date BETWEEN date('now') AND date('now','+14 day') ${orgCond}
    ORDER BY d.scheduled_date, d.scheduled_time LIMIT 60`)
    .map(r => ({ date: r.scheduled_date, time: r.scheduled_time || '', type: DTYPE_LABEL[r.dispatch_type] || r.dispatch_type,
      case_number: r.case_number, title: r.title, client: r.client, leader: r.leader || '', crew: r.crew || '' }));

  // 施工派工未指定小組長
  const installNoLeader = q(`SELECT d.scheduled_date, c.case_number, c.title, cl.name client, ${crewSub} crew
    FROM dispatches d JOIN cases c ON c.id=d.case_id LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE d.dispatch_type='install' AND d.status!='cancelled' AND d.leader_id IS NULL
      AND d.scheduled_date>=date('now') ${orgCond}
    ORDER BY d.scheduled_date LIMIT 20`).map(r => ({ ...r, crew: r.crew || '（未指派人員）' }));

  // 未來 14 天各師傅工作量
  const crewLoad = q(`SELECT u.name, COUNT(DISTINCT d.id) n
    FROM dispatch_users du JOIN dispatches d ON d.id=du.dispatch_id JOIN cases c ON c.id=d.case_id
    JOIN users u ON u.id=du.user_id
    WHERE d.status!='cancelled' AND d.scheduled_date BETWEEN date('now') AND date('now','+14 day') ${orgCond}
    GROUP BY du.user_id ORDER BY n DESC LIMIT 30`);

  // 同一師傅同一天被排多筆（可能衝突）
  const conflicts = q(`SELECT u.name, d.scheduled_date, COUNT(DISTINCT d.id) n,
      GROUP_CONCAT(DISTINCT c.case_number) cases
    FROM dispatch_users du JOIN dispatches d ON d.id=du.dispatch_id JOIN cases c ON c.id=d.case_id
    JOIN users u ON u.id=du.user_id
    WHERE d.status!='cancelled' AND d.scheduled_date BETWEEN date('now') AND date('now','+14 day') ${orgCond}
    GROUP BY du.user_id, d.scheduled_date HAVING COUNT(DISTINCT d.id) > 1
    ORDER BY d.scheduled_date LIMIT 20`).map(r => ({ name: r.name, date: r.scheduled_date, n: r.n, cases: r.cases }));

  return { generatedAt: _now(), toDispatch, toSurvey, upcoming, installNoLeader, crewLoad, conflicts };
}

function _now() { return new Date().toISOString().slice(0, 16).replace('T', ' '); }

// ── 顧問設定 ───────────────────────────────────────────────
const ASSISTANT_PROMPT = `你是「繪新國際」（貼膜/裝潢膜施工公司）管理系統的特助 AI 顧問，服務對象是老闆與管理者。
你會收到一份「目前案件現況快照」(JSON)。請像一位精明、主動的營運特助，用繁體中文、條理清楚地：
1. 先用 2-3 句話點出「現在最該注意的重點」。
2. 分區塊給出洞察與具體行動建議，優先順序由高到低：
   - 🔴 風險/卡關：哪些案子停太久、成交沒排施工、報價沒回簽、逾期收款 → 建議誰去跟進、怎麼跟。
   - 🟢 機會：哪些案子金額高、接近成交，值得優先推進。
   - 🗓️ 近期施工：未來幾天要施工的，提醒準備。
3. 具體、可執行，直接點名案號/客戶，不要空泛。金額用新台幣。
4. 若某區塊沒有資料就簡短帶過或省略，不要硬湊。
用 Markdown 輸出，善用標題與清單，簡潔有力。`;

const ACCOUNTING_PROMPT = `你是「繪新國際」（貼膜/裝潢膜施工公司）管理系統的會計 AI 顧問，服務對象是老闆與會計人員。
你會收到一份「財務現況快照」(JSON)，內容含：本月收支結餘、支出分類、待審核/待結算的費用申請、逾期與待收應收款、預收款（客戶訂金）未沖銷。
請像一位嚴謹、細心的公司會計，用繁體中文、條理清楚地：
1. 先用 2-3 句話點出「財務上現在最該處理的事」。
2. 分區塊給出洞察與具體行動建議，優先順序由高到低：
   - 💰 應收/逾期：哪些案子款項逾期或未收，金額多少、逾期幾天 → 建議催收順序與方式。
   - 🧾 費用審核：有哪些費用申請卡在待審/待撥款，提醒盡快處理，注意異常金額。
   - 📊 本月收支：收入、支出、結餘概況，支出集中在哪些分類，是否需留意。
   - 🏦 預收款：尚未沖銷的客戶訂金，提醒與對應案件勾稽。
3. 具體、可執行，直接點名案號/客戶/申請人與金額，不要空泛。金額用新台幣、加上千分位。
4. 若某區塊沒有資料就簡短帶過或省略，不要硬湊。
5. 你是內部會計顧問，可以討論公司財務數字；但僅就系統提供的資料回答，不臆測未提供的數字。
用 Markdown 輸出，善用標題與清單，簡潔有力。`;

const DISPATCH_PROMPT = `你是「繪新國際」（貼膜/裝潢膜施工公司）管理系統的派單 AI 顧問，服務對象是負責排工的客服、副總與老闆。
你會收到一份「排工現況快照」(JSON)，內容含：待派施工的成交案、待排場勘（含地點 location）、未來 14 天的場勘/施工/維修排程、施工未指定小組長、各師傅工作量、以及同一師傅同一天被排多筆（可能衝突）。
請像一位有經驗的派工調度員，用繁體中文、條理清楚地：
1. 先用 2-3 句話點出「排工上現在最該處理的事」。
2. 分區塊給出洞察與具體行動建議，優先順序由高到低：
   - 🗺️ 場勘路線建議（重點）：看 toSurvey 每個案子的 location 地點，把「地理位置相近」（同縣市、同行政區、同路段或明顯順路）的案子分組，建議「哪幾件可以排在同一天、同一趟一起場勘」比較順、省車程。每一組列出案號＋地點，並在組內給一個建議的拜訪順序（例如由北到南、順路串起來）。同時考量客戶希望進場日（desired_entry_date）近的要優先排。地點沒填的另外列出、提醒補地址。
   - 🔴 該儘快排：成交卻還沒排施工的案子、還沒排場勘的案子 → 建議優先順序（金額高、客戶希望進場日近的優先）。
   - ⚠️ 排程風險：同一師傅同天多筆可能撞班、施工沒指定小組長、某人工作量過重 → 具體點名、建議怎麼調。
   - 🗓️ 近期排程：未來幾天的場勘/施工重點提醒（誰去、哪個案子）。
3. 具體、可執行，直接點名案號/客戶/地點/師傅與日期，不要空泛。
4. 場勘分組時只依提供的地點文字合理推斷遠近，不要臆造不存在的地址；把握不準時就說明「地點資訊不足、建議確認」。
5. 若某區塊沒有資料就簡短帶過或省略，不要硬湊。
用 Markdown 輸出，善用標題與清單，簡潔有力。`;

const ADVISORS = {
  assistant: {
    label: '特助顧問', access: canAssistant, gather: gatherAssistantSnapshot, system: ASSISTANT_PROMPT,
    briefPrompt: '這是目前的案件現況快照，請給我今天的營運洞察與行動建議：',
    chatIntro: '好的，我已掌握目前案件現況，請問您想了解什麼？',
    snapLabel: '目前案件現況快照',
  },
  accounting: {
    label: '會計顧問', access: canAccounting, gather: gatherAccountingSnapshot, system: ACCOUNTING_PROMPT,
    briefPrompt: '這是目前的財務現況快照，請給我今天的財務洞察與行動建議：',
    chatIntro: '好的，我已掌握目前財務現況，請問您想了解什麼？',
    snapLabel: '目前財務現況快照',
  },
  dispatch: {
    label: '派單顧問', access: canDispatch, gather: gatherDispatchSnapshot, system: DISPATCH_PROMPT,
    briefPrompt: '這是目前的排工現況快照，請給我今天的派工洞察與行動建議：',
    chatIntro: '好的，我已掌握目前排工現況，請問您想了解什麼？',
    snapLabel: '目前排工現況快照',
  },
};

async function callClaude(system, messages, maxTokens = 2000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('系統尚未設定 ANTHROPIC_API_KEY，請老闆到 Zeabur 環境變數設定');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
  });
  const data = await resp.json();
  if (!resp.ok || data.type === 'error') throw new Error(data.error?.message || `API 錯誤 ${resp.status}`);
  // 掃描所有 text 區塊（新模型第一個 block 可能不是 text）
  const text = Array.isArray(data.content)
    ? data.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
    : '';
  if (!text) {
    const kinds = Array.isArray(data.content) ? data.content.map(b => b?.type).join(',') : typeof data.content;
    throw new Error(`AI 沒有回傳文字內容（stop=${data.stop_reason || '?'}, blocks=${kinds || '空'}）`);
  }
  return text;
}

// 取得目標顧問，並檢查權限；失敗時 res 已回應，回傳 null
function resolveAdvisor(req, res) {
  const adv = ADVISORS[req.params.advisor];
  if (!adv) { res.status(404).json({ error: '未知的顧問' }); return null; }
  if (!adv.access(req.session.user)) { res.status(403).json({ error: '您沒有使用此顧問的權限' }); return null; }
  return adv;
}

// 目前使用者可用哪些顧問（給前端過濾頁籤）
router.get('/access', requireAuth, (req, res) => {
  const me = req.session.user;
  const available = Object.entries(ADVISORS)
    .filter(([, a]) => a.access(me))
    .map(([key, a]) => ({ key, label: a.label }));
  res.json({ available });
});

// GET 現況快照
router.get('/:advisor/snapshot', requireAuth, (req, res) => {
  const adv = resolveAdvisor(req, res); if (!adv) return;
  res.json(adv.gather(req.session.user));
});

// POST 主動簡報：把快照交給 Claude 產出洞察
router.post('/:advisor/brief', requireAuth, async (req, res) => {
  const adv = resolveAdvisor(req, res); if (!adv) return;
  try {
    const snap = adv.gather(req.session.user);
    const text = await callClaude(adv.system, [{ role: 'user', content:
      `${adv.briefPrompt}\n\n${JSON.stringify(snap)}` }]);
    res.json({ ok: true, brief: text, snapshot: snap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST 追問：帶著最新快照與對話歷史
router.post('/:advisor/chat', requireAuth, async (req, res) => {
  const adv = resolveAdvisor(req, res); if (!adv) return;
  const history = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!history.length) return res.status(400).json({ error: '缺少訊息' });
  try {
    const snap = adv.gather(req.session.user);
    const msgs = [{ role: 'user', content: `【${adv.snapLabel}，供你參考回答】\n${JSON.stringify(snap)}` },
                  { role: 'assistant', content: adv.chatIntro },
                  ...history.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))];
    const text = await callClaude(adv.system, msgs);
    res.json({ ok: true, reply: text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 向下相容：舊版無前綴路徑 → 特助顧問 ─────────────────────
router.get('/snapshot', requireAuth, (req, res) => {
  if (!canAssistant(req.session.user)) return res.status(403).json({ error: '此功能限老闆使用' });
  res.json(gatherAssistantSnapshot(req.session.user));
});

module.exports = router;
