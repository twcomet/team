const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function canManage(user) {
  return user.role === 'owner' || !!user.can_manage_assets;
}

// 已入流水帳（到貨稅金/運費已產生 ledger 紀錄）
function poInLedger(poId) {
  const refs = db.prepare(`SELECT id FROM purchase_receipts WHERE purchase_order_id=?`).all(poId)
    .flatMap(r => [`receipt_${r.id}_tax`, `receipt_${r.id}_shipping`]);
  if (!refs.length) return false;
  const ph = refs.map(() => '?').join(',');
  return !!db.prepare(`SELECT 1 FROM ledger_entries WHERE source_ref IN (${ph}) LIMIT 1`).get(...refs);
}
// 已入流水帳者，編輯/刪除限老闆+會計
function ledgerLocked(req, res, po) {
  if (poInLedger(po.id) && !['owner', 'hq_accounting'].includes(req.session.user.role)) {
    res.status(403).json({ error: '此採購單已入流水帳，僅老闆或會計可編輯／刪除' });
    return true;
  }
  return false;
}

// 同步該案「採購到貨稅金」加總 → cases.purchase_tax_cost（計入案件成本/毛利）
function syncCasePurchaseTax(caseId) {
  if (!caseId) return;
  const row = db.prepare(`
    SELECT COALESCE(SUM(pr.tax),0) AS tax
    FROM purchase_receipts pr
    JOIN purchase_orders po ON po.id = pr.purchase_order_id
    WHERE po.case_id = ?
  `).get(caseId);
  const total = row.tax || 0;
  db.prepare(`UPDATE cases SET purchase_tax_cost=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(total > 0 ? total : null, caseId);
}

// 單筆到貨稅金 → 收支流水帳（費用·稅費，零用金/付款人）；稅金為0或無則移除該筆
function syncReceiptTaxLedger(receiptId) {
  const r = db.prepare(`
    SELECT pr.id, pr.tax, pr.received_date, pr.payment_method, pr.created_by, pr.payer_id,
           po.case_id, po.org_id, c.case_number, c.title, pu.name AS payer_name
    FROM purchase_receipts pr
    JOIN purchase_orders po ON po.id = pr.purchase_order_id
    LEFT JOIN cases c  ON c.id  = po.case_id
    LEFT JOIN users pu ON pu.id = pr.payer_id
    WHERE pr.id = ?
  `).get(receiptId);
  if (!r) return;
  const ref = `receipt_${receiptId}_tax`;
  if (!r.tax || r.tax <= 0) {
    db.prepare(`DELETE FROM ledger_entries WHERE source_ref=?`).run(ref);
    return;
  }
  const date = r.received_date || new Date().toISOString().slice(0, 10);
  const payVia = r.payment_method || '零用金';
  const who = r.payer_name ? `／${r.payer_name}` : '';
  const caseLabel = r.case_number ? `｜${r.case_number} ${r.title || ''}`.trim() : '';
  const desc = `材料到貨稅金${caseLabel}（${payVia}${who}）`;
  const existing = db.prepare(`SELECT id FROM ledger_entries WHERE source_ref=?`).get(ref);
  if (existing) {
    db.prepare(`UPDATE ledger_entries SET date=?, amount=?, category='稅費', description=?, case_id=?, org_id=?, created_by=? WHERE id=?`)
      .run(date, r.tax, desc, r.case_id || null, r.org_id || null, r.created_by || null, existing.id);
  } else {
    db.prepare(`INSERT INTO ledger_entries (date, type, category, amount, case_id, description, org_id, created_by, source_ref, review_status) VALUES (?, 'expense', '稅費', ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(date, r.tax, r.case_id || null, desc, r.org_id || null, r.created_by || null, ref);
  }
}

// 同步該案「採購到貨運費」加總 → cases.purchase_shipping_cost（計入案件成本/毛利，比照稅金）
function syncCasePurchaseShipping(caseId) {
  if (!caseId) return;
  const row = db.prepare(`
    SELECT COALESCE(SUM(pr.shipping_fee),0) AS fee
    FROM purchase_receipts pr
    JOIN purchase_orders po ON po.id = pr.purchase_order_id
    WHERE po.case_id = ?
  `).get(caseId);
  const total = row.fee || 0;
  db.prepare(`UPDATE cases SET purchase_shipping_cost=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(total > 0 ? total : null, caseId);
}

// 單筆到貨運費 → 收支流水帳（費用·運費）；運費為0或無則移除該筆（比照稅金）
function syncReceiptShippingLedger(receiptId) {
  const r = db.prepare(`
    SELECT pr.id, pr.shipping_fee, pr.received_date, pr.payment_method, pr.created_by, pr.payer_id,
           po.case_id, po.org_id, c.case_number, c.title, pu.name AS payer_name
    FROM purchase_receipts pr
    JOIN purchase_orders po ON po.id = pr.purchase_order_id
    LEFT JOIN cases c  ON c.id  = po.case_id
    LEFT JOIN users pu ON pu.id = pr.payer_id
    WHERE pr.id = ?
  `).get(receiptId);
  if (!r) return;
  const ref = `receipt_${receiptId}_shipping`;
  if (!r.shipping_fee || r.shipping_fee <= 0) {
    db.prepare(`DELETE FROM ledger_entries WHERE source_ref=?`).run(ref);
    return;
  }
  const date = r.received_date || new Date().toISOString().slice(0, 10);
  const payVia = r.payment_method || '零用金';
  const who = r.payer_name ? `／${r.payer_name}` : '';
  const caseLabel = r.case_number ? `｜${r.case_number} ${r.title || ''}`.trim() : '';
  const desc = `材料到貨運費${caseLabel}（${payVia}${who}）`;
  const existing = db.prepare(`SELECT id FROM ledger_entries WHERE source_ref=?`).get(ref);
  if (existing) {
    db.prepare(`UPDATE ledger_entries SET date=?, amount=?, category='費用-運費', description=?, case_id=?, org_id=?, created_by=? WHERE id=?`)
      .run(date, r.shipping_fee, desc, r.case_id || null, r.org_id || null, r.created_by || null, existing.id);
  } else {
    db.prepare(`INSERT INTO ledger_entries (date, type, category, amount, case_id, description, org_id, created_by, source_ref, review_status) VALUES (?, 'expense', '費用-運費', ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(date, r.shipping_fee, r.case_id || null, desc, r.org_id || null, r.created_by || null, ref);
  }
}

const SHIPPING_LABEL = { air:'空運', express:'快遞', sea:'海運', domestic:'國內' };
const STATUS_LABEL   = { pending:'待到貨', partial:'部分到貨', received:'已到齊', cancelled:'已取消' };

// ── 採購單 ────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, org_id } = req.query;
  let sql = `
    SELECT po.*, m.brand as mat_brand, m.model as mat_model, m.color as mat_color,
           v.name as vendor_name, u.name as created_by_name, o.name as org_name,
           uo.name as ordered_by_name,
           c.case_number as case_number, c.title as case_title, cl.name as client_name,
           COALESCE(SUM(pr.quantity_meters),0) as received_meters,
           COALESCE(SUM(pr.tax),0) as total_tax,
           COALESCE(SUM(pr.shipping_fee),0) as total_shipping_fee,
           (SELECT u2.name FROM purchase_receipts pr2 LEFT JOIN users u2 ON u2.id=pr2.created_by
            WHERE pr2.purchase_order_id=po.id ORDER BY pr2.received_date DESC, pr2.id DESC LIMIT 1) as receiver_name,
           (SELECT pr3.carrier FROM purchase_receipts pr3 WHERE pr3.purchase_order_id=po.id AND pr3.carrier IS NOT NULL ORDER BY pr3.received_date DESC, pr3.id DESC LIMIT 1) as carrier,
           (SELECT pr4.payment_method FROM purchase_receipts pr4 WHERE pr4.purchase_order_id=po.id AND pr4.payment_method IS NOT NULL ORDER BY pr4.received_date DESC, pr4.id DESC LIMIT 1) as payment_method,
           (SELECT MAX(pr5.received_date) FROM purchase_receipts pr5 WHERE pr5.purchase_order_id=po.id) as last_received_date
    FROM purchase_orders po
    LEFT JOIN materials m ON m.id=po.material_id
    LEFT JOIN vendors v ON v.id=po.vendor_id
    LEFT JOIN users u ON u.id=po.created_by
    LEFT JOIN users uo ON uo.id=po.ordered_by
    LEFT JOIN orgs o ON o.id=po.org_id
    LEFT JOIN cases c ON c.id=po.case_id
    LEFT JOIN clients cl ON cl.id=c.client_id
    LEFT JOIN purchase_receipts pr ON pr.purchase_order_id=po.id
    WHERE 1=1
  `;
  const params = [];
  if (me.role !== 'owner') { sql += ` AND po.org_id=?`; params.push(me.org_id); }
  else if (org_id)         { sql += ` AND po.org_id=?`; params.push(org_id); }
  if (status) { sql += ` AND po.status=?`; params.push(status); }
  sql += ` GROUP BY po.id ORDER BY po.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const po = db.prepare(`
    SELECT po.*, m.brand as mat_brand, m.model as mat_model, m.color as mat_color,
           v.name as vendor_name, u.name as created_by_name, o.name as org_name,
           c.case_number as case_number, c.title as case_title
    FROM purchase_orders po
    LEFT JOIN materials m ON m.id=po.material_id
    LEFT JOIN vendors v ON v.id=po.vendor_id
    LEFT JOIN users u ON u.id=po.created_by
    LEFT JOIN orgs o ON o.id=po.org_id
    LEFT JOIN cases c ON c.id=po.case_id
    WHERE po.id=?
  `).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  if (me.role !== 'owner' && po.org_id !== me.org_id) return res.status(403).json({ error: '無權限' });
  po.receipts = db.prepare(`
    SELECT pr.*, u.name as created_by_name
    FROM purchase_receipts pr LEFT JOIN users u ON u.id=pr.created_by
    WHERE pr.purchase_order_id=? ORDER BY pr.received_date
  `).all(po.id);
  res.json(po);
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const { material_id, vendor_id, brand, series_code, quantity_meters,
          unit_cost, shipping_type, shipping_cost, expected_date, notes, org_id, case_id, ordered_by, width_cm } = req.body;
  if (!quantity_meters || quantity_meters <= 0) return res.status(400).json({ error: '請填入採購米數' });
  const targetOrg = me.role === 'owner' ? (org_id || me.org_id) : me.org_id;
  const total_cost = (parseFloat(unit_cost)||0) * parseFloat(quantity_meters) + (parseFloat(shipping_cost)||0);
  const r = db.prepare(`
    INSERT INTO purchase_orders (org_id,material_id,vendor_id,brand,series_code,width_cm,quantity_meters,
      unit_cost,total_cost,shipping_type,shipping_cost,expected_date,notes,created_by,case_id,ordered_by,order_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')
  `).run(targetOrg, material_id||null, vendor_id||null, brand||null, series_code||null, width_cm!=null&&width_cm!==''?parseFloat(width_cm):null,
         parseFloat(quantity_meters), parseFloat(unit_cost)||0, total_cost,
         shipping_type||'domestic', parseFloat(shipping_cost)||0,
         expected_date||null, notes||null, me.id, case_id||null, ordered_by||null);
  // 通知訂貨人
  if (ordered_by) notifyOrderer(r.lastInsertRowid, ordered_by, me.name, brand, series_code, quantity_meters);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// 通知被指派的訂貨人
function notifyOrderer(poId, orderedBy, byName, brand, series, qty) {
  try {
    const label = `${brand || ''}${series ? ' '+series : ''} ${qty}米`.trim();
    db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url)
      VALUES (?,?,?,'purchase','purchase_orders',?, '/purchases')`)
      .run(orderedBy, `🛒 採購單待訂貨：${label}`, `${byName} 指派你訂貨，請確認後回報「已訂貨」。`, poId);
  } catch (_) {}
}

