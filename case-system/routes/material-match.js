// 相似花色查詢（第一期）：庫存米數篩選＋條件搜尋＋分享連結（免登入、伺服器端過濾機密欄位）。
// 第二/三期再接 AI 視覺標籤相似推薦與圖片搜尋。此模組獨立、不影響現有功能。
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function _code(n = 8) {
  const B = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const b = crypto.randomBytes(n); let s = '';
  for (let i = 0; i < n; i++) s += B[b[i] % 62];
  return s;
}
const FILM = "1=1";   // 不用 category 過濾：正式庫 category 值不一，過濾會把膜料全濾掉

// ── 搜尋膜料：庫存 >= 米數 ＋ 品牌 ＋ 關鍵字（品牌/型號/花色/規格）──
router.get('/search', requireAuth, (req, res) => {
  const min   = Number(req.query.min_meters) || 0;
  const brand = (req.query.brand || '').trim();
  const q     = (req.query.q || '').trim();
  const where = [FILM, 'COALESCE(m.stock_meters,0) >= ?'];
  const params = [min];
  if (brand) { where.push('TRIM(LOWER(m.brand))=TRIM(LOWER(?))'); params.push(brand); }
  if (q) {
    // 忽略連字號/空格、不分大小寫：AA611 也能搜到 AA-611、aa 611
    const nq = '%' + q.replace(/[-\s]/g, '').toLowerCase() + '%';
    const norm = c => `REPLACE(REPLACE(LOWER(${c}),'-',''),' ','')`;
    where.push(`(${norm('m.brand')} LIKE ? OR ${norm('m.model')} LIKE ? OR ${norm('m.color')} LIKE ? OR ${norm('m.spec')} LIKE ?)`);
    params.push(nq, nq, nq, nq);
  }
  const rows = db.prepare(`
    SELECT m.id, m.brand, m.model, m.color, m.spec, m.image_url, m.unit_price,
           m.stock_meters, m.location, m.width_cm, m.ai_tags, o.name AS branch
    FROM materials m LEFT JOIN orgs o ON o.id = m.org_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(m.stock_meters,0) DESC, m.brand, m.model
    LIMIT 200
  `).all(...params);
  rows.forEach(r => { r.ai_tags = _parseTags(r.ai_tags); });
  res.json(rows);
});

