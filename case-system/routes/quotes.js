const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

function genToken() { return crypto.randomBytes(16).toString('hex'); }

// 只有「草稿」可直接編輯；已發送/已確認/已拒絕一律唯讀（前端會自動分版後改草稿）。回傳 true=可寫
function ensureDraft(quoteId, res) {
  const st = db.prepare(`SELECT status FROM quote_sheets WHERE id=?`).get(quoteId)?.status;
  if (st && st !== 'draft') { res.status(409).json({ error: '此報價單已發送，請建立新版後再編輯', locked: true }); return false; }
  return true;
}

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

  const taxRate = q.no_invoice ? 0 : (q.tax_rate || 0.05);   // 不開發票 → 免稅
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
  const taxRate = q.no_invoice ? 0 : (q.tax_rate || 0.05);   // 不開發票 → 免稅
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
  // 工務回報的人力：人數 × 工作天數（內部成本/毛利/成本地板用；不對客戶顯示）
  const workers  = (b.workers   != null && b.workers   !== '') ? Number(b.workers)   : null;
  const workDays = (b.work_days != null && b.work_days !== '') ? Number(b.work_days) : null;
  const sellMode = b.sell_mode || '';   // 膜料販售：'roll'=整支、其餘=散米/米
  db.prepare(`UPDATE quote_sheet_items SET
      calc_mode=?, unit_price_cai=?, item_disc=?, promo_price=?, area_photos=?, row_kind=?, suggested_price=?, area_sqchi=?, subtotal=?, workers=?, work_days=?, sell_mode=?
      WHERE id=? AND quote_id=?`)
    .run(mode, unitCai, disc, promo, areaPhotos, kind, suggested, cai, subtotal, workers, workDays, sellMode, itemId, quoteId);
  db.prepare(`UPDATE quote_sheets SET engine='v2' WHERE id=?`).run(quoteId);
}

// ── 報價單總列表（含過濾）────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, from, to, search, case_type, creator } = req.query;

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
  if (creator)   { sql += ` AND qs.created_by = ?`; params.push(creator); }
  if (search) {
    sql += ` AND (c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ?)`;
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  sql += ` ORDER BY qs.created_at DESC LIMIT 300`;
  res.json(db.prepare(sql).all(...params));
});

