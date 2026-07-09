const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

function genToken() { return crypto.randomBytes(16).toString('hex'); }

// 同步庫存保留記錄
function syncReservations(quoteId, newStatus) {
  if (newStatus === 'pending') {
    db.prepare(`DELETE FROM material_reservations WHERE quote_id=? AND status='pending'`).run(quoteId);
    const q = db.prepare(`SELECT case_id FROM quote_sheets WHERE id=?`).get(quoteId);
    if (!q) return;
    const orgId = db.prepare(`SELECT org_id FROM cases WHERE id=?`).get(q.case_id)?.org_id;
    const items = db.prepare(`
      SELECT id, material_id, area_sqchi, film_width_cm, estimated_meters
      FROM quote_sheet_items
      WHERE quote_id=? AND item_type='film' AND material_id IS NOT NULL
    `).all(quoteId);
    const ins = db.prepare(`
      INSERT INTO material_reservations
        (material_id, quote_id, quote_item_id, case_id, org_id, quantity_sqchi, quantity_meters, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    for (const it of items) {
      const sqchi = it.area_sqchi || 0;
      const fw = it.film_width_cm || 122;
      const meters = it.estimated_meters || Math.round(sqchi * 9 / fw * 100) / 100;
      ins.run(it.material_id, quoteId, it.id, q.case_id, orgId, sqchi, meters);
    }
  } else if (newStatus === 'committed') {
    db.prepare(`UPDATE material_reservations SET status='committed' WHERE quote_id=? AND status='pending'`).run(quoteId);
  } else if (newStatus === 'released') {
    db.prepare(`UPDATE material_reservations SET status='released', released_at=CURRENT_TIMESTAMP WHERE quote_id=? AND status!='released'`).run(quoteId);
  }
}

// 計算報價單各項金額，寫回 quote_sheets
function recalcQuote(quoteId) {
  const q = db.prepare(`SELECT * FROM quote_sheets WHERE id=?`).get(quoteId);
  if (!q) return;
  if (q.engine === 'v2') return recalcQuoteV2(quoteId, q);

  const items = db.prepare(`SELECT subtotal, item_type FROM quote_sheet_items WHERE quote_id=?`).all(quoteId);
  const itemsSubtotal = items.reduce((s, i) => s + (i.subtotal || 0), 0);
  const travel = q.travel_fee || 0;
  const freight = q.freight_fee || 0;
  const subtotal = itemsSubtotal + travel + freight;

  const discountRate = q.discount_rate || 1.0;
  const discountedTotal = Math.round(subtotal * discountRate);

  const marketingRate = q.marketing_rate || 1.0;
  const marketingTotal = Math.round(subtotal * marketingRate);

  const taxRate = q.tax_rate || 0.05;
  const taxAmount = Math.round(discountedTotal * taxRate);
  const finalTotal = discountedTotal + taxAmount;

  db.prepare(`UPDATE quote_sheets SET subtotal=?,discount_value=?,marketing_total=?,tax_amount=?,final_total=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(subtotal, discountedTotal, marketingTotal, taxAmount, finalTotal, quoteId);
}

// v2 重建版算法：逐項優惠(promo) → 行銷優惠(PAROI) → 稅 → 折抵(預付金 client_deposits + 彈性)
function recalcQuoteV2(quoteId, q) {
  const items = db.prepare(`SELECT subtotal, item_disc, promo_price FROM quote_sheet_items WHERE quote_id=?`).all(quoteId);
  const travel = q.travel_fee || 0, freight = q.freight_fee || 0;
  const itemsSubtotal = items.reduce((s, i) => s + (i.subtotal || 0), 0);
  const subtotal = itemsSubtotal + travel + freight;
  // 逐項優惠價：promo_price 優先；否則 subtotal×item_disc/100（item_disc 預設100=不折）
  const promoTotal = items.reduce((s, i) => {
    const p = (i.promo_price != null) ? i.promo_price : Math.round((i.subtotal || 0) * ((i.item_disc ?? 100) / 100));
    return s + p;
  }, 0) + travel + freight;
  // 行銷優惠(PAROI)：mkt_mode pct=再打折(90=9折) / amt=再折抵金額；空=不套用
  let afterMkt = promoTotal;
  if (q.mkt_value) {
    afterMkt = q.mkt_mode === 'amt' ? Math.max(0, promoTotal - q.mkt_value) : Math.round(promoTotal * q.mkt_value / 100);
  }
  const taxRate = q.tax_rate || 0.05;
  const taxAmount = Math.round(afterMkt * taxRate);
  const withTax = afterMkt + taxAmount;
  // 折抵：預付金(已套用到本案的 client_deposits) + 彈性折抵(JSON)
  let flex = 0;
  try { flex = (JSON.parse(q.flex_deducts || '[]')).reduce((s, d) => s + (Number(d.amount) || 0), 0); } catch (e) {}
  const prepay = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM client_deposits WHERE applied_case_id=? AND status='applied'`).get(q.case_id)?.s || 0;
  const finalTotal = withTax - flex - prepay;

  db.prepare(`UPDATE quote_sheets SET subtotal=?,discount_value=?,marketing_total=?,tax_amount=?,final_total=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(subtotal, promoTotal, afterMkt, taxAmount, finalTotal, quoteId);
}

// v2 品項：依計價方式修正 subtotal/才數、寫入 v2 欄位，並把整單標記為 v2 引擎
// 計價方式：unit=單價×數量 / cai=才數×單價/才 / material=每米×米數 / row_kind=text 自由文字列(單價×數量)
function applyV2Item(quoteId, itemId, b) {
  if (b.calc_mode === undefined && b.row_kind === undefined) return; // 非 v2 呼叫，不動
  const mode = b.calc_mode || 'unit';
  const kind = b.row_kind || 'item';
  const qty = Number(b.quantity) || 1;
  const width = Number(b.film_width_cm) || 0;
  const srv = Number(b.estimated_meters) || 0;   // 工務回報米數
  const unitPrice = Number(b.unit_price) || 0;
  const unitCai = Number(b.unit_price_cai) || 0;
  // 才數 = 米數 × 100 × 膜寬 ÷ 900（與 estimator 一致）
  const cai = (b.area_sqchi != null && b.area_sqchi !== '') ? Number(b.area_sqchi)
            : Math.round(srv * 100 * width / 900 * 100) / 100;
  let subtotal;
  if (kind === 'text')      subtotal = Math.round(unitPrice * qty);
  else if (mode === 'cai')  subtotal = Math.round(cai * unitCai);
  else                      subtotal = Math.round(unitPrice * qty); // unit & material
  const disc  = (b.item_disc != null && b.item_disc !== '') ? Number(b.item_disc) : 100;
  const promo = (b.promo_price != null && b.promo_price !== '') ? Number(b.promo_price) : Math.round(subtotal * disc / 100);
  const suggested = (b.suggested_price != null && b.suggested_price !== '') ? Number(b.suggested_price) : Math.round(cai * unitCai);
  const areaPhotos = b.area_photos == null ? '[]' : (typeof b.area_photos === 'string' ? b.area_photos : JSON.stringify(b.area_photos));
  db.prepare(`UPDATE quote_sheet_items SET
      calc_mode=?, unit_price_cai=?, item_disc=?, promo_price=?, area_photos=?, row_kind=?, suggested_price=?, area_sqchi=?, subtotal=?
      WHERE id=? AND quote_id=?`)
    .run(mode, unitCai, disc, promo, areaPhotos, kind, suggested, cai, subtotal, itemId, quoteId);
  db.prepare(`UPDATE quote_sheets SET engine='v2' WHERE id=?`).run(quoteId);
}

// ── 報價單總列表（含過濾）────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, from, to, search, case_type } = req.query;

  let sql = `
    SELECT qs.id, qs.case_id, qs.version, qs.status, qs.final_total, qs.created_at,
           qs.discount_rate, qs.share_token, qs.updated_at,
           c.case_number, c.title, c.case_type, c.org_id,
           cl.name as client_name,
           u.name as creator_name
    FROM quote_sheets qs
    JOIN cases c ON c.id = qs.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users u ON u.id = qs.created_by
    WHERE 1=1
  `;
  const params = [];

  if (me.role !== 'owner') { sql += ` AND c.org_id = ?`; params.push(me.org_id); }
  if (status)    { sql += ` AND qs.status = ?`; params.push(status); }
  if (from)      { sql += ` AND date(qs.created_at) >= ?`; params.push(from); }
  if (to)        { sql += ` AND date(qs.created_at) <= ?`; params.push(to); }
  if (case_type) { sql += ` AND c.case_type = ?`; params.push(case_type); }
  if (search) {
    sql += ` AND (c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ?)`;
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  sql += ` ORDER BY qs.created_at DESC LIMIT 300`;
  res.json(db.prepare(sql).all(...params));
});

// ── 案件搜尋（新增報價單 modal 用）──────────────────────────────
router.get('/search-cases', requireAuth, (req, res) => {
  const me = req.session.user;
  const { q } = req.query;
  if (!q) return res.json([]);
  const like = `%${q}%`;
  let sql = `
    SELECT c.id, c.case_number, c.title, c.case_type, c.status,
           cl.name as client_name
    FROM cases c
    LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE (c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ?)
    AND c.status NOT IN ('closed','invalid')
  `;
  const params = [like, like, like];
  if (me.role !== 'owner') { sql += ` AND c.org_id = ?`; params.push(me.org_id); }
  sql += ` ORDER BY c.created_at DESC LIMIT 20`;
  res.json(db.prepare(sql).all(...params));
});

// ── 取得案件所有版本的報價單列表 ─────────────────────────────────
router.get('/cases/:id/versions', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT qs.*, u.name as creator_name FROM quote_sheets qs
    LEFT JOIN users u ON u.id = qs.created_by
    WHERE qs.case_id = ? ORDER BY qs.version DESC
  `).all(req.params.id);
  res.json(rows);
});

// 取得案件最新報價單（含品項）
router.get('/cases/:id', requireAuth, (req, res) => {
  const q = db.prepare(`
    SELECT qs.*, u.name as creator_name FROM quote_sheets qs
    LEFT JOIN users u ON u.id = qs.created_by
    WHERE qs.case_id = ? ORDER BY qs.version DESC LIMIT 1
  `).get(req.params.id);
  if (!q) return res.json(null);
  q.items = db.prepare(`SELECT * FROM quote_sheet_items WHERE quote_id=? ORDER BY sort_order, id`).all(q.id);
  res.json(q);
});

// 建立新報價單（或首次建立）
router.post('/cases/:id', requireAuth, (req, res) => {
  const case_id = Number(req.params.id);
  const me = req.session.user;
  const { valid_days, payment_terms, client_notes, client_type,
          discount_rate, marketing_rate, tax_rate,
          travel_fee, freight_fee, notes_terms, notes_acceptance,
          discount_rule_id } = req.body;

  const lastVersion = db.prepare(`SELECT MAX(version) as v FROM quote_sheets WHERE case_id=?`).get(case_id);
  const newVersion = (lastVersion?.v || 0) + 1;
  const token = genToken();

  const r = db.prepare(`
    INSERT INTO quote_sheets (case_id, share_token, version, valid_days, payment_terms, client_notes,
      client_type, discount_rate, marketing_rate, tax_rate, travel_fee, freight_fee,
      notes_terms, notes_acceptance, discount_rule_id, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(case_id, token, newVersion,
    valid_days ?? 30, payment_terms ?? null, client_notes ?? null,
    client_type ?? 'owner',
    discount_rate ?? 1.0, marketing_rate ?? 1.0, tax_rate ?? 0.05,
    travel_fee ?? 0, freight_fee ?? 0,
    notes_terms ?? null, notes_acceptance ?? null,
    discount_rule_id ?? null, 'draft', me.id);

  const quoteId = r.lastInsertRowid;

  // 如果有指定從上一版複製品項
  if (req.body.copy_from_version) {
    const prev = db.prepare(`SELECT id FROM quote_sheets WHERE case_id=? AND version=?`).get(case_id, req.body.copy_from_version);
    if (prev) {
      const prevItems = db.prepare(`SELECT * FROM quote_sheet_items WHERE quote_id=?`).all(prev.id);
      const ins = db.prepare(`INSERT INTO quote_sheet_items (quote_id,sort_order,item_type,location,description,
        film_brand,film_model,film_spec,film_width_cm,surface_type,length_cm,width_cm,area_sqchi,
        catalog_item_id,catalog_config,difficulty_level,addon_ids,addon_total,
        unit,quantity,unit_price,subtotal,notice_template_id,notice_text,
        material_photo_url,area_photo_url,notes,cost_per_meter,estimated_meters,material_cost)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of prevItems) {
        ins.run(quoteId, item.sort_order, item.item_type, item.location, item.description,
          item.film_brand, item.film_model, item.film_spec, item.film_width_cm, item.surface_type,
          item.length_cm, item.width_cm, item.area_sqchi,
          item.catalog_item_id, item.catalog_config, item.difficulty_level,
          item.addon_ids, item.addon_total,
          item.unit, item.quantity, item.unit_price, item.subtotal,
          item.notice_template_id, item.notice_text,
          item.material_photo_url, item.area_photo_url, item.notes,
          item.cost_per_meter, item.estimated_meters, item.material_cost);
      }
      recalcQuote(quoteId);
    }
  }

  // 升案件狀態
  const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(case_id);
  if (c?.status === 'inquiry' || c?.status === 'surveyed') {
    db.prepare(`UPDATE cases SET status='quoted', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(case_id);
  }

  res.json({ ok: true, id: quoteId, token, version: newVersion });
});

// ── 報價單範本（骨架）：只存報價品項內容，可存多種版本（電梯/門片…）─────────
// 注意：這些 /templates 路由必須定義在 /:quoteId 之前，否則會被當成 quoteId

// 範本清單（建立者 / 標題 / 建立日期 / 品項數）
router.get('/templates', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.item_count, t.created_at, u.name AS created_by_name
    FROM quote_templates t LEFT JOIN users u ON u.id = t.created_by
    ORDER BY t.created_at DESC, t.id DESC`).all();
  res.json(rows);
});

// 取得單一範本內容（含品項）供導入
router.get('/templates/:tid', requireAuth, (req, res) => {
  const t = db.prepare(`SELECT id, title, items_json, item_count, created_at FROM quote_templates WHERE id=?`).get(req.params.tid);
  if (!t) return res.status(404).json({ error: '找不到範本' });
  let items = [];
  try { items = JSON.parse(t.items_json || '[]') || []; } catch (e) { items = []; }
  res.json({ id: t.id, title: t.title, item_count: t.item_count, created_at: t.created_at, items });
});

// 儲存範本（body: { title, items }）items = 前端品項陣列（已去除照片/案件資料）
router.post('/templates', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!title) return res.status(400).json({ error: '請輸入範本標題' });
  if (!items.length) return res.status(400).json({ error: '沒有可儲存的報價品項' });
  const r = db.prepare(`INSERT INTO quote_templates (title, items_json, item_count, created_by) VALUES (?,?,?,?)`)
    .run(title, JSON.stringify(items), items.length, req.session.user.id);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// 刪除範本（限老闆或建立者）
router.delete('/templates/:tid', requireAuth, (req, res) => {
  const me = req.session.user;
  const t = db.prepare(`SELECT created_by FROM quote_templates WHERE id=?`).get(req.params.tid);
  if (!t) return res.status(404).json({ error: '找不到範本' });
  if (me.role !== 'owner' && !me.manage_users && t.created_by !== me.id)
    return res.status(403).json({ error: '僅限老闆或建立者可刪除此範本' });
  db.prepare(`DELETE FROM quote_templates WHERE id=?`).run(req.params.tid);
  res.json({ ok: true });
});

// 取得單一報價單（含品項），用於版本切換
router.get('/:quoteId', requireAuth, (req, res) => {
  const q = db.prepare(`
    SELECT qs.*, u.name as creator_name,
           c.case_number, c.title as case_title, c.location as case_location, c.client_id,
           cl.name as client_name, cl.phone as client_phone, cl.tax_id as client_tax_id, cl.contact_person as client_contact
    FROM quote_sheets qs
    LEFT JOIN users u ON u.id=qs.created_by
    LEFT JOIN cases c ON c.id=qs.case_id
    LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE qs.id=?`).get(req.params.quoteId);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  q.items = db.prepare(`SELECT * FROM quote_sheet_items WHERE quote_id=? ORDER BY sort_order, id`).all(q.id);
  res.json(q);
});

// 更新報價單設定（不含品項）
router.put('/:quoteId', requireAuth, (req, res) => {
  const { valid_days, payment_terms, client_notes, client_type, status,
          discount_rate, marketing_rate, tax_rate,
          travel_fee, freight_fee, notes_terms, notes_acceptance, discount_rule_id } = req.body;

  db.prepare(`UPDATE quote_sheets SET valid_days=?,payment_terms=?,client_notes=?,client_type=?,
    discount_rate=?,marketing_rate=?,tax_rate=?,travel_fee=?,freight_fee=?,
    notes_terms=?,notes_acceptance=?,discount_rule_id=?,status=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?`)
    .run(valid_days??30, payment_terms??null, client_notes??null, client_type??'owner',
         discount_rate??1.0, marketing_rate??1.0, tax_rate??0.05,
         travel_fee??0, freight_fee??0,
         notes_terms??null, notes_acceptance??null, discount_rule_id??null,
         status??'draft', req.params.quoteId);

  // v2 欄位（行銷優惠 PAROI / 彈性折抵 / 須知；前端 v2 存檔會整包帶）
  const v2 = req.body;
  if (v2.engine === 'v2' || v2.mkt_mode !== undefined || v2.flex_deducts !== undefined) {
    db.prepare(`UPDATE quote_sheets SET mkt_mode=?, mkt_value=?, flex_deducts=?, notes_notice=?, notes_inspection=?, engine='v2', client_marketing_consent=? WHERE id=?`)
      .run(v2.mkt_mode || 'pct',
           (v2.mkt_value === '' || v2.mkt_value == null) ? null : Number(v2.mkt_value),
           v2.flex_deducts != null ? (typeof v2.flex_deducts === 'string' ? v2.flex_deducts : JSON.stringify(v2.flex_deducts)) : '[]',
           v2.notes_notice ?? null, v2.notes_inspection ?? null,
           v2.client_marketing_consent ? 1 : 0,
           req.params.quoteId);
  }

  // 各條款區塊附圖（如(d)回簽/付款的銀行帳號圖）
  if (v2.block_images !== undefined) {
    const bi = typeof v2.block_images === 'string' ? v2.block_images : JSON.stringify(v2.block_images || {});
    db.prepare(`UPDATE quote_sheets SET block_images=? WHERE id=?`).run(bi, req.params.quoteId);
  }

  recalcQuote(Number(req.params.quoteId));
  const q = db.prepare(`SELECT share_token, final_total FROM quote_sheets WHERE id=?`).get(req.params.quoteId);
  res.json({ ok: true, token: q?.share_token, final_total: q?.final_total });
});

// 發送報價單（更新狀態為 sent + 同步案件成交金額 + 建立 pending 保留）
router.post('/:quoteId/send', requireAuth, (req, res) => {
  const quoteId = Number(req.params.quoteId);
  recalcQuote(quoteId);
  db.prepare(`UPDATE quote_sheets SET status='sent', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(quoteId);
  const q = db.prepare(`SELECT share_token, case_id, final_total, marketing_total FROM quote_sheets WHERE id=?`).get(quoteId);
  if (q) {
    db.prepare(`UPDATE cases SET contract_amount=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(q.final_total || 0, q.case_id);
  }
  try { syncReservations(quoteId, 'pending'); } catch(e) { /* non-critical */ }
  res.json({ ok: true, token: q?.share_token });
});

// 退回報價（客戶拒絕或客服取消）
router.post('/:quoteId/reject', requireAuth, (req, res) => {
  const quoteId = Number(req.params.quoteId);
  db.prepare(`UPDATE quote_sheets SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(quoteId);
  try { syncReservations(quoteId, 'released'); } catch(e) { /* non-critical */ }
  res.json({ ok: true });
});

// ── 品項 CRUD ────────────────────────────────────────────────────

// 取得報價單的所有品項
router.get('/:quoteId/items', requireAuth, (req, res) => {
  const items = db.prepare(`SELECT * FROM quote_sheet_items WHERE quote_id=? ORDER BY sort_order, id`).all(req.params.quoteId);
  res.json(items);
});

// 新增品項
router.post('/:quoteId/items', requireAuth, (req, res) => {
  const quoteId = Number(req.params.quoteId);
  const {
    item_type, location, description,
    film_brand, film_model, film_spec, film_width_cm, surface_type,
    length_cm, width_cm, size_text,
    catalog_item_id, catalog_config, difficulty_level,
    addon_ids, addon_total,
    unit, quantity, unit_price,
    notice_template_id, notice_text,
    material_photo_url, area_photo_url, notes,
    cost_per_meter, estimated_meters, material_cost,
    display_mode, simple_price,
    material_id
  } = req.body;

  // 才數自動計算
  let area_sqchi = req.body.area_sqchi;
  if (!area_sqchi && length_cm && width_cm) {
    area_sqchi = Math.round((Number(length_cm) * Number(width_cm) / 900) * 100) / 100;
  }

  // 小計計算：簡易模式(報價單主要用法)＝單價×數量，不算才數；否則沿用才數/數量×單價
  let subtotal;
  if (display_mode === 'simple') {
    subtotal = Math.round((Number(simple_price) || 0) * (Number(quantity) || 1));
  } else {
    const qty = item_type === 'film' ? (area_sqchi || 0) : (Number(quantity) || 1);
    subtotal = Math.round(qty * (Number(unit_price) || 0) + (Number(addon_total) || 0));
  }

  // 自動帶入貼膜須知
  let finalNoticeText = notice_text;
  if (!finalNoticeText && notice_template_id) {
    const tmpl = db.prepare(`SELECT content FROM film_notice_templates WHERE id=?`).get(notice_template_id);
    finalNoticeText = tmpl?.content || null;
  }

  const maxOrder = db.prepare(`SELECT MAX(sort_order) as m FROM quote_sheet_items WHERE quote_id=?`).get(quoteId);
  const sort_order = (maxOrder?.m ?? -1) + 1;

  const r = db.prepare(`INSERT INTO quote_sheet_items
    (quote_id,sort_order,item_type,location,description,
     film_brand,film_model,film_spec,film_width_cm,surface_type,
     length_cm,width_cm,size_text,area_sqchi,
     catalog_item_id,catalog_config,difficulty_level,
     addon_ids,addon_total,unit,quantity,unit_price,subtotal,
     notice_template_id,notice_text,material_photo_url,area_photo_url,notes,
     cost_per_meter,estimated_meters,material_cost,display_mode,simple_price,material_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(quoteId, sort_order, item_type||'film', location||null, description||null,
         film_brand||null, film_model||null, film_spec||null, film_width_cm||122, surface_type||'flat',
         length_cm||null, width_cm||null, size_text||null, area_sqchi||null,
         catalog_item_id||null, JSON.stringify(catalog_config||{}), difficulty_level||3,
         JSON.stringify(addon_ids||[]), addon_total||0,
         unit||'才', quantity||1, unit_price||0, subtotal,
         notice_template_id||null, finalNoticeText||null,
         material_photo_url||null, area_photo_url||null, notes||null,
         cost_per_meter||null, estimated_meters||null, material_cost||null,
         display_mode||'detail', simple_price||null, material_id||null);

  applyV2Item(quoteId, r.lastInsertRowid, req.body);
  recalcQuote(quoteId);
  const saved = db.prepare(`SELECT area_sqchi, subtotal, promo_price FROM quote_sheet_items WHERE id=?`).get(r.lastInsertRowid);
  res.json({ ok: true, id: r.lastInsertRowid, area_sqchi: saved?.area_sqchi, subtotal: saved?.subtotal, promo_price: saved?.promo_price });
});

// 更新品項
router.put('/:quoteId/items/:itemId', requireAuth, (req, res) => {
  const quoteId = Number(req.params.quoteId);
  const {
    item_type, location, description,
    film_brand, film_model, film_spec, film_width_cm, surface_type,
    length_cm, width_cm, size_text,
    catalog_item_id, catalog_config, difficulty_level,
    addon_ids, addon_total,
    unit, quantity, unit_price,
    notice_template_id, notice_text,
    material_photo_url, area_photo_url, notes,
    cost_per_meter, estimated_meters, material_cost,
    display_mode, simple_price, material_id
  } = req.body;

  let area_sqchi = req.body.area_sqchi;
  if (!area_sqchi && length_cm && width_cm) {
    area_sqchi = Math.round((Number(length_cm) * Number(width_cm) / 900) * 100) / 100;
  }

  let subtotal;
  if (display_mode === 'simple') {
    subtotal = Math.round((Number(simple_price) || 0) * (Number(quantity) || 1));
  } else {
    const qty = item_type === 'film' ? (area_sqchi || 0) : (Number(quantity) || 1);
    subtotal = Math.round(qty * (Number(unit_price) || 0) + (Number(addon_total) || 0));
  }

  let finalNoticeText = notice_text;
  if (finalNoticeText === undefined && notice_template_id) {
    const tmpl = db.prepare(`SELECT content FROM film_notice_templates WHERE id=?`).get(notice_template_id);
    finalNoticeText = tmpl?.content || null;
  }

  db.prepare(`UPDATE quote_sheet_items SET
    item_type=?,location=?,description=?,
    film_brand=?,film_model=?,film_spec=?,film_width_cm=?,surface_type=?,
    length_cm=?,width_cm=?,size_text=?,area_sqchi=?,
    catalog_item_id=?,catalog_config=?,difficulty_level=?,
    addon_ids=?,addon_total=?,unit=?,quantity=?,unit_price=?,subtotal=?,
    notice_template_id=?,notice_text=?,material_photo_url=?,area_photo_url=?,notes=?,
    cost_per_meter=?,estimated_meters=?,material_cost=?,
    display_mode=?,simple_price=?,material_id=?
    WHERE id=? AND quote_id=?`)
    .run(item_type||'film', location||null, description||null,
         film_brand||null, film_model||null, film_spec||null, film_width_cm||122, surface_type||'flat',
         length_cm||null, width_cm||null, size_text||null, area_sqchi||null,
         catalog_item_id||null, JSON.stringify(catalog_config||{}), difficulty_level||3,
         JSON.stringify(addon_ids||[]), addon_total||0,
         unit||'才', quantity||1, unit_price||0, subtotal,
         notice_template_id||null, finalNoticeText??null,
         material_photo_url||null, area_photo_url||null, notes||null,
         cost_per_meter||null, estimated_meters||null, material_cost||null,
         display_mode||'detail', simple_price||null, material_id||null,
         req.params.itemId, quoteId);

  applyV2Item(quoteId, Number(req.params.itemId), req.body);
  recalcQuote(quoteId);
  const saved = db.prepare(`SELECT area_sqchi, subtotal, promo_price FROM quote_sheet_items WHERE id=?`).get(req.params.itemId);
  res.json({ ok: true, area_sqchi: saved?.area_sqchi, subtotal: saved?.subtotal, promo_price: saved?.promo_price, display_mode: display_mode||'detail' });
});

// 刪除整張報價單
router.delete('/:quoteId', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.manage_users) return res.status(403).json({ error: '僅限老闆或管理員可刪除報價單' });
  const qs = db.prepare(`SELECT qs.id, qs.status, c.status as case_status, c.case_number
    FROM quote_sheets qs JOIN cases c ON c.id=qs.case_id
    WHERE qs.id=?`).get(req.params.quoteId);
  if (!qs) return res.status(404).json({ error: '找不到報價單' });
  const dealStatuses = ['contracted','payment','closed'];
  if (dealStatuses.includes(qs.case_status))
    return res.status(400).json({ error: `案件 ${qs.case_number} 已成交，報價單無法刪除` });
  if (qs.status === 'signed')
    return res.status(400).json({ error: '已簽署的報價單無法刪除' });
  db.prepare(`DELETE FROM quote_sheet_items WHERE quote_id=?`).run(req.params.quoteId);
  db.prepare(`DELETE FROM quote_sheets WHERE id=?`).run(req.params.quoteId);
  res.json({ ok: true });
});

// 刪除品項
router.delete('/:quoteId/items/:itemId', requireAuth, (req, res) => {
  const quoteId = Number(req.params.quoteId);
  db.prepare(`DELETE FROM quote_sheet_items WHERE id=? AND quote_id=?`).run(req.params.itemId, quoteId);
  recalcQuote(quoteId);
  res.json({ ok: true });
});

// 品項排序
router.post('/:quoteId/items/reorder', requireAuth, (req, res) => {
  const { order } = req.body; // array of item ids in new order
  const stmt = db.prepare(`UPDATE quote_sheet_items SET sort_order=? WHERE id=? AND quote_id=?`);
  order.forEach((id, idx) => stmt.run(idx, id, req.params.quoteId));
  res.json({ ok: true });
});

// ── 公開頁面（客戶看報價，不需登入）────────────────────────────

router.get('/sign/:token', (req, res) => {
  const q = db.prepare(`
    SELECT qs.*, c.title, c.case_number, c.location,
           cl.name as client_name, cl.phone as client_phone,
           u.name as creator_name, o.name as org_name
    FROM quote_sheets qs
    JOIN cases c ON c.id = qs.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users u ON u.id = qs.created_by
    LEFT JOIN orgs o ON o.id = c.org_id
    WHERE qs.share_token = ?
  `).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });

  // 記錄客戶首次開啟（已傳送後才算，避免草稿內部預覽誤標）→ 列表顯示「客戶已打開」
  if (!q.client_viewed_at && q.status !== 'draft') {
    db.prepare(`UPDATE quote_sheets SET client_viewed_at=CURRENT_TIMESTAMP WHERE id=? AND client_viewed_at IS NULL`).run(q.id);
    q.client_viewed_at = new Date().toISOString();
  }

  // 優先讀 quote_sheet_items（新版），fallback 到 case_items（舊版相容）
  let items = db.prepare(`SELECT * FROM quote_sheet_items WHERE quote_id=? ORDER BY sort_order, id`).all(q.id);
  if (!items.length) {
    items = db.prepare(`
      SELECT id, sort_order, item_type, description, location,
             width_cm, height_cm, quantity, unit, area as area_sqchi,
             material_brand as film_brand, material_model as film_model,
             client_unit_price as unit_price,
             CASE WHEN client_unit_price IS NOT NULL THEN client_subtotal ELSE subtotal END as subtotal
      FROM case_items WHERE case_id = ? ORDER BY sort_order, id
    `).all(q.case_id);
  }

  // 🔒 客戶端機密過濾：成本欄位「永遠」不送到客戶頁（防外洩）；
  //    業主版（client_type='owner'）另外隱藏才數/尺寸/單價，只給項目與金額。
  //    ⚠️ 日後新增任何成本類欄位，務必加進 COST_FIELDS。
  const hideChi = (q.client_type === 'owner');
  const COST_FIELDS = ['cost_per_meter', 'material_cost', 'estimated_meters', 'material_id'];
  const CHI_FIELDS  = ['area_sqchi', 'length_cm', 'width_cm', 'height_cm', 'film_width_cm', 'unit_price', 'surface_type'];
  items = items.map(it => {
    const o = { ...it };
    for (const f of COST_FIELDS) delete o[f];
    if (hideChi) for (const f of CHI_FIELDS) delete o[f];
    return o;
  });

  res.json({ ...q, hide_chi: hideChi ? 1 : 0, items });
});

router.post('/sign/:token', (req, res) => {
  const { signature, marketing_consent } = req.body;
  if (!signature) return res.status(400).json({ error: '請提供簽名' });

  const q = db.prepare(`SELECT id, case_id, status, engine, discount_value, marketing_total, tax_amount, tax_rate, final_total FROM quote_sheets WHERE share_token=?`).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  if (q.status === 'accepted') return res.status(400).json({ error: '此報價單已確認' });

  const consent = marketing_consent ? 1 : 0;
  db.prepare(`UPDATE quote_sheets SET status='accepted', client_signature=?,
    client_accepted_at=CURRENT_TIMESTAMP, client_marketing_consent=? WHERE share_token=?`)
    .run(signature, consent, req.params.token);

  // 案件升為已確認，同步成交金額
  let finalAmt;
  if (q.engine === 'v2') {
    // final_total 已是「同意拍照」的含稅扣折抵應付；不同意＝優惠價×(1+稅)−折抵
    const deduction = Math.max(0, (q.marketing_total || 0) + (q.tax_amount || 0) - (q.final_total || 0));
    finalAmt = consent ? (q.final_total || 0)
                       : Math.round((q.discount_value || 0) * (1 + (q.tax_rate || 0.05))) - deduction;
  } else {
    finalAmt = consent && q.marketing_total ? q.marketing_total : q.final_total;
  }
  db.prepare(`UPDATE cases SET status='confirmed', contract_amount=?, contracted_at=COALESCE(contracted_at, CURRENT_TIMESTAMP),
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(finalAmt || 0, q.case_id);

  // 升級為 committed 保留
  try { syncReservations(q.id, 'committed'); } catch(e) { /* non-critical */ }

  // 通知負責業務
  try {
    const caseInfo = db.prepare(`SELECT title, case_number, assigned_to FROM cases WHERE id=?`).get(q.case_id);
    if (caseInfo?.assigned_to) {
      const fmtAmt = finalAmt ? 'NT$' + Math.round(finalAmt).toLocaleString('zh-TW') : '';
      db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'quote','cases',?,?)`)
        .run(caseInfo.assigned_to,
          '客戶已確認報價單',
          `${caseInfo.title||caseInfo.case_number} ${fmtAmt}${consent?' (含行銷同意)':''}`,
          q.case_id,
          `/case-detail?id=${q.case_id}`);
    }
  } catch(e) { /* non-critical */ }

  res.json({ ok: true });
});

module.exports = router;
