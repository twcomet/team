const express = require('express');
const db = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router = express.Router();

const log = (uid, action, entity, eid, detail) =>
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`).run(uid, action, entity, eid ?? null, detail ?? null);

function notifyUser(userId, msg) {
  const u = db.prepare(`SELECT line_user_id FROM users WHERE id=?`).get(userId);
  if (u?.line_user_id) pushMessage(u.line_user_id, msg).catch(() => {});
}

function notifyRole(role, msg) {
  const users = db.prepare(`SELECT line_user_id FROM users WHERE role=? AND active=1 AND line_user_id IS NOT NULL`).all(role);
  users.forEach(u => pushMessage(u.line_user_id, msg).catch(() => {}));
}

function notifyOwners(msg) {
  const owners = db.prepare(`SELECT line_user_id FROM users WHERE role='owner' AND active=1 AND line_user_id IS NOT NULL`).all();
  owners.forEach(u => pushMessage(u.line_user_id, msg).catch(() => {}));
}

// ── LIFF 端點（LINE access_token 驗證，不需 session）────────────
async function verifyLiff(access_token) {
  try {
    const r = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!r.ok) return null;
    const profile = await r.json();
    return db.prepare(`SELECT id, name, role, org_id FROM users WHERE line_user_id=? AND active=1`).get(profile.userId);
  } catch { return null; }
}

// LIFF：驗證身份
router.post('/liff/me', async (req, res) => {
  const user = await verifyLiff(req.body?.access_token);
  if (!user) return res.status(401).json({ error: '無法驗證 LINE 身份，請確認已綁定系統帳號' });
  res.json({ id: user.id, name: user.name });
});

// LIFF：取得費用科目
router.post('/liff/categories', async (req, res) => {
  const user = await verifyLiff(req.body?.access_token);
  if (!user) return res.status(401).json({ error: '無法驗證 LINE 身份，請確認已綁定系統帳號' });
  res.json(db.prepare(`SELECT * FROM expense_categories WHERE active=1 ORDER BY sort_order, id`).all());
});

// LIFF：取得我的近期申請（最新20筆）
router.post('/liff/list', async (req, res) => {
  const user = await verifyLiff(req.body?.access_token);
  if (!user) return res.status(401).json({ error: '無法驗證 LINE 身份' });
  const list = db.prepare(`
    SELECT r.id, r.expense_date, r.amount, r.description, r.status,
           ec.name as category_name
    FROM expense_requests r
    LEFT JOIN expense_categories ec ON r.category_id = ec.id
    WHERE r.user_id = ?
    ORDER BY r.expense_date DESC, r.id DESC
    LIMIT 20
  `).all(user.id);
  res.json(list);
});

// LIFF：送出費用申請（建立草稿並立即送出）
router.post('/liff/submit', async (req, res) => {
  const user = await verifyLiff(req.body?.access_token);
  if (!user) return res.status(401).json({ error: '無法驗證 LINE 身份' });

  const { expense_date, category_id, amount, description } = req.body;
  if (!expense_date || !category_id || !amount) return res.status(400).json({ error: '請填寫日期、科目與金額' });
  if (Number(amount) <= 0) return res.status(400).json({ error: '金額必須大於 0' });

  // 建立草稿
  const ins = db.prepare(`
    INSERT INTO expense_requests (user_id, org_id, expense_date, category_id, amount, description, case_id, status)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'draft')
  `).run(user.id, user.org_id || null, expense_date, category_id, Number(amount), description || null);
  const expenseId = ins.lastInsertRowid;

  // 找審核人（店長或直送老闆）
  const mgr = user.org_id
    ? db.prepare(`SELECT * FROM users WHERE org_id=? AND role='branch_manager' AND active=1 LIMIT 1`).get(user.org_id)
    : null;
  const newStatus = mgr ? 'submitted' : 'mgr_approved';

  db.prepare(`UPDATE expense_requests SET status=?, mgr_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(newStatus, mgr?.id || null, expenseId);

  const cat = db.prepare(`SELECT name FROM expense_categories WHERE id=?`).get(category_id);
  const msg = `【費用申請通知】\n${user.name} 申請費用報銷\n科目：${cat?.name || ''}\n金額：$${Number(amount).toLocaleString()}\n日期：${expense_date}\n說明：${description || '無'}`;

  if (mgr) {
    notifyUser(mgr.id, msg + `\n\n請至系統審核`);
  } else {
    notifyOwners(msg + `\n\n（無所屬店長，直接送至您審核）`);
  }

  res.json({ ok: true, id: expenseId });
});

