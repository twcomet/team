const express = require('express');
const db = require('../db');
const { requireAuth, orgFilter, orgFilterSQL } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router = express.Router();

// ── 地址轉座標（非阻塞，fire-and-forget）────────────────────
async function geocodeCase(caseId, address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey || !address) return;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}&language=zh-TW&region=TW`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status === 'OK' && data.results[0]) {
      const { lat, lng } = data.results[0].geometry.location;
      db.prepare(`UPDATE cases SET lat=?, lng=? WHERE id=?`).run(lat, lng, caseId);
    }
  } catch (e) {
    console.error('[geocode] error:', e.message);
  }
}

// ── 派工通知 ─────────────────────────────────────────────────
const DISPATCH_LABELS = { cut_material:'裁切材料', factory_survey:'場勘', survey:'場勘', install:'施工', aftersales:'售後服務', other:'其他' };

async function notifyDispatch(case_id, dispatch_type, scheduled_date, user_ids, creatorId) {
  if (!Array.isArray(user_ids) || !user_ids.length) return;
  const c = db.prepare(`
    SELECT c.case_number, c.title, cl.name AS client_name
    FROM cases c LEFT JOIN clients cl ON cl.id = c.client_id WHERE c.id=?
  `).get(case_id);
  const typeLabel = DISPATCH_LABELS[dispatch_type] || dispatch_type;
  const title = `${typeLabel}派工通知`;
  const body = `案件 ${c?.case_number || ''} ${c?.title || ''}\n日期：${scheduled_date}\n類型：${typeLabel}`;
  const url = `/case-detail?id=${case_id}`;

  const insNotif = db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'dispatch','cases',?,?)`);

  for (const uid of user_ids) {
    if (uid === creatorId) continue; // 不通知自己
    insNotif.run(uid, title, body, case_id, url);

    // LINE Messaging API 推播（主動模式才自動送）
    const pushMode = db.prepare(`SELECT value FROM settings WHERE key='push_mode'`).get()?.value || 'manual';
    if (pushMode === 'auto') {
      const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(uid);
      if (u?.line_user_id) {
        const msg = `【繪新 ${typeLabel}派工通知】\n案件：${c?.case_number || ''} ${c?.title || ''}\n日期：${scheduled_date}`;
        pushMessage(u.line_user_id, msg);
      }
    }
  }
}

// ── 工具 ─────────────────────────────────────────────────────
function genCaseNumber(org_id) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `HX${yy}${mm}`;
  const last = db.prepare(`SELECT case_number FROM cases WHERE case_number LIKE ? ORDER BY case_number DESC LIMIT 1`).get(`${prefix}%`);
  const seq  = last ? (parseInt(last.case_number.split('-')[1]) || 0) + 1 : 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

// 依 install_fee / 總人次 重算每筆施工派工的 labor_cost
function recalcLaborCost(case_id) {
  const c = db.prepare(`SELECT install_fee FROM cases WHERE id=?`).get(case_id);
  const rows = db.prepare(`
    SELECT d.id, COUNT(du.user_id) AS worker_count
    FROM dispatches d
    LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
    WHERE d.case_id=? AND d.dispatch_type='install'
    GROUP BY d.id
  `).all(case_id);
  const totalPersons = rows.reduce((s, r) => s + (r.worker_count || 0), 0);
  const upd = db.prepare(`UPDATE dispatches SET labor_cost=? WHERE id=?`);
  if (!c?.install_fee || !totalPersons) {
    rows.forEach(r => upd.run(null, r.id));
    return;
  }
  const perPerson = c.install_fee / totalPersons;
  rows.forEach(r => upd.run((r.worker_count || 0) * perPerson, r.id));
}

function recalcCase(case_id) {
  const items = db.prepare(`SELECT * FROM case_items WHERE case_id = ?`).all(case_id);
  const quoted_price = items.reduce((s, i) => s + (i.subtotal || 0), 0);
  const material_cost = items.reduce((s, i) => s + (i.material_total || 0), 0);
  db.prepare(`UPDATE cases SET quoted_price=?, material_cost=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(quoted_price || null, material_cost || null, case_id);
}

function calcItem(item) {
  let area = item.area;
  if (!area && item.width_cm && item.height_cm) {
    const cm2 = item.width_cm * item.height_cm * (item.quantity || 1);
    if (item.unit === '才') area = cm2 / 929.03;
    else if (item.unit === '平方公尺') area = cm2 / 10000;
    else area = cm2 / 929.03;
  } else if (!area) {
    area = item.quantity || 1;
  }
  const material_total = area * (item.material_unit_cost || 0);
  const install_total  = area * (item.install_unit_price || 0);
  const subtotal = material_total + install_total;
  const client_unit_price = (item.client_unit_price != null && item.client_unit_price !== '') ? Number(item.client_unit_price) : null;
  const client_subtotal = client_unit_price != null ? area * client_unit_price : subtotal;
  return { area, material_total, install_total, subtotal, client_unit_price, client_subtotal };
}

// ── 案件 CRUD ─────────────────────────────────────────────────
const STATUS_GROUP_MAP = {
  inquiry: 'inquiry', initial_estimate: 'inquiry', quote_needed: 'inquiry', quote_sent: 'inquiry',
  survey_pending: 'survey', survey_scheduled: 'survey', surveyed: 'survey',
  quote_draft: 'survey', quoted: 'survey',
  contracted: 'deal', dispatched: 'deal', constructing: 'deal', payment: 'deal', closed: 'deal', aftersales: 'deal',
};
const HQ_ROLES = ['owner','vp','hq_cs','hq_sales','hq_accounting','hq_hr'];

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, case_type, date_from, date_to, search, group, client_id } = req.query;

  // 自動將「今天有施工派工」的「已派工待施工」升為「施工中」
  db.prepare(`
    UPDATE cases SET status='constructing', prev_status='dispatched', updated_at=CURRENT_TIMESTAMP
    WHERE status='dispatched' AND case_group='deal'
      AND id IN (
        SELECT DISTINCT case_id FROM dispatches
        WHERE scheduled_date = date('now','localtime')
          AND dispatch_type = 'install'
          AND status NOT IN ('cancelled')
      )
  `).run();

  // 成交案件管理需要額外權限
  if (group === 'deal') {
    const p = me.permissions || {};
    const canSeeDeals = me.role === 'owner' || (p.page_cases_deal !== undefined ? p.page_cases_deal : HQ_ROLES.includes(me.role));
    if (!canSeeDeals) return res.status(403).json({ error: '無成交案件管理權限' });
  }

  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');

  let q = `
    SELECT c.*,
           cl.name  as client_name, cl.phone as client_phone,
           s.name   as sales_name,
           cs.name  as cs_name,
           sv.name  as surveyor_name,
           qdb.name as quote_drafted_name,
           qb.name  as quoted_name,
           inv.name as invalided_name,
           o.name   as org_name,
           ub.name  as updated_by_name,
           ROUND((c.final_price - c.material_cost) * 100.0 / NULLIF(c.final_price, 0), 1) as gross_margin_pct
    FROM cases c
    LEFT JOIN clients cl  ON c.client_id        = cl.id
    LEFT JOIN users   s   ON c.sales_id         = s.id
    LEFT JOIN users   cs  ON c.cs_id            = cs.id
    LEFT JOIN users   sv  ON c.surveyor_id      = sv.id
    LEFT JOIN users   qdb ON c.quote_drafted_by = qdb.id
    LEFT JOIN users   qb  ON c.quoted_by        = qb.id
    LEFT JOIN users   inv ON c.invalided_by     = inv.id
    LEFT JOIN users   ub  ON c.updated_by       = ub.id
    LEFT JOIN orgs    o   ON c.org_id           = o.id
    WHERE 1=1
  `;
  const p = [];

  if (orgSql) { q += ` AND ${orgSql}`; p.push(...orgPs); }
  if (me.role === 'hq_tech' || me.role === 'branch_tech') {
    // 技術人員只看有被派工的案件（透過 dispatches）
    q += ` AND EXISTS (SELECT 1 FROM dispatch_users du JOIN dispatches d ON du.dispatch_id = d.id WHERE d.case_id = c.id AND du.user_id = ?)`;
    p.push(me.id);
  } else if (me.role === 'contractor_install' || me.role === 'contractor_sales') {
    q += ` AND EXISTS (SELECT 1 FROM dispatch_users du JOIN dispatches d ON du.dispatch_id = d.id WHERE d.case_id = c.id AND du.user_id = ?)`;
    p.push(me.id);
  }
  if (client_id) { q += ` AND c.client_id = ?`;       p.push(client_id); }
  if (group)     { q += ` AND c.case_group = ?`;      p.push(group); }
  if (status)    { q += ` AND c.status = ?`;         p.push(status); }
  if (req.query.active) { q += ` AND c.status NOT IN ('closed','invalid')`; }
  if (case_type) { q += ` AND c.case_type = ?`;      p.push(case_type); }
  if (date_from) { q += ` AND c.scheduled_date >= ?`; p.push(date_from); }
  if (date_to)   { q += ` AND c.scheduled_date <= ?`; p.push(date_to); }
  if (search)    { q += ` AND (c.title LIKE ? OR c.case_number LIKE ? OR cl.name LIKE ?)`; const s = `%${search}%`; p.push(s,s,s); }

  q += group === 'inquiry' ? ` ORDER BY c.created_at DESC` : ` ORDER BY c.updated_at DESC`;
  res.json(db.prepare(q).all(...p));
});

// 最近編輯人 tooltip（不限 owner）
router.get('/:id/recent-editors', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.name, l.created_at
    FROM audit_logs l
    JOIN users u ON u.id = l.user_id
    WHERE l.entity = 'cases' AND l.entity_id = ? AND l.action IN ('update','advance')
    ORDER BY l.id DESC LIMIT 5
  `).all(req.params.id);
  // 去重只保留每人最近一筆
  const seen = new Set();
  const result = rows.filter(r => { if (seen.has(r.name)) return false; seen.add(r.name); return true; }).slice(0, 3);
  res.json(result);
});