// ── 相近花色推薦（規則式，無 AI）：以某支膜料為基準，比對「紋路類型＋色系＋膜寬＋品牌」找相近替代花色 ──
// 紋路類型（互斥大類，命中同類最加分）
const GRAIN = [
  ['木紋', /木紋|木理|橡木|栓木|胡桃|柚木?|梧桐|楓木?|松木|白橡|灰橡|原木|洗白木|木/],
  ['石紋', /大理石|石紋|岩板|岩|雲石|石材|砂岩|水磨石|洞石|大理/],
  ['水泥', /水泥|清水模|工業風|素水泥/],
  ['布紋', /布紋|織布|亞麻|棉麻|編織布|布|織|紡/],
  ['皮革', /皮革|皮紋|荔枝皮|皮/],
  ['金屬', /金屬|拉絲|不鏽鋼|鏡面|鏡|鋁|鋼|銅|髮絲/],
  ['藤竹', /藤|籐|竹/],
  ['素色', /素色|純色|單色|烤漆|素/],
];
// 色系關鍵字（重疊愈多愈相近）
const HUE = ['白橡','灰橡','米白','象牙','奶油','原木','胡桃','梧桐','煙燻','香檳','白','米','淺','橡','楓','柚','栓','灰','棕','咖','深','黑','碳','金','銀','藍','綠','紅','紫','橘','黃'];
function _profile(m) {
  const t = [m.color, m.spec, m.model].map(x => String(x || '')).join(' ');
  const grain = new Set(); for (const [k, re] of GRAIN) if (re.test(t)) grain.add(k);
  const hue = new Set(); for (const h of HUE) if (t.includes(h)) hue.add(h);
  return { grain, hue, hasText: !!t.replace(/[\s\-()（）]/g, '') };
}
function _simScore(seed, cand) {
  let s = 0;
  for (const g of seed.grain) if (cand.grain.has(g)) s += 5;   // 同紋路大類，最重要
  for (const h of seed.hue)   if (cand.hue.has(h))   s += 2;   // 共同色系
  if (seed.brand && cand.brand && String(seed.brand).toLowerCase() === String(cand.brand).toLowerCase()) s += 1;
  const w1 = Number(seed.width_cm) || 122, w2 = Number(cand.width_cm) || 122;
  if (Math.abs(w1 - w2) <= 8) s += 1;                          // 膜寬相近（可互換施工）
  return s;
}
function _parseTags(s) { if (!s) return null; try { const t = JSON.parse(s); return t && typeof t === 'object' ? t : null; } catch (_) { return null; } }
// AI 視覺標籤比對分數（兩支都有 AI 標籤時使用，權重高於純文字）
function _tagScore(a, b) {
  let s = 0;
  if (a.grain && b.grain && a.grain === b.grain) s += 6;      // 同紋路類型
  if (a.tone && b.tone && a.tone === b.tone) s += 3;          // 同明暗
  const ah = new Set(a.hue || []), bh = b.hue || [];
  for (const h of bh) if (ah.has(h)) s += 2;                  // 共同色系
  const as = new Set(a.style || []), bs = b.style || [];
  for (const st of bs) if (as.has(st)) s += 1;                // 同風格
  return s;
}
router.get('/similar', requireAuth, (req, res) => {
  const id  = Number(req.query.id) || 0;
  const min = Number(req.query.min_meters) || 0;
  if (!id) return res.json([]);
  const seed = db.prepare(`SELECT id, brand, model, color, spec, width_cm, ai_tags FROM materials WHERE id=?`).get(id);
  if (!seed) return res.json([]);
  const sp = _profile(seed);
  const seedTags = _parseTags(seed.ai_tags);
  const rows = db.prepare(`
    SELECT m.id, m.brand, m.model, m.color, m.spec, m.image_url, m.unit_price,
           m.stock_meters, m.location, m.width_cm, m.ai_tags, o.name AS branch
    FROM materials m LEFT JOIN orgs o ON o.id = m.org_id
    WHERE ${FILM} AND COALESCE(m.stock_meters,0) >= ?
      AND TRIM(LOWER(COALESCE(m.model,''))) <> TRIM(LOWER(COALESCE(?,'')))
    ORDER BY COALESCE(m.stock_meters,0) DESC
  `).all(min, seed.model || '');
  // 同型號只留庫存最高的一筆（避免同一支花色因多個貨架重複出現）
  const bestByModel = {};
  for (const r of rows) {
    const key = (String(r.brand || '') + '|' + String(r.model || '')).toLowerCase();
    if (!bestByModel[key] || (Number(r.stock_meters) || 0) > (Number(bestByModel[key].stock_meters) || 0)) bestByModel[key] = r;
  }
  const noSeedText = !sp.hasText || (!sp.grain.size && !sp.hue.size);
  const scored = Object.values(bestByModel).map(r => {
    const cp = _profile(r);
    const candTags = _parseTags(r.ai_tags);
    let s = 0, ai = false;
    if (seedTags && candTags) {                                // 兩支都有 AI 花色標籤 → 用視覺比對（較準）
      s = _tagScore(seedTags, candTags);
      if (seed.brand && r.brand && String(seed.brand).toLowerCase() === String(r.brand).toLowerCase()) s += 1;
      if (Math.abs((Number(seed.width_cm) || 122) - (Number(r.width_cm) || 122)) <= 8) s += 1;
      if (s > 0) { s += 20; ai = true; }                       // AI 命中者整體排在文字猜測之上
    } else if (noSeedText) {                                   // 基準膜料沒有花色文字可比對：同品牌＋膜寬相近先推
      if (seed.brand && r.brand && String(seed.brand).toLowerCase() === String(r.brand).toLowerCase()) s += 3;
      if (Math.abs((Number(seed.width_cm) || 122) - (Number(r.width_cm) || 122)) <= 8) s += 1;
    } else {                                                   // 純文字規則比對
      s = _simScore({ ...sp, brand: seed.brand, width_cm: seed.width_cm }, { ...cp, brand: r.brand, width_cm: r.width_cm });
    }
    if (candTags) r._tags = candTags;
    return { r, s, ai };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map(x => ({ ...x.r, matched_by: x.ai ? 'ai' : 'text', ai_tags: x.r._tags || null, _tags: undefined }));
  res.json({ seed: { id: seed.id, brand: seed.brand, model: seed.model, color: seed.color, ai_tags: seedTags }, items: scored, seed_tagged: !!seedTags });
});

// 尚未 AI 分析、但有花色圖的膜料數量
router.get('/untagged-count', requireAuth, (req, res) => {
  const n = db.prepare(`SELECT COUNT(*) c FROM materials WHERE ${FILM} AND image_url IS NOT NULL AND image_url<>'' AND (ai_tags IS NULL OR ai_tags='')`).get().c;
  const total = db.prepare(`SELECT COUNT(*) c FROM materials WHERE ${FILM} AND image_url IS NOT NULL AND image_url<>''`).get().c;
  res.json({ untagged: n, with_image: total });
});

// AI 分析單一膜料花色
router.post('/ai-tag/:id', requireAuth, async (req, res) => {
  try { const tags = await require('../lib/material-ai').tagMaterial(Number(req.params.id)); res.json({ ok: true, tags }); }
  catch (e) { res.status(400).json({ error: e.message || 'AI 分析失敗' }); }
});

// 批次 AI 分析：一次處理 N 支「有花色圖但尚未分析」的膜料（預設 8 支，避免逾時／爆量）
router.post('/ai-tag-batch', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.body.limit) || 8, 1), 20);
  const ids = db.prepare(`SELECT id FROM materials WHERE ${FILM} AND image_url IS NOT NULL AND image_url<>'' AND (ai_tags IS NULL OR ai_tags='') ORDER BY COALESCE(stock_meters,0) DESC LIMIT ?`).all(limit).map(r => r.id);
  const mai = require('../lib/material-ai');
  let done = 0; const errors = [];
  for (const id of ids) { try { await mai.tagMaterial(id); done++; } catch (e) { errors.push({ id, error: e.message }); } }
  const left = db.prepare(`SELECT COUNT(*) c FROM materials WHERE ${FILM} AND image_url IS NOT NULL AND image_url<>'' AND (ai_tags IS NULL OR ai_tags='')`).get().c;
  res.json({ ok: true, done, tried: ids.length, remaining: left, errors });
});

