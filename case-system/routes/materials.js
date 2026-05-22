const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ── 膜料目錄 ─────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const rows = db.prepare(`SELECT * FROM materials WHERE org_id = ? ORDER BY brand, model`).all(org_id);
  res.json(rows);
});

router.post('/', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const uid    = req.session.user.id;
  const { brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });

  const r = db.prepare(`
    INSERT INTO materials (org_id, brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(org_id, brand, model, color || null, spec || null, location || null,
         unit_cost || 0, unit_price || 0, stock_meters || 0, notes || null);

  const matId = r.lastInsertRowid;

  // 有設定初始庫存 → 自動建第一支捲料＋進貨流水帳
  if (stock_meters > 0) {
    const today    = new Date().toISOString().slice(0, 10);
    const orgName  = db.prepare(`SELECT name FROM orgs WHERE id = ?`).get(org_id)?.name || '總部';
    const dateCode = today.replace(/-/g, '');
    const rollNo   = `${brand.trim()}-${model.trim()}-${dateCode}-01`;
    const roll     = db.prepare(`
      INSERT INTO material_rolls
        (material_id, org_id, roll_no, initial_meters, remaining_meters, purchase_date, unit_cost, location, branch, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(matId, org_id, rollNo, stock_meters, stock_meters, today,
           unit_cost || 0, location || null, orgName, uid);
    db.prepare(`
      INSERT INTO material_logs (roll_id, material_id, org_id, log_type, meters, notes, logged_by)
      VALUES (?, ?, ?, 'purchase', ?, '建立型號時設定初始庫存', ?)
    `).run(roll.lastInsertRowid, matId, org_id, stock_meters, uid);
  }

  res.json({ id: matId });
});

router.put('/:id', requireAuth, (req, res) => {
  const { brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });
  db.prepare(`
    UPDATE materials SET brand=?, model=?, color=?, spec=?, location=?, unit_cost=?, unit_price=?, stock_meters=?, notes=?
    WHERE id=? AND org_id=?
  `).run(brand, model, color || null, spec || null, location || null,
         unit_cost || 0, unit_price || 0, stock_meters || 0, notes || null,
         req.params.id, req.session.user.org_id);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM materials WHERE id=? AND org_id=?`)
    .run(req.params.id, req.session.user.org_id);
  res.json({ ok: true });
});

// ── 捲料（個別支料）────────────────────────────────────────────

// GET /branches — 取得所有店別清單
router.get('/branches', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const rows = db.prepare(`
    SELECT DISTINCT branch FROM material_rolls
    WHERE org_id = ? AND branch IS NOT NULL
    ORDER BY branch
  `).all(org_id);
  res.json(rows.map(r => r.branch));
});

// GET /:matId/rolls — 取得某膜料的所有捲料（可選 ?branch= 篩選）
router.get('/:matId/rolls', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const { branch } = req.query;
  const params = [req.params.matId, org_id];
  let where = 'WHERE r.material_id = ? AND r.org_id = ?';
  if (branch) { where += ' AND r.branch = ?'; params.push(branch); }
  const rolls = db.prepare(`
    SELECT r.*, u.name AS created_by_name
    FROM material_rolls r
    LEFT JOIN users u ON u.id = r.created_by
    ${where}
    ORDER BY r.branch, r.purchase_date DESC, r.id DESC
  `).all(...params);
  res.json(rolls);
});

// POST /:matId/rolls — 新增捲料（進貨）
router.post('/:matId/rolls', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const uid = req.session.user.id;
  const { roll_no, initial_meters, purchase_date, unit_cost, location, branch, notes } = req.body;
  if (!initial_meters) return res.status(400).json({ error: '請填寫進貨米數' });

  const r = db.prepare(`
    INSERT INTO material_rolls (material_id, org_id, roll_no, initial_meters, remaining_meters, purchase_date, unit_cost, location, branch, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.matId, org_id, roll_no || null, initial_meters, initial_meters,
         purchase_date || null, unit_cost || 0, location || null, branch || '總部', notes || null, uid);

  // 同步更新 materials.stock_meters
  db.prepare(`UPDATE materials SET stock_meters = stock_meters + ? WHERE id = ? AND org_id = ?`)
    .run(initial_meters, req.params.matId, org_id);

  // 寫一筆進貨流水帳
  db.prepare(`
    INSERT INTO material_logs (roll_id, material_id, org_id, log_type, meters, notes, logged_by)
    VALUES (?, ?, ?, 'purchase', ?, ?, ?)
  `).run(r.lastInsertRowid, req.params.matId, org_id, initial_meters, notes || null, uid);

  res.json({ id: r.lastInsertRowid });
});