router.get('/:id', requireAuth, (req, res) => {
  const c = db.prepare(`
    SELECT c.*,
           cl.name as client_name, cl.phone as client_phone, cl.address as client_address, cl.email as client_email,
           s.name  as sales_name,  sv.name as surveyor_name, o.name as org_name,
           ROUND((COALESCE(c.final_price, c.quoted_price) - c.material_cost) * 100.0
                 / NULLIF(COALESCE(c.final_price, c.quoted_price), 0), 1) as gross_margin_pct
    FROM cases c
    LEFT JOIN clients cl ON c.client_id   = cl.id
    LEFT JOIN users   s  ON c.sales_id    = s.id
    LEFT JOIN users   sv ON c.surveyor_id = sv.id
    LEFT JOIN orgs    o  ON c.org_id      = o.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到案件' });

  const items = db.prepare(`SELECT * FROM case_items WHERE case_id = ? ORDER BY sort_order, id`).all(c.id);
  const dispatches = db.prepare(`
    SELECT d.*,
           GROUP_CONCAT(u.name, '、') as installer_names,
           GROUP_CONCAT(u.id, ',')    as installer_ids
    FROM dispatches d
    LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
    LEFT JOIN users u ON u.id = du.user_id
    WHERE d.case_id = ?
    GROUP BY d.id
    ORDER BY d.scheduled_date, d.scheduled_time
  `).all(c.id);
  const logs = db.prepare(`
    SELECT l.*, u.name as user_name FROM audit_logs l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.entity = 'cases' AND l.entity_id = ?
    ORDER BY l.created_at DESC LIMIT 30
  `).all(c.id);

  const matUsage = db.prepare(`
    SELECT dm.*, u.name AS recorder_name,
           d.scheduled_date AS dispatch_date, d.dispatch_type
    FROM dispatch_materials dm
    LEFT JOIN users u ON u.id = dm.created_by
    LEFT JOIN dispatches d ON d.id = dm.dispatch_id
    WHERE dm.case_id = ?
    ORDER BY dm.created_at DESC
  `).all(c.id);

  const matLogs = db.prepare(`
    SELECT ml.id, ml.roll_id, ml.log_type, ml.status, ml.meters, ml.notes, ml.logged_at,
           m.brand AS film_brand, m.model AS film_model,
           mr.unit_cost,
           u.name AS recorder_name
    FROM material_logs ml
    LEFT JOIN material_rolls mr ON mr.id = ml.roll_id
    LEFT JOIN materials m ON m.id = ml.material_id
    LEFT JOIN users u ON u.id = ml.logged_by
    WHERE ml.case_id = ? AND ml.log_type IN ('case_cut','case_loss','reserve')
    ORDER BY ml.logged_at DESC
  `).all(c.id);

  // 金額遮蔽（無 can_see_amounts 的人看不到金額欄）
  const me = req.session.user;
  if (!me.can_see_amounts) {
    ['quoted_price','final_price','material_cost','survey_fee','install_fee',
     'payment_received','deposit_amount','gross_margin_pct'].forEach(k => { c[k] = null; });
    items.forEach(i => {
      ['material_unit_cost','material_total','install_unit_price','install_total','subtotal'].forEach(k => { i[k] = null; });
    });
    matUsage.forEach(m => { m.unit_cost = null; });
    matLogs.forEach(m => { m.unit_cost = null; });
  }

  res.json({ ...c, items, dispatches, logs, matUsage, matLogs });
});

router.post('/', requireAuth, (req, res) => {
  try {
    const me = req.session.user;
    const { client_id, case_type, title, description, location, sales_id, is_outsourced, outsource_type, priority, notes, status: initStatus } = req.body;
    if (!title) return res.status(400).json({ error: '請填入項目名稱' });

    const startStatus = initStatus || 'initial_estimate';
    const case_group = STATUS_GROUP_MAP[startStatus] || 'survey';
    const case_number = genCaseNumber(me.org_id);
    const result = db.prepare(`
      INSERT INTO cases (org_id, case_number, client_id, case_type, title, description, location,
                         sales_id, is_outsourced, outsource_type, priority, notes, created_by, status, case_group)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(me.org_id, case_number,
           client_id ?? null, case_type || 'other',
           title, description ?? null, location ?? null,
           sales_id ?? null,
           is_outsourced ? 1 : 0, outsource_type ?? null,
           priority || 'normal', notes ?? null, me.id, startStatus, case_group);

    db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?, 'create', 'cases', ?, ?)`)
      .run(me.id, result.lastInsertRowid, `建立案件 ${case_number}`);

    if (location) geocodeCase(result.lastInsertRowid, location);

    res.json({ ok: true, id: result.lastInsertRowid, case_number });
  } catch (err) {
    console.error('[POST /api/cases]', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, (req, res) => { try {
  const {
    client_id, case_type, title, description, location, sales_id,
    final_price, survey_fee, survey_fee_date, survey_fee_note, survey_fee_method, survey_fee_category,
    payment_status, payment_received,
    deposit_amount, deposit_date, deposit_note, deposit_method, deposit_category,
    balance_paid, balance_paid_date, balance_paid_note, balance_paid_method, balance_category,
    retention_amount, retention_due_date, retention_invoiced, needs_invoice,
    payment_due_date, payment_notes,
    status, priority, deal_intent, is_outsourced, outsource_type, notes,
    line_source, line_display_name, line_official_name, keyword, client_category, material_ordered,
    scheduled_date, desired_entry_date, contracted_at, actual_entry_date,
    invoice_company, invoice_tax_id, invoice_address, invoice_email, invoice_item_desc,
    invoice_contact, invoice_phone,
    survey_date, surveyor_id, cs_id,
    entry_info, photo_upload_url, external_quote_url,
    material_cost, install_fee, outsource_cost, shipping_cost, other_cost,
    initial_estimate_data,
    survey_fee_credited,
    invoice_issued, invoice_issued_date,
    marketing_discount,
    followup_date,
  } = req.body;

  const prev = db.prepare(`SELECT sales_id, cs_id, location, lat, lng FROM cases WHERE id=?`).get(req.params.id);

  db.prepare(`
    UPDATE cases SET
      client_id=?, case_type=?, title=?, description=?, location=?,
      sales_id=?, final_price=?, survey_fee=?, survey_fee_date=?, survey_fee_note=?, survey_fee_method=?, survey_fee_category=?,
      payment_status=?, payment_received=?,
      deposit_amount=?, deposit_date=?, deposit_note=?, deposit_method=?, deposit_category=?,
      balance_paid=?, balance_paid_date=?, balance_paid_note=?, balance_paid_method=?, balance_category=?,
      retention_amount=?, retention_due_date=?, retention_invoiced=?, needs_invoice=?,
      payment_due_date=?, payment_notes=?, status=?, priority=?, deal_intent=?,
      is_outsourced=?, outsource_type=?, notes=?,
      line_source=?, line_display_name=?, line_official_name=?, keyword=?, client_category=?, material_ordered=?,
      scheduled_date=?, desired_entry_date=?, contracted_at=COALESCE(?,contracted_at), actual_entry_date=?,
      invoice_company=?, invoice_tax_id=?, invoice_address=?,
      invoice_email=?, invoice_item_desc=?, invoice_contact=?, invoice_phone=?,
      survey_date=?, surveyor_id=?, cs_id=?,
      entry_info=?, photo_upload_url=?, external_quote_url=?,
      material_cost=?, install_fee=?, outsource_cost=?, shipping_cost=?, other_cost=?,
      initial_estimate_data=?,
      survey_fee_credited=?,
      invoice_issued=?, invoice_issued_date=?,
      marketing_discount=?,
      followup_date=?,
      updated_by=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    client_id ?? null, case_type, title, description ?? null, location ?? null,
    sales_id ?? null, final_price ?? null, survey_fee ?? null, survey_fee_date ?? null, survey_fee_note ?? null, survey_fee_method ?? null, survey_fee_category ?? null,
    payment_status || 'unpaid', payment_received ?? 0,
    deposit_amount ?? null, deposit_date ?? null, deposit_note ?? null, deposit_method ?? null, deposit_category ?? null,
    balance_paid ?? null, balance_paid_date ?? null, balance_paid_note ?? null, balance_paid_method ?? null, balance_category ?? null,
    retention_amount ?? null, retention_due_date ?? null,
    retention_invoiced ?? null, needs_invoice ? 1 : 0,
    payment_due_date ?? null, payment_notes ?? null,
    status, priority || 'normal', deal_intent ?? null,
    is_outsourced ? 1 : 0, outsource_type ?? null, notes ?? null,
    line_source ?? null, line_display_name ?? null, line_official_name ?? null, keyword ?? null, client_category ?? null,
    material_ordered ? 1 : 0,
    scheduled_date ?? null, desired_entry_date ?? null, contracted_at ?? null, actual_entry_date ?? null,
    invoice_company ?? null, invoice_tax_id ?? null, invoice_address ?? null,
    invoice_email ?? null, invoice_item_desc ?? null,
    invoice_contact ?? null, invoice_phone ?? null,
    survey_date ?? null, surveyor_id ?? null, cs_id ?? null,
    entry_info ?? null, photo_upload_url ?? null, external_quote_url ?? null,
    material_cost ?? null, install_fee ?? null, outsource_cost ?? null, shipping_cost ?? null, other_cost ?? null,
    initial_estimate_data ?? null,
    survey_fee_credited ? 1 : 0,
    invoice_issued ? 1 : 0, invoice_issued_date ?? null,
    marketing_discount ? Number(marketing_discount) : 0,
    followup_date ?? null,
    req.session.user.id,
    req.params.id,
  );

  // 當狀態更新時自動同步 case_group（invalid 保留原 group）
  if (status && status !== 'invalid' && STATUS_GROUP_MAP[status]) {
    db.prepare(`UPDATE cases SET case_group=? WHERE id=?`).run(STATUS_GROUP_MAP[status], req.params.id);
  }

  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?, 'update', 'cases', ?, ?)`)
    .run(req.session.user.id, req.params.id, `更新案件資訊`);

  // 負責業務 / 客服變更時推派通知
  if (prev) {
    const caseInfo = db.prepare(`SELECT case_number, title FROM cases WHERE id=?`).get(req.params.id);
    const url = `/case-detail?id=${req.params.id}`;
    const pushMode = db.prepare(`SELECT value FROM settings WHERE key='push_mode'`).get()?.value || 'manual';
    const notifyUser = (uid, role) => {
      if (!uid || uid == req.session.user.id) return;
      const label = role === 'sales' ? '負責業務' : '負責客服';
      const title = `您被指派為「${label}」`;
      const body  = `案件 ${caseInfo?.case_number || ''} ${caseInfo?.title || ''}`;
      db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'assign','cases',?,?)`)
        .run(uid, title, body, req.params.id, url);
      if (pushMode === 'auto') {
        const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(uid);
        if (u?.line_user_id) pushMessage(u.line_user_id, `【繪新指派通知】\n${title}\n${body}`);
      }
    };
    if (String(sales_id || '') !== String(prev.sales_id || '')) notifyUser(sales_id, 'sales');
    if (String(cs_id    || '') !== String(prev.cs_id    || '')) notifyUser(cs_id,    'cs');
  }

  recalcLaborCost(Number(req.params.id));

  // 地址變更或尚未有座標時重新 geocode
  if (location && (location !== prev?.location || !prev?.lat)) {
    geocodeCase(Number(req.params.id), location);
  }

  // ── 自動同步收支表 ──────────────────────────────────────────
  try {
    const caseId  = Number(req.params.id);
    const c       = db.prepare(`SELECT org_id FROM cases WHERE id=?`).get(caseId);
    const orgId   = c?.org_id || null;
    const me      = req.session.user;
    const upsertLedger = (ref, date, amount, category, desc) => {
      if (!date || !amount) {
        db.prepare(`DELETE FROM ledger_entries WHERE source_ref=?`).run(ref);
        return;
      }
      const existing = db.prepare(`SELECT id FROM ledger_entries WHERE source_ref=?`).get(ref);
      if (existing) {
        db.prepare(`UPDATE ledger_entries SET date=?, amount=?, category=?, description=?, org_id=?, created_by=? WHERE id=?`)
          .run(date, amount, category, desc, orgId, me.id, existing.id);
      } else {
        db.prepare(`INSERT INTO ledger_entries (date, type, category, amount, case_id, description, org_id, created_by, source_ref) VALUES (?, 'income', ?, ?, ?, ?, ?, ?, ?)`)
          .run(date, category, amount, caseId, desc, orgId, me.id, ref);
      }
    };
    const c2 = db.prepare(`SELECT case_number, title FROM cases WHERE id=?`).get(caseId);
    const label = `${c2?.case_number || ''} ${c2?.title || ''}`.trim();
    upsertLedger(`case_${caseId}_survey_fee`,  survey_fee_date,   survey_fee,      survey_fee_category || '場勘費', `場勘費｜${label}`);
    upsertLedger(`case_${caseId}_deposit`,     deposit_date,      deposit_amount,  deposit_category  || '其他收入', `訂金｜${label}`);
    upsertLedger(`case_${caseId}_balance`,     balance_paid_date, balance_paid,    balance_category  || '其他收入', `尾款｜${label}`);
  } catch(ledgerErr) {
    console.error('[PUT case ledger sync]', ledgerErr.message);
  }

  res.json({ ok: true });
  } catch(err) {
    console.error('[PUT /api/cases/:id]', err.message);
    res.status(500).json({ error: '儲存失敗：' + err.message });
  }
});

