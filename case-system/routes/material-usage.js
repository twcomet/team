const express = require('express');
const db = require('../db');
const { requireAuth, orgFilterSQL } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router = express.Router();

// 倉管：owner 或 can_manage_assets
function isWarehouse(u) { return u.role === 'owner' || !!u.can_manage_assets; }

const log = (uid, action, eid, detail) => {
  try { db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(uid, action, 'material_req', eid ?? null, detail ?? null); } catch (e) {}
};
// 通知同分店倉管 + owner（copy assets.js pattern）
function notifyManagers(orgId, msg) {
  try {
    const targets = db.prepare(`
      SELECT line_user_id FROM users
      WHERE active=1 AND line_user_id IS NOT NULL
        AND (role='owner' OR can_manage_assets=1)
        AND (role='owner' OR org_id=?)`).all(orgId || null);
    targets.forEach(u => pushMessage(u.line_user_id, msg).catch(() => {}));
  } catch (e) {}
}
function notifyUser(userId, msg) {
  try { const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(userId);
    if (u?.line_user_id) pushMessage(u.line_user_id, msg).catch(() => {}); } catch (e) {}
}

// ── 第二階段：倉管審核＝實扣庫存 helpers ──────────────────────────────
// 同步案件膜料成本（與 materials.js 同邏輯，避免跨檔相依）
function syncCaseMaterialCost(caseId) {
  if (!caseId) return;
  const fromDispatch = db.prepare(`SELECT COALESCE(SUM(meters_used * unit_cost), 0) AS t FROM dispatch_materials WHERE case_id=?`).get(caseId).t || 0;
  const fromLogs = db.prepare(`
    SELECT COALESCE(SUM(ABS(ml.meters) * mr.unit_cost), 0) AS t
    FROM material_logs ml LEFT JOIN material_rolls mr ON mr.id = ml.roll_id
    WHERE ml.case_id=? AND ml.log_type IN ('case_cut','case_loss')
      AND ml.status != 'cancelled' AND mr.unit_cost IS NOT NULL
  `).get(caseId).t || 0;
  const total = fromDispatch + fromLogs;
  db.prepare(`UPDATE cases SET dispatch_material_cost=? WHERE id=?`).run(total || null, caseId);
}

// 用途代碼 → material_logs.log_type（沒對應的歸 adjust，不動 CHECK 約束）
function purposeToLogType(code) {
  switch (code) {
    case 'case_takeout':
    case 'case_material': return 'case_cut';
    case 'academy':       return 'academy';
    case 'store_sale':    return 'store_sale';
    case 'ecommerce':     return 'ecommerce';
    default:              return 'adjust';   // sample / other / adjust / 其他
  }
}
// 哪些用途會真的扣庫存（case_reserve 為保留、不扣）
const CONSUME_PURPOSES = new Set(['case_takeout','case_material','sample','academy','store_sale','ecommerce','adjust','other']);

// 申領單沒存 material_id 時，盡力用 material_label 回推（品牌+型號包含比對）
function resolveMaterialId(reqRow) {
  if (reqRow.material_id) return reqRow.material_id;
  const label = (reqRow.material_label || '').trim();
  if (!label) return null;
  let best = null;
  for (const m of db.prepare(`SELECT id, brand, model FROM materials`).all()) {
    const k = [m.brand, m.model].filter(Boolean).join(' ');
    if (k && label.indexOf(k) >= 0 && (!best || k.length > best.k)) best = { id: m.id, k: k.length };
  }
  return best ? best.id : null;
}

