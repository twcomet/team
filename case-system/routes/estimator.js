const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const db = require('../db');
const eng = require('../lib/estimator');
const _catData = require('../lib/estimator-catalog');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 圖片/PDF 上限 25MB

// 958 回簽歷史行情（成交/報價/明細分開），啟動時載入一次快取
let DEAL_HISTORY = { deals: [], quotes: [], lines: [], counts: {} };
try { DEAL_HISTORY = require('../data/deal-history.json'); } catch (e) { console.warn('deal-history.json 未載入:', e.message); }

// 估價單客戶分享 token（比照報價單 quote_sheets.share_token）
function genToken() { return crypto.randomBytes(16).toString('hex'); }
function ensureToken(id) {
  const row = db.prepare('SELECT share_token FROM est_quotes WHERE id=?').get(id);
  if (row && row.share_token) return row.share_token;
  const t = genToken();
  db.prepare('UPDATE est_quotes SET share_token=? WHERE id=?').run(t, id);
  return t;
}

// 把整張真實牌價匯入 est_film_catalog / est_door_catalog（force=清空重灌；否則只在空表時帶入）。
// 兼作「啟動 seed 沒跑成功」的保險：GET /catalog 會 lazy 呼叫，確保頁面一定有資料。
function seedCatalogDefaults(force) {
  // 注意：本專案用 node:sqlite(DatabaseSync)，無 .transaction()；直接逐筆 insert（seed 量小、可接受）
  if (force) db.exec('DELETE FROM est_film_catalog; DELETE FROM est_door_catalog;');
  if (!db.prepare('SELECT COUNT(*) n FROM est_film_catalog').get().n) {
    const ins = db.prepare(`INSERT INTO est_film_catalog (brand,asia_code,kr_code,color,model_note,per_m,plane,cabinet,shape,width,roll_len,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [brand, b] of Object.entries(_catData.FILMS))
      b.items.forEach(it => ins.run(brand, it.asia, it.kr, it.color, it.model || '', it.perM || 0, it.plane, it.cabinet, it.shape, it.width || 122, it.rollLen || 50, so++));
  }
  if (!db.prepare('SELECT COUNT(*) n FROM est_door_catalog').get().n) {
    const ins = db.prepare(`INSERT INTO est_door_catalog (cat,size,origin,side,frame,price,sort_order) VALUES (?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [c, d] of Object.entries(_catData.DOORS)) {
      if (d.sized) { for (const size of ['small', 'large', 'double']) for (const origin of ['kr', 'jp']) for (const side of ['single', 'double']) ins.run('fire', size, origin, side, null, d[size][origin][side], so++); }
      else { for (const origin of ['kr', 'jp']) for (const side of ['single', 'double']) for (const frame of ['no', 'yes']) ins.run(c, null, origin, side, frame, d[origin][side][frame], so++); }
    }
  }
}

// 只有老闆 / 管理員 / 有報價設定權限者可改價目
function canEditPrices(u) {
  if (!u) return false;
  if (u.role === 'owner' || u.manage_users) return true;
  const p = u.permissions || {};
  return p.page_quote_settings === true;
}
function requireEdit(req, res, next) {
  if (!canEditPrices(req.session.user)) return res.status(403).json({ error: '沒有修改價目的權限' });
  next();
}

// ── 讀全部價目（估價頁與設定頁共用）──────────────────────────────
router.get('/prices', requireAuth, (req, res) => {
  const films = db.prepare(`SELECT * FROM est_films ORDER BY sort_order, id`).all();
  const glass = db.prepare(`SELECT * FROM est_glass ORDER BY sort_order, id`).all();
  const doors = db.prepare(`SELECT * FROM est_doors ORDER BY sort_order, id`).all();
  const freight = db.prepare(`SELECT * FROM est_freight ORDER BY sort_order, id`).all();
  const lo = db.prepare(`SELECT key,value FROM settings WHERE key IN ('est_lowmin_owner','est_lowmin_designer')`).all();
  const lowmin = {
    owner: Number(lo.find(x => x.key === 'est_lowmin_owner')?.value || 10000),
    designer: Number(lo.find(x => x.key === 'est_lowmin_designer')?.value || 9000),
  };
  res.json({ films, glass, doors, freight, lowmin });
});

// ── 改單筆價目 ───────────────────────────────────────────────────
router.put('/films/:id', requireAuth, requireEdit, (req, res) => {
  const { per_m, plane, cabinet, shape, active } = req.body;
  db.prepare(`UPDATE est_films SET per_m=?,plane=?,cabinet=?,shape=?,active=? WHERE id=?`)
    .run(Number(per_m)||0, Number(plane)||0, Number(cabinet)||0, Number(shape)||0, active?1:0, req.params.id);
  res.json({ ok: true });
});

router.put('/glass/:id', requireAuth, requireEdit, (req, res) => {
  const { owner_price, designer_price, active, width, roll_len } = req.body;
  db.prepare(`UPDATE est_glass SET owner_price=?,designer_price=?,width=?,roll_len=?,active=? WHERE id=?`)
    .run(Number(owner_price)||0, Number(designer_price)||0, Number(width)||122, Number(roll_len)||50, active?1:0, req.params.id);
  res.json({ ok: true });
});
router.post('/glass', requireAuth, requireEdit, (req, res) => {
  const b = req.body || {};
  const maxSo = db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 n FROM est_glass`).get().n;
  const info = db.prepare(`INSERT INTO est_glass (cat_key,cat_label,sys,owner_price,designer_price,width,roll_len,sort_order) VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.cat_key || '', b.cat_label || '', b.sys || '', Number(b.owner_price)||0, Number(b.designer_price)||0, Number(b.width)||122, Number(b.roll_len)||50, maxSo);
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.delete('/glass/:id', requireAuth, requireEdit, (req, res) => {
  db.prepare(`DELETE FROM est_glass WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

router.put('/doors/:id', requireAuth, requireEdit, (req, res) => {
  const { price, active } = req.body;
  db.prepare(`UPDATE est_doors SET price=?,active=? WHERE id=?`)
    .run(Number(price)||0, active?1:0, req.params.id);
  res.json({ ok: true });
});

router.put('/freight/:id', requireAuth, requireEdit, (req, res) => {
  const { survey_fee, amount, overnight_fee, night_surcharge } = req.body;
  db.prepare(`UPDATE est_freight SET survey_fee=?, amount=?, overnight_fee=?, night_surcharge=? WHERE id=?`)
    .run(Number(survey_fee)||0, Number(amount)||0, Number(overnight_fee)||0, Number(night_surcharge)||0, req.params.id);
  res.json({ ok: true });
});

router.put('/lowmin', requireAuth, requireEdit, (req, res) => {
  const { owner, designer } = req.body;
  db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Number(owner)||0));
  db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_designer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Number(designer)||0));
  res.json({ ok: true });
});

// ── 回復預設值（清空後重新 seed）────────────────────────────────
// 已停用：整張還原會覆蓋自訂的玻璃/車馬費/低消等資料
router.post('/reset-defaults', requireAuth, requireEdit, (req, res) => {
  res.status(410).json({ error: '此功能已停用（避免誤刪自訂價目）' });
});

// ── 估價單儲存（est_quotes）─────────────────────────────────────────
// 金額一律由引擎讀 DB 牌價重算後存（不信前端金額）；items/photos 存 JSON
function computeAndPersistFields(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  // 整體折扣硬性限制：最多 8 折（0.8 ~ 1），防前端被繞過
  let disc = parseFloat(b.disc); if (isNaN(disc) || disc > 1) disc = 1; if (disc < 0.8) disc = 0.8;
  b.disc = disc;
  const r = eng.quote(items, { cust: b.customer_type, region: b.region, disc }, eng.buildCatalogFromDb(db));
  return { items, r };
}
router.post('/quotes', requireAuth, (req, res) => {
  const b = req.body || {};
  const { items, r } = computeAndPersistFields(b);
  const token = genToken();
  const info = db.prepare(`INSERT INTO est_quotes
    (case_id,project_name,customer_type,region,customer_name,phone,address,community,line_replied,items_json,photos_json,customer_note,disc,subtotal,discount,items_final,freight,fut,total,status,created_by,share_token)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      b.case_id || null, b.project_name || '', b.customer_type || 'owner', b.region || '',
      b.customer_name || '', b.phone || '', b.address || '', b.community || '', b.line_replied ? 1 : 0,
      JSON.stringify(items), JSON.stringify(b.photos || []), b.customer_note || '',
      Number(b.disc) || 1, r.sub, r.discAmt, r.itemsFinal, r.freight, r.fut, r.total,
      b.status || 'draft', req.session.user.id, token);
  res.json({ ok: true, id: info.lastInsertRowid, total: r.total, share_token: token });
});
router.put('/quotes/:id', requireAuth, (req, res) => {
  const b = req.body || {};
  const { items, r } = computeAndPersistFields(b);
  const info = db.prepare(`UPDATE est_quotes SET
    case_id=?,project_name=?,customer_type=?,region=?,customer_name=?,phone=?,address=?,community=?,line_replied=?,
    items_json=?,photos_json=?,customer_note=?,disc=?,subtotal=?,discount=?,items_final=?,freight=?,fut=?,total=?,status=?,updated_at=datetime('now','localtime')
    WHERE id=?`).run(
      b.case_id || null, b.project_name || '', b.customer_type || 'owner', b.region || '',
      b.customer_name || '', b.phone || '', b.address || '', b.community || '', b.line_replied ? 1 : 0,
      JSON.stringify(items), JSON.stringify(b.photos || []), b.customer_note || '',
      Number(b.disc) || 1, r.sub, r.discAmt, r.itemsFinal, r.freight, r.fut, r.total,
      b.status || 'draft', req.params.id);
  if (!info.changes) return res.status(404).json({ error: '找不到估價單' });
  res.json({ ok: true, total: r.total, share_token: ensureToken(req.params.id) });
});
router.get('/quotes', requireAuth, (req, res) => {
  // 可用 ?case_id= 篩選單一案件（供案件詳情「初步估價紀錄」合併顯示）；不帶則回全部(限200)
  const caseId = req.query.case_id;
  const where  = caseId ? `WHERE q.case_id = ?` : ``;
  const limit  = caseId ? `` : `LIMIT 200`;
  const params = caseId ? [Number(caseId)] : [];
  const rows = db.prepare(`
    SELECT q.id,q.case_id,q.project_name,q.customer_name,q.customer_type,q.region,
           q.subtotal,q.discount,q.disc,q.total,q.status,q.created_at,q.updated_at,
           q.share_token,q.client_viewed_at,
           u.name AS created_by_name,
           cl.name AS case_client_name,
           c.case_number AS case_number, c.title AS case_title
    FROM est_quotes q
    LEFT JOIN users u    ON u.id = q.created_by
    LEFT JOIN cases c    ON c.id = q.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    ${where} ORDER BY q.id DESC ${limit}
  `).all(...params);
  res.json(rows);
});
// 歷史報價查詢（估價機彈窗參考）：系統內既有 正式報價單(quote_sheets)+估價機估價單(est_quotes)。
// 之後 958 回簽成交行情匯入後，可在此再 union 一段外部資料源。
router.get('/history', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const hasQ = q.length > 0;
  const like = '%' + q + '%';
  const qsWhere = hasQ ? `WHERE (c.title LIKE ? OR cl.name LIKE ? OR c.case_number LIKE ?)` : '';
  const quotes = db.prepare(`
    SELECT qs.id, qs.case_id, qs.version, qs.final_total AS total, qs.status, qs.client_accepted_at, qs.created_at,
           c.case_number, c.title AS case_title, c.case_type, cl.name AS client_name
    FROM quote_sheets qs
    LEFT JOIN cases c   ON c.id  = qs.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    ${qsWhere}
    ORDER BY (qs.status='accepted' OR qs.client_accepted_at IS NOT NULL) DESC, qs.id DESC
    LIMIT 40
  `).all(...(hasQ ? [like, like, like] : []));
  const eqWhere = hasQ ? `WHERE (c.title LIKE ? OR cl.name LIKE ? OR c.case_number LIKE ? OR eq.project_name LIKE ? OR eq.customer_name LIKE ?)` : '';
  const estimates = db.prepare(`
    SELECT eq.id, eq.case_id, eq.total, eq.status, eq.created_at,
           eq.project_name, eq.customer_name, eq.customer_type,
           c.case_number, c.title AS case_title, c.case_type, cl.name AS case_client_name
    FROM est_quotes eq
    LEFT JOIN cases c   ON c.id  = eq.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    ${eqWhere}
    ORDER BY eq.id DESC
    LIMIT 40
  `).all(...(hasQ ? [like, like, like, like, like] : []));
  // 958 回簽歷史（成交/報價/明細），伺服器端過濾+限量，不整包回傳
  const ql = q.toLowerCase();
  const fhist = (arr, fields, lim) => {
    const hit = !ql ? arr : arr.filter(r => fields.some(f => {
      const val = r[f];
      if (Array.isArray(val)) return val.join(' ').toLowerCase().includes(ql);
      return val != null && String(val).toLowerCase().includes(ql);
    }));
    return hit.slice(0, lim);
  };
  const deals = fhist(DEAL_HISTORY.deals || [], ['cust', 'types', 'films', 'loc'], 80);
  const histQuotes = fhist(DEAL_HISTORY.quotes || [], ['cust', 'cat', 'films'], 80);
  const lines = fhist(DEAL_HISTORY.lines || [], ['cust', 'type', 'film', 'desc', 'dim'], 120);
  res.json({ quotes, estimates, deals, histQuotes, lines, histCounts: DEAL_HISTORY.counts || {} });
});
router.get('/quotes/:id', requireAuth, (req, res) => {
  const q = db.prepare(`SELECT * FROM est_quotes WHERE id=?`).get(req.params.id);
  if (!q) return res.status(404).json({ error: '找不到估價單' });
  q.items = JSON.parse(q.items_json || '[]');
  q.photos = JSON.parse(q.photos_json || '[]');
  res.json(q);
});
router.delete('/quotes/:id', requireAuth, (req, res) => {
  const info = db.prepare(`DELETE FROM est_quotes WHERE id=?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: '找不到估價單' });
  res.json({ ok: true });
});

// ── 客戶版估價單（公開連結，免登入；比照報價單 /sign）────────────────
// 金額一律由引擎讀 DB 牌價重算；成本欄不出；業主(owner)另隱藏 才數/尺寸/單價
router.get('/quotes/sign/:token', (req, res) => {
  const q = db.prepare(`
    SELECT eq.*, cl.name AS case_client_name, c.title AS case_title, c.case_number
    FROM est_quotes eq
    LEFT JOIN cases c    ON c.id  = eq.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE eq.share_token = ?`).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到估價單' });
  if (!q.client_viewed_at) db.prepare(`UPDATE est_quotes SET client_viewed_at=datetime('now','localtime') WHERE id=?`).run(q.id);
  const items = JSON.parse(q.items_json || '[]');
  const r = eng.quote(items, { cust: q.customer_type, region: q.region, disc: q.disc }, eng.buildCatalogFromDb(db));
  const owner = q.customer_type === 'owner';
  const lines = r.lines.map(L => ({
    type: L.type, label: L.label,
    series: owner ? '' : (L.series || ''),
    n: L.n,
    cai:  owner ? null : (L.cai != null ? Math.round(L.cai * 10) / 10 : null),
    unit: owner ? null : (L.unit || null),
    base: L.base || null, amount: L.amount
  }));
  res.json({
    project_name: q.project_name,
    customer_name: q.customer_name || q.case_client_name || '',
    customer_type: q.customer_type, region: q.region,
    created_at: q.created_at, updated_at: q.updated_at, customer_note: q.customer_note,
    disc: q.disc,
    lines, sub: r.sub, discAmt: r.discAmt, itemsFinal: r.itemsFinal,
    freight: r.freight, fut: r.fut, total: r.total, lowApplied: r.lowApplied, lowmin: r.lowmin
  });
});

// ── 重設計版牌價（est_film_catalog / est_door_catalog）──────────────
// 讀全部（估價頁與設定頁共用）
router.get('/catalog', requireAuth, (req, res) => {
  try { seedCatalogDefaults(false); } catch (e) { console.warn('[catalog lazy seed]', e.message); } // 保險：空表自動帶入
  const isOwner = req.session.user.role === 'owner';
  const films = db.prepare(`SELECT * FROM est_film_catalog ORDER BY sort_order, id`).all();
  if (!isOwner) films.forEach(f => { delete f.cost_per_m; }); // 成本機密：非老闆一律不外送（含估價計算機）
  const doors = db.prepare(`SELECT * FROM est_door_catalog ORDER BY sort_order, id`).all();
  res.json({ films, doors, isOwner });
});
// 匯入/回復 裝潢膜+門 預設牌價（整張重灌）
// 已停用：整張還原會清掉韓版/公式連工帶料/代碼統一等自訂資料（migration 不會重跑）
router.post('/reset-catalog-defaults', requireAuth, requireEdit, (req, res) => {
  res.status(410).json({ error: '此功能已停用（避免誤刪自訂價目）' });
});
// 改單筆裝潢膜（每米＋三種連工帶料價）
router.put('/film-catalog/:id', requireAuth, requireEdit, (req, res) => {
  const isOwner = req.session.user.role === 'owner';
  const { per_m, plane, cabinet, shape, active, cost_per_m, width, roll_len, fireproof, asia_code, kr_code, color, model_note } = req.body;
  const _row = db.prepare(`SELECT brand FROM est_film_catalog WHERE id=?`).get(req.params.id);
  // 電商含稅牌價由未稅牌價自動推算（進位50）；3M 不上電商→維持 0（售價以牌價 per_m 為準）
  const ecom = (_row && _row.brand === '3m') ? 0 : Math.round((Number(per_m)||0)*1.05/50)*50;
  db.prepare(`UPDATE est_film_catalog SET per_m=?,ecom_price=?,fireproof=?,plane=?,cabinet=?,shape=?,width=?,roll_len=?,active=? WHERE id=?`)
    .run(Number(per_m)||0, ecom, fireproof||'', Number(plane)||0, Number(cabinet)||0, Number(shape)||0, Number(width)||122, Number(roll_len)||50, active?1:0, req.params.id);
  // 代碼/花色/備註（可編輯；只在有送才更新，避免清空）
  if (asia_code !== undefined || kr_code !== undefined || color !== undefined || model_note !== undefined)
    db.prepare(`UPDATE est_film_catalog SET asia_code=COALESCE(?,asia_code),kr_code=COALESCE(?,kr_code),color=COALESCE(?,color),model_note=COALESCE(?,model_note) WHERE id=?`)
      .run(asia_code ?? null, kr_code ?? null, color ?? null, model_note ?? null, req.params.id);
  if (isOwner && cost_per_m !== undefined) // 成本只有老闆能改；非老闆送來的 cost 一律忽略、不覆蓋
    db.prepare(`UPDATE est_film_catalog SET cost_per_m=? WHERE id=?`).run(Number(cost_per_m)||0, req.params.id);
  res.json({ ok: true });
});
// 新增膜款
router.post('/film-catalog', requireAuth, requireEdit, (req, res) => {
  const isOwner = req.session.user.role === 'owner';
  const b = req.body || {};
  const maxSo = db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 n FROM est_film_catalog`).get().n;
  const ecom = Math.round((Number(b.per_m)||0)*1.05/50)*50; // 電商含稅牌價：由未稅牌價自動推算（進位50）
  const info = db.prepare(`INSERT INTO est_film_catalog (brand,region,asia_code,kr_code,color,model_note,fireproof,per_m,ecom_price,plane,cabinet,shape,width,roll_len,cost_per_m,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.brand || 'bodaq', b.region || '', b.asia_code || '', b.kr_code || '', b.color || '', b.model_note || '', b.fireproof || '', Number(b.per_m)||0, ecom, Number(b.plane)||0, Number(b.cabinet)||0, Number(b.shape)||0, Number(b.width)||122, Number(b.roll_len)||50, isOwner ? (Number(b.cost_per_m)||0) : 0, maxSo);
  res.json({ ok: true, id: info.lastInsertRowid });
});
// 刪除膜款
router.delete('/film-catalog/:id', requireAuth, requireEdit, (req, res) => {
  db.prepare(`DELETE FROM est_film_catalog WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});
// 改單筆門固定價
router.put('/door-catalog/:id', requireAuth, requireEdit, (req, res) => {
  const { price, active } = req.body;
  db.prepare(`UPDATE est_door_catalog SET price=?,active=? WHERE id=?`)
    .run(Number(price)||0, active?1:0, req.params.id);
  res.json({ ok: true });
});

// ── 尺寸表／場勘圖 OCR（圖片或 PDF）→ 回傳每片 {name,w,h,qty} ──
// 沿用 clients.js /ocr-card 的 Claude 視覺模式；規則對齊繪新場勘估算系統（淨尺寸寬高各+10、膜寬122、超寬拆塊）
router.post('/ocr-sizes', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請上傳圖片或 PDF' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '未設定 ANTHROPIC_API_KEY' });

  const b64  = req.file.buffer.toString('base64');
  const mime = req.file.mimetype || '';
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(req.file.originalname || '');
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mime || 'image/jpeg', data: b64 } };

  const PROMPT = `這是裝潢貼膜的尺寸表或場勘圖（可能是表格，或手繪標註尺寸）。請辨識每一塊要貼膜的材料，抓出名稱、寬、高（公分）、數量。
規則：
- 尺寸多為「寬*高」「寬x高」cm；小數要保留（例 79.5）。原尺寸即可，不用自己加裁切餘裕。
- 數量：有標示就用該值，沒有則為 1。整批相同的區塊可用數量合併。
- 名稱：取該列品名（例 大門、#1門片、間隔片、洗手檯旁牆片、便斗隔板…）；沒有就留空字串。
只回傳 JSON、不要任何說明文字：
{"rows":[{"name":"大門","w":79.5,"h":203,"qty":1}]}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [ media, { type: 'text', text: PROMPT } ] }]
      })
    });
    const data = await resp.json();
    if (!resp.ok || data.type === 'error') {
      return res.status(500).json({ error: `辨識服務錯誤：${data.error?.message || ('API ' + resp.status)}` });
    }
    require('../lib/ai-usage').logUsage(db, { feature: 'estimator_ocr', userId: req.session.user?.id, model: 'claude-sonnet-5', data });
    const text = (data.content || []).map(c => c.text || '').join('').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(422).json({ error: `辨識不到尺寸，請確認上傳的是尺寸表/場勘圖${text ? '（' + text.slice(0, 60) + '）' : ''}` });
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch (e) { return res.status(422).json({ error: '辨識結果格式異常，請重試或換清晰一點的檔案' }); }
    const rows = (parsed.rows || []).map(r => ({
      name: String(r.name || '').slice(0, 40),
      w: Number(r.w) || 0, h: Number(r.h) || 0,
      qty: Math.max(1, Math.round(Number(r.qty) || 1))
    })).filter(r => r.w > 0 && r.h > 0);
    res.json({ rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
