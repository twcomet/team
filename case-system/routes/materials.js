const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ── 膜料目錄 ─────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const rows = me.view_all_branches
    ? db.prepare(`SELECT * FROM materials ORDER BY brand, model`).all()
    : db.prepare(`SELECT * FROM materials WHERE org_id = ? ORDER BY brand, model`).all(me.org_id);
  // 非成本可見者隱藏 unit_cost
  if (!me.can_see_cost) rows.forEach(r => { r.unit_cost = null; });
  res.json(rows);
});

router.post('/', requireAuth, (req, res) => {
  const me     = req.session.user;
  const org_id = me.org_id;
  const uid    = me.id;
  const { brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes, category, ec_key } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });
  // 只有 can_see_cost 才能寫入成本
  const safeCost = me.can_see_cost ? (unit_cost || 0) : 0;

  const r = db.prepare(`
    INSERT INTO materials (org_id, brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes, category, ec_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(org_id, brand, model, color || null, spec || null, location || null,
         safeCost, unit_price || 0, stock_meters || 0, notes || null,
         category || 'film', ec_key || null);

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

  db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (?, ?, 'create', ?, ?)`)
    .run(matId, org_id, `新增膜料型號：${brand} ${model}`, uid);

  res.json({ id: matId });
});

router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const { org_id, id: uid } = me;
  const { brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes, category, ec_key } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });
  // 只有 can_see_cost 才能更新成本，否則保留舊值
  const existing = db.prepare(`SELECT unit_cost FROM materials WHERE id=?`).get(req.params.id);
  const safeCost = me.can_see_cost ? (unit_cost || 0) : (existing?.unit_cost ?? 0);

  db.prepare(`
    UPDATE materials SET brand=?, model=?, color=?, spec=?, location=?, unit_cost=?, unit_price=?, stock_meters=?, notes=?, category=?, ec_key=?
    WHERE id=? AND org_id=?
  `).run(brand, model, color || null, spec || null, location || null,
         safeCost, unit_price || 0, stock_meters || 0, notes || null,
         category || 'film', ec_key || null,
         req.params.id, org_id);

  // 若編輯後有庫存但完全沒有捲料紀錄 → 自動補建初始捲料，避免銷貨找不到可用捲料
  const meters = parseFloat(stock_meters) || 0;
  if (meters > 0) {
    const rollCount = db.prepare(`SELECT COUNT(*) as cnt FROM material_rolls WHERE material_id = ? AND org_id = ?`)
      .get(req.params.id, org_id)?.cnt || 0;
    if (rollCount === 0) {
      const today    = new Date().toISOString().slice(0, 10);
      const orgName  = db.prepare(`SELECT name FROM orgs WHERE id = ?`).get(org_id)?.name || '總部';
      const dateCode = today.replace(/-/g, '');
      const rollNo   = `${brand.trim()}-${model.trim()}-${dateCode}-01`;
      const roll     = db.prepare(`
        INSERT INTO material_rolls (material_id, org_id, roll_no, initial_meters, remaining_meters, purchase_date, unit_cost, location, branch, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, org_id, rollNo, meters, meters, today,
             unit_cost || 0, location || null, orgName, uid);
      db.prepare(`
        INSERT INTO material_logs (roll_id, material_id, org_id, log_type, meters, notes, logged_by)
        VALUES (?, ?, ?, 'purchase', ?, '編輯膜料時補建初始捲料', ?)
      `).run(roll.lastInsertRowid, req.params.id, org_id, meters, uid);
    }
  }

  db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (?, ?, 'edit', ?, ?)`)
    .run(req.params.id, org_id, `編輯膜料資料：${brand} ${model}`, uid);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const { org_id, id: uid } = req.session.user;
  const mat = db.prepare(`SELECT brand, model FROM materials WHERE id=? AND org_id=?`).get(req.params.id, org_id);
  db.prepare(`DELETE FROM materials WHERE id=? AND org_id=?`).run(req.params.id, org_id);
  if (mat) {
    db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (NULL, ?, 'delete', ?, ?)`)
      .run(org_id, `刪除膜料型號：${mat.brand} ${mat.model}`, uid);
  }
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
  const { branch } = req.query;
  let where = 'WHERE r.material_id = ?';
  const params = [req.params.matId];
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

  const mat = db.prepare(`SELECT brand, model FROM materials WHERE id=?`).get(req.params.matId);
  if (mat) {
    db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (?, ?, 'purchase', ?, ?)`)
      .run(req.params.matId, org_id, `進貨 ${initial_meters}米：${mat.brand} ${mat.model}`, uid);
  }

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
  store_sale: '門市銷售', academy: '學院使用', ecommerce: '電商訂單', adjust: '庫存調整',
  reserve: '保留'
};

