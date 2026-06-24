const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function canManage(user) {
  return user.role === 'owner' || !!user.can_manage_assets;
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
          unit_cost, shipping_type, shipping_cost, expected_date, notes, org_id, case_id, ordered_by } = req.body;
  if (!quantity_meters || quantity_meters <= 0) return res.status(400).json({ error: '請填入採購米數' });
  const targetOrg = me.role === 'owner' ? (org_id || me.org_id) : me.org_id;
  const total_cost = (parseFloat(unit_cost)||0) * parseFloat(quantity_meters) + (parseFloat(shipping_cost)||0);
  const r = db.prepare(`
    INSERT INTO purchase_orders (org_id,material_id,vendor_id,brand,series_code,quantity_meters,
      unit_cost,total_cost,shipping_type,shipping_cost,expected_date,notes,created_by,case_id,ordered_by,order_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')
  `).run(targetOrg, material_id||null, vendor_id||null, brand||null, series_code||null,
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
  const { material_id, vendor_id, brand, series_code, quantity_meters,
          unit_cost, shipping_type, shipping_cost, expected_date, notes, status, case_id, ordered_by } = req.body;
  const total_cost = (parseFloat(unit_cost)||0) * parseFloat(quantity_meters||po.quantity_meters) + (parseFloat(shipping_cost)||0);
  const newOrderedBy = ordered_by !== undefined ? (ordered_by || null) : po.ordered_by;
  db.prepare(`UPDATE purchase_orders SET material_id=?,vendor_id=?,brand=?,series_code=?,quantity_meters=?,
    unit_cost=?,total_cost=?,shipping_type=?,shipping_cost=?,expected_date=?,notes=?,status=?,case_id=?,ordered_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(material_id||null, vendor_id||null, brand||null, series_code||null,
         parseFloat(quantity_meters||po.quantity_meters), parseFloat(unit_cost)||0, total_cost,
         shipping_type||'domestic', parseFloat(shipping_cost)||0,
         expected_date||null, notes||null, status||po.status, case_id !== undefined ? (case_id||null) : po.case_id, newOrderedBy, po.id);
  // 改派了新訂貨人（且尚未訂貨）→ 通知新的人
  if (newOrderedBy && String(newOrderedBy) !== String(po.ordered_by || '') && po.order_status !== 'ordered') {
    notifyOrderer(po.id, newOrderedBy, me.name, brand, series_code, quantity_meters || po.quantity_meters);
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
    db.prepare(`DELETE FROM purchase_receipts WHERE purchase_order_id=?`).run(po.id);
    db.prepare(`DELETE FROM purchase_orders WHERE id=?`).run(po.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: e.message });
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
  res.json({ ok: true });
});

// ── 收貨紀錄 ──────────────────────────────────────────────────────

router.post('/:id/receipts', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無權限' });
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(req.params.id);
  if (!po) return res.status(404).json({ error: '找不到採購單' });
  if (['received','cancelled'].includes(po.status)) return res.status(400).json({ error: '此採購單無法新增收貨' });

  const { received_date, quantity_meters, batch_note, carrier, tax, shipping_fee, payment_method } = req.body;
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
  db.prepare(`INSERT INTO purchase_receipts (purchase_order_id,material_roll_id,received_date,quantity_meters,batch_note,carrier,tax,shipping_fee,payment_method,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(po.id, rollId, received_date, parseFloat(quantity_meters), batch_note||null,
         carrier||null, tax!=null&&tax!==''?parseFloat(tax):null, shipping_fee!=null&&shipping_fee!==''?parseFloat(shipping_fee):null, payment_method||null, me.id);

  // 更新採購單狀態
  const totalReceived = db.prepare(`SELECT COALESCE(SUM(quantity_meters),0) as total FROM purchase_receipts WHERE purchase_order_id=?`).get(po.id).total;
  const newStatus = totalReceived >= po.quantity_meters ? 'received' : 'partial';
  db.prepare(`UPDATE purchase_orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(newStatus, po.id);

  res.json({ ok: true, roll_id: rollId, new_status: newStatus, total_received: totalReceived });
});

module.exports = router;
module.exports.SHIPPING_LABEL = SHIPPING_LABEL;
module.exports.STATUS_LABEL   = STATUS_LABEL;