// ── 負責人快速指派（列表 inline 批次儲存用）────────────────────
router.patch('/:id/assign', requireAuth, (req, res) => {
  const me = req.session.user;
  const prev = db.prepare(`SELECT sales_id, cs_id, case_number, title FROM cases WHERE id=?`).get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'not found' });
  // 只更新有明確傳入的欄位，避免只改其中一個時另一個被清空
  const sales_id = 'sales_id' in req.body ? (req.body.sales_id ?? null) : prev.sales_id;
  const cs_id    = 'cs_id'    in req.body ? (req.body.cs_id    ?? null) : prev.cs_id;
  db.prepare(`UPDATE cases SET sales_id=?, cs_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(sales_id, cs_id, req.params.id);
  const url = `/case-detail?id=${req.params.id}`;
  const pushMode = db.prepare(`SELECT value FROM settings WHERE key='push_mode'`).get()?.value || 'manual';
  const notifyUser = (uid, role) => {
    if (!uid || uid == me.id) return;
    const label = role === 'sales' ? '負責業務' : '負責客服';
    const title = `您被指派為「${label}」`;
    const body  = `案件 ${prev.case_number || ''} ${prev.title || ''}`;
    db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'assign','cases',?,?)`)
      .run(uid, title, body, req.params.id, url);
    if (pushMode === 'auto') {
      const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(uid);
      if (u?.line_user_id) pushMessage(u.line_user_id, `【繪新指派通知】\n${title}\n${body}`);
    }
  };
  if (String(sales_id || '') !== String(prev.sales_id || '')) notifyUser(sales_id, 'sales');
  if (String(cs_id    || '') !== String(prev.cs_id    || '')) notifyUser(cs_id,    'cs');
  res.json({ ok: true });
});