// GET /:matId/logs — 取得某膜料下所有流水帳（跨捲料）
router.get('/:matId/logs', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const logs = db.prepare(`
    SELECT l.*, r.roll_no, u.name AS logger_name,
           c.title AS case_title, c.case_number,
           cl.name AS client_name
    FROM material_logs l
    LEFT JOIN material_rolls r ON r.id = l.roll_id
    LEFT JOIN users u ON u.id = l.logged_by
    LEFT JOIN cases c ON c.id = l.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE l.material_id = ? AND l.org_id = ?
    ORDER BY l.logged_at DESC
  `).all(req.params.matId, org_id);
  res.json(logs);
});

// POST /case-reserves — 新增案件膜料保留（不指定捲料，僅計畫用量）
router.post('/case-reserves', requireAuth, (req, res) => {
  const { org_id } = req.session.user;
  const uid = req.session.user.id;
  const { material_id, case_id, meters, notes } = req.body;
  if (!material_id || !case_id || !meters || meters <= 0) {
    return res.status(400).json({ error: '請填寫膜料、案件及用量' });
  }
  db.prepare(`
    INSERT INTO material_logs (roll_id, material_id, org_id, log_type, case_id, meters, notes, logged_by)
    VALUES (NULL, ?, ?, 'reserve', ?, ?, ?, ?)
  `).run(material_id, org_id, case_id, -Math.abs(meters), notes || null, uid);
  res.json({ ok: true });
});

