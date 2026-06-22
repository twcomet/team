const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 同步案件的 dispatch_material_cost（含 dispatch_materials 和 material_logs 兩個來源）
function syncCaseMaterialCost(caseId) {
  if (!caseId) return;
  const fromDispatch = db.prepare(`SELECT COALESCE(SUM(meters_used * unit_cost), 0) AS t FROM dispatch_materials WHERE case_id=?`).get(caseId).t || 0;
  const fromLogs = db.prepare(`
    SELECT COALESCE(SUM(ABS(ml.meters) * mr.unit_cost), 0) AS t
    FROM material_logs ml
    LEFT JOIN material_rolls mr ON mr.id = ml.roll_id
    WHERE ml.case_id=? AND ml.log_type IN ('case_cut','case_loss')
    AND ml.status != 'cancelled' AND mr.unit_cost IS NOT NULL
  `).get(caseId).t || 0;
  const total = fromDispatch + fromLogs;
  db.prepare(`UPDATE cases SET dispatch_material_cost=? WHERE id=?`).run(total || null, caseId);
}

// ── 膜料目錄 ─────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const rows = me.view_all_branches
    ? db.prepare(`SELECT * FROM materials ORDER BY brand, model`).all()
    : db.prepare(`SELECT * FROM materials WHERE org_id = ? ORDER BY brand, model`).all(me.org_id);
  // 非成本可見者隱藏 unit_cost
  if (!me.can_see_cost) rows.forEach(r => { r.unit_cost = null; });
  // 加入保留量
  try {
    const resRows = db.prepare(`
      SELECT material_id,
        COALESCE(SUM(CASE WHEN status='pending'   THEN quantity_meters ELSE 0 END),0) as pending_meters,
        COALESCE(SUM(CASE WHEN status='committed' THEN quantity_meters ELSE 0 END),0) as committed_meters
      FROM material_reservations WHERE status!='released' GROUP BY material_id
    `).all();
    const resMap = {};
    resRows.forEach(r => { resMap[r.material_id] = r; });
    rows.forEach(m => {
      m.pending_reserved_meters   = resMap[m.id]?.pending_meters   || 0;
      m.committed_reserved_meters = resMap[m.id]?.committed_meters || 0;
    });
  } catch(e) { /* 表格不存在時忽略 */ }
  // 加入案件膜料保留量（來自 material_logs，log_type='reserve'）
  try {
    const caseResRows = db.prepare(`
      SELECT material_id,
        COALESCE(SUM(CASE WHEN status='active' THEN -meters ELSE 0 END), 0) as case_reserved_meters
      FROM material_logs WHERE log_type='reserve'
      GROUP BY material_id
    `).all();
    const caseResMap = {};
    caseResRows.forEach(r => { caseResMap[r.material_id] = r; });
    rows.forEach(m => { m.case_reserved_meters = caseResMap[m.id]?.case_reserved_meters || 0; });
  } catch(e) {}
  res.json(rows);
});