// FIFO 實扣庫存：指定捲料則扣該捲，否則同型號最舊可用捲依序扣；每扣一支寫一筆 material_logs；回傳 logIds。庫存不足則 throw。
function consumeStock({ materialId, rollId, meters, log_type, case_id, notes, logged_by, org_id, requisition_id }) {
  meters = Math.abs(Number(meters) || 0);
  if (!materialId) throw new Error('此申領單未綁定膜料型號，無法扣庫存，請編輯申領單重新選擇膜料');
  if (meters <= 0) return [];
  const rolls = rollId
    ? db.prepare(`SELECT * FROM material_rolls WHERE id=? AND material_id=?`).all(rollId, materialId)
    : db.prepare(`SELECT * FROM material_rolls WHERE material_id=? AND status='active' AND remaining_meters>0 ORDER BY purchase_date, id`).all(materialId);
  const avail = rolls.reduce((s, r) => s + (r.remaining_meters || 0), 0);
  if (meters > avail + 1e-6) throw new Error(`庫存不足：需 ${meters} 米，可用僅 ${Math.round(avail * 100) / 100} 米`);
  let need = meters; const logIds = [];
  for (const r of rolls) {
    if (need <= 1e-9) break;
    const take = Math.min(need, r.remaining_meters || 0);
    if (take <= 0) continue;
    const newRem = Math.max(0, (r.remaining_meters || 0) - take);
    db.prepare(`UPDATE material_rolls SET remaining_meters=?, status=? WHERE id=?`).run(newRem, newRem > 0 ? 'active' : 'finished', r.id);
    db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters - ?) WHERE id=?`).run(take, materialId);
    const ins = db.prepare(`INSERT INTO material_logs (roll_id, material_id, org_id, log_type, case_id, meters, notes, logged_by, requisition_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(r.id, materialId, org_id || null, log_type, case_id || null, -take, notes || null, logged_by, requisition_id || null);
    logIds.push(ins.lastInsertRowid);
    need -= take;
  }
  return logIds;
}

// 還原某申領單實扣的庫存（刪除已歸檔申領單時用；沒扣過就 no-op）
function restoreRequisitionStock(reqId) {
  const logs = db.prepare(`SELECT * FROM material_logs WHERE requisition_id=? AND status!='cancelled'`).all(reqId);
  for (const l of logs) {
    if (l.roll_id) {
      const roll = db.prepare(`SELECT remaining_meters FROM material_rolls WHERE id=?`).get(l.roll_id);
      if (roll) {
        const restored = (roll.remaining_meters || 0) - l.meters;   // l.meters 為負 → 加回
        db.prepare(`UPDATE material_rolls SET remaining_meters=?, status=? WHERE id=?`).run(Math.max(0, restored), restored > 0 ? 'active' : 'finished', l.roll_id);
      }
    }
    db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters - ?) WHERE id=?`).run(l.meters, l.material_id);
    db.prepare(`DELETE FROM material_logs WHERE id=?`).run(l.id);
  }
}

// 沖銷一筆案件保留：軟保留(roll_id NULL，建立時未扣庫存)只標記取消；硬保留(roll_id 有值)才加回庫存
function releaseReserveLog(l) {
  if (l.roll_id) {
    const roll = db.prepare(`SELECT remaining_meters FROM material_rolls WHERE id=?`).get(l.roll_id);
    if (roll) {
      const restored = (roll.remaining_meters || 0) - l.meters;   // l.meters 為負 → 加回
      db.prepare(`UPDATE material_rolls SET remaining_meters=?, status=? WHERE id=?`).run(Math.max(0, restored), restored > 0 ? 'active' : 'finished', l.roll_id);
    }
    db.prepare(`UPDATE materials SET stock_meters = stock_meters - ? WHERE id=?`).run(l.meters, l.material_id);
  }
  db.prepare(`UPDATE material_logs SET status='cancelled' WHERE id=?`).run(l.id);
}

// 某案(可限型號)目前有效保留的彙總，供核准扣庫存後提示倉管沖銷
function activeCaseReserves(caseId, materialId) {
  if (!caseId) return null;
  const r = materialId
    ? db.prepare(`SELECT COALESCE(SUM(-meters),0) AS m, COUNT(*) AS c FROM material_logs WHERE log_type='reserve' AND status='active' AND case_id=? AND material_id=?`).get(caseId, materialId)
    : db.prepare(`SELECT COALESCE(SUM(-meters),0) AS m, COUNT(*) AS c FROM material_logs WHERE log_type='reserve' AND status='active' AND case_id=?`).get(caseId);
  return r.c > 0 ? { case_id: caseId, material_id: materialId || null, meters: Math.round(r.m * 100) / 100, count: r.c } : null;
}

const SEL = `
  SELECT r.*, o.name AS org_name, c.case_number, c.title AS case_title, cl.name AS client_name,
         ua.name AS applicant_name, up.name AS pickup_approver_name, uar.name AS archive_approver_name
  FROM material_requisitions r
  LEFT JOIN orgs o   ON o.id = r.org_id
  LEFT JOIN cases c  ON c.id = r.case_id
  LEFT JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN users ua ON ua.id = r.applicant_id
  LEFT JOIN users up ON up.id = r.pickup_approver_id
  LEFT JOIN users uar ON uar.id = r.archive_approver_id`;

// 列表
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  let sql = SEL + ` WHERE 1=1`;
  const p = [];
  if (!me.view_all_branches && me.role !== 'owner') { sql += ` AND r.org_id = ?`; p.push(me.org_id); }
  if (req.query.org_id) { sql += ` AND r.org_id = ?`; p.push(req.query.org_id); }
  if (req.query.case_id) { sql += ` AND r.case_id = ?`; p.push(req.query.case_id); }  // 案件詳情頁連動查詢
  if (req.query.status) { sql += ` AND r.status = ?`; p.push(req.query.status); }
  sql += ` ORDER BY r.applied_at DESC, r.id DESC`;
  res.json({ rows: db.prepare(sql).all(...p), me: { isWarehouse: isWarehouse(me), id: me.id } });
});

// 保留材料（讀 material_logs reserve active）
router.get('/reserves', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT ml.id, ml.case_id, ml.meters, ml.notes, ml.logged_at, ml.org_id,
           m.brand, m.model, c.case_number, c.title AS case_title, cl.name AS client_name,
           o.name AS org_name, u.name AS logged_by_name
    FROM material_logs ml
    LEFT JOIN materials m ON m.id = ml.material_id
    LEFT JOIN cases c     ON c.id = ml.case_id
    LEFT JOIN clients cl  ON cl.id = c.client_id
    LEFT JOIN orgs o      ON o.id = ml.org_id
    LEFT JOIN users u     ON u.id = ml.logged_by
    WHERE ml.log_type='reserve' AND ml.status='active'
    ORDER BY ml.logged_at DESC`).all();
  res.json(rows.map(r => ({ ...r, meters: Math.abs(r.meters || 0) })));
});