// ── 一般 session 端點 ─────────────────────────────────────────────
// 取得費用科目
router.get('/categories', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM expense_categories WHERE active=1 ORDER BY sort_order, id`).all());
});

// 取得費用申請清單
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { status, month, user_id } = req.query;
  const isOwner = me.role === 'owner';
  const isMgr = ['branch_manager','hq_cs_manager'].includes(me.role);
  const isAccounting = me.role === 'hq_accounting';

  let sql = `
    SELECT r.*, u.name as user_name, u.org_id as user_org_id,
           ec.name as category_name,
           c.case_number, c.title as case_title,
           o.name as org_name,
           mgr.name as mgr_name
    FROM expense_requests r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN expense_categories ec ON r.category_id = ec.id
    LEFT JOIN cases c ON r.case_id = c.id
    LEFT JOIN orgs o ON r.org_id = o.id
    LEFT JOIN users mgr ON r.mgr_id = mgr.id
    WHERE 1=1
  `;
  const params = [];

  if (!isOwner && !isAccounting) {
    if (isMgr) {
      // 店長只看自己店的
      sql += ` AND u.org_id = ?`; params.push(me.org_id);
    } else {
      // 一般員工只看自己的
      sql += ` AND r.user_id = ?`; params.push(me.id);
    }
  }
  if (status) { sql += ` AND r.status = ?`; params.push(status); }
  if (month)  { sql += ` AND strftime('%Y-%m', r.expense_date) = ?`; params.push(month); }
  if (user_id && (isOwner || isAccounting)) { sql += ` AND r.user_id = ?`; params.push(user_id); }

  sql += ` ORDER BY r.expense_date DESC, r.id DESC`;
  res.json(db.prepare(sql).all(...params));
});

// 建立費用申請（草稿）
router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { expense_date, category_id, amount, description, case_id } = req.body;
  if (!expense_date || !category_id || !amount) return res.status(400).json({ error: '請填寫日期、科目與金額' });
  const r = db.prepare(`
    INSERT INTO expense_requests (user_id, org_id, expense_date, category_id, amount, description, case_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(me.id, me.org_id || null, expense_date, category_id, Number(amount), description || null, case_id || null);
  log(me.id, 'create', 'expense', r.lastInsertRowid, `${expense_date} $${amount}`);
  res.json({ id: r.lastInsertRowid });
});

// 送出申請
router.patch('/:id/submit', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM expense_requests WHERE id=? AND user_id=?`).get(req.params.id, me.id);
  if (!r) return res.status(404).json({ error: '找不到申請' });
  if (!['draft','rejected'].includes(r.status)) return res.status(400).json({ error: '此申請無法送出' });

  // 找審核人：有所屬店長先給店長，否則直接給owner
  const mgr = me.org_id
    ? db.prepare(`SELECT * FROM users WHERE org_id=? AND role='branch_manager' AND active=1 LIMIT 1`).get(me.org_id)
    : null;

  const newStatus = mgr ? 'submitted' : 'mgr_approved';
  db.prepare(`UPDATE expense_requests SET status=?, mgr_id=?, reject_reason=NULL, rejected_by=NULL, rejected_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(newStatus, mgr?.id || null, r.id);

  const cat = db.prepare(`SELECT name FROM expense_categories WHERE id=?`).get(r.category_id);
  const msg = `【費用申請通知】\n${me.name} 申請費用報銷\n科目：${cat?.name || ''}\n金額：$${r.amount}\n日期：${r.expense_date}\n說明：${r.description || '無'}`;

  if (mgr) {
    notifyUser(mgr.id, msg + `\n\n請至系統審核`);
  } else {
    notifyOwners(msg + `\n\n（無所屬店長，直接送至您審核）`);
  }
  log(me.id, 'submit', 'expense', r.id, `送出申請`);
  res.json({ ok: true });
});

// 店長審核：核准
router.patch('/:id/mgr-approve', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!['owner','branch_manager','hq_cs_manager'].includes(me.role)) return res.status(403).json({ error: '無權限' });
  const r = db.prepare(`SELECT * FROM expense_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'submitted') return res.status(400).json({ error: '此申請無法審核' });

  db.prepare(`UPDATE expense_requests SET status='mgr_approved', mgr_id=?, mgr_action_at=CURRENT_TIMESTAMP, mgr_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, req.body.note || null, r.id);

  const cat = db.prepare(`SELECT name FROM expense_categories WHERE id=?`).get(r.category_id);
  const applicant = db.prepare(`SELECT name FROM users WHERE id=?`).get(r.user_id);
  notifyOwners(`【費用申請待審】\n${applicant?.name} 的費用申請已由店長核准\n科目：${cat?.name}\n金額：$${r.amount}\n請至系統進行審核`);
  log(me.id, 'mgr_approve', 'expense', r.id, `店長核准`);
  res.json({ ok: true });
});