// ── 優先程度快速更新 ──────────────────────────────────────────
router.patch('/:id/folder-url', requireAuth, (req, res) => {
  const { photo_upload_url } = req.body;
  db.prepare(`UPDATE cases SET photo_upload_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(photo_upload_url || null, req.params.id);
  res.json({ ok: true });
});

router.patch('/:id/priority', requireAuth, (req, res) => {
  const { priority } = req.body;
  if (!['urgent','high','normal','low'].includes(priority))
    return res.status(400).json({ error: '無效的優先程度' });
  db.prepare(`UPDATE cases SET priority=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(priority, req.params.id);
  res.json({ ok: true });
});

router.patch('/:id/intent', requireAuth, (req, res) => {
  const { deal_intent } = req.body;
  const allowed = ['', 'called', 'incomplete', 'waiting_quote', 'need_survey'];
  if (!allowed.includes(deal_intent ?? ''))
    return res.status(400).json({ error: '無效的處理狀態' });
  db.prepare(`UPDATE cases SET deal_intent=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(deal_intent || null, req.params.id);
  res.json({ ok: true });
});

// ── 報價明細 ─────────────────────────────────────────────────
router.get('/:id/items', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM case_items WHERE case_id = ? ORDER BY sort_order, id`).all(req.params.id));
});

