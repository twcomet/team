const express = require('express');
const db = require('../db');
const { requireAuth, orgFilter, orgFilterSQL } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router = express.Router();

// ── 派工通知 ─────────────────────────────────────────────────
const DISPATCH_LABELS = { survey:'場勘', install:'施工', aftersales:'維修' };

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
  const count = db.prepare(`SELECT COUNT(*) as n FROM cases WHERE case_number LIKE ?`).get(`${prefix}%`).n;
  return `${prefix}-${String(count + 1).padStart(3, '0')}`;
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
  inquiry: 'inquiry',
  initial_estimate: 'survey', survey: 'survey', quoted: 'survey',
  contracted: 'deal', payment: 'deal', closed: 'deal',
};
const HQ_ROLES = ['owner','vp','hq_cs','hq_sales','hq_tech','hq_accounting','hq_hr'];

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, case_type, date_from, date_to, search, group } = req.query;

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
           sv.name  as surveyor_name,
           o.name   as org_name,
           ROUND((c.final_price - c.material_cost) * 100.0 / NULLIF(c.final_price, 0), 1) as gross_margin_pct
    FROM cases c
    LEFT JOIN clients cl ON c.client_id   = cl.id
    LEFT JOIN users   s  ON c.sales_id    = s.id
    LEFT JOIN users   sv ON c.surveyor_id = sv.id
    LEFT JOIN orgs    o  ON c.org_id      = o.id
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
  if (group)     { q += ` AND c.case_group = ?`;      p.push(group); }
  if (status)    { q += ` AND c.status = ?`;         p.push(status); }
  if (req.query.active) { q += ` AND c.status NOT IN ('closed','invalid')`; }
  if (case_type) { q += ` AND c.case_type = ?`;      p.push(case_type); }
  if (date_from) { q += ` AND c.scheduled_date >= ?`; p.push(date_from); }
  if (date_to)   { q += ` AND c.scheduled_date <= ?`; p.push(date_to); }
  if (search)    { q += ` AND (c.title LIKE ? OR c.case_number LIKE ? OR cl.name LIKE ?)`; const s = `%${search}%`; p.push(s,s,s); }

  q += ` ORDER BY c.updated_at DESC`;
  res.json(db.prepare(q).all(...p));
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

  res.json({ ok: true, id: result.lastInsertRowid, case_number });
});