router.post('/', requireAuth, (req, res) => {
  const me     = req.session.user;
  const org_id = me.org_id;
  const uid    = me.id;
  const { brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes, category, ec_key, fire_retardant, width_cm, image_url, image_public_id } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });
  // 只有 can_see_cost 才能寫入成本
  const safeCost = me.can_see_cost ? (unit_cost || 0) : 0;

  const r = db.prepare(`
    INSERT INTO materials (org_id, brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes, category, ec_key, fire_retardant, width_cm, image_url, image_public_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(org_id, brand, model, color || null, spec || null, location || null,
         safeCost, unit_price || 0, stock_meters || 0, notes || null,
         category || 'film', ec_key || null, Number(fire_retardant) ? 1 : 0, width_cm || 122,
         image_url || null, image_public_id || null);

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
  const { brand, model, color, spec, location, unit_cost, unit_price, stock_meters, notes, category, ec_key, fire_retardant, width_cm, image_url, image_public_id } = req.body;
  if (!brand || !model) return res.status(400).json({ error: '品牌和型號必填' });
  // 只有 can_see_cost 才能更新成本，否則保留舊值
  const existing = db.prepare(`SELECT unit_cost, image_url, image_public_id FROM materials WHERE id=?`).get(req.params.id);
  const safeCost = me.can_see_cost ? (unit_cost || 0) : (existing?.unit_cost ?? 0);
  const safeImageUrl = image_url !== undefined ? (image_url || null) : (existing?.image_url ?? null);
  const safePublicId = image_public_id !== undefined ? (image_public_id || null) : (existing?.image_public_id ?? null);

  db.prepare(`
    UPDATE materials SET brand=?, model=?, color=?, spec=?, location=?, unit_cost=?, unit_price=?, stock_meters=?, notes=?, category=?, ec_key=?, fire_retardant=?, width_cm=?, image_url=?, image_public_id=?
    WHERE id=? AND org_id=?
  `).run(brand, model, color || null, spec || null, location || null,
         safeCost, unit_price || 0, stock_meters || 0, notes || null,
         category || 'film', ec_key || null, Number(fire_retardant) ? 1 : 0, width_cm || 122,
         safeImageUrl, safePublicId,
         req.params.id, org_id);

  // 編輯庫存米數：同步捲料剩餘，避免 stock_meters 與捲料脫鉤（否則之後扣庫會帶到舊的捲料剩餘）
  const meters = parseFloat(stock_meters) || 0;
  const activeRolls = db.prepare(`SELECT id, remaining_meters, initial_meters FROM material_rolls WHERE material_id=? AND org_id=? AND status!='lost' ORDER BY (status='active') DESC, id`).all(req.params.id, org_id);
  if (activeRolls.length === 0) {
    // 完全沒有捲料且有庫存 → 自動補建初始捲料
    if (meters > 0) {
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
  } else {
    // 已有捲料 → 把新庫存同步到捲料剩餘
    const oldTotal = activeRolls.reduce((s, r) => s + (r.remaining_meters || 0), 0);
    if (Math.abs(meters - oldTotal) > 1e-6) {
      if (activeRolls.length === 1) {
        const r = activeRolls[0], nr = Math.max(0, meters);
        db.prepare(`UPDATE material_rolls SET remaining_meters=?, initial_meters=MAX(initial_meters,?), status=? WHERE id=?`)
          .run(nr, nr, nr > 0 ? 'active' : 'finished', r.id);
      } else {
        // 多支捲料：差額套到剩餘最多的那支
        const tgt = activeRolls.slice().sort((a, b) => (b.remaining_meters || 0) - (a.remaining_meters || 0))[0];
        const nr = Math.max(0, (tgt.remaining_meters || 0) + (meters - oldTotal));
        db.prepare(`UPDATE material_rolls SET remaining_meters=?, status=? WHERE id=?`)
          .run(nr, nr > 0 ? 'active' : 'finished', tgt.id);
      }
    }
  }

  db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (?, ?, 'edit', ?, ?)`)
    .run(req.params.id, org_id, `編輯膜料資料：${brand} ${model}`, uid);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const { org_id, id: uid } = req.session.user;
  try {
    const mat = db.prepare(`SELECT brand, model FROM materials WHERE id=? AND org_id=?`).get(req.params.id, org_id);
    if (!mat) return res.status(404).json({ error: '找不到膜料' });
    db.prepare(`DELETE FROM materials WHERE id=? AND org_id=?`).run(req.params.id, org_id);
    db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (NULL, ?, 'delete', ?, ?)`)
      .run(org_id, `刪除膜料型號：${mat.brand} ${mat.model}`, uid);
    res.json({ ok: true });
  } catch (e) {
    if (e.message && e.message.includes('FOREIGN KEY')) {
      return res.status(409).json({ error: '此膜料已有關聯採購紀錄或報價資料，無法直接刪除。請先刪除相關紀錄後再試。' });
    }
    res.status(500).json({ error: e.message });
  }
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

// PUT /:matId/rolls/:rid — 編輯捲料（含 remaining_meters）
router.put('/:matId/rolls/:rid', requireAuth, (req, res) => {
  const { roll_no, purchase_date, unit_cost, location, branch, status, notes } = req.body;
  const newRemaining = req.body.remaining_meters !== undefined ? parseFloat(req.body.remaining_meters) : undefined;

  // 若有傳入 remaining_meters → 同步更新 materials.stock_meters
  if (newRemaining !== undefined) {
    const cur = db.prepare(`SELECT remaining_meters FROM material_rolls WHERE id=? AND org_id=?`)
      .get(req.params.rid, req.session.user.org_id);
    if (cur) {
      const delta = newRemaining - (cur.remaining_meters || 0);
      if (delta !== 0) {
        db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters + ?) WHERE id=?`)
          .run(delta, req.params.matId);
      }
    }
    db.prepare(`
      UPDATE material_rolls SET roll_no=?, purchase_date=?, unit_cost=?, location=?, branch=?, status=?, notes=?, remaining_meters=?
      WHERE id=? AND org_id=?
    `).run(roll_no || null, purchase_date || null, unit_cost || 0, location || null,
           branch || '總部', status || 'active', notes || null, newRemaining,
           req.params.rid, req.session.user.org_id);
  } else {
    db.prepare(`
      UPDATE material_rolls SET roll_no=?, purchase_date=?, unit_cost=?, location=?, branch=?, status=?, notes=?
      WHERE id=? AND org_id=?
    `).run(roll_no || null, purchase_date || null, unit_cost || 0, location || null,
           branch || '總部', status || 'active', notes || null,
           req.params.rid, req.session.user.org_id);
  }
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

  // 擋超量：出料/保留不可超過捲料可用庫存（須在任何異動之前檢查，避免改一半才擋）
  if (isOut) {
    let available = roll.remaining_meters;
    // 實際出料(case_cut/case_loss)會先還原本案在此捲料的保留，故可用量要加回這些保留
    if (['case_cut', 'case_loss'].includes(log_type) && case_id) {
      const back = db.prepare(`SELECT COALESCE(SUM(-meters),0) AS m FROM material_logs
        WHERE roll_id=? AND case_id=? AND log_type='reserve' AND status='active'`).get(req.params.rid, case_id).m;
      available += back;
    }
    if (Math.abs(meters) > available + 1e-6) {
      return res.status(400).json({ error: `用量 ${Math.abs(meters)} 米超過捲料可用庫存（可用 ${available} 米）` });
    }
  }

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

  if (case_id && ['case_cut','case_loss'].includes(log_type)) syncCaseMaterialCost(case_id);
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
  if (log.case_id && ['case_cut','case_loss'].includes(log.log_type)) syncCaseMaterialCost(log.case_id);
  res.json({ ok: true });
});

