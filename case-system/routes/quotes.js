const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

function genToken() { return crypto.randomBytes(16).toString('hex'); }

// 計算報價單各項金額，寫回 quote_sheets
function recalcQuote(quoteId) {
  const items = db.prepare(`SELECT subtotal, item_type FROM quote_sheet_items WHERE quote_id=?`).all(quoteId);
  const q = db.prepare(`SELECT * FROM quote_sheets WHERE id=?`).get(quoteId);
  if (!q) return;

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

// 取得單一報價單（含品項），用於版本切換
router.get('/:quoteId', requireAuth, (req, res) => {
  const q = db.prepare(`SELECT qs.*, u.name as creator_name FROM quote_sheets qs LEFT JOIN users u ON u.id=qs.created_by WHERE qs.id=?`).get(req.params.quoteId);
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

  recalcQuote(Number(req.params.quoteId));
  const q = db.prepare(`SELECT share_token, final_total FROM quote_sheets WHERE id=?`).get(req.params.quoteId);
  res.json({ ok: true, token: q?.share_token, final_total: q?.final_total });
});

// 發送報價單（更新狀態為 sent + 同步案件成交金額）
router.post('/:quoteId/send', requireAuth, (req, res) => {
  recalcQuote(Number(req.params.quoteId));
  db.prepare(`UPDATE quote_sheets SET status='sent', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.quoteId);
  const q = db.prepare(`SELECT share_token, case_id, final_total, marketing_total FROM quote_sheets WHERE id=?`).get(req.params.quoteId);
  if (q) {
    db.prepare(`UPDATE cases SET contract_amount=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(q.final_total || 0, q.case_id);
  }
  res.json({ ok: true, token: q?.share_token });
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
    length_cm, width_cm,
    catalog_item_id, catalog_config, difficulty_level,
    addon_ids, addon_total,
    unit, quantity, unit_price,
    notice_template_id, notice_text,
    material_photo_url, area_photo_url, notes,
    cost_per_meter, estimated_meters, material_cost
  } = req.body;

  // 才數自動計算
  let area_sqchi = req.body.area_sqchi;
  if (!area_sqchi && length_cm && width_cm) {
    area_sqchi = Math.round((Number(length_cm) * Number(width_cm) / 900) * 100) / 100;
  }

  // 小計計算
  const qty = item_type === 'film' ? (area_sqchi || 0) : (Number(quantity) || 1);
  const subtotal = Math.round(qty * (Number(unit_price) || 0) + (Number(addon_total) || 0));

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
     length_cm,width_cm,area_sqchi,
     catalog_item_id,catalog_config,difficulty_level,
     addon_ids,addon_total,unit,quantity,unit_price,subtotal,
     notice_template_id,notice_text,material_photo_url,area_photo_url,notes,
     cost_per_meter,estimated_meters,material_cost)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(quoteId, sort_order, item_type||'film', location||null, description||null,
         film_brand||null, film_model||null, film_spec||null, film_width_cm||122, surface_type||'flat',
         length_cm||null, width_cm||null, area_sqchi||null,
         catalog_item_id||null, JSON.stringify(catalog_config||{}), difficulty_level||3,
         JSON.stringify(addon_ids||[]), addon_total||0,
         unit||'才', quantity||1, unit_price||0, subtotal,
         notice_template_id||null, finalNoticeText||null,
         material_photo_url||null, area_photo_url||null, notes||null,
         cost_per_meter||null, estimated_meters||null, material_cost||null);

  recalcQuote(quoteId);
  res.json({ ok: true, id: r.lastInsertRowid, area_sqchi, subtotal });
});

// 更新品項
router.put('/:quoteId/items/:itemId', requireAuth, (req, res) => {
  const quoteId = Number(req.params.quoteId);
  const {
    item_type, location, description,
    film_brand, film_model, film_spec, film_width_cm, surface_type,
    length_cm, width_cm,
    catalog_item_id, catalog_config, difficulty_level,
    addon_ids, addon_total,
    unit, quantity, unit_price,
    notice_template_id, notice_text,
    material_photo_url, area_photo_url, notes,
    cost_per_meter, estimated_meters, material_cost,
    display_mode, simple_price
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
    length_cm=?,width_cm=?,area_sqchi=?,
    catalog_item_id=?,catalog_config=?,difficulty_level=?,
    addon_ids=?,addon_total=?,unit=?,quantity=?,unit_price=?,subtotal=?,
    notice_template_id=?,notice_text=?,material_photo_url=?,area_photo_url=?,notes=?,
    cost_per_meter=?,estimated_meters=?,material_cost=?,
    display_mode=?,simple_price=?
    WHERE id=? AND quote_id=?`)
    .run(item_type||'film', location||null, description||null,
         film_brand||null, film_model||null, film_spec||null, film_width_cm||122, surface_type||'flat',
         length_cm||null, width_cm||null, area_sqchi||null,
         catalog_item_id||null, JSON.stringify(catalog_config||{}), difficulty_level||3,
         JSON.stringify(addon_ids||[]), addon_total||0,
         unit||'才', quantity||1, unit_price||0, subtotal,
         notice_template_id||null, finalNoticeText??null,
         material_photo_url||null, area_photo_url||null, notes||null,
         cost_per_meter||null, estimated_meters||null, material_cost||null,
         display_mode||'detail', simple_price||null,
         req.params.itemId, quoteId);

  recalcQuote(quoteId);
  res.json({ ok: true, area_sqchi, subtotal, display_mode: display_mode||'detail' });
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

  res.json({ ...q, items });
});

router.post('/sign/:token', (req, res) => {
  const { signature, marketing_consent } = req.body;
  if (!signature) return res.status(400).json({ error: '請提供簽名' });

  const q = db.prepare(`SELECT id, case_id, status, marketing_total, final_total FROM quote_sheets WHERE share_token=?`).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  if (q.status === 'accepted') return res.status(400).json({ error: '此報價單已確認' });

  const consent = marketing_consent ? 1 : 0;
  db.prepare(`UPDATE quote_sheets SET status='accepted', client_signature=?,
    client_accepted_at=CURRENT_TIMESTAMP, client_marketing_consent=? WHERE share_token=?`)
    .run(signature, consent, req.params.token);

  // 案件升為已確認，同步成交金額（行銷同意用優惠價，否則用一般折扣價）
  const finalAmt = consent && q.marketing_total ? q.marketing_total : q.final_total;
  db.prepare(`UPDATE cases SET status='confirmed', contract_amount=?, contracted_at=COALESCE(contracted_at, CURRENT_TIMESTAMP),
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(finalAmt || 0, q.case_id);

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