// 領用「關聯案件」下拉搜尋：回傳「全部案件」（不受派工/分店權限限制，就算他看不到案件也能關聯）
// 只回傳案號/客戶/標題等識別欄位，不含金額或成本，避免洩漏機密
router.get('/case-lookup', requireAuth, (req, res) => {
  const q = (req.query.search || '').trim();
  let sql = `
    SELECT c.id, c.case_number, c.title, cl.name AS client_name
    FROM cases c
    LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE 1=1`;
  const p = [];
  if (q) { sql += ` AND (c.case_number LIKE ? OR c.title LIKE ? OR cl.name LIKE ?)`; const s = `%${q}%`; p.push(s, s, s); }
  sql += ` ORDER BY c.updated_at DESC LIMIT 20`;
  res.json(db.prepare(sql).all(...p));
});

// 新增領用申請
router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const b = req.body;
  if (!b.material_label) return res.status(400).json({ error: '請填膜料' });
  const needsReturn = b.purpose_code === 'case_takeout' ? 1 : 0;  // 只有整捲帶出要歸還
  const r = db.prepare(`
    INSERT INTO material_requisitions
      (org_id, material_label, material_id, roll_id, case_id, purpose, purpose_code, needs_return, est_meters, note, applicant_id, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending_pickup')`)
    .run(b.org_id || me.org_id || null, b.material_label, b.material_id || null, b.roll_id || null,
         b.case_id || null, b.purpose || null, b.purpose_code || null, needsReturn, b.est_meters || null, b.note || null, me.id);
  log(me.id, 'create', r.lastInsertRowid, b.material_label);
  notifyManagers(b.org_id || me.org_id, `【膜料領用申請】\n${me.name} 申請領用「${b.material_label}」${b.est_meters ? '預估'+b.est_meters+'米' : ''}\n請至系統審核。`);
  res.json({ id: r.lastInsertRowid });
});

