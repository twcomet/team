// 膜料花色 AI 視覺標籤（第二期）：用 Claude vision 看花色圖，萃取結構化標籤（紋路/明暗/色系/風格），
// 供「相近花色推薦」以視覺特徵比對，比純文字型號更準。僅對有 image_url 的膜料有效。
const db = require('../db');
const MODEL = 'claude-sonnet-5';

// 對齊電商網站的分面 taxonomy（款式 20／顏色系列 22／色調 3）
const PATTERNS = ['木紋', '大理石紋', '金屬紋', '素面', '特殊紋', '編織', '皮革', '炫彩虹膜', '塗料', '石紋', '亮面', '珍珠紋', '亮片', '幾何紋', '混合波紋', '金銀箔', '高光澤', '超浮雕', '光滑表面', '彩釉'];
const COLORS   = ['黑', '藍', '深棕', '深灰', '深灰棕', '深銀灰', '金', '綠', '淺棕', '淺灰', '淺灰棕', '淺銀灰', '中性棕', '中性灰', '橘', '粉', '紫', '白', '彩虹', '紅棕', '紅', '黃'];
const TONES    = ['淺色', '中性色', '深色'];

// 核心：對一個「圖片來源」(URL 或 base64) 呼叫 vision 分類，回正規化標籤
async function _vision(source, feature) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('未設定 ANTHROPIC_API_KEY');
  const system = `你是室內裝潢貼膜的花色分類專家。看這張圖（膜料花色或客戶提供的布料/顏色參考），依下列固定選項分類，只輸出 JSON（不要多餘文字）：
{"pattern":["款式，只能從此清單選 1-2 個：${PATTERNS.join('/')}"],"tone":"色調，只能從［${TONES.join('/')}］擇一","color_family":["顏色系列，只能從此清單選 1-2 個：${COLORS.join('/')}"],"main_color":"一句話主色描述，如 淺白橡木色"}
規則：pattern 與 color_family 一定要從清單挑最接近的，不要自創詞；色調偏白偏亮＝淺色、偏黑偏暗＝深色、其餘＝中性色。`;
  const messages = [{ role: 'user', content: [
    { type: 'image', source },
    { type: 'text', text: '請分析這張圖，只輸出上述 JSON。' },
  ] }];
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system, messages }),
  });
  const data = await resp.json();
  if (!resp.ok || data.type === 'error') throw new Error(data.error?.message || `API 錯誤 ${resp.status}`);
  try { require('./ai-usage').logUsage(db, { feature: feature || 'material_color_tag', userId: null, model: MODEL, data }); } catch (_) {}
  const text = Array.isArray(data.content) ? data.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '';
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI 未回傳 JSON');
  let j; try { j = JSON.parse(text.slice(a, b + 1)); } catch (e) { throw new Error('AI JSON 解析失敗'); }
  const pickList = (v, list, max) => (Array.isArray(v) ? v : [v]).map(x => String(x || '').trim()).filter(x => list.includes(x)).slice(0, max);
  const tone = TONES.includes(j.tone) ? j.tone : '中性色';
  const pattern = pickList(j.pattern, PATTERNS, 2);
  const color_family = pickList(j.color_family, COLORS, 2);
  return { tone, pattern, color_family, main_color: String(j.main_color || '').trim().slice(0, 40) };
}
function callVision(imageUrl) { return _vision({ type: 'url', url: imageUrl }, 'material_color_tag'); }
// 客戶上傳的布料/顏色照片：base64 直接辨識同一套標籤（不需存檔）
function tagImageData(mediaType, b64) { return _vision({ type: 'base64', media_type: mediaType, data: b64 }, 'material_image_match'); }

// 對單一膜料上標籤（需有 image_url），寫回 materials.ai_tags / ai_tagged_at
async function tagMaterial(id) {
  const m = db.prepare('SELECT id, image_url FROM materials WHERE id=?').get(id);
  if (!m) throw new Error('膜料不存在');
  if (!m.image_url || !/^https?:\/\//.test(m.image_url)) throw new Error('此膜料沒有花色圖，無法 AI 分析');
  const tags = await callVision(m.image_url);
  db.prepare("UPDATE materials SET ai_tags=?, ai_tagged_at=datetime('now','+8 hours') WHERE id=?").run(JSON.stringify(tags), id);
  return tags;
}

module.exports = { tagMaterial, callVision, tagImageData, PATTERNS, COLORS, TONES };