router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  if (me.role !== 'owner' && po.org_id !== me.org_id) return res.status(403).json({ error: '無權限' });
  if (ledgerLocked(req, res, po)) return;
  const { material_id, vendor_id, brand, series_code, quantity_meters,
          unit_cost, shipping_type, shipping_cost, expected_date, notes, status, case_id, ordered_by, width_cm } = req.body;
  const total_cost = (parseFloat(unit_cost)||0) * parseFloat(quantity_meters||po.quantity_meters) + (parseFloat(shipping_cost)||0);
  const newOrderedBy = ordered_by !== undefined ? (ordered_by || null) : po.ordered_by;
  const newWidth = width_cm !== undefined ? (width_cm!=null&&width_cm!==''?parseFloat(width_cm):null) : po.width_cm;
  db.prepare(`UPDATE purchase_orders SET material_id=?,vendor_id=?,brand=?,series_code=?,width_cm=?,quantity_meters=?,
    unit_cost=?,total_cost=?,shipping_type=?,shipping_cost=?,expected_date=?,notes=?,status=?,case_id=?,ordered_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(material_id||null, vendor_id||null, brand||null, series_code||null, newWidth,
         parseFloat(quantity_meters||po.quantity_meters), parseFloat(unit_cost)||0, total_cost,
         shipping_type||'domestic', parseFloat(shipping_cost)||0,
         expected_date||null, notes||null, status||po.status, case_id !== undefined ? (case_id||null) : po.case_id, newOrderedBy, po.id);
  // 改派了新訂貨人（且尚未訂貨）→ 通知新的人
  if (newOrderedBy && String(newOrderedBy) !== String(po.ordered_by || '') && po.order_status !== 'ordered') {
    notifyOrderer(po.id, newOrderedBy, me.name, brand, series_code, quantity_meters || po.quantity_meters);
  }
  // 若改了關聯案件，重算稅金成本並更新到貨稅金流水帳的案件歸屬
  const newCaseId = case_id !== undefined ? (case_id || null) : po.case_id;
  if (String(newCaseId || '') !== String(po.case_id || '')) {
    db.prepare(`SELECT id FROM purchase_receipts WHERE purchase_order_id=?`).all(po.id)
      .forEach(r => { syncReceiptTaxLedger(r.id); syncReceiptShippingLedger(r.id); });
    syncCasePurchaseTax(po.case_id);
    syncCasePurchaseTax(newCaseId);
    syncCasePurchaseShipping(po.case_id);
    syncCasePurchaseShipping(newCaseId);
  }
  res.json({ ok: true });
});

// PATCH /:id/confirm-order — 訂貨人確認「已訂貨」
router.patch('/:id/confirm-order', requireAuth, (req, res) => {
  const me = req.session.user;
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  // 限被指派的訂貨人本人，或管理者
  const isManager = me.role === 'owner' || !!me.manage_users || !!me.can_manage_assets;
  if (String(po.ordered_by || '') !== String(me.id) && !isManager) {
    return res.status(403).json({ error: '只有被指派的訂貨人或管理者可以確認' });
  }
  db.prepare(`UPDATE purchase_orders SET order_status='ordered', ordered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(po.id);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  if (me.role !== 'owner' && po.org_id !== me.org_id) return res.status(403).json({ error: '無權限' });
  if (ledgerLocked(req, res, po)) return;
  if (po.status === 'cancelled') return res.status(400).json({ error: '採購單已取消' });

  // 待到貨：無到貨、無庫存 → 直接軟取消
  if (po.status === 'pending') {
    db.prepare(`UPDATE purchase_orders SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(po.id);
    return res.json({ ok: true });
  }

  // 已到齊／部分到貨：反向處理已建立的膜料卷與庫存；該卷必須完全未被使用
  const receipts = db.prepare(`SELECT * FROM purchase_receipts WHERE purchase_order_id=?`).all(po.id);
  const rollIds = receipts.map(r => r.material_roll_id).filter(Boolean);
  for (const rid of rollIds) {
    const roll = db.prepare(`SELECT initial_meters, remaining_meters FROM material_rolls WHERE id=?`).get(rid);
    if (!roll) continue;
    const usedLogs = db.prepare(`SELECT COUNT(*) n FROM material_logs WHERE roll_id=? AND log_type!='purchase'`).get(rid).n;
    if (usedLogs > 0 || Math.abs((roll.remaining_meters||0) - (roll.initial_meters||0)) > 1e-6) {
      return res.status(400).json({ error: '此採購單到貨的膜料卷已被使用，無法刪除，請先處理相關使用紀錄' });
    }
  }
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN');
  try {
    for (const rid of rollIds) {
      const roll = db.prepare(`SELECT material_id, initial_meters FROM material_rolls WHERE id=?`).get(rid);
      if (roll) {
        db.prepare(`UPDATE materials SET stock_meters = MAX(0, stock_meters - ?) WHERE id=?`).run(roll.initial_meters||0, roll.material_id);
        db.prepare(`DELETE FROM material_logs WHERE roll_id=?`).run(rid);
        db.prepare(`DELETE FROM material_rolls WHERE id=?`).run(rid);
      }
    }
    // 移除這些到貨稅金/運費在流水帳的對應紀錄
    for (const r of receipts) {
      db.prepare(`DELETE FROM ledger_entries WHERE source_ref=?`).run(`receipt_${r.id}_tax`);
      db.prepare(`DELETE FROM ledger_entries WHERE source_ref=?`).run(`receipt_${r.id}_shipping`);
    }
    db.prepare(`DELETE FROM purchase_receipts WHERE purchase_order_id=?`).run(po.id);
    db.prepare(`DELETE FROM purchase_orders WHERE id=?`).run(po.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: e.message });
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
  syncCasePurchaseTax(po.case_id);       // 重算該案稅金成本
  syncCasePurchaseShipping(po.case_id);  // 重算該案運費成本
  res.json({ ok: true });
});

// ── 收貨紀錄 ──────────────────────────────────────────────────────

router.post('/:id/receipts', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  if (['received','cancelled'].includes(po.status)) return res.status(400).json({ error: '此採購單無法新增收貨' });

  const { received_date, quantity_meters, batch_note, carrier, tax, shipping_fee, payment_method, payer_id } = req.body;
  if (!received_date || !quantity_meters || quantity_meters <= 0) return res.status(400).json({ error: '請填入收貨日期與米數' });

  // 建立新膜料卷
  let rollId = null;
  if (po.material_id) {
    const roll = db.prepare(`
      INSERT INTO material_rolls (material_id, org_id, initial_meters, remaining_meters, purchase_date, unit_cost, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(po.material_id, po.org_id, parseFloat(quantity_meters), parseFloat(quantity_meters),
           received_date, po.unit_cost, batch_note||null, me.id);
    rollId = roll.lastInsertRowid;

    // 寫入膜料流水帳
    db.prepare(`INSERT INTO material_logs (roll_id,material_id,org_id,log_type,meters,notes,logged_by) VALUES (?,?,?,?,?,?,?)`)
      .run(rollId, po.material_id, po.org_id, 'purchase', parseFloat(quantity_meters), `採購單#${po.id} 到貨${batch_note ? ' - '+batch_note : ''}`, me.id);
  }

  // 建立收貨紀錄
  const recRes = db.prepare(`INSERT INTO purchase_receipts (purchase_order_id,material_roll_id,received_date,quantity_meters,batch_note,carrier,tax,shipping_fee,payment_method,payer_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(po.id, rollId, received_date, parseFloat(quantity_meters), batch_note||null,
         carrier||null, tax!=null&&tax!==''?parseFloat(tax):null, shipping_fee!=null&&shipping_fee!==''?parseFloat(shipping_fee):null, payment_method||null,
         payer_id!=null&&payer_id!==''?Number(payer_id):null, me.id);

  // 到貨稅金/運費 → 自動入流水帳＋計入案件成本（會計獨立核帳，免重複手key）
  syncReceiptTaxLedger(recRes.lastInsertRowid);
  syncReceiptShippingLedger(recRes.lastInsertRowid);
  syncCasePurchaseTax(po.case_id);
  syncCasePurchaseShipping(po.case_id);

  // 更新採購單狀態
  const totalReceived = db.prepare(`SELECT COALESCE(SUM(quantity_meters),0) as total FROM purchase_receipts WHERE purchase_order_id=?`).get(po.id).total;
  const newStatus = totalReceived >= po.quantity_meters ? 'received' : 'partial';
  db.prepare(`UPDATE purchase_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(newStatus, po.id);

  res.json({ ok: true, roll_id: rollId, new_status: newStatus, total_received: totalReceived });
});

// 編輯到貨紀錄（修正運費/稅金/送貨/付款等；不改米數，避免動到庫存）→ 重新同步流水帳與案件成本
// 🔒 已入帳資料，僅老闆+會計可編輯（避免他人改動已入帳內容卻未經會計審核）
router.put('/:id/receipts/:receiptId', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!['owner', 'hq_accounting'].includes(me.role)) return res.status(403).json({ error: '已入帳資料僅限老闆或會計編輯' });
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  const rec = db.prepare(`SELECT * FROM purchase_receipts WHERE id=? AND purchase_order_id=?`).get(req.params.receiptId, po.id);
  if (!rec) return res.status(404).json({ error: '找不到到貨紀錄' });

  const { received_date, batch_note, carrier, tax, shipping_fee, payment_method, payer_id } = req.body;
  db.prepare(`
    UPDATE purchase_receipts
    SET received_date=?, batch_note=?, carrier=?, tax=?, shipping_fee=?, payment_method=?, payer_id=?
    WHERE id=?`)
    .run(received_date || rec.received_date, batch_note ?? rec.batch_note, carrier || null,
         tax != null && tax !== '' ? parseFloat(tax) : null,
         shipping_fee != null && shipping_fee !== '' ? parseFloat(shipping_fee) : null,
         payment_method || null, payer_id != null && payer_id !== '' ? Number(payer_id) : null,
         rec.id);

  // 同步更新流水帳（稅金/運費）與案件成本
  syncReceiptTaxLedger(rec.id);
  syncReceiptShippingLedger(rec.id);
  syncCasePurchaseTax(po.case_id);
  syncCasePurchaseShipping(po.case_id);
  res.json({ ok: true });
});

