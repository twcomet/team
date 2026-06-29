const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 可進入此頁的角色：老闆 + 店長 + 會計 + 客服（個人權限 page_subcontract 可覆蓋）
const ACCESS_ROLES = ['owner', 'branch_manager', 'hq_accounting', 'hq_cs'];
// 可確認/取消付款：老闆 + 會計
const PAY_ROLES = ['owner', 'hq_accounting'];

const isOwner = u => u.role === 'owner';
const canPay  = u => PAY_ROLES.includes(u.role);
const canAccess = u =>
  u.role === 'owner' ||
  (u.permissions && u.permissions.page_subcontract === true) ||
  ACCESS_ROLES.includes(u.role);

function requireAccess(req, res, next) {
  if (!canAccess(req.session.user)) return res.status(403).json({ error: '無權限' });
  next();
}

const log = (uid, action, eid, detail) => {
  try {
    db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
      .run(uid, action, 'subcontract', eid ?? null, detail ?? null);
  } catch (e) {}
};

// ── 外包單列表 ──────────────────────────────────────────────
router.get('/', requireAuth, requireAccess, (req, res) => {
  const me = req.session.user;
  const { org_id, category } = req.query;
  let sql = `
    SELECT j.*, o.name AS org_name,
           c.case_number, c.title AS case_title, cl.name AS client_name,
           pu.name AS paid_by_name, cu.name AS created_by_name
    FROM subcontract_jobs j
    LEFT JOIN orgs    o  ON o.id  = j.org_id
    LEFT JOIN cases   c  ON c.id  = j.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users   pu ON pu.id = j.paid_by
    LEFT JOIN users   cu ON cu.id = j.created_by
    WHERE 1=1`;
  const p = [];
  // 分店權限：不能看全分店者（如店長）只看自己分店
  if (!me.view_all_branches && me.role !== 'owner') { sql += ` AND j.org_id = ?`; p.push(me.org_id); }
  if (org_id)   { sql += ` AND j.org_id = ?`;   p.push(org_id); }
  if (category) { sql += ` AND j.category = ?`; p.push(category); }
  sql += ` ORDER BY j.work_date DESC, j.id DESC`;
  const rows = db.prepare(sql).all(...p);
  // 🔒 確定成本機密：非老闆一律不回傳 owner_cost
  const owner = isOwner(me);
  if (!owner) rows.forEach(r => { r.owner_cost = null; });
  res.json({ rows, me: { isOwner: owner, canPay: canPay(me) } });
});