router.post('/:id/items', requireAuth, (req, res) => {
  const case_id = Number(req.params.id);
  const { item_type, description, location, width_cm, height_cm, length_cm, quantity, unit,
          area, material_brand, material_model, material_unit_cost, install_unit_price,
          client_unit_price, notes, sort_order } = req.body;

  const calc = calcItem({ area, width_cm, height_cm, quantity, unit,
                          material_unit_cost, install_unit_price, client_unit_price });

  const result = db.prepare(`
    INSERT INTO case_items (case_id, sort_order, item_type, description, location,
      width_cm, height_cm, length_cm, quantity, unit, area,
      material_brand, material_model, material_unit_cost, material_total,
      install_unit_price, install_total, subtotal,
      client_unit_price, client_subtotal, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(case_id, sort_order ?? 0, item_type, description ?? null, location ?? null,
         width_cm ?? null, height_cm ?? null, length_cm ?? null,
         quantity ?? 1, unit || '才', calc.area,
         material_brand ?? null, material_model ?? null,
         material_unit_cost ?? 0, calc.material_total,
         install_unit_price ?? 0, calc.install_total, calc.subtotal,
         calc.client_unit_price, calc.client_subtotal, notes ?? null);

  recalcCase(case_id);
  res.json({ ok: true, id: result.lastInsertRowid, ...calc });
});

router.put('/:id/items/:itemId', requireAuth, (req, res) => {
  const case_id = Number(req.params.id);
  const { item_type, description, location, width_cm, height_cm, length_cm, quantity, unit,
          area, material_brand, material_model, material_unit_cost, install_unit_price,
          client_unit_price, notes, sort_order } = req.body;

  const calc = calcItem({ area, width_cm, height_cm, quantity, unit,
                          material_unit_cost, install_unit_price, client_unit_price });

  db.prepare(`
    UPDATE case_items SET sort_order=?, item_type=?, description=?, location=?,
      width_cm=?, height_cm=?, length_cm=?, quantity=?, unit=?, area=?,
      material_brand=?, material_model=?, material_unit_cost=?, material_total=?,
      install_unit_price=?, install_total=?, subtotal=?,
      client_unit_price=?, client_subtotal=?, notes=?
    WHERE id=? AND case_id=?
  `).run(sort_order ?? 0, item_type, description ?? null, location ?? null,
         width_cm ?? null, height_cm ?? null, length_cm ?? null,
         quantity ?? 1, unit || '才', calc.area,
         material_brand ?? null, material_model ?? null,
         material_unit_cost ?? 0, calc.material_total,
         install_unit_price ?? 0, calc.install_total, calc.subtotal,
         calc.client_unit_price, calc.client_subtotal,
         notes ?? null, req.params.itemId, case_id);

  recalcCase(case_id);
  res.json({ ok: true, ...calc });
});

router.delete('/:id/items/:itemId', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM case_items WHERE id=? AND case_id=?`).run(req.params.itemId, req.params.id);
  recalcCase(Number(req.params.id));
  res.json({ ok: true });
});

// ── 派工 ─────────────────────────────────────────────────────
router.get('/:id/dispatches', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*,
           GROUP_CONCAT(u.name, '、') as installer_names,
           GROUP_CONCAT(u.id, ',')    as installer_ids
    FROM dispatches d
    LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
    LEFT JOIN users u ON u.id = du.user_id
    WHERE d.case_id = ?
    GROUP BY d.id
    ORDER BY d.scheduled_date, d.scheduled_time
  `).all(req.params.id);
  res.json(rows);
});

router.post('/:id/dispatches', requireAuth, (req, res) => {
  const case_id = Number(req.params.id);
  const { dispatch_type, scheduled_date, scheduled_time, estimated_hours, material, notes, user_ids,
          unloading_location, has_parking, work_until, access_code,
          warranty_covered, service_fee } = req.body;
  if (!scheduled_date) return res.status(400).json({ error: '請選擇派工日期' });

  const result = db.prepare(`
    INSERT INTO dispatches (case_id, dispatch_type, scheduled_date, scheduled_time, estimated_hours, material, notes,
      unloading_location, has_parking, work_until, access_code, warranty_covered, service_fee, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(case_id, dispatch_type || 'install', scheduled_date,
         scheduled_time ?? null, estimated_hours ?? null,
         material ?? null, notes ?? null,
         unloading_location ?? null, has_parking ?? null, work_until ?? null, access_code ?? null,
         warranty_covered != null ? Number(warranty_covered) : 1,
         service_fee != null ? Number(service_fee) : null,
         req.session.user.id);

  const did = result.lastInsertRowid;
  if (Array.isArray(user_ids)) {
    user_ids.forEach(uid => {
      db.prepare(`INSERT INTO dispatch_users (dispatch_id, user_id, role_in_dispatch) VALUES (?, ?, 'lead')`).run(did, uid);
    });
  }

  // 派工 → 自動帶入施工日期（任何類型，若案件尚無施工日則填入）、升狀態
  const c = db.prepare(`SELECT status, scheduled_date FROM cases WHERE id=?`).get(case_id);
  {
    const updates = [];
    const params = [];
    if (!c?.scheduled_date) {
      updates.push(`scheduled_date=?`); params.push(scheduled_date);
    }
    if (c?.status === 'contracted' && dispatch_type === 'install') {
      updates.push(`status='dispatched'`, `prev_status='contracted'`);
    }
    // 在結案/請款案件新增售後維修派工 → 自動切換到 aftersales 狀態
    if (['closed', 'payment'].includes(c?.status) && dispatch_type === 'aftersales') {
      updates.push(`status='aftersales'`, `prev_status='${c.status}'`);
    }
    if (updates.length) {
      params.push(case_id);
      db.prepare(`UPDATE cases SET ${updates.join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...params);
    }
  }

  recalcLaborCost(case_id);
  notifyDispatch(case_id, dispatch_type || 'install', scheduled_date, user_ids, req.session.user.id);
  res.json({ ok: true, id: did });
});

router.put('/:id/dispatches/:did', requireAuth, (req, res) => {
  const { dispatch_type, scheduled_date, scheduled_time, estimated_hours, actual_hours, material, material_used, status, notes, user_ids,
          unloading_location, has_parking, work_until, access_code,
          warranty_covered, service_fee } = req.body;
  try {
    db.prepare(`
      UPDATE dispatches SET dispatch_type=?, scheduled_date=?, scheduled_time=?, estimated_hours=?,
        actual_hours=?, material=?, material_used=?, status=?, notes=?,
        unloading_location=?, has_parking=?, work_until=?, access_code=?,
        warranty_covered=?, service_fee=?
      WHERE id=? AND case_id=?
    `).run(dispatch_type, scheduled_date, scheduled_time ?? null, estimated_hours ?? null,
           actual_hours ?? null, material ?? null, material_used ?? null,
           status || 'pending', notes ?? null,
           unloading_location ?? null, has_parking ?? null, work_until ?? null, access_code ?? null,
           warranty_covered != null ? Number(warranty_covered) : 1,
           service_fee != null ? Number(service_fee) : null,
           req.params.did, req.params.id);
  } catch (e) {
    console.error('PUT dispatch error:', e.message);
    return res.status(500).json({ error: '儲存失敗：' + e.message });
  }

  // 記錄舊派工人員，用來計算新增的人
  const oldUserIds = new Set(
    db.prepare(`SELECT user_id FROM dispatch_users WHERE dispatch_id=?`).all(req.params.did).map(r => r.user_id)
  );

  db.prepare(`DELETE FROM dispatch_users WHERE dispatch_id=?`).run(req.params.did);
  if (Array.isArray(user_ids)) {
    user_ids.forEach(uid => {
      db.prepare(`INSERT INTO dispatch_users (dispatch_id, user_id, role_in_dispatch) VALUES (?, ?, 'lead')`).run(req.params.did, uid);
    });
  }
  recalcLaborCost(Number(req.params.id));

  // 只通知新增的派工人員
  const newUserIds = Array.isArray(user_ids) ? user_ids.filter(uid => !oldUserIds.has(uid)) : [];
  if (newUserIds.length) {
    notifyDispatch(Number(req.params.id), dispatch_type, scheduled_date, newUserIds, req.session.user.id);
  }
  res.json({ ok: true });
});

router.delete('/:id/dispatches/:did', requireAuth, (req, res) => {
  const caseId = Number(req.params.id);
  const d = db.prepare(`SELECT dispatch_type, scheduled_date FROM dispatches WHERE id=? AND case_id=?`).get(req.params.did, caseId);
  db.prepare(`DELETE FROM dispatch_users WHERE dispatch_id=?`).run(req.params.did);
  db.prepare(`DELETE FROM dispatches WHERE id=? AND case_id=?`).run(req.params.did, caseId);
  recalcLaborCost(caseId);

  // 若刪除施工派工後已無任何施工派工，案件退回「成交待派工」並清除施工日期
  if (d?.dispatch_type === 'install') {
    const remaining = db.prepare(`SELECT COUNT(*) cnt FROM dispatches WHERE case_id=? AND dispatch_type='install'`).get(caseId);
    if (remaining.cnt === 0) {
      const cs = db.prepare(`SELECT status FROM cases WHERE id=?`).get(caseId);
      if (['dispatched','constructing'].includes(cs?.status)) {
        db.prepare(`UPDATE cases SET status='contracted', prev_status=?, scheduled_date=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(cs.status, caseId);
      }
    }
  }

  if (d) {
    db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
      .run(req.session.user.id, 'delete', 'dispatches', req.params.did, `刪除派工：${d.dispatch_type} ${d.scheduled_date}（案件 #${caseId}）`);
  }
  res.json({ ok: true });
});