// 編輯：申請人限「待核准/已駁回」；倉管/老闆可編輯任何狀態
// （已扣過庫存的紀錄編輯時自動還原庫存、退回「待核准」重審，倉管重新核准時再重新扣，確保庫存正確）
router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  const isWh = isWarehouse(me);
  if (r.applicant_id !== me.id && !isWh) return res.status(403).json({ error: '僅申請人或倉管可編輯' });
  const editable = ['pending_pickup', 'rejected'].includes(r.status);
  if (!editable && !isWh) return res.status(400).json({ error: '此狀態僅倉管或老闆可編輯' });
  const b = req.body;
  const needsReturn = b.purpose_code === 'case_takeout' ? 1 : 0;
  const needsRestore = !editable;   // 非待核准/已駁回 → 曾扣過庫存，需還原並退回重審
  try {
    db.exec('BEGIN');
    if (needsRestore) restoreRequisitionStock(r.id);
    db.prepare(`UPDATE material_requisitions SET material_label=?, material_id=?, roll_id=?, case_id=?, purpose=?, purpose_code=?, needs_return=?, est_meters=?, note=?, org_id=?, status='pending_pickup', reject_note=NULL, actual_meters=NULL, remaining_meters=NULL, pickup_approver_id=NULL, pickup_approved_at=NULL, archive_approver_id=NULL, archived_at=NULL, returned_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.material_label || r.material_label, b.material_id || null, b.roll_id || null, b.case_id || null,
           b.purpose || null, b.purpose_code || null, needsReturn, b.est_meters || null, b.note || null, b.org_id || r.org_id, r.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: '編輯失敗：' + e.message });
  }
  if (r.case_id) syncCaseMaterialCost(r.case_id);
  res.json({ ok: true });
});

// 倉管核准：帶出型→已帶出待歸還；裁切型→直接結案(已完成)
router.patch('/:id/approve-pickup', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isWarehouse(me)) return res.status(403).json({ error: '僅倉管可審核' });
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'pending_pickup') return res.status(400).json({ error: '此狀態無法核准' });
  let caseReserves = null;   // 裁切型實扣後，回報該案是否還有保留可沖銷（前端跳提示）
  if (r.needs_return) {
    // 帶出型：核准後帶走，等歸還（實扣留到歸檔核准）
    db.prepare(`UPDATE material_requisitions SET status='picked', material_id=COALESCE(material_id,?), pickup_approver_id=?, pickup_approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(resolveMaterialId(r) || null, me.id, r.id);
    notifyUser(r.applicant_id, `【膜料領用已核准】\n你申請的「${r.material_label}」已核准，可前往拿料；用完請填歸還單。`);
  } else {
    // 裁切型：核准即結案 → 倉管審核＝實扣庫存
    const matId = resolveMaterialId(r);
    const willConsume = CONSUME_PURPOSES.has(r.purpose_code) && Number(r.est_meters) > 0;
    if (willConsume && !matId) return res.status(400).json({ error: '此申領單未綁定膜料型號，無法扣庫存，請先編輯申領單選擇膜料' });
    try {
      db.exec('BEGIN');
      if (willConsume) {
        consumeStock({ materialId: matId, rollId: r.roll_id, meters: r.est_meters,
          log_type: purposeToLogType(r.purpose_code), case_id: r.case_id,
          notes: `申領核銷#${r.id} ${r.purpose || ''}`.trim(), logged_by: me.id, org_id: r.org_id, requisition_id: r.id });
      }
      db.prepare(`UPDATE material_requisitions SET status='archived', material_id=COALESCE(material_id,?), pickup_approver_id=?, pickup_approved_at=CURRENT_TIMESTAMP, archive_approver_id=?, archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(matId || null, me.id, me.id, r.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      return res.status(400).json({ error: e.message });
    }
    if (willConsume && r.case_id) syncCaseMaterialCost(r.case_id);
    if (willConsume) caseReserves = activeCaseReserves(r.case_id, matId);
    notifyUser(r.applicant_id, `【膜料申請已核准】\n你申請的「${r.material_label}」已核准${willConsume ? `，庫存已扣 ${Math.abs(Number(r.est_meters))} 米` : ''}。`);
  }
  log(me.id, 'approve_pickup', r.id, r.needs_return ? 'picked' : 'archived');
  res.json({ ok: true, caseReserves });
});

// 申請人確認使用完畢（回報實際用量+三情境）
router.patch('/:id/report', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  if (!['picked', 'reserved'].includes(r.status)) return res.status(400).json({ error: '此狀態無法回報' });
  const b = req.body;
  if (b.remaining_meters == null || b.remaining_meters === '') return res.status(400).json({ error: '請填歸還剩餘米數' });
  const remaining = Number(b.remaining_meters);
  // 實際用量＝領出米數(est)−歸還剩餘，系統自動算，不信前端手算
  const actual = (r.est_meters != null) ? Math.max(0, Number(r.est_meters) - remaining)
               : (b.actual_meters != null && b.actual_meters !== '' ? Number(b.actual_meters) : null);
  db.prepare(`UPDATE material_requisitions SET actual_meters=?, remaining_meters=?, archive_location=?, cat_add=?, cat_redo=?, cat_wrongmat=?, cat_recut=?, cat_loss=?, cat_other=?, cat_other_note=?, note=COALESCE(?,note), status='pending_return', returned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(actual, remaining, b.archive_location || null,
         Number(b.cat_add) || null, Number(b.cat_redo) || null, Number(b.cat_wrongmat) || null, Number(b.cat_recut) || null, Number(b.cat_loss) || null, Number(b.cat_other) || null, b.cat_other_note || null,
         b.note || null, r.id);
  log(me.id, 'report', r.id, `actual ${b.actual_meters}`);
  notifyManagers(r.org_id, `【膜料歸檔申請】\n${me.name} 回報「${r.material_label}」實際用 ${b.actual_meters}米、剩餘 ${b.remaining_meters||0}米\n請至系統核准歸檔。`);
  res.json({ ok: true });
});

// 倉管核准歸檔（第一階段：純記錄，不動 material_rolls 庫存）
router.patch('/:id/approve-archive', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isWarehouse(me)) return res.status(403).json({ error: '僅倉管可核准歸檔' });
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'pending_return') return res.status(400).json({ error: '此狀態無法核准歸檔' });
  const b = req.body;
  // 倉管可在歸檔時修正剩餘 → 重算實際用量（領出 est − 剩餘）
  const finalRemaining = (b.remaining_meters != null && b.remaining_meters !== '') ? Number(b.remaining_meters) : r.remaining_meters;
  const used = (r.est_meters != null)
    ? Math.max(0, Number(r.est_meters) - (Number(finalRemaining) || 0))
    : (r.actual_meters != null ? Number(r.actual_meters) : 0);
  const matId = resolveMaterialId(r);
  const willConsume = used > 0;
  if (willConsume && !matId) return res.status(400).json({ error: '此申領單未綁定膜料型號，無法扣庫存，請先編輯申領單選擇膜料' });
  try {
    db.exec('BEGIN');
    if (willConsume) {
      consumeStock({ materialId: matId, rollId: r.roll_id, meters: used,
        log_type: purposeToLogType(r.purpose_code), case_id: r.case_id,
        notes: `膜料歸還核銷#${r.id} 實際用 ${used} 米`, logged_by: me.id, org_id: r.org_id, requisition_id: r.id });
    }
    db.prepare(`UPDATE material_requisitions SET status='archived', material_id=COALESCE(material_id,?), actual_meters=?, archive_approver_id=?, archived_at=CURRENT_TIMESTAMP, remaining_meters=COALESCE(?,remaining_meters), archive_location=COALESCE(?,archive_location), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(matId || null, used, me.id, finalRemaining != null && finalRemaining !== '' ? Number(finalRemaining) : null, b.archive_location || null, r.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(400).json({ error: e.message });
  }
  if (willConsume && r.case_id) syncCaseMaterialCost(r.case_id);
  log(me.id, 'approve_archive', r.id, null);
  notifyUser(r.applicant_id, `【膜料已歸檔】\n你回報的「${r.material_label}」已完成歸檔${willConsume ? `，庫存已扣 ${used} 米` : ''}。`);
  // 已實扣案件用料 → 回報該案是否還有保留可沖銷（前端跳提示問倉管）
  const caseReserves = willConsume ? activeCaseReserves(r.case_id, matId) : null;
  res.json({ ok: true, caseReserves });
});

// 倉管駁回（退回申請人修改重送，非作廢）
router.patch('/:id/reject', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isWarehouse(me)) return res.status(403).json({ error: '僅倉管可駁回' });
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  db.prepare(`UPDATE material_requisitions SET status='rejected', reject_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.body.reject_note || null, r.id);
  log(me.id, 'reject', r.id, req.body.reject_note || null);
  notifyUser(r.applicant_id, `【膜料申請被退回】\n「${r.material_label}」被退回，請修改後重送。${req.body.reject_note ? '\n原因：'+req.body.reject_note : ''}`);
  res.json({ ok: true });
});