// PUT /:matId/rolls/:rid — 編輯捲料
router.put('/:matId/rolls/:rid', requireAuth, (req, res) => {
  const { roll_no, purchase_date, unit_cost, location, branch, status, notes } = req.body;
  db.prepare(`
    UPDATE material_rolls SET roll_no=?, purchase_date=?, unit_cost=?, location=?, branch=?, status=?, notes=?
    WHERE id=? AND org_id=?
  `).run(roll_no || null, purchase_date || null, unit_cost || 0, location || null,
         branch || '總部', status || 'active', notes || null,
         req.params.rid, req.session.user.org_id);
  res.json({ ok: true });
});

// ── 流水帳 ────────────────────────────────────────────────────

const LOG_TYPE_LABELS = {
  purchase: '進貨', case_cut: '案場切料', case_loss: '案場損失重貼',
  store_sale: '門市銷售', academy: '學院使用', ecommerce: '電商訂單', adjust: '庫存調整'
};

// GET /:matId/logs — 取得某膜料下所有流水帳（跨捲料）
router.get('/:matId/logs', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const logs = db.prepare(`
    SELECT l.*, r.roll_no, u.name AS logger_name,
           c.title AS case_title, c.case_number
    FROM material_logs l
    LEFT JOIN material_rolls r ON r.id = l.roll_id
    LEFT JOIN users u ON u.id = l.logged_by
    LEFT JOIN cases c ON c.id = l.case_id
    WHERE l.material_id = ? AND l.org_id = ?
    ORDER BY l.logged_at DESC
  `).all(req.params.matId, org_id);
  res.json(logs);
});

// GET /rolls/:rid/logs — 取得某捲料的流水帳
router.get('/rolls/:rid/logs', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const logs = db.prepare(`
    SELECT l.*, u.name AS logger_name, c.title AS case_title, c.case_number
    FROM material_logs l
    LEFT JOIN users u ON u.id = l.logged_by
    LEFT JOIN cases c ON c.id = l.case_id
    WHERE l.roll_id = ? AND l.org_id = ?
    ORDER BY l.logged_at DESC
  `).all(req.params.rid, org_id);
  res.json(logs);
});

// POST /rolls/:rid/logs — 新增使用紀錄
router.post('/rolls/:rid/logs', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const uid = req.session.user.id;
  const { log_type, case_id, meters, notes } = req.body;
  if (!log_type || !meters) return res.status(400).json({ error: '請填寫用途和米數' });

  const roll = db.prepare(`SELECT * FROM material_rolls WHERE id = ? AND org_id = ?`).get(req.params.rid, org_id);
  if (!roll) return res.status(404).json({ error: '找不到捲料' });

  const isOut = log_type !== 'purchase';
  const delta = isOut ? -Math.abs(meters) : Math.abs(meters);

  // 更新捲料剩餘米數
  const newRemaining = Math.max(0, roll.remaining_meters + delta);
  db.prepare(`UPDATE material_rolls SET remaining_meters = ?, status = ? WHERE id = ?`)
    .run(newRemaining, newRemaining <= 0 ? 'finished' : 'active', req.params.rid);

  // 更新 materials.stock_meters
  db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters + ?) WHERE id = ? AND org_id = ?`)
    .run(delta, roll.material_id, org_id);

  db.prepare(`
    INSERT INTO material_logs (roll_id, material_id, org_id, log_type, case_id, meters, notes, logged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.rid, roll.material_id, org_id, log_type,
         case_id || null, delta, notes || null, uid);

  res.json({ ok: true, remaining: newRemaining });
});

module.exports = router;
