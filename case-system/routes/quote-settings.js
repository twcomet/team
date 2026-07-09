const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ── 難度等級費率 ─────────────────────────────────────────────────
router.get('/skill-levels', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM skill_levels ORDER BY level`).all());
});
router.post('/skill-levels', requireAuth, (req, res) => {
  const { level, label, internal_daily_rate, external_daily_rate, notes } = req.body;
  const r = db.prepare(`INSERT INTO skill_levels (level,label,internal_daily_rate,external_daily_rate,notes) VALUES (?,?,?,?,?)`)
    .run(level, label||null, internal_daily_rate||0, external_daily_rate||0, notes||null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.put('/skill-levels/:id', requireAuth, (req, res) => {
  const { label, internal_daily_rate, external_daily_rate, notes, active } = req.body;
  db.prepare(`UPDATE skill_levels SET label=?,internal_daily_rate=?,external_daily_rate=?,notes=?,active=? WHERE id=?`)
    .run(label||null, internal_daily_rate||0, external_daily_rate||0, notes||null, active??1, req.params.id);
  res.json({ ok: true });
});
router.delete('/skill-levels/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM skill_levels WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 公規品目錄 ───────────────────────────────────────────────────
router.get('/catalog', requireAuth, (req, res) => {
  const items = db.prepare(`SELECT ci.*, fnt.name as notice_name FROM catalog_items ci
    LEFT JOIN film_notice_templates fnt ON fnt.id = ci.notice_template_id
    WHERE ci.active=1 ORDER BY ci.category, ci.sort_order, ci.id`).all();
  res.json(items);
});
router.post('/catalog', requireAuth, (req, res) => {
  const { category, name, material, sides, includes_frame, size_spec,
          base_price, default_difficulty, film_width_cm, notice_template_id, sort_order } = req.body;
  const r = db.prepare(`INSERT INTO catalog_items
    (category,name,material,sides,includes_frame,size_spec,base_price,default_difficulty,film_width_cm,notice_template_id,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(category, name, material||null, sides||null, includes_frame?1:0, size_spec||null,
         base_price||0, default_difficulty||3, film_width_cm||122, notice_template_id||null, sort_order||0);
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.put('/catalog/:id', requireAuth, (req, res) => {
  const { category, name, material, sides, includes_frame, size_spec,
          base_price, default_difficulty, film_width_cm, notice_template_id, sort_order, active } = req.body;
  db.prepare(`UPDATE catalog_items SET category=?,name=?,material=?,sides=?,includes_frame=?,size_spec=?,
    base_price=?,default_difficulty=?,film_width_cm=?,notice_template_id=?,sort_order=?,active=? WHERE id=?`)
    .run(category, name, material||null, sides||null, includes_frame?1:0, size_spec||null,
         base_price||0, default_difficulty||3, film_width_cm||122, notice_template_id||null,
         sort_order||0, active??1, req.params.id);
  res.json({ ok: true });
});
router.delete('/catalog/:id', requireAuth, (req, res) => {
  db.prepare(`UPDATE catalog_items SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 加價項目庫 ───────────────────────────────────────────────────
router.get('/addons', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM catalog_addons WHERE active=1 ORDER BY sort_order, id`).all());
});
router.post('/addons', requireAuth, (req, res) => {
  const { name, description, price_type, base_price, max_price, requires_photo, applies_to, sort_order } = req.body;
  const r = db.prepare(`INSERT INTO catalog_addons (name,description,price_type,base_price,max_price,requires_photo,applies_to,sort_order)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(name, description||null, price_type||'fixed', base_price||0, max_price||null,
         requires_photo?1:0, applies_to||'all', sort_order||0);
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.put('/addons/:id', requireAuth, (req, res) => {
  const { name, description, price_type, base_price, max_price, requires_photo, applies_to, sort_order, active } = req.body;
  db.prepare(`UPDATE catalog_addons SET name=?,description=?,price_type=?,base_price=?,max_price=?,
    requires_photo=?,applies_to=?,sort_order=?,active=? WHERE id=?`)
    .run(name, description||null, price_type||'fixed', base_price||0, max_price||null,
         requires_photo?1:0, applies_to||'all', sort_order||0, active??1, req.params.id);
  res.json({ ok: true });
});
router.delete('/addons/:id', requireAuth, (req, res) => {
  db.prepare(`UPDATE catalog_addons SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 貼膜須知模板 ─────────────────────────────────────────────────
router.get('/notices', requireAuth, (req, res) => {
  const block = req.query.block;
  let sql = `SELECT * FROM film_notice_templates WHERE active=1`;
  const ps = [];
  if (block) { sql += ` AND COALESCE(block,'notice')=?`; ps.push(block); }
  sql += ` ORDER BY block, category, sort_order, id`;
  res.json(db.prepare(sql).all(...ps));
});
router.post('/notices', requireAuth, (req, res) => {
  const { name, category, content, sort_order, block, image_url } = req.body;
  const r = db.prepare(`INSERT INTO film_notice_templates (name,category,content,sort_order,block,image_url) VALUES (?,?,?,?,?,?)`)
    .run(name, category||null, content||'', sort_order||0, block||'notice', image_url||null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.put('/notices/:id', requireAuth, (req, res) => {
  const { name, category, content, sort_order, active, block, image_url } = req.body;
  db.prepare(`UPDATE film_notice_templates SET name=?,category=?,content=?,sort_order=?,active=?,block=?,image_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, category||null, content||'', sort_order||0, active??1, block||'notice', image_url||null, req.params.id);
  res.json({ ok: true });
});
router.delete('/notices/:id', requireAuth, (req, res) => {
  db.prepare(`UPDATE film_notice_templates SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 折扣規則 ─────────────────────────────────────────────────────
router.get('/discount-rules', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT dr.*, cc.name as category_name FROM discount_rules dr
    LEFT JOIN client_categories cc ON cc.id = dr.client_category_id
    WHERE dr.active=1 ORDER BY dr.client_category_id, dr.min_amount`).all();
  res.json(rows);
});
router.post('/discount-rules', requireAuth, (req, res) => {
  const { client_category_id, min_amount, discount_rate, label, notes } = req.body;
  const r = db.prepare(`INSERT INTO discount_rules (client_category_id,min_amount,discount_rate,label,notes) VALUES (?,?,?,?,?)`)
    .run(client_category_id||null, min_amount||0, discount_rate, label||null, notes||null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.put('/discount-rules/:id', requireAuth, (req, res) => {
  const { client_category_id, min_amount, discount_rate, label, notes, active } = req.body;
  db.prepare(`UPDATE discount_rules SET client_category_id=?,min_amount=?,discount_rate=?,label=?,notes=?,active=? WHERE id=?`)
    .run(client_category_id||null, min_amount||0, discount_rate, label||null, notes||null, active??1, req.params.id);
  res.json({ ok: true });
});
router.delete('/discount-rules/:id', requireAuth, (req, res) => {
  db.prepare(`UPDATE discount_rules SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// 自動折扣計算：給定 client_id + 金額，回傳最優折扣規則
router.get('/auto-discount', requireAuth, (req, res) => {
  const { client_id, amount } = req.query;
  if (!client_id || !amount) return res.json({ rate: 1.0, label: null, rule_id: null });
  const client = db.prepare(`SELECT category_id FROM clients WHERE id=?`).get(client_id);
  if (!client?.category_id) return res.json({ rate: 1.0, label: null, rule_id: null });
  const rule = db.prepare(`
    SELECT * FROM discount_rules
    WHERE active=1 AND client_category_id=? AND min_amount <= ?
    ORDER BY min_amount DESC LIMIT 1
  `).get(client.category_id, Number(amount));
  if (!rule) return res.json({ rate: 1.0, label: null, rule_id: null });
  res.json({ rate: rule.discount_rate, label: rule.label, rule_id: rule.id });
});

// ── 車馬費地區表 ─────────────────────────────────────────────────
router.get('/travel-fees', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM travel_fees WHERE active=1 ORDER BY sort_order, id`).all());
});
router.post('/travel-fees', requireAuth, (req, res) => {
  const { region_name, keywords, survey_fee, install_fee, overnight_fee, night_surcharge, notes, sort_order } = req.body;
  const r = db.prepare(`INSERT INTO travel_fees (region_name,keywords,survey_fee,install_fee,overnight_fee,night_surcharge,notes,sort_order)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(region_name, keywords||null, survey_fee||0, install_fee||0, overnight_fee||0, night_surcharge||0, notes||null, sort_order||0);
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.put('/travel-fees/:id', requireAuth, (req, res) => {
  const { region_name, keywords, survey_fee, install_fee, overnight_fee, night_surcharge, notes, sort_order, active } = req.body;
  db.prepare(`UPDATE travel_fees SET region_name=?,keywords=?,survey_fee=?,install_fee=?,overnight_fee=?,night_surcharge=?,notes=?,sort_order=?,active=? WHERE id=?`)
    .run(region_name, keywords||null, survey_fee||0, install_fee||0, overnight_fee||0, night_surcharge||0, notes||null, sort_order||0, active??1, req.params.id);
  res.json({ ok: true });
});
router.delete('/travel-fees/:id', requireAuth, (req, res) => {
  db.prepare(`UPDATE travel_fees SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// 依地址關鍵字自動匹配車馬費
router.get('/travel-fees/match', requireAuth, (req, res) => {
  const { address } = req.query;
  if (!address) return res.json(null);
  const all = db.prepare(`SELECT * FROM travel_fees WHERE active=1 ORDER BY sort_order`).all();
  for (const fee of all) {
    const kws = (fee.keywords || '').split(/[,，\s]+/).filter(Boolean);
    if (kws.some(kw => address.includes(kw))) return res.json(fee);
  }
  res.json(null);
});

// ── 膜料價格矩陣 ─────────────────────────────────────────────────
// 回傳可選庫存膜料列表（給新增 modal 的 dropdown 使用）
router.get('/film-prices/inventory', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.brand, m.model, m.spec, m.unit_cost, m.unit_price,
           m.fire_retardant, m.width_cm,
           COALESCE(SUM(mr.remaining_meters), 0) AS stock_meters
    FROM materials m
    LEFT JOIN material_rolls mr ON mr.material_id = m.id AND mr.status='active'
    WHERE m.category = 'film'
    GROUP BY m.id
    ORDER BY m.brand, m.model
  `).all();
  if (!req.session.user?.can_see_cost) rows.forEach(r => { r.unit_cost = null; });
  res.json(rows);
});
router.get('/film-prices', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM film_price_matrix
    WHERE active=1
    ORDER BY brand, series_name, flame_resistant, sort_order
  `).all();
  if (!req.session.user?.can_see_cost) rows.forEach(r => { r.cost_per_meter = null; });

  // 附上各施工類型定價（key'd by service_type_id）
  const svcPrices = db.prepare(`
    SELECT fsp.matrix_id, st.id as service_type_id, st.key as service_type_key, fsp.price
    FROM film_service_prices fsp
    JOIN service_types st ON st.id = fsp.service_type_id
  `).all();
  const priceMap = {};
  svcPrices.forEach(p => {
    if (!priceMap[p.matrix_id]) priceMap[p.matrix_id] = {};
    priceMap[p.matrix_id][p.service_type_key] = p.price;
  });
  rows.forEach(r => { r.service_prices = priceMap[r.id] || {}; });

  res.json(rows);
});

router.post('/film-prices', requireAuth, (req, res) => {
  const { brand, series_code, series_name, flame_resistant, film_width_cm,
          cost_per_meter, service_prices, sort_order, material_id } = req.body;
  const flameVal = flame_resistant === '' || flame_resistant == null ? null : Number(flame_resistant) ? 1 : 0;
  const r = db.prepare(`INSERT INTO film_price_matrix
    (brand,series_code,series_name,flame_resistant,film_width_cm,cost_per_meter,sort_order,material_id)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(brand, series_code||null, series_name||null, flameVal,
         film_width_cm||122, cost_per_meter||0, sort_order||0, material_id||null);
  const matrixId = r.lastInsertRowid;
  _saveServicePrices(matrixId, service_prices || {});
  res.json({ ok: true, id: matrixId });
});

router.put('/film-prices/:id', requireAuth, (req, res) => {
  const { brand, series_code, series_name, flame_resistant, film_width_cm,
          cost_per_meter, service_prices, sort_order, active, material_id } = req.body;
  const flameVal = flame_resistant === '' || flame_resistant == null ? null : Number(flame_resistant) ? 1 : 0;
  db.prepare(`UPDATE film_price_matrix SET brand=?,series_code=?,series_name=?,flame_resistant=?,film_width_cm=?,
    cost_per_meter=?,sort_order=?,active=?,material_id=? WHERE id=?`)
    .run(brand, series_code||null, series_name||null, flameVal,
         film_width_cm||122, cost_per_meter||0,
         sort_order||0, active??1, material_id||null, req.params.id);
  _saveServicePrices(req.params.id, service_prices || {});
  res.json({ ok: true });
});

router.delete('/film-prices/:id', requireAuth, (req, res) => {
  db.prepare(`UPDATE film_price_matrix SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

function _saveServicePrices(matrixId, servicePrices) {
  // servicePrices = { [service_type_key]: price, ... }
  const stRows = db.prepare(`SELECT id, key FROM service_types`).all();
  const stMap = {};
  stRows.forEach(r => { stMap[r.key] = r.id; });
  for (const [key, price] of Object.entries(servicePrices)) {
    const stId = stMap[key];
    if (!stId) continue;
    db.prepare(`INSERT INTO film_service_prices (matrix_id, service_type_id, price)
      VALUES (?,?,?)
      ON CONFLICT(matrix_id, service_type_id) DO UPDATE SET price=excluded.price`)
      .run(matrixId, stId, price || 0);
  }
}

module.exports = router;
