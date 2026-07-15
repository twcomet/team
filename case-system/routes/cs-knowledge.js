// 客服知識庫：常見問答 / 制式回覆 / 資源連結（餵給 LINE AI）
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const CAN_EDIT = ['owner', 'hq_cs', 'hq_cs_manager', 'hq_accounting', 'vp'];
function canEdit(req, res, next) {
  if (CAN_EDIT.includes(req.session.user?.role) || req.session.user?.manage_users) return next();
  return res.status(403).json({ error: '沒有編輯知識庫的權限' });
}

// 列表
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT k.*, u.name AS updated_by_name
                           FROM cs_knowledge k LEFT JOIN users u ON k.updated_by = u.id
                           ORDER BY k.active DESC, k.sort_order, k.id`).all();
  res.json({ rows });
});

// 新增
router.post('/', requireAuth, canEdit, (req, res) => {
  const { category, question, answer, link_url, link_label, keywords, sort_order } = req.body;
  if (!question?.trim() && !answer?.trim()) return res.status(400).json({ error: '請至少填寫主題或回覆內容' });
  const r = db.prepare(`INSERT INTO cs_knowledge (category, question, answer, link_url, link_label, keywords, sort_order, updated_by)
                        VALUES (?,?,?,?,?,?,?,?)`)
    .run(category || '常見問題', question || '', answer || '', link_url || null, link_label || null,
         keywords || null, Number(sort_order) || 0, req.session.user.id);
  res.json({ id: r.lastInsertRowid });
});

// 編輯
router.put('/:id', requireAuth, canEdit, (req, res) => {
  const { category, question, answer, link_url, link_label, keywords, sort_order, active } = req.body;
  db.prepare(`UPDATE cs_knowledge SET category=?, question=?, answer=?, link_url=?, link_label=?, keywords=?,
              sort_order=?, active=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(category || '常見問題', question || '', answer || '', link_url || null, link_label || null,
         keywords || null, Number(sort_order) || 0, active === 0 || active === false ? 0 : 1,
         req.session.user.id, req.params.id);
  res.json({ ok: true });
});

// 刪除
router.delete('/:id', requireAuth, canEdit, (req, res) => {
  db.prepare(`DELETE FROM cs_knowledge WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// AI 從歷史對話挖常見問題 → 回傳建議條目（不直接存，讓使用者挑）
// 限老闆使用：此功能一次讀 600 則對話，最耗 API credit，避免同事誤按
router.post('/mine', requireAuth, async (req, res) => {
  try {
    if (req.session.user?.role !== 'owner') return res.status(403).json({ error: '此功能僅開放給老闆使用（避免誤用消耗 API 額度）' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: '未設定 ANTHROPIC_API_KEY' });
    // 取近期客人發言（文字），量大時抽樣
    const msgs = db.prepare(`SELECT content FROM line_inquiry_messages
                             WHERE direction='in' AND msg_type='text' AND content IS NOT NULL AND length(content)>1
                             ORDER BY id DESC LIMIT 600`).all();
    if (!msgs.length) return res.json({ suggestions: [] });
    const corpus = msgs.map(m => `- ${m.content.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');

    const existing = db.prepare(`SELECT question FROM cs_knowledge WHERE active=1`).all().map(k => k.question).filter(Boolean);
    const system = `你是繪新國際（裝潢貼膜公司）的客服知識庫整理助理。以下是客人在 LINE 問過的訊息集合，請歸納出「最常被問到、值得建成制式回覆」的常見問題。
- 每題給：category（分類，如 電商/報價/服務範圍/材質/施工/展間/其他）、question（精煉後的常見問題）、answer（建議的制式回覆草稿，繁中、親切、簡短；不確定的事實用括號提示客服補）。
- 合併相似問題，最多 12 題，由高頻到低頻。
- 已存在的題目不要重複：${existing.join('、') || '（無）'}
只輸出 JSON：{"suggestions":[{"category":"","question":"","answer":""}]}`;
    const raw = await callClaude(system, [{ role: 'user', content: `客人訊息集合：\n${corpus}\n\n請歸納常見問題，只輸出 JSON。` }], 2000);
    const parsed = safeParseJson(raw);
    res.json({ suggestions: Array.isArray(parsed?.suggestions) ? parsed.suggestions.slice(0, 12) : [] });
  } catch (e) {
    res.status(500).json({ error: 'AI 分析失敗：' + e.message });
  }
});

// 內部：呼叫 Claude（與 line-ai 相同寫法，避免循環相依而各自保留）
async function callClaude(system, messages, maxTokens = 1024) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: maxTokens, system, messages }),
  });
  const data = await resp.json();
  if (!resp.ok || data.type === 'error') throw new Error(data.error?.message || `API 錯誤 ${resp.status}`);
  return Array.isArray(data.content) ? data.content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n').trim() : '';
}
function safeParseJson(raw) {
  if (!raw) return null;
  let s = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = router;