// 店長審核：退回
router.patch('/:id/mgr-reject', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!['owner','branch_manager','hq_cs_manager'].includes(me.role)) return res.status(403).json({ error: '無權限' });
  const r = db.prepare(`SELECT * FROM expense_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'submitted') return res.status(400).json({ error: '此申請無法退回' });
  const reason = req.body.reason || '';

  db.prepare(`UPDATE expense_requests SET status='rejected', mgr_id=?, mgr_action_at=CURRENT_TIMESTAMP, reject_reason=?, rejected_by=?, rejected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, reason, me.id, r.id);

  notifyUser(r.user_id, `【費用申請退回】\n您的費用申請已被退回\n金額：$${r.amount}\n退回原因：${reason || '未填寫'}\n請至系統修改後重新送出`);
  log(me.id, 'mgr_reject', 'expense', r.id, `退回：${reason}`);
  res.json({ ok: true });
});

// Owner 審核：核准
router.patch('/:id/owner-approve', requireOwner, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM expense_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'mgr_approved') return res.status(400).json({ error: '此申請無法審核' });

  db.prepare(`UPDATE expense_requests SET status='owner_approved', owner_action_at=CURRENT_TIMESTAMP, owner_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.body.note || null, r.id);

  // 通知會計
  const cat = db.prepare(`SELECT name FROM expense_categories WHERE id=?`).get(r.category_id);
  const applicant = db.prepare(`SELECT name FROM users WHERE id=?`).get(r.user_id);
  notifyRole('hq_accounting', `【費用申請待付款】\n${applicant?.name} 的費用申請已由老闆核准\n科目：${cat?.name}\n金額：$${r.amount}\n請至系統費用管理進行月結付款`);
  log(me.id, 'owner_approve', 'expense', r.id, `Owner核准`);
  res.json({ ok: true });
});

// Owner 審核：退回
router.patch('/:id/owner-reject', requireOwner, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM expense_requests WHERE id=?`).get(req.params.id);
  if (!r || r.status !== 'mgr_approved') return res.status(400).json({ error: '此申請無法退回' });
  const reason = req.body.reason || '';

  db.prepare(`UPDATE expense_requests SET status='rejected', owner_action_at=CURRENT_TIMESTAMP, reject_reason=?, rejected_by=?, rejected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(reason, me.id, r.id);

  notifyUser(r.user_id, `【費用申請退回】\n您的費用申請已被老闆退回\n金額：$${r.amount}\n退回原因：${reason || '未填寫'}\n請至系統修改後重新送出`);
  log(me.id, 'owner_reject', 'expense', r.id, `退回：${reason}`);
  res.json({ ok: true });
});

// 月結：查看待付款清單
router.get('/pending-settlement', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!['owner','hq_accounting'].includes(me.role)) return res.status(403).json({ error: '無權限' });
  const { month } = req.query;
  let sql = `
    SELECT r.*, u.name as user_name, ec.name as category_name,
           c.case_number, c.title as case_title
    FROM expense_requests r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN expense_categories ec ON r.category_id = ec.id
    LEFT JOIN cases c ON r.case_id = c.id
    WHERE r.status = 'owner_approved'
  `;
  const params = [];
  if (month) { sql += ` AND strftime('%Y-%m', r.expense_date) = ?`; params.push(month); }
  sql += ` ORDER BY u.name, r.expense_date`;
  res.json(db.prepare(sql).all(...params));
});

// 月結：執行結算
router.post('/settle', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!['owner','hq_accounting'].includes(me.role)) return res.status(403).json({ error: '無權限' });
  const { month, ids, payment_method, notes } = req.body;
  if (!month || !ids?.length) return res.status(400).json({ error: '請選擇月份與申請項目' });

  const placeholders = ids.map(() => '?').join(',');
  const requests = db.prepare(`SELECT * FROM expense_requests WHERE id IN (${placeholders}) AND status='owner_approved'`).all(...ids);
  if (!requests.length) return res.status(400).json({ error: '沒有符合的待付款項目' });

  const total = requests.reduce((s, r) => s + r.amount, 0);

  // 建立月結記錄
  const settlement = db.prepare(`
    INSERT INTO expense_settlements (month, total_amount, request_count, settled_by, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(month, total, requests.length, me.id, notes || null);
  const settlementId = settlement.lastInsertRowid;

  // 找或建流水帳科目「員工費用報銷」
  let ledgerCat = db.prepare(`SELECT id FROM ledger_categories WHERE name='員工費用報銷' AND section='expense' LIMIT 1`).get();
  if (!ledgerCat) {
    const ins = db.prepare(`INSERT INTO ledger_categories (type, section, name, sort_order) VALUES ('expense','expense','員工費用報銷',99)`).run();
    ledgerCat = { id: ins.lastInsertRowid };
  }

  // 建立流水帳分錄
  const ledger = db.prepare(`
    INSERT INTO ledger_entries (date, type, category, amount, description, created_by)
    VALUES (?, 'expense', ?, ?, ?, ?)
  `).run(
    new Date().toISOString().slice(0,10),
    '員工費用報銷',
    total,
    `${month} 員工費用報銷（${requests.length}筆）${notes ? ' - ' + notes : ''}`,
    me.id
  );
  const ledgerEntryId = ledger.lastInsertRowid;

  // 更新月結記錄的 ledger_entry_id
  db.prepare(`UPDATE expense_settlements SET ledger_entry_id=? WHERE id=?`).run(ledgerEntryId, settlementId);

  // 更新所有申請狀態
  db.prepare(`UPDATE expense_requests SET status='settled', settlement_id=?, settled_at=CURRENT_TIMESTAMP, settled_by=?, ledger_entry_id=? WHERE id IN (${placeholders})`)
    .run(settlementId, me.id, ledgerEntryId, ...ids);

  // 通知每位申請人
  const userIds = [...new Set(requests.map(r => r.user_id))];
  userIds.forEach(uid => {
    const userReqs = requests.filter(r => r.user_id === uid);
    const userTotal = userReqs.reduce((s, r) => s + r.amount, 0);
    notifyUser(uid, `【費用報銷已匯款】\n${month} 費用報銷已完成匯款\n本次共 ${userReqs.length} 筆，合計 $${userTotal.toLocaleString()}\n付款方式：${payment_method || '—'}`);
  });

  log(me.id, 'settle', 'expense', settlementId, `${month} 月結 ${requests.length}筆 $${total}`);
  res.json({ ok: true, settlement_id: settlementId, total, count: requests.length });
});