// PUT /logs/:id — 編輯使用紀錄（改米數/備註，連動還原並重套庫存）
router.put('/logs/:id', requireAuth, (req, res) => {
  const org_id = req.session.user.org_id;
  const log = db.prepare(`SELECT * FROM material_logs WHERE id=? AND org_id=?`).get(req.params.id, org_id);
  if (!log) return res.status(404).json({ error: '找不到記錄' });
  if (log.status === 'cancelled') return res.status(400).json({ error: '已取消的紀錄無法編輯' });
  const { meters, notes } = req.body;
  const newAbs = Math.abs(parseFloat(meters));
  if (!newAbs || newAbs <= 0) return res.status(400).json({ error: '請填寫用量（米）' });
  const isOut = log.log_type !== 'purchase';
  const newDelta = isOut ? -newAbs : newAbs;

  if (log.roll_id) {
    const roll = db.prepare(`SELECT remaining_meters FROM material_rolls WHERE id=?`).get(log.roll_id);
    if (roll) {
      const restored = roll.remaining_meters - log.meters;   // 撤銷原本這筆後的可用量
      if (isOut && newAbs > restored + 1e-6) {
        return res.status(400).json({ error: `用量 ${newAbs} 米超過捲料可用庫存（可用 ${restored} 米）` });
      }
      const newRemaining = Math.max(0, restored + newDelta);
      db.prepare(`UPDATE material_rolls SET remaining_meters=?, status=? WHERE id=?`)
        .run(newRemaining, newRemaining > 0 ? 'active' : 'finished', log.roll_id);
    }
  }
  // 調整 materials.stock_meters：差額 = 新delta - 舊delta
  db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters + ?) WHERE id=?`)
    .run(newDelta - log.meters, log.material_id);

  db.prepare(`UPDATE material_logs SET meters=?, notes=? WHERE id=?`)
    .run(newDelta, notes !== undefined ? (notes || null) : log.notes, req.params.id);
  if (log.case_id && ['case_cut','case_loss'].includes(log.log_type)) syncCaseMaterialCost(log.case_id);
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

// ════════════════════════════════════════════════════════════════
// 📥 批次更新庫存（Tanya 自助）— 預覽 / 套用 / 還原 / 匯出含捲號
// 安全原則：絕不硬刪；只新增 / 更新 / 封存(finished)；套用前快照、可整批還原；不碰成本
// ════════════════════════════════════════════════════════════════
function requireMaterials(req, res, next) {
  const u = req.session.user;
  if (u && (u.permissions?.page_materials || u.manage_users)) return next();
  return res.status(403).json({ error: '沒有膜料管理權限' });
}
const cleanModel = s => String(s || '').replace(/[（(][^）)]*[)）]/g, '').trim();   // 去括號別名
const normKey    = s => cleanModel(s).replace(/\s+/g, '').toUpperCase();           // 比對鍵

function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const IMP_HEADER = {
  '貨架位置': 'location', '位置': 'location',
  '材質': 'material',
  '品牌': 'brand',
  '型號': 'model',
  '是否防焰': 'fire', '防焰': 'fire',
  '每米含稅價': 'price', '售價': 'price', '每米售價': 'price', '價格': 'price',
  '庫存米數': 'meters', '米數': 'meters', '庫存': 'meters',
  '捲號': 'roll_no', '編號': 'roll_no',
};
function readImportRows(csv) {
  const grid = parseCSV(csv);
  if (!grid.length) return { error: '檔案是空的' };
  const hIdx = grid.findIndex(r => r.some(c => String(c).includes('型號')));
  if (hIdx < 0) return { error: '找不到標題列（需含「品牌／型號／庫存米數」等欄位）。若中文變亂碼，請在 Excel「另存新檔」選「CSV UTF-8（逗號分隔）」。' };
  const keys = grid[hIdx].map(h => IMP_HEADER[String(h).trim()] || null);
  const out = [];
  for (let i = hIdx + 1; i < grid.length; i++) {
    const r = grid[i]; const o = {};
    keys.forEach((k, j) => { if (k) o[k] = (r[j] ?? '').toString().trim(); });
    if (!o.model) continue;
    out.push({
      brand: (o.brand || '').trim(), model: (o.model || '').trim(),
      location: o.location || '', material: o.material || '', fire: o.fire || '',
      price: (o.price === '' || o.price == null) ? null : parseFloat(o.price),
      meters: parseFloat(o.meters) || 0,
      roll_no: (o.roll_no || '').trim(),
    });
  }
  return { rows: out };
}

// 比對成計畫（預覽與套用共用）
function buildPlan(orgId, rows) {
  const materials = db.prepare(`SELECT * FROM materials WHERE org_id=?`).all(orgId);
  const matByKey = {};
  materials.forEach(m => { matByKey[(m.brand || '').trim().toUpperCase() + '|' + normKey(m.model)] = m; });
  const activeRolls = db.prepare(`SELECT * FROM material_rolls WHERE org_id=? AND status='active'`).all(orgId);
  const rollByNo = {};
  activeRolls.forEach(r => { if (r.roll_no) rollByNo[r.roll_no] = r; });
  const resMat   = new Set(db.prepare(`SELECT DISTINCT material_id FROM material_reservations WHERE status!='released'`).all().map(r => r.material_id));
  const histRoll = new Set(db.prepare(`SELECT DISTINCT roll_id FROM material_logs WHERE log_type IN ('case_cut','case_loss') AND roll_id IS NOT NULL`).all().map(r => r.roll_id));

  const plan = { newMaterials: [], updMaterials: [], newRolls: [], updRolls: [], orphanRolls: [], errors: [] };
  const matchedRolls = new Set();
  const seenNewMat = {};
  rows.forEach((row, idx) => {
    if (!row.brand || !row.model) { plan.errors.push({ idx: idx + 1, model: row.model || '(空)', reason: '缺品牌或型號' }); return; }
    const key = row.brand.toUpperCase() + '|' + normKey(row.model);
    const mat = matByKey[key];
    if (mat) {
      const changed = (row.price != null && Number(row.price) !== Number(mat.unit_price));
      plan.updMaterials.push({ matId: mat.id, row, oldPrice: mat.unit_price, priceChanged: changed });
    } else if (!seenNewMat[key]) {
      seenNewMat[key] = true; plan.newMaterials.push({ key, row });
    }
    const mr = row.roll_no && rollByNo[row.roll_no];
    if (mr) { matchedRolls.add(mr.id); plan.updRolls.push({ rollId: mr.id, matId: mr.material_id, row, oldRemaining: mr.remaining_meters, oldLocation: mr.location }); }
    else plan.newRolls.push({ key, row });
  });
  plan.orphanRolls = activeRolls.filter(r => !matchedRolls.has(r.id)).map(r => ({
    id: r.id, roll_no: r.roll_no, material_id: r.material_id, remaining: r.remaining_meters,
    protected: histRoll.has(r.id) || resMat.has(r.material_id),
  }));
  return plan;
}

// 預覽（唯讀，不寫入）
router.post('/import/preview', requireAuth, requireMaterials, (req, res) => {
  const orgId = req.session.user.org_id;
  const { rows, error } = readImportRows(req.body.csv);
  if (error) return res.status(400).json({ error });
  if (!rows.length) return res.status(400).json({ error: '沒有讀到任何資料列' });
  const plan = buildPlan(orgId, rows);
  res.json({
    total: rows.length,
    summary: {
      newMaterials: plan.newMaterials.length,
      updMaterials: plan.updMaterials.filter(m => m.priceChanged).length,
      newRolls: plan.newRolls.length,
      updRolls: plan.updRolls.length,
      orphanArchive: plan.orphanRolls.filter(o => !o.protected).length,
      orphanProtected: plan.orphanRolls.filter(o => o.protected).length,
      errors: plan.errors.length,
    },
    newMaterialsSample: plan.newMaterials.slice(0, 50).map(n => `${n.row.brand} ${n.row.model}`),
    orphanSample: plan.orphanRolls.slice(0, 50).map(o => ({ roll_no: o.roll_no, remaining: o.remaining, protected: o.protected })),
    errors: plan.errors.slice(0, 50),
  });
});

// 套用（交易內寫入＋快照可還原）
router.post('/import/apply', requireAuth, requireMaterials, (req, res) => {
  const me = req.session.user, orgId = me.org_id, uid = me.id;
  const { rows, error } = readImportRows(req.body.csv);
  if (error) return res.status(400).json({ error });
  if (!rows.length) return res.status(400).json({ error: '沒有讀到任何資料列' });
  const orgName = db.prepare(`SELECT name FROM orgs WHERE id=?`).get(orgId)?.name || '總部';
  const today = new Date().toISOString().slice(0, 10);
  const plan = buildPlan(orgId, rows);
  const affected = { createdMats: [], createdRolls: [], updRolls: [], archived: [], priceChanges: [] };

  // 每型號捲號流水：以現有總捲料數為起點
  const rollNoSet = new Set(db.prepare(`SELECT roll_no FROM material_rolls WHERE org_id=? AND roll_no IS NOT NULL`).all(orgId).map(r => r.roll_no));
  const seq = {};
  db.prepare(`SELECT material_id, COUNT(*) c FROM material_rolls WHERE org_id=? GROUP BY material_id`).all(orgId).forEach(r => { seq[r.material_id] = r.c; });
  const genRollNo = (matId, brand, model) => {
    let n = (seq[matId] = (seq[matId] || 0) + 1);
    let no = `${brand}-${cleanModel(model)}-${String(n).padStart(2, '0')}`;
    while (rollNoSet.has(no)) { n++; seq[matId] = n; no = `${brand}-${cleanModel(model)}-${String(n).padStart(2, '0')}`; }
    rollNoSet.add(no); return no;
  };
  const matIdByKey = {};
  db.prepare(`SELECT id, brand, model FROM materials WHERE org_id=?`).all(orgId)
    .forEach(m => { matIdByKey[(m.brand || '').toUpperCase() + '|' + normKey(m.model)] = m.id; });

  try {
    db.exec('BEGIN');
    // 1) 新增品項
    for (const nm of plan.newMaterials) {
      const r = nm.row;
      const ins = db.prepare(`INSERT INTO materials (org_id, brand, model, color, unit_cost, unit_price, stock_meters, category, fire_retardant, width_cm) VALUES (?,?,?,?,0,?,0,'film',?,122)`)
        .run(orgId, r.brand, r.model, r.material || null, r.price || 0, /防焰/.test(r.fire) && !/非/.test(r.fire) ? 1 : 0);
      matIdByKey[nm.key] = ins.lastInsertRowid; affected.createdMats.push(ins.lastInsertRowid);
    }
    // 2) 既有品項：更新售價 / 材質 / 防焰（不碰成本）
    for (const um of plan.updMaterials) {
      if (um.priceChanged) affected.priceChanges.push({ matId: um.matId, old: um.oldPrice });
      const r = um.row;
      db.prepare(`UPDATE materials SET unit_price=?, color=COALESCE(NULLIF(?,''),color), fire_retardant=? WHERE id=?`)
        .run(r.price != null ? r.price : (db.prepare(`SELECT unit_price FROM materials WHERE id=?`).get(um.matId)?.unit_price || 0),
             r.material || '', /防焰/.test(r.fire) && !/非/.test(r.fire) ? 1 : 0, um.matId);
    }
    // 3) 既有捲料（憑捲號）更新庫存/位置
    for (const ur of plan.updRolls) {
      affected.updRolls.push({ id: ur.rollId, oldRemaining: ur.oldRemaining, oldLocation: ur.oldLocation });
      const m = Math.max(0, ur.row.meters);
      db.prepare(`UPDATE material_rolls SET remaining_meters=?, location=COALESCE(NULLIF(?,''),location), status=? WHERE id=?`)
        .run(m, ur.row.location || '', m > 0 ? 'active' : 'finished', ur.rollId);
    }
    // 4) 新捲料：建立 + 發捲號 + 進貨流水
    for (const nr of plan.newRolls) {
      const r = nr.row;
      let matId = matIdByKey[nr.key];
      if (!matId) { // 後援：理論上 newMaterials/既有品項已涵蓋
        const ins = db.prepare(`INSERT INTO materials (org_id, brand, model, color, unit_cost, unit_price, stock_meters, category, fire_retardant, width_cm) VALUES (?,?,?,?,0,?,0,'film',?,122)`)
          .run(orgId, r.brand, r.model, r.material || null, r.price || 0, /防焰/.test(r.fire) && !/非/.test(r.fire) ? 1 : 0);
        matId = ins.lastInsertRowid; matIdByKey[nr.key] = matId; affected.createdMats.push(matId);
      }
      const m = Math.max(0, r.meters);
      const rollNo = genRollNo(matId, r.brand, r.model);
      const roll = db.prepare(`INSERT INTO material_rolls (material_id, org_id, roll_no, initial_meters, remaining_meters, purchase_date, unit_cost, location, branch, status, created_by) VALUES (?,?,?,?,?,?,0,?,?,?,?)`)
        .run(matId, orgId, rollNo, m, m, today, r.location || null, orgName, m > 0 ? 'active' : 'finished', uid);
      db.prepare(`INSERT INTO material_logs (roll_id, material_id, org_id, log_type, meters, notes, logged_by) VALUES (?,?,?,'purchase',?,'批次匯入庫存',?)`)
        .run(roll.lastInsertRowid, matId, orgId, m, uid);
      affected.createdRolls.push(roll.lastInsertRowid);
    }
    // 5) 系統有、匯入沒有 → 封存（不刪，保留歷史）
    for (const o of plan.orphanRolls) {
      affected.archived.push({ id: o.id, prev: 'active' });
      db.prepare(`UPDATE material_rolls SET status='finished' WHERE id=?`).run(o.id);
    }
    // 6) 重算各受影響品項的 stock_meters = 使用中捲料剩餘總和
    const touched = new Set([...affected.createdMats, ...affected.priceChanges.map(p => p.matId),
      ...plan.updRolls.map(u => u.matId), ...plan.orphanRolls.map(o => o.material_id), ...Object.values(matIdByKey)]);
    for (const mid of touched) {
      db.prepare(`UPDATE materials SET stock_meters=(SELECT COALESCE(SUM(remaining_meters),0) FROM material_rolls WHERE material_id=? AND status='active') WHERE id=?`).run(mid, mid);
    }
    const summary = {
      newMaterials: affected.createdMats.length, updRolls: plan.updRolls.length,
      newRolls: plan.newRolls.length, archived: affected.archived.length,
      priceChanges: affected.priceChanges.length, errors: plan.errors.length,
    };
    const batch = db.prepare(`INSERT INTO material_import_batches (org_id, filename, summary, affected, row_count, created_by) VALUES (?,?,?,?,?,?)`)
      .run(orgId, (req.body.filename || '庫存匯入').slice(0, 120), JSON.stringify(summary), JSON.stringify(affected), rows.length, uid);
    db.prepare(`INSERT INTO material_change_logs (org_id, action, detail, changed_by) VALUES (?, 'import', ?, ?)`)
      .run(orgId, `批次更新庫存：新增${summary.newMaterials}型號／新捲料${summary.newRolls}／更新${summary.updRolls}／封存${summary.archived}`, uid);
    db.exec('COMMIT');
    res.json({ ok: true, batchId: batch.lastInsertRowid, summary });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('[import/apply]', e);
    res.status(500).json({ error: '套用失敗：' + e.message });
  }
});

// 還原整批
router.post('/import/revert/:id', requireAuth, requireMaterials, (req, res) => {
  const orgId = req.session.user.org_id;
  const batch = db.prepare(`SELECT * FROM material_import_batches WHERE id=? AND org_id=?`).get(req.params.id, orgId);
  if (!batch) return res.status(404).json({ error: '找不到這批匯入' });
  if (batch.status === 'reverted') return res.status(400).json({ error: '這批已經還原過了' });
  const a = JSON.parse(batch.affected || '{}');
  try {
    db.exec('BEGIN');
    for (const id of (a.createdRolls || [])) db.prepare(`DELETE FROM material_rolls WHERE id=?`).run(id);
    for (const u of (a.updRolls || [])) db.prepare(`UPDATE material_rolls SET remaining_meters=?, location=?, status=? WHERE id=?`).run(u.oldRemaining || 0, u.oldLocation || null, (u.oldRemaining || 0) > 0 ? 'active' : 'finished', u.id);
    for (const ar of (a.archived || [])) db.prepare(`UPDATE material_rolls SET status=? WHERE id=?`).run(ar.prev || 'active', ar.id);
    for (const p of (a.priceChanges || [])) db.prepare(`UPDATE materials SET unit_price=? WHERE id=?`).run(p.old || 0, p.matId);
    for (const id of (a.createdMats || [])) {
      const hasRoll = db.prepare(`SELECT 1 FROM material_rolls WHERE material_id=? LIMIT 1`).get(id);
      const hasRes  = db.prepare(`SELECT 1 FROM material_reservations WHERE material_id=? LIMIT 1`).get(id);
      if (!hasRoll && !hasRes) db.prepare(`DELETE FROM materials WHERE id=?`).run(id);
    }
    const mids = new Set([...(a.createdMats || []), ...(a.priceChanges || []).map(p => p.matId)]);
    db.prepare(`SELECT DISTINCT material_id FROM material_rolls WHERE org_id=?`).all(orgId).forEach(r => mids.add(r.material_id));
    for (const mid of mids) db.prepare(`UPDATE materials SET stock_meters=(SELECT COALESCE(SUM(remaining_meters),0) FROM material_rolls WHERE material_id=? AND status='active') WHERE id=?`).run(mid, mid);
    db.prepare(`UPDATE material_import_batches SET status='reverted', reverted_at=CURRENT_TIMESTAMP WHERE id=?`).run(batch.id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: '還原失敗：' + e.message });
  }
});

// 匯出目前庫存（含捲號）→ Tanya 拿來當母檔
router.get('/import/export', requireAuth, requireMaterials, (req, res) => {
  const orgId = req.session.user.org_id;
  const rolls = db.prepare(`
    SELECT mr.roll_no, m.brand, m.model, m.color AS material, m.fire_retardant, mr.location, m.unit_price, mr.remaining_meters
    FROM material_rolls mr JOIN materials m ON m.id=mr.material_id
    WHERE mr.org_id=? AND mr.status='active' ORDER BY m.brand, m.model, mr.roll_no
  `).all(orgId);
  const esc = v => { const s = (v == null ? '' : String(v)); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['捲號', '品牌', '型號', '材質', '是否防焰', '貨架位置', '每米含稅價', '庫存米數'];
  const lines = [head.join(',')];
  rolls.forEach(r => lines.push([r.roll_no, r.brand, r.model, r.material, r.fire_retardant ? '防焰' : '非防焰', r.location, r.unit_price, r.remaining_meters].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory_export.csv"');
  res.send('﻿' + lines.join('\n'));   // BOM 讓 Excel 正確顯示中文
});

module.exports = router;