// GET /rolls/:rid/logs — 取得某捲料的流水帳
router.get('/rolls/:rid/logs', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const logs = db.prepare(`
    SELECT l.*, u.name AS logger_name,
           c.title AS case_title, c.case_number,
           cl.name AS client_name
    FROM material_logs l
    LEFT JOIN users u ON u.id = l.logged_by
    LEFT JOIN cases c ON c.id = l.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
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

  const roll = db.prepare(`SELECT * FROM material_rolls WHERE id = ?`).get(req.params.rid);
  if (!roll) return res.status(404).json({ error: '找不到捲料' });

  const isOut = log_type !== 'purchase';
  const delta = isOut ? -Math.abs(meters) : Math.abs(meters);

  // 若為實際出料（case_cut / case_loss），自動取消同案件的所有保留
  if (['case_cut', 'case_loss'].includes(log_type) && case_id) {
    // 1. 取消綁定同一捲料的保留
    const rollReserves = db.prepare(`
      SELECT * FROM material_logs
      WHERE roll_id = ? AND case_id = ? AND log_type = 'reserve' AND status = 'active'
    `).all(req.params.rid, case_id);
    for (const r of rollReserves) {
      db.prepare(`UPDATE material_rolls SET remaining_meters = remaining_meters - ? WHERE id = ?`)
        .run(r.meters, r.roll_id);
      db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters - ?) WHERE id = ?`)
        .run(r.meters, r.material_id);
      db.prepare(`UPDATE material_logs SET status = 'cancelled' WHERE id = ?`).run(r.id);
    }
    // 2. 取消未綁定捲料（roll_id IS NULL）但同膜料同案件的保留
    const matReserves = db.prepare(`
      SELECT * FROM material_logs
      WHERE roll_id IS NULL AND material_id = ? AND case_id = ? AND log_type = 'reserve' AND status = 'active'
    `).all(roll.material_id, case_id);
    for (const r of matReserves) {
      // roll_id 為 NULL，只還原 materials.stock_meters
      db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters - ?) WHERE id = ?`)
        .run(r.meters, r.material_id);
      db.prepare(`UPDATE material_logs SET status = 'cancelled' WHERE id = ?`).run(r.id);
    }
    // 重新取得最新 remaining_meters（保留還原後可能改變）
    const fresh = db.prepare(`SELECT remaining_meters FROM material_rolls WHERE id = ?`).get(req.params.rid);
    roll.remaining_meters = fresh ? fresh.remaining_meters : roll.remaining_meters;
  }

  // 更新捲料剩餘米數
  const newRemaining = Math.max(0, roll.remaining_meters + delta);
  db.prepare(`UPDATE material_rolls SET remaining_meters = ?, status = ? WHERE id = ?`)
    .run(newRemaining, newRemaining <= 0 ? 'finished' : 'active', req.params.rid);

  // 更新 materials.stock_meters
  db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters + ?) WHERE id = ?`)
    .run(delta, roll.material_id);

  db.prepare(`
    INSERT INTO material_logs (roll_id, material_id, org_id, log_type, case_id, meters, notes, logged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.rid, roll.material_id, org_id, log_type,
         case_id || null, delta, notes || null, uid);

  if (['store_sale','academy','ecommerce','adjust'].includes(log_type)) {
    const logLabels = { store_sale:'門市銷售', academy:'學院使用', ecommerce:'電商訂單', adjust:'庫存調整' };
    const matInfo = db.prepare(`SELECT brand, model FROM materials WHERE id=?`).get(roll.material_id);
    if (matInfo) {
      db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (?, ?, ?, ?, ?)`)
        .run(roll.material_id, org_id,
             log_type,
             `${logLabels[log_type]} ${Math.abs(delta)}米：${matInfo.brand} ${matInfo.model}`,
             uid);
    }
  }

  res.json({ ok: true, remaining: newRemaining });
});

// DELETE /logs/:id — 刪除流水帳並還原庫存
router.delete('/logs/:id', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const log = db.prepare(`SELECT * FROM material_logs WHERE id = ? AND org_id = ?`).get(req.params.id, org_id);
  if (!log) return res.status(404).json({ error: '找不到記錄' });

  // 已取消的保留不需還原（庫存刪除保留時已還原）
  if (log.status !== 'cancelled') {
    if (log.roll_id) {
      const newRemaining = db.prepare(`SELECT remaining_meters FROM material_rolls WHERE id = ?`).get(log.roll_id)?.remaining_meters || 0;
      const restored = newRemaining - log.meters;
      db.prepare(`UPDATE material_rolls SET remaining_meters = ?, status = ? WHERE id = ?`)
        .run(Math.max(0, restored), restored > 0 ? 'active' : 'finished', log.roll_id);
    }
    db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters - ?) WHERE id = ?`)
      .run(log.meters, log.material_id);
  }

  db.prepare(`DELETE FROM material_logs WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /activity — 全站膜料異動紀錄（最新 N 筆）
router.get('/activity', requireAuth, (req, res) => {
  const { org_id, view_all_branches } = req.session.user;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const params = view_all_branches ? [limit] : [org_id, limit];
  const where  = view_all_branches ? '' : 'WHERE l.org_id = ?';
  const logs   = db.prepare(`
    SELECT l.id, l.material_id, l.action, l.detail, l.changed_at,
           u.name AS user_name,
           m.brand, m.model
    FROM material_change_logs l
    LEFT JOIN users u ON u.id = l.changed_by
    LEFT JOIN materials m ON m.id = l.material_id
    ${where}
    ORDER BY l.changed_at DESC
    LIMIT ?
  `).all(...params);
  res.json(logs);
});

module.exports = router;