// 取得單筆明細
router.get('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`
    SELECT r.*, u.name as user_name, ec.name as category_name,
           c.case_number, c.title as case_title, o.name as org_name,
           mgr.name as mgr_name, rb.name as rejected_by_name, sb.name as settled_by_name
    FROM expense_requests r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN expense_categories ec ON r.category_id = ec.id
    LEFT JOIN cases c ON r.case_id = c.id
    LEFT JOIN orgs o ON r.org_id = o.id
    LEFT JOIN users mgr ON r.mgr_id = mgr.id
    LEFT JOIN users rb ON r.rejected_by = rb.id
    LEFT JOIN users sb ON r.settled_by = sb.id
    WHERE r.id=?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  const isOwner = me.role === 'owner';
  const isAccounting = me.role === 'hq_accounting';
  const isMine = r.user_id === me.id;
  const isMgr = ['branch_manager','hq_cs_manager'].includes(me.role);
  if (!isOwner && !isAccounting && !isMine && !isMgr) return res.status(403).json({ error: '無權限' });
  res.json(r);
});

// 刪除草稿或被退回的申請
router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM expense_requests WHERE id=? AND user_id=?`).get(req.params.id, me.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  if (!['draft','rejected'].includes(r.status)) return res.status(400).json({ error: '此申請無法刪除' });
  db.prepare(`DELETE FROM expense_requests WHERE id=?`).run(r.id);
  res.json({ ok: true });
});

// 更新草稿或被退回的申請
router.put('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  const r = db.prepare(`SELECT * FROM expense_requests WHERE id=? AND user_id=?`).get(req.params.id, me.id);
  if (!r) return res.status(404).json({ error: '找不到' });
  if (!['draft','rejected'].includes(r.status)) return res.status(400).json({ error: '此申請無法修改' });
  const { expense_date, category_id, amount, description, case_id } = req.body;
  db.prepare(`UPDATE expense_requests SET expense_date=?, category_id=?, amount=?, description=?, case_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(expense_date, category_id, Number(amount), description || null, case_id || null, r.id);
  res.json({ ok: true });
});

module.exports = router;