// ── 類別清單 ────────────────────────────────────────────────
router.get('/categories', requireAuth, requireAccess, (req, res) => {
  res.json(db.prepare(`SELECT id, name FROM subcontract_categories WHERE active=1 ORDER BY sort_order, name`).all());
});
router.post('/categories', requireAuth, requireAccess, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  try { db.prepare(`INSERT OR IGNORE INTO subcontract_categories (name) VALUES (?)`).run(name); } catch (e) {}
  res.json({ ok: true });
});
router.delete('/categories/:id', requireAuth, requireAccess, (req, res) => {
  db.prepare(`DELETE FROM subcontract_categories WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 外包個人/點工標籤 ───────────────────────────────────────
router.get('/workers', requireAuth, requireAccess, (req, res) => {
  res.json(db.prepare(`SELECT id, name FROM subcontract_workers WHERE active=1 ORDER BY sort_order, name`).all());
});
router.post('/workers', requireAuth, requireAccess, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  try { db.prepare(`INSERT OR IGNORE INTO subcontract_workers (name) VALUES (?)`).run(name); } catch (e) {}
  res.json({ ok: true });
});
router.delete('/workers/:id', requireAuth, requireAccess, (req, res) => {
  db.prepare(`DELETE FROM subcontract_workers WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 廠商名單（只給名稱，供自動媒合；避開供應商完整資料權限）──
router.get('/vendors', requireAuth, requireAccess, (req, res) => {
  res.json(db.prepare(`SELECT id, name FROM vendors WHERE active=1 ORDER BY name`).all());
});

// ── 新增外包單 ──────────────────────────────────────────────
router.post('/', requireAuth, requireAccess, (req, res) => {
  const me = req.session.user;
  const b = req.body;
  const staff = Number(b.staff_amount);
  if (!staff) return res.status(400).json({ error: '請填寫員工填寫金額' });
  // owner_cost：只有老闆能設定
  const owner_cost = (isOwner(me) && b.owner_cost != null && b.owner_cost !== '') ? Number(b.owner_cost) : null;
  const r = db.prepare(`
    INSERT INTO subcontract_jobs
      (org_id, case_id, category, worker, vendor, work_date, hours, staff_amount, owner_cost, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.org_id || me.org_id || null, b.case_id || null, b.category || null,
         b.worker || null, b.vendor || null, b.work_date || null,
         b.hours || null, staff, owner_cost, b.note || null, me.id);
  log(me.id, 'create', r.lastInsertRowid, `${b.work_date || ''} $${staff}`);
  res.json({ id: r.lastInsertRowid });
});

// ── 編輯（已付款鎖定）──────────────────────────────────────
router.put('/:id', requireAuth, requireAccess, (req, res) => {
  const me = req.session.user;
  const j = db.prepare(`SELECT * FROM subcontract_jobs WHERE id=?`).get(req.params.id);
  if (!j) return res.status(404).json({ error: '找不到' });
  if (j.paid_at) return res.status(400).json({ error: '已付款鎖定，無法修改（請先取消付款）' });
  const b = req.body;
  const staff = Number(b.staff_amount) || j.staff_amount;
  // owner_cost：只有老闆能改，其他人維持原值
  const owner_cost = isOwner(me)
    ? ((b.owner_cost != null && b.owner_cost !== '') ? Number(b.owner_cost) : null)
    : j.owner_cost;
  db.prepare(`
    UPDATE subcontract_jobs
    SET org_id=?, case_id=?, category=?, worker=?, vendor=?, work_date=?, hours=?, staff_amount=?, owner_cost=?, note=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?`)
    .run(b.org_id || j.org_id, b.case_id || null, b.category || null,
         b.worker || null, b.vendor || null, b.work_date || j.work_date,
         b.hours || null, staff, owner_cost, b.note || null, j.id);
  res.json({ ok: true });
});

// ── 刪除（已付款僅老闆可刪）────────────────────────────────
router.delete('/:id', requireAuth, requireAccess, (req, res) => {
  const me = req.session.user;
  const j = db.prepare(`SELECT * FROM subcontract_jobs WHERE id=?`).get(req.params.id);
  if (!j) return res.status(404).json({ error: '找不到' });
  if (j.paid_at && !isOwner(me)) return res.status(400).json({ error: '已付款，僅老闆可刪除' });
  db.prepare(`DELETE FROM subcontract_jobs WHERE id=?`).run(j.id);
  log(me.id, 'delete', j.id, null);
  res.json({ ok: true });
});

// ── 確認付款（限老闆/會計；需先有確定成本）────────────────
router.patch('/:id/pay', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canPay(me)) return res.status(403).json({ error: '僅老闆或會計可確認付款' });
  const j = db.prepare(`SELECT * FROM subcontract_jobs WHERE id=?`).get(req.params.id);
  if (!j) return res.status(404).json({ error: '找不到' });
  if (j.owner_cost == null) return res.status(400).json({ error: '老闆尚未設定確定成本，無法確認付款' });
  const paid_at = req.body.paid_at || new Date().toISOString().slice(0, 10);
  db.prepare(`UPDATE subcontract_jobs SET paid_at=?, paid_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(paid_at, me.id, j.id);
  log(me.id, 'pay', j.id, paid_at);
  // ⚠️ 第二階段才寫入流水帳 / 計入案件毛利（此處先不動錢的計算）
  res.json({ ok: true });
});

// ── 取消付款 ────────────────────────────────────────────────
router.patch('/:id/unpay', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canPay(me)) return res.status(403).json({ error: '僅老闆或會計可操作' });
  const j = db.prepare(`SELECT * FROM subcontract_jobs WHERE id=?`).get(req.params.id);
  if (!j) return res.status(404).json({ error: '找不到' });
  db.prepare(`UPDATE subcontract_jobs SET paid_at=NULL, paid_by=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(j.id);
  log(me.id, 'unpay', j.id, null);
  res.json({ ok: true });
});

module.exports = router;
