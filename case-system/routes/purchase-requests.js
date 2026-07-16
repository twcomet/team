const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router = express.Router();

// 可審核／可採購的角色（一關審核 + 採購進度更新）
const MANAGE_ROLES = ['owner', 'branch_manager', 'hq_cs_manager', 'hq_accounting'];
const isManager = role => MANAGE_ROLES.includes(role);

const STATUS_NAMES = {
  draft: '草稿', submitted: '待審核', approved: '待採購',
  purchasing: '採購中', received: '已到貨', rejected: '已退回',
};

const log = (uid, action, eid, detail) =>
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?, 'purchase_request', ?, ?)`)
    .run(uid, action, eid ?? null, detail ?? null);

function notifyUser(userId, msg) {
  const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(userId);
  if (u?.line_user_id) pushMessage(u.line_user_id, msg).catch(() => {});
}

// 通知管理層：老闆＋會計恆通知；申請人所屬店長／客服主管一併通知
function notifyManagers(msg, orgId) {
  const oid = orgId ?? null;
  const rows = db.prepare(`
    SELECT DISTINCT line_user_id FROM users
    WHERE active=1 AND line_user_id IS NOT NULL
      AND ( role='owner' OR role='hq_accounting'
            OR ( (role='branch_manager' OR role='hq_cs_manager') AND (? IS NULL OR org_id = ?) ) )
  `).all(oid, oid);
  rows.forEach(u => pushMessage(u.line_user_id, msg).catch(() => {}));
}

// 品項摘要文字（LINE 用）
function itemsSummary(reqId) {
  const items = db.prepare(`SELECT name, quantity, unit FROM purchase_request_items WHERE request_id=? ORDER BY sort_order,id`).all(reqId);
  if (!items.length) return '（無品項）';
  return items.map(i => `・${i.name} ×${i.quantity}${i.unit || ''}`).join('\n');
}

// 寫入品項並回算預估合計
function saveItems(reqId, items) {
  db.prepare(`DELETE FROM purchase_request_items WHERE request_id=?`).run(reqId);
  const ins = db.prepare(`INSERT INTO purchase_request_items (request_id,name,quantity,unit,est_price,note,sort_order) VALUES (?,?,?,?,?,?,?)`);
  let est = 0;
  (items || []).forEach((it, i) => {
    const name = (it.name || '').trim();
    if (!name) return;
    const qty = Number(it.quantity) || 0;
    const price = (it.est_price === '' || it.est_price == null) ? null : Number(it.est_price);
    if (price != null && !isNaN(price)) est += qty * price;
    ins.run(reqId, name, qty, it.unit || null, price, it.note || null, i);
  });
  db.prepare(`UPDATE purchase_requests SET est_total=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(est, reqId);
  return est;
}

function attachItems(rows) {
  const stmt = db.prepare(`SELECT * FROM purchase_request_items WHERE request_id=? ORDER BY sort_order,id`);
  rows.forEach(r => { r.items = stmt.all(r.id); });
  return rows;
}

// ── 清單 ──────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, scope } = req.query;
  const mgr = isManager(me.role);
  const isOwnerAcct = ['owner', 'hq_accounting'].includes(me.role);

  let sql = `
    SELECT pr.*, u.name AS user_name, u.org_id AS user_org_id,
           o.name AS org_name, rv.name AS reviewer_name, pc.name AS purchaser_name
    FROM purchase_requests pr
    LEFT JOIN users u  ON pr.user_id = u.id
    LEFT JOIN orgs  o  ON pr.org_id = o.id
    LEFT JOIN users rv ON pr.reviewer_id = rv.id
    LEFT JOIN users pc ON pr.purchaser_id = pc.id
    WHERE 1=1`;
  const params = [];

  if (scope === 'mine' || !mgr) {
    sql += ` AND pr.user_id = ?`; params.push(me.id);
  } else if (!isOwnerAcct) {
    // 店長／客服主管：只看自己店的
    sql += ` AND u.org_id = ?`; params.push(me.org_id);
  }
  if (status) {
    const st = String(status).split(',').filter(Boolean);
    if (st.length > 1) { sql += ` AND pr.status IN (${st.map(() => '?').join(',')})`; params.push(...st); }
    else if (st.length === 1) { sql += ` AND pr.status = ?`; params.push(st[0]); }
  }
  sql += ` ORDER BY pr.created_at DESC, pr.id DESC`;
  res.json(attachItems(db.prepare(sql).all(...params)));
});