// POST /:id/convert-to-stock — 轉庫存：把未綁型號的採購單已到貨數量，轉成物料庫存
router.post('/:id/convert-to-stock', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  if (me.role !== 'owner' && po.org_id !== me.org_id) return res.status(403).json({ error: '無權限' });

  const receipts = db.prepare(`SELECT * FROM purchase_receipts WHERE purchase_order_id=?`).all(po.id);
  if (!receipts.length) return res.status(400).json({ error: '此採購單尚無到貨紀錄，無法轉庫存' });
  const pending = receipts.filter(r => !r.material_roll_id);
  if (!pending.length) return res.status(400).json({ error: '此採購單到貨已全部入庫，無需轉庫存' });

  const { material_id, new_material, meters } = req.body;
  let matId = material_id ? Number(material_id) : (po.material_id || null);

  // 轉入總米數：預設＝各待入庫到貨批次米數總和；使用者可覆寫。
  // 為保留「一到貨批次＝一捲」結構（刪除回退依此逐捲扣庫存），覆寫的總數按各批原始米數等比例分攤；
  // 單一批次（最常見）時即精確等於輸入值。
  const defaultTotal = pending.reduce((s, r) => s + (parseFloat(r.quantity_meters) || 0), 0);
  const targetTotal  = (meters != null && meters !== '' && parseFloat(meters) > 0) ? parseFloat(meters) : defaultTotal;
  const scale = defaultTotal > 0 ? (targetTotal / defaultTotal) : 0;

  try {
    db.exec('BEGIN');
    // 需要新建型號
    if (!matId) {
      const nm = new_material || {};
      if (!nm.brand || !nm.model) throw new Error('請選擇既有型號，或填寫新型號的品牌與型號');
      const safeCost = me.can_see_cost ? (parseFloat(nm.unit_cost) || parseFloat(po.unit_cost) || 0) : 0;
      const ins = db.prepare(`INSERT INTO materials (org_id, brand, model, color, location, unit_cost, unit_price, stock_meters, category, fire_retardant, width_cm, on_ecommerce) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`)
        .run(po.org_id, String(nm.brand).trim(), String(nm.model).trim(), nm.color || null, nm.location || null,
             safeCost, parseFloat(nm.unit_price) || 0, nm.category || 'film',
             Number(nm.fire_retardant) ? 1 : 0, parseFloat(nm.width_cm) || po.width_cm || 122, Number(nm.on_ecommerce) ? 1 : 0);
      matId = ins.lastInsertRowid;
      db.prepare(`INSERT INTO material_change_logs (material_id, org_id, action, detail, changed_by) VALUES (?, ?, 'create', ?, ?)`)
        .run(matId, po.org_id, `採購單#${po.id} 轉庫存新增型號：${nm.brand} ${nm.model}`, me.id);
    }
    // 回綁採購單到該型號
    if (po.material_id !== matId) db.prepare(`UPDATE purchase_orders SET material_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(matId, po.id);
    // 為每筆尚未入庫的到貨建捲料 + 進貨流水 + 加庫存
    const orgName = db.prepare(`SELECT name FROM orgs WHERE id=?`).get(po.org_id)?.name || '總部';
    const mat = db.prepare(`SELECT brand, model FROM materials WHERE id=?`).get(matId) || {};
    const cleanModel = s => String(s || '').replace(/[（(][^）)]*[)）]/g, '').trim();
    let seq = db.prepare(`SELECT COUNT(*) c FROM material_rolls WHERE material_id=?`).get(matId).c;
    let totalMeters = 0; const rollIds = [];
    const lastIdx = pending.length - 1;
    for (let i = 0; i < pending.length; i++) {
      const rc = pending[i];
      const raw = parseFloat(rc.quantity_meters) || 0;
      // 等比例分攤；最後一批用「目標總數 − 已分攤」補足，避免浮點誤差累積
      let m = defaultTotal > 0 ? Math.round(raw * scale * 100) / 100 : Math.round((targetTotal / pending.length) * 100) / 100;
      if (i === lastIdx) m = Math.round((targetTotal - totalMeters) * 100) / 100;
      if (m < 0) m = 0;
      // 每支料自動給獨立捲號：品牌-型號-到貨日-序號
      const dateCode = String(rc.received_date || '').replace(/-/g, '') || 'NA';
      const rollNo = `${mat.brand || ''}-${cleanModel(mat.model)}-${dateCode}-${String(++seq).padStart(2, '0')}`;
      const roll = db.prepare(`INSERT INTO material_rolls (material_id, org_id, roll_no, initial_meters, remaining_meters, purchase_date, unit_cost, branch, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(matId, po.org_id, rollNo, m, m, rc.received_date, po.unit_cost || 0, orgName, `採購單#${po.id} 轉庫存`, me.id);
      db.prepare(`UPDATE purchase_receipts SET material_roll_id=? WHERE id=?`).run(roll.lastInsertRowid, rc.id);
      db.prepare(`INSERT INTO material_logs (roll_id, material_id, org_id, log_type, meters, notes, logged_by) VALUES (?,?,?,'purchase',?,?,?)`)
        .run(roll.lastInsertRowid, matId, po.org_id, m, `採購單#${po.id} 轉庫存`, me.id);
      db.prepare(`UPDATE materials SET stock_meters = stock_meters + ? WHERE id=?`).run(m, matId);
      totalMeters += m; rollIds.push(roll.lastInsertRowid);
    }
    db.exec('COMMIT');
    res.json({ ok: true, material_id: matId, rolls: rollIds.length, meters: Math.round(totalMeters * 100) / 100 });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: '轉庫存失敗：' + e.message });
  }
});

module.exports = router;
module.exports.SHIPPING_LABEL = SHIPPING_LABEL;
module.exports.STATUS_LABEL   = STATUS_LABEL;