// 人工推播：手動發送 LINE 通知給該派工的所有人員
router.post('/:id/dispatches/:did/push', requireAuth, async (req, res) => {
  const d = db.prepare(`SELECT * FROM dispatches WHERE id=? AND case_id=?`).get(req.params.did, req.params.id);
  if (!d) return res.status(404).json({ error: '派工不存在' });
  const c = db.prepare(`SELECT c.case_number, c.title FROM cases c WHERE c.id=?`).get(req.params.id);
  const typeLabel = DISPATCH_LABELS[d.dispatch_type] || d.dispatch_type;
  const uids = db.prepare(`SELECT user_id FROM dispatch_users WHERE dispatch_id=?`).all(req.params.did).map(r => r.user_id);
  const msg = `【繪新 ${typeLabel}派工通知】\n案件：${c?.case_number || ''} ${c?.title || ''}\n日期：${d.scheduled_date}`;
  let sent = 0;
  for (const uid of uids) {
    const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(uid);
    if (u?.line_user_id) { pushMessage(u.line_user_id, msg); sent++; }
  }
  res.json({ ok: true, sent, total: uids.length });
});

// ── 狀態推進 PATCH /:id/advance ──────────────────────────────
const ADVANCE_MAP = {
  inquiry:          { next: 'initial_estimate',  tsCol: 'initial_estimate_at', byCol: null },
  initial_estimate: { next: 'survey_pending',    tsCol: 'survey_pending_at',   byCol: null },
  survey_pending:   { next: 'survey_scheduled',  tsCol: null,                  byCol: null },
  survey_scheduled: { next: 'surveyed',          tsCol: 'surveyed_at',         byCol: null },
  surveyed:         { next: 'quote_draft',       tsCol: 'quote_draft_at',      byCol: 'quote_drafted_by' },
  quote_draft:      { next: 'quoted',           tsCol: 'quoted_at',           byCol: 'quoted_by'        },
  quoted:           { next: 'contracted',       tsCol: 'contracted_at',       byCol: null               },
  contracted:       { next: 'dispatched',       tsCol: null,                  byCol: null               },
  dispatched:       { next: 'constructing',     tsCol: null,                  byCol: null               },
  constructing:     { next: 'payment',          tsCol: 'payment_at',          byCol: null               },
  payment:          { next: 'closed',           tsCol: 'closed_at',           byCol: null               },
  closed:           { next: 'aftersales',       tsCol: null,                  byCol: null               },
  aftersales:       { next: 'closed',           tsCol: null,                  byCol: null               },
};
router.patch('/:id/advance', requireAuth, (req, res) => {
  const me = req.session.user;
  const c = db.prepare(`SELECT status, payment_status, prev_status FROM cases WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到案件' });

  const t = ADVANCE_MAP[c.status];
  if (!t) return res.status(400).json({ error: '此狀態無法推進' });

  // 結案需收款完成
  if (c.status === 'payment' && c.payment_status !== 'paid')
    return res.status(400).json({ error: '尚未完成收款，無法結案' });

  // 完工請款前警示：有未完成派工
  if (c.status === 'constructing' && !req.body.force) {
    const inc = db.prepare(
      `SELECT COUNT(*) cnt FROM dispatches WHERE case_id=? AND status NOT IN ('done','cancelled')`
    ).get(req.params.id);
    if (inc.cnt > 0)
      return res.status(200).json({ warning: `此案件尚有 ${inc.cnt} 筆未完成派工，確定要繼續？`, needConfirm: true });
  }

  const newGroup = STATUS_GROUP_MAP[t.next] || null;
  let sets = `status=?, prev_status=?, updated_at=CURRENT_TIMESTAMP`;
  if (t.tsCol) sets += `, ${t.tsCol}=COALESCE(${t.tsCol}, CURRENT_TIMESTAMP)`;
  const params = [t.next, c.status];
  if (newGroup) { sets += `, case_group=?`; params.push(newGroup); }
  if (t.byCol)  { sets += `, ${t.byCol}=COALESCE(${t.byCol}, ?)`; params.push(me.id); }
  params.push(req.params.id);
  db.prepare(`UPDATE cases SET ${sets} WHERE id=?`).run(...params);

  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'advance', 'cases', req.params.id, `${c.status} → ${t.next}`);
  res.json({ ok: true, new_status: t.next });
});

// ── 標記無效 PATCH /:id/invalidate ──────────────────────────
const INVALIDATABLE = new Set(['inquiry','initial_estimate','quote_needed','quote_sent','survey_pending','survey_scheduled','surveyed','quote_draft','quoted','contracted','dispatched','constructing']);
router.patch('/:id/invalidate', requireAuth, (req, res) => {
  const me = req.session.user;
  const { reason, tags } = req.body;
  const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到案件' });
  if (!INVALIDATABLE.has(c.status)) return res.status(400).json({ error: '此狀態無法標記無效' });

  db.prepare(`UPDATE cases SET status='invalid', prev_status=?, invalid_reason=?, invalid_reason_tags=?,
    invalid_at=CURRENT_TIMESTAMP, invalided_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(c.status, reason || null, tags ? JSON.stringify(tags) : null, me.id, req.params.id);

  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'invalidate', 'cases', req.params.id, `無效：${reason || '未填理由'}`);
  res.json({ ok: true });
});

// ── 退回上一步 PATCH /:id/step-back ─────────────────────────
router.patch('/:id/step-back', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!me.manage_users && me.role !== 'owner')
    return res.status(403).json({ error: '僅限管理者可退回狀態' });

  const c = db.prepare(`SELECT status, prev_status FROM cases WHERE id=?`).get(req.params.id);
  if (!c || !c.prev_status) return res.status(400).json({ error: '無法退回（無前一狀態記錄）' });

  const newGroup = STATUS_GROUP_MAP[c.prev_status] || null;
  let sets = `status=?, prev_status=NULL, updated_at=CURRENT_TIMESTAMP`;
  const params = [c.prev_status];
  if (newGroup) { sets += `, case_group=?`; params.push(newGroup); }
  params.push(req.params.id);
  db.prepare(`UPDATE cases SET ${sets} WHERE id=?`).run(...params);

  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'step_back', 'cases', req.params.id, `退回：${c.status} → ${c.prev_status}`);
  res.json({ ok: true, new_status: c.prev_status });
});

