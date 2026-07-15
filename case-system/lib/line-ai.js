// LINE 詢問 AI 草稿助理（草稿模式）
// 讀對話 → 依客服 SOP + 牌價護欄擬一則「要傳給客人的回覆草稿」，存回 line_inquiries。
// 一律不主動傳給客人；客服在後台審核後才送。
const db = require('../db');

const MODEL = 'claude-sonnet-5';

async function callClaude(system, messages, maxTokens = 1024) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('未設定 ANTHROPIC_API_KEY');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
  });
  const data = await resp.json();
  if (!resp.ok || data.type === 'error') throw new Error(data.error?.message || `API 錯誤 ${resp.status}`);
  const text = Array.isArray(data.content)
    ? data.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
    : '';
  if (!text) throw new Error('AI 沒有回傳文字');
  return text;
}

// 從模型輸出中安全取出 JSON（容忍 ```json 圍籬 / 前後多餘文字）
function safeParseJson(raw) {
  if (!raw) return null;
  let s = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

// 膜料牌價摘要（只給「材料每才牌價」；連工帶料/成本一律不給 AI）
function buildFilmPricing() {
  let rows = [];
  try {
    rows = db.prepare(`SELECT brand, asia_code, kr_code, color, fireproof, width, per_m, plane
                       FROM est_film_catalog WHERE active=1 ORDER BY sort_order, id`).all();
  } catch { /* 表不存在 */ }
  if (!rows.length) return '（目前牌價表無資料，遇到問價一律請客人稍候、轉客服）';
  return rows.map(r => {
    // 材料每才牌價＝牆面連工帶料價 −70（頁面同一套換算）；無 plane 時用每米換算
    const perTsai = (r.plane != null) ? (r.plane - 70)
                                      : Math.round((r.per_m || 0) / ((r.width || 122) * 100 / 900));
    const codes = [r.brand, r.asia_code, r.kr_code].filter(Boolean).join('/');
    return `${codes}｜花色:${r.color || '—'}｜${r.fireproof || '—'}｜幅寬${r.width || 122}cm｜材料牌價 約$${perTsai}/才`;
  }).join('\n');
}

// 客服知識庫摘要（公司事實／常見問答／資源連結）
function buildKnowledge() {
  let rows = [];
  try {
    rows = db.prepare(`SELECT category, question, answer, link_url, link_label FROM cs_knowledge WHERE active=1 ORDER BY sort_order, id`).all();
  } catch { /* 表不存在 */ }
  if (!rows.length) return '（知識庫尚無資料，遇到公司相關問題不確定就標需轉真人）';
  return rows.map(r => {
    let s = `- [${r.category || '常見問題'}] ${r.question || ''}`;
    if (r.answer)   s += `\n  回答：${r.answer}`;
    if (r.link_url) s += `\n  連結：${(r.link_label || '') + ' '}${r.link_url}`;
    return s;
  }).join('\n');
}

function buildSystemPrompt() {
  return `你是台灣「繪新國際」的 LINE 官方帳號客服助理。繪新是專業裝潢貼膜公司（牆面、系統櫃門片、造型、玻璃、電梯等貼膜施工）。
你的工作：讀客人與客服的 LINE 對話，擬「一則要傳給客人的回覆草稿」，並判斷這通是否需要轉真人客服。
草稿之後會由真人客服審核、可修改後才送出——所以請擬得像真人客服會傳的訊息。

【回覆風格】
- 繁體中文、口語、親切有禮，像 LINE 聊天，簡短（通常 1～4 句），可用少量 emoji（😊🙏）。
- 一次只推進一步，不要一口氣問一堆。

【先判斷對方身分，再決定怎麼接洽】
- 若客人表明是「設計師／室內設計／統包／工班／廠商／同業」，或傳來的是名片、公司資訊 → 用專業窗口口吻招呼（例：「設計師您好！很高興為您服務，請問這邊有什麼可以協助的嗎？😊」），了解他的專案或配合需求。這類通常要業務對接與配合報價 → 設 needs_human=true，reason 註明「設計師／廠商窗口，建議轉業務對接」。不要對他們用一般消費者「請傳案場照片、問尺寸」那套流程。
- 一般消費者 → 走下面客服 SOP。

【一般消費者 SOP：依對話目前進度接續】
1. 若還不清楚案場 → 請客人拍幾張要施工位置的照片，並說一下位置（牆面／系統櫃門片／玻璃…）。
2. 了解需求（想貼哪、想要的花色或效果、大概尺寸範圍）。
3. 適時請客人留聯絡電話與方便聯繫的時間。
4. 客人想看實體 → 告知有實體展間可預約參觀，說會請專人提供展間地址與時段（你沒有確切地址，不要自己編）。

【關於照片（你看得到客人傳的圖，請依內容判斷，不要瞎猜）】
- 名片／公司資訊 → 對方是設計師或廠商窗口，照上面「身分」方式接洽，別當成案場照片問位置。
- 案場照片 → 簡短說出你看到的重點（例如看起來是系統櫃門片／牆面），再接續了解需求。
- 看不清或不確定 → 禮貌請對方補充說明，不要亂猜施作內容。

【公司知識庫（回答公司相關事實／常見問題時，一律以此為準；有連結就自然地附給客人）】
${buildKnowledge()}
※ 公司是否有電商／官網／某項服務等事實，一律依知識庫回答。知識庫沒寫、你不確定的，**不要自己說「有」或「沒有」**，改用「我幫您確認一下」並標記需轉真人。

【機密守則（最高優先，絕對遵守，違反會出大事）】
以下屬公司機密，一律「不回答內容」，禮貌帶過並標 needs_human=true（reason 註明客人問到機密）：
- 公司內部人員／組織：有哪些員工、誰負責、老闆是誰、團隊多少人、某某人是誰、找某某人 → 不透露。回類似「這部分我幫您安排專人為您服務喔😊」。
- 成本、進貨價、利潤、毛利、分潤、內部定價邏輯、跟哪家廠商／供應商進貨、貨從哪來 → 一律不透露。
- 內部制度：派工、抽成、獎金、薪資、收款／催款、財務、業績 → 不透露。
- 其他客戶的任何資料（誰是你們客戶、某某案子）→ 不透露。
- 只要問到上述，不要因為客人追問就鬆口；就是禮貌帶過＋轉專人。

【牌價護欄（非常重要，違反會出事）】
- 只有「材料每才牌價」可以講（見下方牌價表），且要講清楚是材料參考牌價、實際金額需依面積與現場評估。
- 「連工帶料／整體施工報價／貼一片多少／一坪多少／總共多少錢」→ 一律不可自己報數字，回覆「這要依現場丈量與施工範圍，會由專人為您報價」並引導留電話。
- 絕對不可透露成本、毛利、進貨價。
- 不確定的花色/型號有沒有貨、能不能做特殊需求 → 不要亂答，標記需轉真人。

【需要轉真人客服(needs_human=true)的情況】
- 客人殺價、談折扣、催進度、抱怨/客訴、要開發票細節、要簽約/付款、談專案或大量、情緒較激動。
- 問到你牌價表沒有的東西、或需要精準報價/確認庫存。
- 任何你沒把握、可能講錯會影響成交的情況。

【目前材料牌價表（僅供你回答「材料每才牌價」，連工帶料不在此）】
${buildFilmPricing()}

【輸出格式】只輸出一個 JSON，不要有其他文字：
{"draft":"要傳給客人的回覆草稿","needs_human":true或false,"reason":"若需轉真人，一句話說原因；否則空字串"}`;
}

// 產生（或重新產生）某筆詢問的 AI 草稿，寫回 line_inquiries
async function generateInquiryDraft(inquiryId) {
  const inq = db.prepare(`SELECT id FROM line_inquiries WHERE id=?`).get(inquiryId);
  if (!inq) return null;

  const msgs = db.prepare(`SELECT direction, msg_type, content FROM line_inquiry_messages
                           WHERE inquiry_id=? ORDER BY created_at ASC, id ASC`).all(inquiryId);
  if (!msgs.length) return null;

  // 只在最後一則是「客人發言」時才擬稿（客服已回過就不用）
  if (msgs[msgs.length - 1].direction !== 'in') return null;

  // 組多模態內容：文字對話 + 客人傳的圖（讓 AI 真的看得到名片／案場照，不再瞎猜）
  const content = [{ type: 'text', text: '以下是與客人的 LINE 對話（最新在最後）：' }];
  let buf = '';
  const flush = () => { if (buf) { content.push({ type: 'text', text: buf }); buf = ''; } };
  let imgCount = 0;
  for (const m of msgs) {
    const who = m.direction === 'in' ? '客人' : '客服';
    if (m.msg_type === 'image' && m.content && /^https?:\/\//.test(m.content) && imgCount < 6) {
      buf += `\n${who}：（傳了以下這張圖）`;
      flush();
      content.push({ type: 'image', source: { type: 'url', url: m.content } });
      imgCount++;
    } else {
      buf += `\n${who}：${m.msg_type === 'image' ? '[照片]' : (m.content || '')}`;
    }
  }
  buf += '\n\n請依規則擬一則要回覆客人的草稿，並判斷是否需轉真人。只輸出 JSON。';
  flush();

  const raw = await callClaude(buildSystemPrompt(), [{ role: 'user', content }]);

  const parsed     = safeParseJson(raw);
  const draft      = (parsed && parsed.draft) ? String(parsed.draft).trim() : raw.trim();
  const needsHuman = parsed && parsed.needs_human ? 1 : 0;
  const reason     = (parsed && parsed.reason) ? String(parsed.reason).trim() : null;

  db.prepare(`UPDATE line_inquiries
              SET ai_draft=?, ai_draft_at=CURRENT_TIMESTAMP, ai_needs_human=?, ai_needs_human_reason=?
              WHERE id=?`).run(draft, needsHuman, reason, inquiryId);

  return { draft, needsHuman, reason };
}

// 客服的 AI 助手（co-pilot）：客服跟 AI 對話，產生更正確的回覆
function buildAssistantSystemPrompt(transcript) {
  return `你是台灣「繪新國際」LINE 客服的 AI 助手（co-pilot）。客服正在處理一位客人的詢問，會來問你「怎麼回比較好／幫我擬一則訊息／幫我把語氣改客氣／客人問X該怎麼回」等。
你的任務：幫客服產生「可以直接傳給客人的訊息」或給實用建議。
- 若客服是要一則回覆 → 直接產出可傳給客人的訊息（繁體中文、親切、簡短、LINE 口吻）。
- 若客服是在問你問題／請你判斷 → 正常回答、給建議即可。
- 嚴格遵守下面知識庫與所有護欄。

【機密守則（絕對遵守）】公司內部人員／組織（有哪些人、老闆是誰、團隊多大）、成本、毛利、分潤、進貨來源、派工、收款、其他客戶資料 → 一律不可寫進要傳給客人的訊息；客服若問你這些機密的『對客講法』，提醒他這不能對外。
【牌價護欄】只可提「材料每才牌價」（見下）；連工帶料／整體施工報價一律回「需現場丈量、由專人報價」，不可自報數字；不洩成本毛利。
【不確定不要編】知識庫沒有的公司事實不要自己說有或沒有，請客服自行確認。

【公司知識庫（回答一律以此為準，有連結就附上）】
${buildKnowledge()}

【材料每才牌價（僅供回答材料牌價）】
${buildFilmPricing()}

【這通客人目前的對話（供你參考語境，最新在最後）】
${transcript || '（尚無對話）'}`;
}

async function chatWithAssistant(inquiryId, chatMessages) {
  const inq = db.prepare(`SELECT id FROM line_inquiries WHERE id=?`).get(inquiryId);
  if (!inq) throw new Error('詢問不存在');
  const msgs = db.prepare(`SELECT direction, msg_type, content FROM line_inquiry_messages
                           WHERE inquiry_id=? ORDER BY created_at ASC, id ASC`).all(inquiryId);
  const transcript = msgs.map(m => `${m.direction === 'in' ? '客人' : '客服'}：${m.msg_type === 'image' ? '[照片]' : (m.content || '')}`).join('\n');
  const clean = (chatMessages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.trim() }));
  if (!clean.length) throw new Error('沒有訊息');
  return await callClaude(buildAssistantSystemPrompt(transcript), clean, 1024);
}

module.exports = { generateInquiryDraft, chatWithAssistant };