// ── 編輯人清單（報價管理「編輯人」下拉篩選用；只列有建過報價單的人）────
router.get('/editors', requireAuth, (req, res) => {
  const me = req.session.user;
  let sql = `SELECT DISTINCT u.id, u.name
    FROM quote_sheets qs
    JOIN users u ON u.id = qs.created_by
    JOIN cases c ON c.id = qs.case_id
    WHERE u.name IS NOT NULL AND u.name <> ''`;
  const params = [];
  if (me.role !== 'owner') { sql += ` AND c.org_id = ?`; params.push(me.org_id); }
  sql += ` ORDER BY u.name`;
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

// 客戶連結短網址：改用自家網域 /s/<code>（無 TinyURL 中轉預覽頁）；同一單重用同一短碼
router.get('/short/:token', requireAuth, (req, res) => {
  const q = db.prepare(`SELECT id, share_token, short_url FROM quote_sheets WHERE share_token=?`).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  const proto  = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const origin = `${proto}://${req.get('host')}`;
  const full   = `${origin}/quote/${q.share_token}`;
  if (q.short_url && q.short_url.includes('/s/')) return res.json({ short_url: q.short_url, full });  // 只重用自家短網址；舊的 TinyURL 快取重建
  const { makeShort } = require('./shortlink');
  const code  = makeShort(full);
  const short = code ? `${origin}/s/${code}` : full;
  db.prepare(`UPDATE quote_sheets SET short_url=? WHERE id=?`).run(short, q.id);
  res.json({ short_url: short, full });
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
    client_type ?? 'designer',   // 新單預設設計師版(顯示單價/才數)，與前端 fallback 一致；業主版藏價由使用者手動切
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

  // 升案件狀態：開始建立報價單 → 「已建報價資料」(quote_draft)。
  // 「已發報價單」(quoted) 一律不自動判別；改由客服在案件狀態手動變更（stage 機制 quote_draft→quoted）。
  const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(case_id);
  const PRE_QUOTE = ['inquiry','initial_estimate','cared_waiting','quote_needed','quote_sent','survey_pending','survey_scheduled','surveyed'];
  if (PRE_QUOTE.includes(c?.status)) {
    db.prepare(`UPDATE cases SET status='quote_draft', quote_draft_at=COALESCE(quote_draft_at,CURRENT_TIMESTAMP), quote_drafted_by=COALESCE(quote_drafted_by,?), updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(me.id, case_id);
  }

  res.json({ ok: true, id: quoteId, token, version: newVersion });
});

// ── 報價單範本（骨架）：只存報價品項內容，可存多種版本（電梯/門片…）─────────
// 注意：這些 /templates 路由必須定義在 /:quoteId 之前，否則會被當成 quoteId

// 範本清單（建立者 / 標題 / 建立日期 / 品項數）
router.get('/templates', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.item_count, t.created_at, t.blocks_json, u.name AS created_by_name
    FROM quote_templates t LEFT JOIN users u ON u.id = t.created_by
    ORDER BY t.created_at DESC, t.id DESC`).all();
  rows.forEach(r => {
    let b = {}; try { b = JSON.parse(r.blocks_json || '{}') || {}; } catch (e) {}
    r.has_blocks = ['termA','notice','termC','termD'].some(k => String(b[k] || '').trim()) ? 1 : 0;
    delete r.blocks_json;
  });
  res.json(rows);
});

// 取得單一範本內容（含品項 + 底部文字區塊）供導入
router.get('/templates/:tid', requireAuth, (req, res) => {
  const t = db.prepare(`SELECT id, title, items_json, blocks_json, item_count, created_at FROM quote_templates WHERE id=?`).get(req.params.tid);
  if (!t) return res.status(404).json({ error: '找不到範本' });
  let items = [];
  try { items = JSON.parse(t.items_json || '[]') || []; } catch (e) { items = []; }
  let blocks = {};
  try { blocks = JSON.parse(t.blocks_json || '{}') || {}; } catch (e) { blocks = {}; }
  res.json({ id: t.id, title: t.title, item_count: t.item_count, created_at: t.created_at, items, blocks });
});

// 儲存範本（body: { title, items, blocks }）
//   items  = 前端品項陣列（已去除照片/案件資料）
//   blocks = 報價單底部文字 { termA, notice, termC, termD, block_images }
router.post('/templates', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const blocks = (req.body.blocks && typeof req.body.blocks === 'object') ? req.body.blocks : {};
  if (!title) return res.status(400).json({ error: '請輸入範本標題' });
  const hasText = ['termA','notice','termC','termD'].some(k => String(blocks[k] || '').trim());
  if (!items.length && !hasText) return res.status(400).json({ error: '沒有可儲存的報價品項或文字內容' });
  const r = db.prepare(`INSERT INTO quote_templates (title, items_json, blocks_json, item_count, created_by) VALUES (?,?,?,?,?)`)
    .run(title, JSON.stringify(items), JSON.stringify(blocks), items.length, req.session.user.id);
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
  const me = req.session.user;
  const q = db.prepare(`
    SELECT qs.*, u.name as creator_name,
           c.case_number, c.title as case_title, c.location as case_location, c.client_id,
           c.sales_id as sales_id, usales.name as sales_name,
           cl.name as client_name, cl.phone as client_phone, cl.tax_id as client_tax_id, cl.contact_person as client_contact
    FROM quote_sheets qs
    LEFT JOIN users u ON u.id=qs.created_by
    LEFT JOIN cases c ON c.id=qs.case_id
    LEFT JOIN users usales ON usales.id=c.sales_id
    LEFT JOIN clients cl ON cl.id=c.client_id
    WHERE qs.id=?`).get(req.params.quoteId);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  q.items = db.prepare(`SELECT * FROM quote_sheet_items WHERE quote_id=? ORDER BY sort_order, id`).all(q.id);
  // 🔒 成本機密：非成本可見者連 JSON 都不含成本欄（材料成本率／日薪率）；
  //    但工務要填的 人數/工作天數/回報米數 一律保留（那是操作數字，非成本）
  if (!me.can_see_cost)       q.items.forEach(it => { it.cost_per_meter = null; it.material_cost = null; });
  if (!me.can_see_labor_cost) q.day_rate = null;
  // 合併本報價單的客戶/案場覆寫（per-quote 快照優先於 clients/cases 母檔）
  try { const p = JSON.parse(q.party_json || '{}') || {};
    if (p.client_name)    q.client_name    = p.client_name;
    if (p.client_tax_id)  q.client_tax_id  = p.client_tax_id;
    if (p.client_contact) q.client_contact = p.client_contact;
    if (p.client_phone)   q.client_phone   = p.client_phone;
    if (p.site_address)   q.case_location  = p.site_address;
    q.site_note = p.site_note || null; q.party = p;
  } catch (e) {}
  res.json(q);
});

// 更新報價單設定（不含品項）
router.put('/:quoteId', requireAuth, (req, res) => {
  if (!ensureDraft(req.params.quoteId, res)) return;
  const { valid_days, payment_terms, client_notes, client_type, status,
          discount_rate, marketing_rate, tax_rate,
          travel_fee, freight_fee, notes_terms, notes_acceptance, discount_rule_id } = req.body;

  db.prepare(`UPDATE quote_sheets SET valid_days=?,payment_terms=?,client_notes=?,client_type=?,
    discount_rate=?,marketing_rate=?,tax_rate=?,travel_fee=?,freight_fee=?,
    notes_terms=?,notes_acceptance=?,discount_rule_id=?,status=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?`)
    .run(valid_days??30, payment_terms??null, client_notes??null, client_type??'designer',
         discount_rate??1.0, marketing_rate??1.0, tax_rate??0.05,
         travel_fee??0, freight_fee??0,
         notes_terms??null, notes_acceptance??null, discount_rule_id??null,
         status??'draft', req.params.quoteId);

  // v2 欄位（行銷優惠 PAROI / 彈性折抵 / 須知；前端 v2 存檔會整包帶）
  const v2 = req.body;
  if (v2.engine === 'v2' || v2.mkt_mode !== undefined || v2.flex_deducts !== undefined) {
    db.prepare(`UPDATE quote_sheets SET mkt_mode=?, mkt_value=?, flex_deducts=?, notes_notice=?, notes_inspection=?, engine='v2', client_marketing_consent=?, no_invoice=?, hide_marketing=? WHERE id=?`)
      .run(v2.mkt_mode || 'pct',
           (v2.mkt_value === '' || v2.mkt_value == null) ? null : Number(v2.mkt_value),
           v2.flex_deducts != null ? (typeof v2.flex_deducts === 'string' ? v2.flex_deducts : JSON.stringify(v2.flex_deducts)) : '[]',
           v2.notes_notice ?? null, v2.notes_inspection ?? null,
           v2.client_marketing_consent ? 1 : 0,
           v2.no_invoice ? 1 : 0,
           v2.hide_marketing ? 1 : 0,
           req.params.quoteId);
    // 日薪(人工成本率)只有「人工成本可見者」能設定/覆寫；與 GET 端的 day_rate 遮蔽一致，非此權限者存檔不動它
    if (req.session.user?.can_see_labor_cost && v2.day_rate != null && v2.day_rate !== '') {
      db.prepare(`UPDATE quote_sheets SET day_rate=? WHERE id=?`).run(Number(v2.day_rate), req.params.quoteId);
    }
  }

  // 各條款區塊附圖（如(d)回簽/付款的銀行帳號圖）
  if (v2.block_images !== undefined) {
    const bi = typeof v2.block_images === 'string' ? v2.block_images : JSON.stringify(v2.block_images || {});
    db.prepare(`UPDATE quote_sheets SET block_images=? WHERE id=?`).run(bi, req.params.quoteId);
  }

  // 本報價單客戶/案場覆寫（per-quote 快照，不動 clients/cases 母檔）
  if (v2.party_json !== undefined) {
    const pj = typeof v2.party_json === 'string' ? v2.party_json : JSON.stringify(v2.party_json || {});
    db.prepare(`UPDATE quote_sheets SET party_json=? WHERE id=?`).run(pj, req.params.quoteId);
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
    db.prepare(`UPDATE cases SET final_price=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(q.final_total || 0, q.case_id);
  }
  try { syncReservations(quoteId, 'pending'); } catch(e) { /* non-critical */ }
  res.json({ ok: true, token: q?.share_token });
});

// 分版：把一張報價單完整複製成「新版草稿」（原版永不覆蓋）
//   ?items=0 → 只複製表頭設定、不複製品項（前端「發出後編輯自動分版」用，品項會由前端重新 POST）
//   預設複製全部（表頭 v2 欄位 + 全部品項），供未來「手動建立新版」用
router.post('/:quoteId/revise', requireAuth, (req, res) => {
  const me = req.session.user;
  const src = db.prepare(`SELECT * FROM quote_sheets WHERE id=?`).get(req.params.quoteId);
  if (!src) return res.status(404).json({ error: '找不到報價單' });

  const lastVersion = db.prepare(`SELECT MAX(version) as v FROM quote_sheets WHERE case_id=?`).get(src.case_id);
  const newVersion = (lastVersion?.v || 0) + 1;
  const token = genToken();

  // 動態複製 quote_sheets 全部欄位（含 v2：engine/party_json/mkt_*/flex_deducts/block_images/day_rate…），
  // 僅覆寫版本/連結/狀態/建立者，並清掉客戶端簽署快照；created_at/updated_at 用當下時間
  const overrides = {
    version: newVersion, share_token: token, status: 'draft', created_by: me.id,
    client_viewed_at: null, client_signature: null, client_accepted_at: null, client_marketing_consent: 0,
  };
  const skip = new Set(['id', 'created_at', 'updated_at']);
  const cols = db.prepare(`PRAGMA table_info(quote_sheets)`).all().map(c => c.name).filter(n => !skip.has(n));
  const vals = cols.map(c => (c in overrides) ? overrides[c] : src[c]);
  const r = db.prepare(
    `INSERT INTO quote_sheets (${cols.join(',')}, created_at, updated_at)
     VALUES (${cols.map(() => '?').join(',')}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).run(...vals);
  const newId = r.lastInsertRowid;

  // 複製品項（除非 ?items=0）。回傳 item_map: [[原品項id, 新品項id], …]（依序），
  // 讓前端把記憶體中的編輯用「更新」而非「重建」寫進新版 → 保留成本等機密欄位
  const itemMap = [];
  if (String(req.query.items) !== '0') {
    const itemCols = db.prepare(`PRAGMA table_info(quote_sheet_items)`).all()
      .map(c => c.name).filter(n => n !== 'id' && n !== 'quote_id');
    const srcItems = db.prepare(`SELECT * FROM quote_sheet_items WHERE quote_id=? ORDER BY sort_order, id`).all(src.id);
    if (srcItems.length) {
      const ins = db.prepare(`INSERT INTO quote_sheet_items (quote_id, ${itemCols.join(',')}) VALUES (?, ${itemCols.map(() => '?').join(',')})`);
      for (const it of srcItems) { const ir = ins.run(newId, ...itemCols.map(c => it[c])); itemMap.push([it.id, ir.lastInsertRowid]); }
    }
    recalcQuote(newId);
  }

  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'quote_revise', 'quote_sheets', newId, `報價單分版 v${src.version}→v${newVersion}`);
  res.json({ ok: true, id: newId, share_token: token, version: newVersion, from_version: src.version, item_map: itemMap });
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
  if (!ensureDraft(req.params.quoteId, res)) return;
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
  if (!ensureDraft(req.params.quoteId, res)) return;
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

  // 🔒 非成本可見者存檔時，成本欄一律沿用資料庫舊值（他們的 JSON 本來就沒成本，
  //    避免把 cost_per_meter/material_cost 洗成 0/null）
  let costPerMeterToSave = cost_per_meter || null, materialCostToSave = material_cost || null;
  if (!req.session.user?.can_see_cost) {
    const cur = db.prepare(`SELECT cost_per_meter, material_cost FROM quote_sheet_items WHERE id=? AND quote_id=?`).get(req.params.itemId, quoteId);
    costPerMeterToSave = cur ? cur.cost_per_meter : null;
    materialCostToSave = cur ? cur.material_cost : null;
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
         costPerMeterToSave, estimated_meters||null, materialCostToSave,
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
  const canDelAny = me.role === 'owner' || me.manage_users;   // 老闆/主管：可刪任何未回簽
  const canDelDraft = canDelAny || me.can_delete || ['vp','hq_cs','hq_cs_manager','hq_sales'].includes(me.role);  // 有「可刪除資料」權限或客服/業務：可刪草稿
  if (!canDelDraft) return res.status(403).json({ error: '無刪除報價單權限' });
  const qs = db.prepare(`SELECT qs.id, qs.status, c.status as case_status, c.case_number
    FROM quote_sheets qs JOIN cases c ON c.id=qs.case_id
    WHERE qs.id=?`).get(req.params.quoteId);
  if (!qs) return res.status(404).json({ error: '找不到報價單' });
  // 非老闆/主管（客服/業務）只能刪「草稿」；已發送/已回簽的請主管處理
  if (!canDelAny && qs.status !== 'draft') return res.status(403).json({ error: '客服／業務僅能刪除草稿報價單；已發送或已回簽的請主管處理' });
  const dealStatuses = ['contracted','payment','closed'];
  if (dealStatuses.includes(qs.case_status))
    return res.status(400).json({ error: `案件 ${qs.case_number} 已成交，報價單無法刪除` });
  // 已回簽（客戶確認 accepted）／已簽署（signed）一律鎖住，任何人都不可刪除
  if (qs.status === 'accepted' || qs.status === 'signed')
    return res.status(400).json({ error: '已回簽／已簽署的報價單無法刪除' });
  db.prepare(`DELETE FROM quote_sheet_items WHERE quote_id=?`).run(req.params.quoteId);
  db.prepare(`DELETE FROM quote_sheets WHERE id=?`).run(req.params.quoteId);
  res.json({ ok: true });
});

// 刪除品項
router.delete('/:quoteId/items/:itemId', requireAuth, (req, res) => {
  if (!ensureDraft(req.params.quoteId, res)) return;
  const quoteId = Number(req.params.quoteId);
  db.prepare(`DELETE FROM quote_sheet_items WHERE id=? AND quote_id=?`).run(req.params.itemId, quoteId);
  recalcQuote(quoteId);
  res.json({ ok: true });
});

// 品項排序
router.post('/:quoteId/items/reorder', requireAuth, (req, res) => {
  if (!ensureDraft(req.params.quoteId, res)) return;
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
           u.name as creator_name,
           c.sales_id as case_sales_id, usales.name as case_sales_name,
           o.name as org_name, o.tax_id as org_tax_id, o.address as org_address, o.phone as org_phone
    FROM quote_sheets qs
    JOIN cases c ON c.id = qs.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users u ON u.id = qs.created_by
    LEFT JOIN users usales ON usales.id = c.sales_id
    LEFT JOIN orgs o ON o.id = c.org_id
    WHERE qs.share_token = ?
  `).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  // 甲方公司抬頭：若該 org 未填，退回總部(繪新)固定資訊
  q.org_tax_id  = q.org_tax_id  || '45917816';
  q.org_address = q.org_address || '新北市鶯歌區中山路166巷2號';
  q.org_phone   = q.org_phone   || '02-8678-1229';

  // 折抵明細：已套用到本案的預付金（含名目/型別）＋彈性折抵（flex_deducts JSON），供客戶頁逐筆顯示名目
  q.applied_deposits = db.prepare(`SELECT type, amount, product_name FROM client_deposits WHERE applied_case_id=? AND status='applied' ORDER BY collected_at, id`).all(q.case_id);

  // 記錄客戶首次開啟（已傳送後才算，避免草稿內部預覽誤標）→ 列表顯示「客戶已打開」
  if (!q.client_viewed_at && q.status !== 'draft') {
    db.prepare(`UPDATE quote_sheets SET client_viewed_at=CURRENT_TIMESTAMP WHERE id=? AND client_viewed_at IS NULL`).run(q.id);
    q.client_viewed_at = new Date().toISOString();
  }

  // 甲方業務窗口：本報價單選的業務(party_json.sales_id) 優先，否則用案件指定業務，再退回開單人
  let partySalesId = null;
  // 合併本報價單的客戶/案場覆寫（per-quote 快照優先）
  try { const p = JSON.parse(q.party_json || '{}') || {};
    if (p.client_name)  q.client_name  = p.client_name;
    if (p.client_phone) q.client_phone = p.client_phone;
    if (p.site_address) q.location     = p.site_address;
    q.client_tax_id = p.client_tax_id || q.client_tax_id || null;
    q.client_contact = p.client_contact || q.client_contact || null;
    q.site_note = p.site_note || null;
    if (p.sales_id) partySalesId = p.sales_id;
  } catch (e) {}
  if (partySalesId) {
    const su = db.prepare('SELECT name FROM users WHERE id=?').get(partySalesId);
    q.sales_window_name = (su && su.name) || q.case_sales_name || q.creator_name || null;
  } else {
    q.sales_window_name = q.case_sales_name || q.creator_name || null;
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
  const COST_FIELDS = ['cost_per_meter', 'material_cost', 'estimated_meters', 'material_id', 'workers', 'work_days', 'suggested_price'];
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

  const q = db.prepare(`SELECT id, case_id, status, engine, discount_value, marketing_total, tax_amount, tax_rate, final_total, created_by, party_json FROM quote_sheets WHERE share_token=?`).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  // 已確認：冪等處理，重複送出（雙擊／網路重試）直接回成功，讓前端重繪成「已確認」畫面而非跳錯
  if (q.status === 'accepted') return res.json({ ok: true, already: true });

  const consent = marketing_consent ? 1 : 0;
  db.prepare(`UPDATE quote_sheets SET status='accepted', client_signature=?,
    client_accepted_at=CURRENT_TIMESTAMP, client_marketing_consent=? WHERE share_token=?`)
    .run(signature, consent, req.params.token);

  // 案件「成交金額」＝未稅：同意行銷→行銷優惠後(未稅 marketing_total)；不同意→一般優惠後(未稅 discount_value)。
  // 修：原本 v2 存的是含稅應付(final_total)，導致成交金額(未稅)欄被帶成含稅金額。
  let finalAmt;
  if (q.engine === 'v2') {
    finalAmt = consent ? (q.marketing_total != null ? q.marketing_total : (q.discount_value || 0))
                       : (q.discount_value != null ? q.discount_value : 0);
  } else {
    finalAmt = consent && q.marketing_total ? q.marketing_total : q.final_total;
  }
  db.prepare(`UPDATE cases SET status='confirmed', final_price=?, contracted_at=COALESCE(contracted_at, CURRENT_TIMESTAMP),
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(finalAmt || 0, q.case_id);

  // 升級為 committed 保留
  try { syncReservations(q.id, 'committed'); } catch(e) { /* non-critical */ }

  // 通知「客戶已回簽」：站內通知 + LINE 推播 → 報價建立者(客服) + 案件負責業務
  try {
    const { pushMessage } = require('./webhook');
    const info = db.prepare(`SELECT c.title, c.case_number, c.assigned_to, cl.name AS client_name
                             FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id WHERE c.id=?`).get(q.case_id);
    let clientName = info?.client_name || '';
    try { const p = JSON.parse(q.party_json || '{}') || {}; if (p.client_name) clientName = p.client_name; } catch(e) {}
    const caseName = info?.title || info?.case_number || '報價單';
    const fmtAmt = finalAmt ? 'NT$' + Math.round(finalAmt).toLocaleString('zh-TW') : '';
    const body = `${caseName}${clientName ? '｜' + clientName : ''} ${fmtAmt}${consent ? '（含行銷同意）' : ''}`.trim();
    const lineMsg = `✅ 客戶已回簽報價單\n案件：${caseName}\n客戶：${clientName || '—'}\n金額：${fmtAmt || '—'}${consent ? '\n（客戶同意行銷拍照）' : ''}`;
    // 收件人：報價建立者 + 案件負責業務（去重、去空值）
    const targets = [...new Set([q.created_by, info?.assigned_to].filter(Boolean))];
    for (const uid of targets) {
      try {
        db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'quote','cases',?,?)`)
          .run(uid, '✅ 客戶已回簽報價單', body, q.case_id, `/case-detail?id=${q.case_id}`);
        const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(uid);
        if (u?.line_user_id) pushMessage(u.line_user_id, lineMsg).catch(() => {});
      } catch(e) { /* per-recipient non-critical */ }
    }
  } catch(e) { /* non-critical */ }

  res.json({ ok: true });
  // 回簽後自動把報價單 PDF 備份到「案件資料夾」（非阻塞、失敗不影響回簽）
  _backupSignedQuote(q.case_id, req.params.token).catch(() => {});
});
// 產生回簽報價單 PDF → 上傳到「系統客服對話紀錄」受限樹(客戶→案件)，只客服/管理可見（不進案件資料夾）
async function _backupSignedQuote(caseId, token) {
  try {
    const gdrive = require('../lib/gdrive');
    if (!gdrive.isConnected()) return;
    const cs = db.prepare('SELECT c.client_id, c.case_number, cl.name AS client_name FROM cases c LEFT JOIN clients cl ON cl.id=c.client_id WHERE c.id=?').get(caseId);
    if (!cs || !cs.client_id) return;   // 沒連客戶就無法建客戶資料夾，略過
    const { folderId } = await gdrive.ensureCaseCsFolder(caseId);   // 受限樹：系統客服對話紀錄→客戶→案件
    if (!folderId) return;
    const { renderPdf } = require('../lib/pdf-render');
    const PORT = process.env.PORT || 3000;
    const url = `http://127.0.0.1:${PORT}/quote/${encodeURIComponent(token)}?pdf=1`;
    const pdf = await renderPdf(url, { waitSelector: '.status-bar', title: '回簽報價單' });
    const buf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    const stamp = new Date().toISOString().slice(0, 10);
    const cname = String(cs.client_name || ('客戶' + cs.client_id)).replace(/[\\/?%*:|"<>\r\n]+/g, ' ').trim();
    const name = `回簽報價單_${cname}_${cs.case_number || ''}_${stamp}.pdf`.replace(/[\\/?%*:|"<>\r\n]+/g, ' ').trim();
    await gdrive.uploadFileToFolder(folderId, name, buf, 'application/pdf');
  } catch (e) { console.error('[backup-signed-quote]', e && e.message); }
}

module.exports = router;