router.put('/:id', requireAuth, (req, res) => {
  const {
    client_id, case_type, title, description, location, sales_id,
    final_price, survey_fee, payment_status, payment_received, deposit_amount,
    payment_due_date, payment_notes,
    status, priority, is_outsourced, outsource_type, notes,
    line_source, keyword, material_ordered, scheduled_date,
    invoice_company, invoice_tax_id, invoice_address, invoice_email, invoice_item_desc,
    survey_date, surveyor_id,
    entry_info, photo_upload_url,
    material_cost, install_fee, outsource_cost, shipping_cost, other_cost,
  } = req.body;

  db.prepare(`
    UPDATE cases SET
      client_id=?, case_type=?, title=?, description=?, location=?,
      sales_id=?, final_price=?, survey_fee=?,
      payment_status=?, payment_received=?, deposit_amount=?,
      payment_due_date=?, payment_notes=?, status=?, priority=?,
      is_outsourced=?, outsource_type=?, notes=?,
      line_source=?, keyword=?, material_ordered=?, scheduled_date=?,
      invoice_company=?, invoice_tax_id=?, invoice_address=?,
      invoice_email=?, invoice_item_desc=?,
      survey_date=?, surveyor_id=?,
      entry_info=?, photo_upload_url=?,
      material_cost=?, install_fee=?, outsource_cost=?, shipping_cost=?, other_cost=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    client_id ?? null, case_type, title, description ?? null, location ?? null,
    sales_id ?? null, final_price ?? null, survey_fee ?? null,
    payment_status || 'unpaid', payment_received ?? 0, deposit_amount ?? null,
    payment_due_date ?? null, payment_notes ?? null,
    status, priority || 'normal',
    is_outsourced ? 1 : 0, outsource_type ?? null, notes ?? null,
    line_source ?? null, keyword ?? null, material_ordered ? 1 : 0, scheduled_date ?? null,
    invoice_company ?? null, invoice_tax_id ?? null, invoice_address ?? null,
    invoice_email ?? null, invoice_item_desc ?? null,
    survey_date ?? null, surveyor_id ?? null,
    entry_info ?? null, photo_upload_url ?? null,
    material_cost ?? null, install_fee ?? null, outsource_cost ?? null, shipping_cost ?? null, other_cost ?? null,
    req.params.id,
  );

  // 當狀態更新時自動同步 case_group（invalid 保留原 group）
  if (status && status !== 'invalid' && STATUS_GROUP_MAP[status]) {
    db.prepare(`UPDATE cases SET case_group=? WHERE id=?`).run(STATUS_GROUP_MAP[status], req.params.id);
  }

  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?, 'update', 'cases', ?, ?)`)
    .run(req.session.user.id, req.params.id, `更新案件資訊`);

  recalcLaborCost(Number(req.params.id));
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
  const { dispatch_type, scheduled_date, scheduled_time, estimated_hours, material, notes, user_ids } = req.body;
  if (!scheduled_date) return res.status(400).json({ error: '請選擇派工日期' });

  const result = db.prepare(`
    INSERT INTO dispatches (case_id, dispatch_type, scheduled_date, scheduled_time, estimated_hours, material, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(case_id, dispatch_type || 'install', scheduled_date,
         scheduled_time ?? null, estimated_hours ?? null,
         material ?? null, notes ?? null, req.session.user.id);

  const did = result.lastInsertRowid;
  if (Array.isArray(user_ids)) {
    user_ids.forEach(uid => {
      db.prepare(`INSERT INTO dispatch_users (dispatch_id, user_id, role_in_dispatch) VALUES (?, ?, 'lead')`).run(did, uid);
    });
  }

  // 施工派工 → 自動帶入施工日期、升狀態
  const c = db.prepare(`SELECT status, scheduled_date FROM cases WHERE id=?`).get(case_id);
  if (dispatch_type === 'install' || dispatch_type === 'survey') {
    const updates = [];
    const params = [];
    if (!c?.scheduled_date && dispatch_type === 'install') {
      updates.push(`scheduled_date=?`); params.push(scheduled_date);
    }
    if (c?.status === 'confirmed') {
      updates.push(`status='scheduled'`);
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
  const { dispatch_type, scheduled_date, scheduled_time, estimated_hours, actual_hours, material, material_used, status, notes, user_ids } = req.body;
  db.prepare(`
    UPDATE dispatches SET dispatch_type=?, scheduled_date=?, scheduled_time=?, estimated_hours=?,
      actual_hours=?, material=?, material_used=?, status=?, notes=?
    WHERE id=? AND case_id=?
  `).run(dispatch_type, scheduled_date, scheduled_time ?? null, estimated_hours ?? null,
         actual_hours ?? null, material ?? null, material_used ?? null,
         status || 'pending', notes ?? null, req.params.did, req.params.id);

  db.prepare(`DELETE FROM dispatch_users WHERE dispatch_id=?`).run(req.params.did);
  if (Array.isArray(user_ids)) {
    user_ids.forEach(uid => {
      db.prepare(`INSERT INTO dispatch_users (dispatch_id, user_id, role_in_dispatch) VALUES (?, ?, 'lead')`).run(req.params.did, uid);
    });
  }
  recalcLaborCost(Number(req.params.id));
  notifyDispatch(Number(req.params.id), dispatch_type, scheduled_date, user_ids, req.session.user.id);
  res.json({ ok: true });
});

router.delete('/:id/dispatches/:did', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM dispatch_users WHERE dispatch_id=?`).run(req.params.did);
  db.prepare(`DELETE FROM dispatches WHERE id=? AND case_id=?`).run(req.params.did, req.params.id);
  recalcLaborCost(Number(req.params.id));
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

// ── 統計 ─────────────────────────────────────────────────────
router.get('/stats/summary', requireAuth, (req, res) => {
  const me = req.session.user;
  const { sql: orgSql2, params: orgPs2 } = orgFilterSQL(me, 'c.org_id');
  const orgCond = orgSql2 ? `AND ${orgSql2}` : '';
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';

  res.json({
    total:        db.prepare(`SELECT COUNT(*) n FROM cases c WHERE 1=1 ${orgCond}`).get(...orgPs2).n,
    active:       db.prepare(`SELECT COUNT(*) n FROM cases c WHERE status IN ('confirmed','scheduled','in_progress') ${orgCond}`).get(...orgPs2).n,
    unscheduled:  db.prepare(`SELECT COUNT(*) n FROM cases c WHERE status='confirmed' AND (scheduled_date IS NULL OR scheduled_date='') ${orgCond}`).get(...orgPs2).n,
    today_jobs:   db.prepare(`SELECT COUNT(*) n FROM dispatches d JOIN cases c ON d.case_id=c.id WHERE d.scheduled_date=? ${orgCond}`).get(today, ...orgPs2).n,
    unpaid:       db.prepare(`SELECT COALESCE(SUM(COALESCE(final_price,quoted_price,0)-payment_received),0) n FROM cases c WHERE payment_status!='paid' AND status NOT IN ('inquiry','quoted') ${orgCond}`).get(...orgPs2).n,
    month_income: db.prepare(`SELECT COALESCE(SUM(payment_received),0) n FROM cases c WHERE scheduled_date>=? ${orgCond}`).get(monthStart, ...orgPs2).n,
  });
});

module.exports = router;
