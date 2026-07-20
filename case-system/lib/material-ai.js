// 膜料花色 AI 視覺標籤（第二期）：用 Claude vision 看花色圖，萃取結構化標籤（紋路/明暗/色系/風格），
// 供「相近花色推薦」以視覺特徵比對，比純文字型號更準。僅對有 image_url 的膜料有效。
const db = require('../db');
const MODEL = 'claude-sonnet-5';

const GRAINS = ['木紋', '石紋', '水泥', '布紋', '皮革', '金屬', '藤竹', '素色', '其他'];
const TONES  = ['淺', '中', '深'];

async function callVision(imageUrl) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('未設定 ANTHROPIC_API_KEY');
  const system = `你是室內裝潢貼膜的花色分類專家。看這張膜料花色圖，只輸出 JSON（不要多餘文字）：
{"grain":"紋路類型，從［木紋/石紋/水泥/布紋/皮革/金屬/藤竹/素色/其他］擇一","tone":"明暗，從［淺/中/深］擇一","hue":["主要色系，如 白/米/灰/棕/木/黑/藍/綠，最多3個"],"main_color":"一句話主色描述，如 淺白橡木色","style":["風格，如 北歐/日式/工業/現代/自然/古典，最多2個"]}`;
  const messages = [{ role: 'user', content: [
    { type: 'image', source: { type: 'url', url: imageUrl } },
    { type: 'text', text: '請分析這張膜料花色，只輸出上述 JSON。' },
  ] }];
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system, messages }),
  });
  const data = await resp.json();
  if (!resp.ok || data.type === 'error') throw new Error(data.error?.message || `API 錯誤 ${resp.status}`);
  try { require('./ai-usage').logUsage(db, { feature: 'material_color_tag', userId: null, model: MODEL, data }); } catch (_) {}
  const text = Array.isArray(data.content) ? data.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '';
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI 未回傳 JSON');
  let j; try { j = JSON.parse(text.slice(a, b + 1)); } catch (e) { throw new Error('AI JSON 解析失敗'); }
  // 正規化
  const grain = GRAINS.includes(j.grain) ? j.grain : '其他';
  const tone  = TONES.includes(j.tone) ? j.tone : '中';
  const hue   = Array.isArray(j.hue) ? j.hue.map(x => String(x || '').trim()).filter(Boolean).slice(0, 3) : [];
  const style = Array.isArray(j.style) ? j.style.map(x => String(x || '').trim()).filter(Boolean).slice(0, 2) : [];
  return { grain, tone, hue, style, main_color: String(j.main_color || '').trim().slice(0, 40) };
}

// 對單一膜料上標籤（需有 image_url），寫回 materials.ai_tags / ai_tagged_at
async function tagMaterial(id) {
  const m = db.prepare('SELECT id, image_url FROM materials WHERE id=?').get(id);
  if (!m) throw new Error('膜料不存在');
  if (!m.image_url || !/^https?:\/\//.test(m.image_url)) throw new Error('此膜料沒有花色圖，無法 AI 分析');
  const tags = await callVision(m.image_url);
  db.prepare("UPDATE materials SET ai_tags=?, ai_tagged_at=datetime('now','+8 hours') WHERE id=?").run(JSON.stringify(tags), id);
  return tags;
}

module.exports = { tagMaterial, callVision };