// ── 場勘直接轉成交 PATCH /:id/to-deal ────────────────────────────
router.patch('/:id/to-deal', requireAuth, (req, res) => {
  const me = req.session.user;
  const c = db.prepare(`SELECT status, case_group FROM cases WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: '案件不存在' });
  const valid = new Set(['survey_pending','survey_scheduled','surveyed','quote_draft','quoted']);
  if (!valid.has(c.status))
    return res.status(400).json({ error: '僅場勘階段案件可直接轉成交' });
  db.prepare(`UPDATE cases SET status='contracted', case_group='deal', prev_status=?,
               contracted_at=COALESCE(contracted_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP
             WHERE id=?`).run(c.status, req.params.id);
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'convert', 'cases', req.params.id, `${c.status} → contracted (直接成交)`);
  res.json({ ok: true });
});

// ── 刪除案件 DELETE /:id（管理者或有刪除權限的人員）─────────────
router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;

  // guard=1：來自收款追蹤，嚴格模式 — 只限老闆，且空案件才可刪
  if (req.query.guard === '1') {
    if (me.role !== 'owner') return res.status(403).json({ error: '僅限老闆可從收款追蹤刪除案件' });
    const pay = db.prepare(`SELECT payment_received, payment_status, deposit_amount FROM cases WHERE id=?`).get(req.params.id);
    if (!pay) return res.status(404).json({ error: '找不到案件' });
    if ((pay.payment_received || 0) > 0)
      return res.status(400).json({ error: '此案件已有收款金額，無法刪除' });
    if ((pay.deposit_amount || 0) > 0)
      return res.status(400).json({ error: '此案件已有訂金紀錄，無法刪除' });
    if (pay.payment_status === 'paid')
      return res.status(400).json({ error: '此案件已標記為已付款，無法刪除' });
    const dispCount = db.prepare(`SELECT COUNT(*) cnt FROM dispatches WHERE case_id=?`).get(req.params.id).cnt;
    if (dispCount > 0)
      return res.status(400).json({ error: `此案件有 ${dispCount} 筆派工紀錄，無法刪除` });
  } else {
    if (!me.manage_users && me.role !== 'owner' && !me.can_delete)
      return res.status(403).json({ error: '僅限管理者可刪除案件' });
  }

  const c = db.prepare(`SELECT id, case_number, title FROM cases WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: '找不到案件' });

  db.exec('BEGIN');
  try {
    const id = req.params.id;
    const dispIds = db.prepare(`SELECT id FROM dispatches WHERE case_id=?`).all(id).map(r => r.id);
    if (dispIds.length) {
      const ph = dispIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM dispatch_users    WHERE dispatch_id IN (${ph})`).run(...dispIds);
    }
    db.prepare(`DELETE FROM dispatches          WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM notifications       WHERE entity='cases' AND entity_id=?`).run(id);
    db.prepare(`DELETE FROM profit_shares       WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM material_logs       WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM ledger_entries      WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM case_ratings        WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM dispatch_queue      WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM site_surveys        WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM quotations          WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM quality_checks      WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM ratings             WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM user_task_dismissals WHERE case_id=?`).run(id);
    try { db.prepare(`DELETE FROM revenue_shares  WHERE case_id=?`).run(id); } catch {}
    try { db.prepare(`DELETE FROM material_orders WHERE case_id=?`).run(id); } catch {}
    db.prepare(`DELETE FROM case_items          WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM dispatch_materials  WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM quote_sheets        WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM survey_forms        WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM case_applications   WHERE case_id=?`).run(id);
    db.prepare(`DELETE FROM initial_estimates   WHERE case_id=?`).run(id);
    db.prepare(`UPDATE line_inquiries SET converted_case_id=NULL WHERE converted_case_id=?`).run(id);
    db.prepare(`UPDATE warranty_cases SET original_case_id=NULL WHERE original_case_id=?`).run(id);
    db.prepare(`DELETE FROM cases WHERE id=?`).run(id);
    db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
      .run(me.id, 'delete', 'cases', id, `刪除案件 ${c.case_number} ${c.title}`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: e.message });
  }

  res.json({ ok: true });
});

// ── 初步估價紀錄 ─────────────────────────────────────────────
router.get('/:id/initial-estimates', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT ie.*, u.name as created_by_name
    FROM initial_estimates ie
    LEFT JOIN users u ON u.id = ie.created_by
    WHERE ie.case_id = ?
    ORDER BY ie.created_at DESC
  `).all(req.params.id);
  rows.forEach(r => { try { r.items = JSON.parse(r.items || '[]'); } catch { r.items = []; } });
  res.json(rows);
});

router.post('/:id/initial-estimates', requireAuth, (req, res) => {
  const me = req.session.user;
  const case_id = Number(req.params.id);
  const { tool_type, film_type, film_width, calc_mode, roll_length_m, items,
          total_cai, unit_price, total_price, discount, discount_price, note, advance_status } = req.body;

  const result = db.prepare(`
    INSERT INTO initial_estimates
      (case_id, tool_type, film_type, film_width, calc_mode, roll_length_m, items,
       total_cai, unit_price, total_price, discount, discount_price, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(case_id, tool_type || 'material_calc', film_type ?? null, film_width ?? null,
         calc_mode ?? null, roll_length_m ?? null, JSON.stringify(items || []),
         total_cai ?? null, unit_price ?? null, total_price ?? null,
         discount ?? null, discount_price ?? null, note ?? null, me.id);

  if (advance_status) {
    const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(case_id);
    if (c?.status === 'inquiry') {
      db.prepare(`UPDATE cases SET status='initial_estimate', initial_estimate_at=COALESCE(initial_estimate_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(case_id);
    }
  }

  res.json({ ok: true, id: result.lastInsertRowid });
});

// ── 統計 ─────────────────────────────────────────────────────
router.get('/stats/summary', requireAuth, (req, res) => {
  const me = req.session.user;
  const { sql: orgSql2, params: orgPs2 } = orgFilterSQL(me, 'c.org_id');
  const orgCond = orgSql2 ? `AND ${orgSql2}` : '';
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';

  const monthEnd = new Date(today.slice(0,4), Number(today.slice(5,7)), 0).toISOString().slice(0,10);
  res.json({
    total:        db.prepare(`SELECT COUNT(*) n FROM cases c WHERE 1=1 ${orgCond}`).get(...orgPs2).n,
    active:       db.prepare(`SELECT COUNT(*) n FROM cases c WHERE status IN ('contracted','dispatched','constructing','payment') ${orgCond}`).get(...orgPs2).n,
    unscheduled:  db.prepare(`SELECT COUNT(*) n FROM cases c WHERE status='contracted' ${orgCond}`).get(...orgPs2).n,
    today_jobs:   db.prepare(`SELECT COUNT(*) n FROM dispatches d JOIN cases c ON d.case_id=c.id WHERE d.scheduled_date=? ${orgCond}`).get(today, ...orgPs2).n,
    unpaid:       db.prepare(`SELECT COALESCE(SUM(
                   COALESCE(final_price,quoted_price,0)
                   - COALESCE(survey_fee,0)
                   - COALESCE(deposit_amount,0)
                   - COALESCE(balance_paid,0)
                   - COALESCE(retention_amount,0)
                 ),0) n FROM cases c
                 WHERE payment_status!='paid'
                 AND status IN ('contracted','dispatched','constructing','payment','closed','tech_accepted')
                 AND COALESCE(final_price,quoted_price,0) > 0
                 ${orgCond}`).get(...orgPs2).n,
    month_income: db.prepare(`SELECT COALESCE(SUM(payment_received),0) n FROM cases c WHERE scheduled_date>=? AND scheduled_date<=? ${orgCond}`).get(monthStart, monthEnd, ...orgPs2).n,
  });
});

// ── 地址座標補填（owner 手動觸發，處理歷史資料）────────────
router.post('/geocode-backfill', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const cases = db.prepare(`SELECT id, location FROM cases WHERE (lat IS NULL OR lat=0) AND location IS NOT NULL AND location != ''`).all();
  res.json({ queued: cases.length });
  for (const c of cases) {
    await geocodeCase(c.id, c.location);
    await new Promise(r => setTimeout(r, 200)); // 避免超過 API 速率
  }
});