// 品牌下拉清單
router.get('/brands', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT brand FROM materials WHERE brand IS NOT NULL AND brand!='' AND ${FILM} ORDER BY brand`).all();
  res.json(rows.map(r => r.brand));
});

// 建立分享連結：勾選要顯示的機密欄位（品牌/型號/圖片必出、不受此控制）
router.post('/share', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
  if (!ids.length) return res.status(400).json({ error: '請至少勾選一項膜料再分享' });
  const f = req.body.fields || {};
  const token = _code(8);
  db.prepare(`INSERT INTO material_share (token, material_ids, show_price, show_stock, show_location, show_branch, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(token, JSON.stringify(ids.slice(0, 100)), f.price ? 1 : 0, f.stock ? 1 : 0, f.location ? 1 : 0, f.branch ? 1 : 0, req.session.user.id);
  res.json({ ok: true, token });
});

// 公開分享頁資料（免登入）：只回品牌/型號/圖片 ＋ 建立時勾選允許的機密欄位（伺服器端過濾）
router.get('/shared/:token', (req, res) => {
  const s = db.prepare(`SELECT * FROM material_share WHERE token=?`).get(req.params.token);
  if (!s) return res.status(404).json({ error: '連結不存在或已失效' });
  let ids = []; try { ids = JSON.parse(s.material_ids) || []; } catch (_) {}
  if (!ids.length) return res.json({ fields: {}, items: [] });
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.id, m.brand, m.model, m.color, m.image_url, m.unit_price, m.stock_meters, m.location, o.name AS branch
    FROM materials m LEFT JOIN orgs o ON o.id = m.org_id WHERE m.id IN (${ph})
  `).all(...ids);
  const byId = {}; rows.forEach(r => byId[r.id] = r);
  const items = ids.map(id => byId[id]).filter(Boolean).map(r => {
    const o = { brand: r.brand, model: r.model, color: r.color, image_url: r.image_url };   // 必出欄位
    if (s.show_price)    o.unit_price   = r.unit_price;
    if (s.show_stock)    o.stock_meters = r.stock_meters;
    if (s.show_location) o.location     = r.location;
    if (s.show_branch)   o.branch       = r.branch;
    return o;
  });
  res.json({ fields: { price: !!s.show_price, stock: !!s.show_stock, location: !!s.show_location, branch: !!s.show_branch }, items });
});

module.exports = router;