// ── 單筆明細 ───────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`
    SELECT pr.*, u.name AS user_name, u.org_id AS user_org_id, o.name AS org_name,
           rv.name AS reviewer_name, pc.name AS purchaser_name, rb.name AS rejected_by_name
    FROM purchase_requests pr
    LEFT JOIN users u  ON pr.user_id = u.id
    LEFT JOIN orgs  o  ON pr.org_id = o.id
    LEFT JOIN users rv ON pr.reviewer_id = rv.id
    LEFT JOIN users pc ON pr.purchaser_id = pc.id
    LEFT JOIN users rb ON pr.rejected_by = rb.id
    WHERE pr.id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到請購單' });
  const mgr = isManager(me.role);
  const isMine = r.user_id === me.id;
  const sameOrg = ['owner', 'hq_accounting'].includes(me.role) || r.user_org_id === me.org_id;
  if (!isMine && !(mgr && sameOrg)) return res.status(403).json({ error: '無權限' });
  attachItems([r]);
  res.json(r);
});

// ── 建立（草稿，可直接送出）─────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { title, need_date, items, submit } = req.body;
  if (!Array.isArray(items) || !items.some(i => (i.name || '').trim()))
    return res.status(400).json({ error: '請至少填一項要採購的品項' });

  const ins = db.prepare(`INSERT INTO purchase_requests (org_id,user_id,title,need_date,status) VALUES (?,?,?,?, 'draft')`)
    .run(me.org_id || null, me.id, (title || '').trim() || null, need_date || null);
  const id = ins.lastInsertRowid;
  saveItems(id, items);
  log(me.id, 'create', id, title || '');

  if (submit) return doSubmit(id, me, res);
  res.json({ id });
});

// ── 更新（草稿／退回）──────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=? AND user_id=?`).get(req.params.id, me.id);
  if (!r) return res.status(404).json({ error: '找不到請購單' });
  if (!['draft', 'rejected'].includes(r.status)) return res.status(400).json({ error: '此請購單無法修改' });
  const { title, need_date, items } = req.body;
  db.prepare(`UPDATE purchase_requests SET title=?, need_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run((title || '').trim() || null, need_date || null, r.id);
  saveItems(r.id, items);
  res.json({ ok: true });
});

// ── 刪除（草稿／退回）──────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=? AND user_id=?`).get(req.params.id, me.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  if (!['draft', 'rejected'].includes(r.status)) return res.status(400).json({ error: '此請購單無法刪除' });
  db.prepare(`DELETE FROM purchase_request_items WHERE request_id=?`).run(r.id);
  db.prepare(`DELETE FROM purchase_requests WHERE id=?`).run(r.id);
  res.json({ ok: true });
});

// ── 送出 ──────────────────────────────────────────────────────
function doSubmit(id, me, res) {
  db.prepare(`UPDATE purchase_requests SET status='submitted', reject_reason=NULL, rejected_by=NULL, rejected_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=?`).get(id);
  notifyManagers(`【請購單待審核】\n${me.name} 提出請購申請\n主旨：${r.title || '（未填）'}\n${itemsSummary(id)}\n\n請至系統審核`, r.org_id);
  log(me.id, 'submit', id, '送出');
  res.json({ ok: true, id });
}
router.patch('/:id/submit', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=? AND user_id=?`).get(req.params.id, me.id);
  if (!r) return res.status(404).json({ error: '找不到請購單' });
  if (!['draft', 'rejected'].includes(r.status)) return res.status(400).json({ error: '此請購單無法送出' });
  doSubmit(r.id, me, res);
});

// ── 核准（一關）────────────────────────────────────────────────
router.patch('/:id/approve', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isManager(me.role)) return res.status(403).json({ error: '無審核權限' });
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'submitted') return res.status(400).json({ error: '此請購單無法審核' });
  db.prepare(`UPDATE purchase_requests SET status='approved', reviewer_id=?, reviewed_at=CURRENT_TIMESTAMP, review_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, req.body.note || null, r.id);
  notifyUser(r.user_id, `【請購單已核准】\n您的請購申請已核准，將進行採購\n主旨：${r.title || '（未填）'}\n${itemsSummary(r.id)}`);
  notifyManagers(`【請購單待採購】\n${db.prepare(`SELECT name FROM users WHERE id=?`).get(r.user_id)?.name} 的請購單已核准，待安排採購\n主旨：${r.title || '（未填）'}`, r.org_id);
  log(me.id, 'approve', r.id, '核准');
  res.json({ ok: true });
});

