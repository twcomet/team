const express = require('express');
const db = require('../db');
const eng = require('../lib/estimator');
const _catData = require('../lib/estimator-catalog');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

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
router.post('/reset-defaults', requireAuth, requireEdit, (req, res) => {
  const seed = require('../lib/estimator-seed');
  { // node:sqlite 無 .transaction()，直接執行
    db.exec(`DELETE FROM est_films; DELETE FROM est_glass; DELETE FROM est_doors; DELETE FROM est_freight;`);
    const insF = db.prepare(`INSERT INTO est_films (grp_key,grp_label,origin,width,flat_price,sys,per_m,plane,cabinet,shape,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let so = 0;
    for (const [gk, g] of Object.entries(seed.FILMS))
      g.items.forEach(it => insF.run(gk, g.label, g.origin, g.width, g.flatPrice ? 1 : 0, it.sys, it.perM, it.plane, it.cabinet, it.shape, so++));
    const insG = db.prepare(`INSERT INTO est_glass (cat_key,cat_label,sys,owner_price,designer_price,sort_order) VALUES (?,?,?,?,?,?)`);
    so = 0;
    for (const [ck, c] of Object.entries(seed.GLASS))
      c.items.forEach(it => insG.run(ck, c.label, it.sys, it.owner, it.designer, so++));
    const insD = db.prepare(`INSERT INTO est_doors (door_key,label,frame_only,origin,layers,opt,price,sort_order) VALUES (?,?,?,?,?,?,?,?)`);
    so = 0;
    for (const [dk, d] of Object.entries(seed.DOOR)) {
      if (d.frameOnly) { insD.run(dk, d.label, 1, 'kr', null, null, d.kr, so++); insD.run(dk, d.label, 1, 'jp', null, null, d.jp, so++); }
      else for (const origin of ['kr', 'jp']) for (const layers of ['1', '2']) for (const opt of [0, 1]) insD.run(dk, d.label, 0, origin, layers, opt, d[origin][layers][opt], so++);
    }
    const insFr = db.prepare(`INSERT INTO est_freight (region,survey_fee,amount,overnight_fee,night_surcharge,sort_order) VALUES (?,?,?,?,?,?)`);
    so = 0;
    for (const [region, f] of Object.entries(seed.FREIGHT)) insFr.run(region, f.survey_fee, f.amount, f.overnight_fee, f.night_surcharge, so++);
    db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(seed.LOWMIN.owner));
    db.prepare(`INSERT INTO settings (key,value) VALUES ('est_lowmin_designer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(seed.LOWMIN.designer));
  }
  res.json({ ok: true });
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
  const info = db.prepare(`INSERT INTO est_quotes
    (case_id,project_name,customer_type,region,customer_name,phone,address,community,line_replied,items_json,photos_json,customer_note,disc,subtotal,discount,items_final,freight,fut,total,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      b.case_id || null, b.project_name || '', b.customer_type || 'owner', b.region || '',
      b.customer_name || '', b.phone || '', b.address || '', b.community || '', b.line_replied ? 1 : 0,
      JSON.stringify(items), JSON.stringify(b.photos || []), b.customer_note || '',
      Number(b.disc) || 1, r.sub, r.discAmt, r.itemsFinal, r.freight, r.fut, r.total,
      b.status || 'draft', req.session.user.id);
  res.json({ ok: true, id: info.lastInsertRowid, total: r.total });
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
  res.json({ ok: true, total: r.total });
});
router.get('/quotes', requireAuth, (req, res) => {
  // 可用 ?case_id= 篩選單一案件（供案件詳情「初步估價紀錄」合併顯示）；不帶則回全部(限200)
  const caseId = req.query.case_id;
  const where  = caseId ? `WHERE q.case_id = ?` : ``;
  const limit  = caseId ? `` : `LIMIT 200`;
  const params = caseId ? [Number(caseId)] : [];
  const rows = db.prepare(`
    SELECT q.id,q.case_id,q.project_name,q.customer_name,q.customer_type,q.region,
           q.subtotal,q.discount,q.disc,q.total,q.status,q.created_at,
           u.name AS created_by_name,
           cl.name AS case_client_name
    FROM est_quotes q
    LEFT JOIN users u    ON u.id = q.created_by
    LEFT JOIN cases c    ON c.id = q.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    ${where} ORDER BY q.id DESC ${limit}
  `).all(...params);
  res.json(rows);
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
router.post('/reset-catalog-defaults', requireAuth, requireEdit, (req, res) => {
  seedCatalogDefaults(true);
  res.json({ ok: true });
});
// 改單筆裝潢膜（每米＋三種連工帶料價）
router.put('/film-catalog/:id', requireAuth, requireEdit, (req, res) => {
  const isOwner = req.session.user.role === 'owner';
  const { per_m, plane, cabinet, shape, active, cost_per_m, width, roll_len, fireproof } = req.body;
  const ecom = Math.round((Number(per_m)||0)*1.05/50)*50; // 電商含稅牌價：由未稅牌價自動推算（進位50）
  db.prepare(`UPDATE est_film_catalog SET per_m=?,ecom_price=?,fireproof=?,plane=?,cabinet=?,shape=?,width=?,roll_len=?,active=? WHERE id=?`)
    .run(Number(per_m)||0, ecom, fireproof||'', Number(plane)||0, Number(cabinet)||0, Number(shape)||0, Number(width)||122, Number(roll_len)||50, active?1:0, req.params.id);
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
  const info = db.prepare(`INSERT INTO est_film_catalog (brand,asia_code,kr_code,color,fireproof,per_m,ecom_price,plane,cabinet,shape,width,roll_len,cost_per_m,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.brand || 'bodaq', b.asia_code || '', b.kr_code || '', b.color || '', b.fireproof || '', Number(b.per_m)||0, ecom, Number(b.plane)||0, Number(b.cabinet)||0, Number(b.shape)||0, Number(b.width)||122, Number(b.roll_len)||50, isOwner ? (Number(b.cost_per_m)||0) : 0, maxSo);
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

module.exports = router;