// ── CSV 匯出 ──────────────────────────────────────────────────
router.get('/export.csv', requireAuth, (req, res) => {
  const me = req.session.user;
  const { group, status, case_type, date_from, date_to, search } = req.query;

  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  let q = `
    SELECT c.case_number, cl.name as client_name, cl.phone as client_phone,
           c.title, c.case_type, c.status,
           s.name as sales_name, cs.name as cs_name, o.name as org_name,
           c.location, c.case_group,
           c.contracted_at, c.scheduled_date,
           COALESCE(c.final_price, c.quoted_price, 0) as amount,
           ROUND(COALESCE(c.final_price, c.quoted_price, 0)*1.05) as amount_tax,
           COALESCE(c.payment_received, 0) as received,
           COALESCE(c.final_price, c.quoted_price, 0) - COALESCE(c.payment_received, 0) as pending,
           c.payment_status, c.notes
    FROM cases c
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users   s  ON c.sales_id  = s.id
    LEFT JOIN users   cs ON c.cs_id     = cs.id
    LEFT JOIN orgs    o  ON c.org_id    = o.id
    WHERE 1=1
  `;
  const p = [];
  if (orgSql) { q += ` AND ${orgSql}`; p.push(...orgPs); }
  if (group)     { q += ` AND c.case_group=?`; p.push(group); }
  if (status)    { q += ` AND c.status=?`;     p.push(status); }
  if (case_type) { q += ` AND c.case_type=?`;  p.push(case_type); }
  if (date_from) { q += ` AND c.contracted_at>=?`; p.push(date_from); }
  if (date_to)   { q += ` AND c.contracted_at<=?`; p.push(date_to + ' 23:59:59'); }
  if (search)    { q += ` AND (c.title LIKE ? OR c.case_number LIKE ? OR cl.name LIKE ?)`; const s=`%${search}%`; p.push(s,s,s); }
  q += ` ORDER BY c.contracted_at DESC, c.created_at DESC`;

  const rows = db.prepare(q).all(...p);

  const STATUS_MAP = { inquiry:'詢價需初步估價', initial_estimate:'已初步估價', quote_needed:'需出估價單', quote_sent:'已出估價單', survey_pending:'待排場勘', survey_scheduled:'已排場勘', surveyed:'已場勘', quote_draft:'已建報價資料', quoted:'已發報價單', contracted:'成交待派工', dispatched:'已派工待施工', constructing:'施工中', payment:'完工請款', closed:'結案保存', invalid:'無效保存' };
  const TYPE_MAP   = { home:'居家', commercial:'商空', elevator:'電梯', glass:'玻璃', extra:'外快', outsource:'外包', output:'輸出', other:'其他' };
  const PAY_MAP    = { unpaid:'未收款', partial:'部分收款', paid:'已收款', overdue:'逾期' };

  const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;

  const header = ['案號','客戶','電話','項目名稱','案件類型','案件群組','業務','客服','店別','地址','成交日期','施工日期','成交金額(未稅)','含稅金額','已收款','待收款','收款狀態','案件狀態','備注'];
  const csvRows = [header.map(esc).join(',')];
  rows.forEach(r => {
    csvRows.push([
      r.case_number, r.client_name, r.client_phone, r.title,
      TYPE_MAP[r.case_type]||r.case_type, r.case_group,
      r.sales_name, r.cs_name, r.org_name, r.location,
      (r.contracted_at||'').slice(0,10), (r.scheduled_date||'').slice(0,10),
      r.amount, r.amount_tax, r.received, r.pending,
      PAY_MAP[r.payment_status]||r.payment_status,
      STATUS_MAP[r.status]||r.status, r.notes,
    ].map(esc).join(','));
  });

  const bom = '﻿';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cases_export_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(bom + csvRows.join('\r\n'));
});

// ── 往來文件 ────────────────────────────────────────────────────────────────
router.get('/:id/documents', requireAuth, (req, res) => {
  const docs = db.prepare(`
    SELECT d.*, u.name AS uploader_name
    FROM case_documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.case_id = ?
    ORDER BY d.uploaded_at DESC
  `).all(req.params.id);
  res.json(docs);
});

router.post('/:id/documents', requireAuth, (req, res) => {
  const { doc_type, filename, file_url, public_id, notes } = req.body;
  if (!filename || !file_url) return res.status(400).json({ error: '缺少必要欄位' });
  const allowed = ['quote', 'contract', 'other'];
  if (!allowed.includes(doc_type)) return res.status(400).json({ error: '無效文件類型' });

  const r = db.prepare(`
    INSERT INTO case_documents (case_id, doc_type, filename, file_url, public_id, notes, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, doc_type, filename, file_url, public_id || null, notes || null, req.session.user.id);

  res.json({ ok: true, id: r.lastInsertRowid });
});

router.delete('/:id/documents/:docId', requireAuth, async (req, res) => {
  const doc = db.prepare(`SELECT * FROM case_documents WHERE id=? AND case_id=?`).get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: '找不到此文件' });

  if (doc.public_id) {
    try {
      const cloudinary = require('cloudinary').v2;
      const isRaw = !doc.file_url.includes('/image/upload/');
      await cloudinary.uploader.destroy(doc.public_id, { resource_type: isRaw ? 'raw' : 'image' });
    } catch (e) { /* 刪除 Cloudinary 失敗不中斷 */ }
  }

  db.prepare(`DELETE FROM case_documents WHERE id=?`).run(req.params.docId);
  res.json({ ok: true });
});

module.exports = router;