// ── 退回 ──────────────────────────────────────────────────────
router.patch('/:id/reject', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isManager(me.role)) return res.status(403).json({ error: '無審核權限' });
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'submitted') return res.status(400).json({ error: '此請購單無法退回' });
  const reason = req.body.reason || '';
  db.prepare(`UPDATE purchase_requests SET status='rejected', reviewer_id=?, reviewed_at=CURRENT_TIMESTAMP, reject_reason=?, rejected_by=?, rejected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, reason, me.id, r.id);
  notifyUser(r.user_id, `【請購單退回】\n您的請購申請已被退回\n主旨：${r.title || '（未填）'}\n退回原因：${reason || '未填寫'}\n請至系統修改後重新送出`);
  log(me.id, 'reject', r.id, `退回：${reason}`);
  res.json({ ok: true });
});

// ── 標記採購中 ─────────────────────────────────────────────────
router.patch('/:id/purchasing', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isManager(me.role)) return res.status(403).json({ error: '無權限' });
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'approved') return res.status(400).json({ error: '此請購單無法標記採購中' });
  db.prepare(`UPDATE purchase_requests SET status='purchasing', purchaser_id=?, purchasing_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, r.id);
  notifyUser(r.user_id, `【請購單採購中】\n您的請購項目已在採購中\n主旨：${r.title || '（未填）'}`);
  log(me.id, 'purchasing', r.id, '採購中');
  res.json({ ok: true });
});

// ── 標記已到貨（可補實際單價）──────────────────────────────────
router.patch('/:id/receive', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isManager(me.role)) return res.status(403).json({ error: '無權限' });
  const r = db.prepare(`SELECT * FROM purchase_requests WHERE id=?`).get(req.params.id);
  if (!r || !['approved', 'purchasing'].includes(r.status)) return res.status(400).json({ error: '此請購單無法標記到貨' });

  // 補實際單價（選填）
  const priceMap = {};
  (req.body.items || []).forEach(it => { if (it.id != null) priceMap[it.id] = it.actual_price; });
  const items = db.prepare(`SELECT * FROM purchase_request_items WHERE request_id=?`).all(r.id);
  const upd = db.prepare(`UPDATE purchase_request_items SET actual_price=? WHERE id=?`);
  let actualTotal = 0;
  items.forEach(it => {
    let price = it.actual_price;
    if (Object.prototype.hasOwnProperty.call(priceMap, it.id)) {
      const v = priceMap[it.id];
      price = (v === '' || v == null) ? null : Number(v);
      upd.run(price, it.id);
    }
    if (price != null && !isNaN(price)) actualTotal += (Number(it.quantity) || 0) * price;
  });

  db.prepare(`UPDATE purchase_requests SET status='received', purchaser_id=COALESCE(purchaser_id,?), received_at=CURRENT_TIMESTAMP, actual_total=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, actualTotal, r.id);
  notifyUser(r.user_id, `【請購單已到貨】\n您的請購項目已到貨\n主旨：${r.title || '（未填）'}\n${itemsSummary(r.id)}`);
  log(me.id, 'receive', r.id, `到貨 實際$${actualTotal}`);
  res.json({ ok: true, actual_total: actualTotal });
});

module.exports = router;
