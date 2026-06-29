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

// 編輯（僅申請人，且待領用審核或已駁回）
router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  if (r.applicant_id !== me.id && !isWarehouse(me)) return res.status(403).json({ error: '僅申請人可編輯' });
  if (!['pending_pickup', 'rejected'].includes(r.status)) return res.status(400).json({ error: '此狀態無法編輯' });
  const b = req.body;
  const needsReturn = b.purpose_code === 'case_takeout' ? 1 : 0;
  db.prepare(`UPDATE material_requisitions SET material_label=?, material_id=?, roll_id=?, case_id=?, purpose=?, purpose_code=?, needs_return=?, est_meters=?, note=?, org_id=?, status='pending_pickup', reject_note=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.material_label || r.material_label, b.material_id || null, b.roll_id || null, b.case_id || null,
         b.purpose || null, b.purpose_code || null, needsReturn, b.est_meters || null, b.note || null, b.org_id || r.org_id, r.id);
  res.json({ ok: true });
});

// 倉管核准：帶出型→已帶出待歸還；裁切型→直接結案(已完成)
router.patch('/:id/approve-pickup', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isWarehouse(me)) return res.status(403).json({ error: '僅倉管可審核' });
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'pending_pickup') return res.status(400).json({ error: '此狀態無法核准' });
  if (r.needs_return) {
    // 帶出型：核准後帶走，等歸還
    db.prepare(`UPDATE material_requisitions SET status='picked', pickup_approver_id=?, pickup_approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(me.id, r.id);
    notifyUser(r.applicant_id, `【膜料領用已核准】\n你申請的「${r.material_label}」已核准，可前往拿料；用完請填歸還單。`);
  } else {
    // 裁切型：核准即結案（無歸還）
    db.prepare(`UPDATE material_requisitions SET status='archived', pickup_approver_id=?, pickup_approved_at=CURRENT_TIMESTAMP, archive_approver_id=?, archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(me.id, me.id, r.id);
    notifyUser(r.applicant_id, `【膜料申請已核准】\n你申請的「${r.material_label}」已核准，可裁切使用。`);
  }
  log(me.id, 'approve_pickup', r.id, r.needs_return ? 'picked' : 'archived');
  // ⚠️ 第二階段：裁切型在此實扣庫存；案件裁料另需消除該案保留、改實際用量
  res.json({ ok: true });
});

// 申請人確認使用完畢（回報實際用量+三情境）
router.patch('/:id/report', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM material_requisitions WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  if (!['picked', 'reserved'].includes(r.status)) return res.status(400).json({ error: '此狀態無法回報' });
  const b = req.body;
  if (b.actual_meters == null || b.actual_meters === '') return res.status(400).json({ error: '請填實際用量' });
  db.prepare(`UPDATE material_requisitions SET actual_meters=?, remaining_meters=?, archive_location=?, cat_add=?, cat_redo=?, cat_wrongmat=?, cat_recut=?, cat_loss=?, cat_other_note=?, note=COALESCE(?,note), status='pending_return', returned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(Number(b.actual_meters), b.remaining_meters != null && b.remaining_meters !== '' ? Number(b.remaining_meters) : null,
         b.archive_location || null,
         Number(b.cat_add) || null, Number(b.cat_redo) || null, Number(b.cat_wrongmat) || null, Number(b.cat_recut) || null, Number(b.cat_loss) || null, b.cat_other_note || null,
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
  db.prepare(`UPDATE material_requisitions SET status='archived', archive_approver_id=?, archived_at=CURRENT_TIMESTAMP, remaining_meters=COALESCE(?,remaining_meters), archive_location=COALESCE(?,archive_location), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, b.remaining_meters != null && b.remaining_meters !== '' ? Number(b.remaining_meters) : null, b.archive_location || null, r.id);
  log(me.id, 'approve_archive', r.id, null);
  notifyUser(r.applicant_id, `【膜料已歸檔】\n你回報的「${r.material_label}」已完成歸檔。`);
  // ⚠️ 第二階段：在此實扣 material_rolls.remaining_meters + 寫 material_logs（需處理 CHECK 約束新增 log_type）
  res.json({ ok: true });
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
  db.prepare(`DELETE FROM material_requisitions WHERE id=?`).run(r.id);
  log(me.id, 'delete', r.id, null);
  res.json({ ok: true });
});

module.exports = router;
