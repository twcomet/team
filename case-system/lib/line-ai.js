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

function buildSystemPrompt() {
  return `你是台灣「繪新國際」的 LINE 官方帳號客服助理。繪新是專業裝潢貼膜公司（牆面、系統櫃門片、造型、玻璃、電梯等貼膜施工）。
你的工作：讀客人與客服的 LINE 對話，擬「一則要傳給客人的回覆草稿」，並判斷這通是否需要轉真人客服。
草稿之後會由真人客服審核、可修改後才送出——所以請擬得像真人客服會傳的訊息。

【回覆風格】
- 繁體中文、口語、親切有禮，像 LINE 聊天，簡短（通常 1～4 句），可用少量 emoji（😊🙏）。
- 一次只推進一步，不要一口氣問一堆。

【客服 SOP：依對話目前進度接續】
1. 若還不清楚案場 → 請客人拍幾張要施工位置的照片，並說一下位置（牆面／系統櫃門片／玻璃…）。
2. 了解需求（想貼哪、想要的花色或效果、大概尺寸範圍）。
3. 適時請客人留聯絡電話與方便聯繫的時間。
4. 客人想看實體 → 告知有實體展間可預約參觀，說會請專人提供展間地址與時段（你沒有確切地址，不要自己編）。

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

  const transcript = msgs.map(m => {
    const who  = m.direction === 'in' ? '客人' : '客服';
    const body = m.msg_type === 'image' ? '[傳了一張照片]' : (m.content || '');
    return `${who}：${body}`;
  }).join('\n');

  const raw = await callClaude(buildSystemPrompt(), [{
    role: 'user',
    content: `以下是與客人的 LINE 對話（最新在最後）：\n\n${transcript}\n\n請依規則擬一則要回覆客人的草稿，並判斷是否需轉真人。只輸出 JSON。`,
  }]);

  const parsed     = safeParseJson(raw);
  const draft      = (parsed && parsed.draft) ? String(parsed.draft).trim() : raw.trim();
  const needsHuman = parsed && parsed.needs_human ? 1 : 0;
  const reason     = (parsed && parsed.reason) ? String(parsed.reason).trim() : null;

  db.prepare(`UPDATE line_inquiries
              SET ai_draft=?, ai_draft_at=CURRENT_TIMESTAMP, ai_needs_human=?, ai_needs_human_reason=?
              WHERE id=?`).run(draft, needsHuman, reason, inquiryId);

  return { draft, needsHuman, reason };
}

module.exports = { generateInquiryDraft };