// 刪除（申請人於待審核/駁回，或倉管）
router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  if (r.applicant_id !== me.id && !isWarehouse(me)) return res.status(403).json({ error: '無權限' });
  if (r.status === 'archived' && !isWarehouse(me)) return res.status(400).json({ error: '已歸檔，僅倉管可刪' });
  try {
    db.exec('BEGIN');
    restoreRequisitionStock(r.id);   // 還原曾實扣的庫存（沒扣過則 no-op）
    db.prepare(`DELETE FROM material_requisitions WHERE id=?`).run(r.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: '刪除失敗：' + e.message });
  }
  if (r.case_id) syncCaseMaterialCost(r.case_id);
  log(me.id, 'delete', r.id, null);
  res.json({ ok: true });
});

// 倉管手動沖銷一筆案件保留（保留分頁的「沖銷」鈕）
router.patch('/reserves/:logId/release', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isWarehouse(me)) return res.status(403).json({ error: '僅倉管或老闆可沖銷保留' });
  const l = db.prepare(`SELECT * FROM material_logs WHERE id=? AND log_type='reserve' AND status='active'`).get(req.params.logId);
  if (!l) return res.status(404).json({ error: '找不到有效的保留紀錄' });
  try { db.exec('BEGIN'); releaseReserveLog(l); db.exec('COMMIT'); }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} return res.status(500).json({ error: '沖銷失敗：' + e.message }); }
  log(me.id, 'release_reserve', l.id, `case ${l.case_id}`);
  res.json({ ok: true });
});

// 倉管沖銷某案(可限型號)的所有有效保留（核准實扣後跳提示用）
router.patch('/reserves/release-by-case', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isWarehouse(me)) return res.status(403).json({ error: '僅倉管或老闆可沖銷保留' });
  const { case_id, material_id } = req.body;
  if (!case_id) return res.status(400).json({ error: '缺少案件' });
  const logs = material_id
    ? db.prepare(`SELECT * FROM material_logs WHERE log_type='reserve' AND status='active' AND case_id=? AND material_id=?`).all(case_id, material_id)
    : db.prepare(`SELECT * FROM material_logs WHERE log_type='reserve' AND status='active' AND case_id=?`).all(case_id);
  try { db.exec('BEGIN'); for (const l of logs) releaseReserveLog(l); db.exec('COMMIT'); }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} return res.status(500).json({ error: '沖銷失敗：' + e.message }); }
  log(me.id, 'release_reserve_case', case_id, `${logs.length} reserves`);
  res.json({ ok: true, released: logs.length });
});

module.exports = router;
