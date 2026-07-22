const express = require('express');
const crypto  = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

function genToken() { return crypto.randomBytes(16).toString('hex'); }

// 可管理驗收單（清單/解鎖重簽）：老闆／主管／副總／客服／會計
function canManage(u) {
  if (!u) return false;
  return u.role === 'owner' || u.manage_users || ['vp','hq_cs','hq_cs_manager','hq_accounting'].includes(u.role);
}

// 從案件最新報價單帶施工項目（有照片一起帶）；查無報價單則回空陣列（師傅手寫）
function seedItemsFromQuote(caseId) {
  const qs = db.prepare(`SELECT id FROM quote_sheets WHERE case_id=? ORDER BY version DESC, id DESC LIMIT 1`).get(caseId);
  if (!qs) return [];
  const rows = db.prepare(`SELECT description, material_photo_url, area_photo_url, area_photos, row_kind
    FROM quote_sheet_items WHERE quote_id=? ORDER BY sort_order, id`).all(qs.id);
  return rows.filter(r => (r.description || '').trim()).map(r => {
    let photo = r.material_photo_url || r.area_photo_url || '';
    if (!photo) { try { const a = JSON.parse(r.area_photos || '[]'); if (a && a[0]) photo = a[0]; } catch (e) {} }
    return { name: (r.description || '').trim(), checked: false, photo: photo || '', note: '' };
  });
}

// 取得或建立某案件的驗收單（精簡版：一案一張，從案件詳情開啟）
router.get('/case/:caseId', requireAuth, (req, res) => {
  const cid = Number(req.params.caseId);
  const c = db.prepare(`SELECT id, org_id FROM cases WHERE id=?`).get(cid);
  if (!c) return res.status(404).json({ error: '找不到案件' });
  let form = db.prepare(`SELECT * FROM acceptance_forms WHERE case_id=? ORDER BY id DESC LIMIT 1`).get(cid);
  if (!form) {
    const token = genToken();
    const items = JSON.stringify(seedItemsFromQuote(cid));
    const info = db.prepare(`INSERT INTO acceptance_forms (case_id, org_id, share_token, status, items_json, opened_by)
      VALUES (?, ?, ?, 'draft', ?, ?)`).run(cid, c.org_id || null, token, items, req.session.user.id);
    form = db.prepare(`SELECT * FROM acceptance_forms WHERE id=?`).get(info.lastInsertRowid);
  }
  res.json(hydrate(form));
});

// 師傅開啟：取得或建立某派工的驗收單
router.get('/dispatch/:dispatchId', requireAuth, (req, res) => {
  const did = Number(req.params.dispatchId);
  const disp = db.prepare(`SELECT id, case_id FROM dispatches WHERE id=?`).get(did);
  if (!disp) return res.status(404).json({ error: '找不到派工' });
  let form = db.prepare(`SELECT * FROM acceptance_forms WHERE dispatch_id=?`).get(did);
  if (!form) {
    const orgId = db.prepare(`SELECT org_id FROM cases WHERE id=?`).get(disp.case_id)?.org_id || null;
    const token = genToken();
    const items = JSON.stringify(seedItemsFromQuote(disp.case_id));
    const info = db.prepare(`INSERT INTO acceptance_forms (case_id, dispatch_id, org_id, share_token, status, items_json, opened_by)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)`).run(disp.case_id, did, orgId, token, items, req.session.user.id);
    form = db.prepare(`SELECT * FROM acceptance_forms WHERE id=?`).get(info.lastInsertRowid);
  }
  res.json(hydrate(form));
});

// 貼膜須知範本（公開，供簽署頁「師傅勾選貼什麼→自動帶須知」）：取 (b)貼膜前須知，依類別分組
// 註：必須放在 GET /:id 之前，否則會被當成 id 攔截
router.get('/notice-templates', (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, name, category, content FROM film_notice_templates
      WHERE active=1 AND COALESCE(block,'notice')='notice' AND TRIM(COALESCE(content,''))<>'' ORDER BY category, sort_order, id`).all();
    res.json(rows);
  } catch (e) { res.json([]); }
});

// 取單一驗收單（師傅檢視/編輯）
router.get('/:id', requireAuth, (req, res) => {
  const form = db.prepare(`SELECT * FROM acceptance_forms WHERE id=?`).get(req.params.id);
  if (!form) return res.status(404).json({ error: '找不到驗收單' });
  res.json(hydrate(form));
});

// 師傅儲存（施工項目打勾/照片/客戶須知）；已回簽且未解鎖不可改
router.put('/:id', requireAuth, (req, res) => {
  const form = db.prepare(`SELECT * FROM acceptance_forms WHERE id=?`).get(req.params.id);
  if (!form) return res.status(404).json({ error: '找不到驗收單' });
  if (form.status === 'signed') return res.status(400).json({ error: '已回簽的驗收單不可修改，如需重簽請通知客服解鎖' });
  const b = req.body || {};
  db.prepare(`UPDATE acceptance_forms SET items_json=?, notice_content=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(typeof b.items === 'string' ? b.items : JSON.stringify(b.items || []), b.notice_content ?? form.notice_content, req.params.id);
  res.json({ ok: true });
});

// 客戶版資料（公開，免登入）
router.get('/sign/:token', (req, res) => {
  const form = db.prepare(`
    SELECT af.*, c.title AS case_title, c.case_number, c.location,
           cl.name AS client_name, cl.phone AS client_phone,
           o.name AS org_name, o.tax_id AS org_tax_id, o.address AS org_address, o.phone AS org_phone
    FROM acceptance_forms af
    JOIN cases c ON c.id = af.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN orgs o ON o.id = af.org_id
    WHERE af.share_token = ?`).get(req.params.token);
  if (!form) return res.status(404).json({ error: '找不到驗收單' });
  form.org_name = form.org_name || '繪新國際有限公司';
  form.org_tax_id = form.org_tax_id || '45917816';
  form.org_address = form.org_address || '新北市鶯歌區中山路166巷2號';
  form.org_phone = form.org_phone || '02-8678-1229';
  res.json(hydrate(form));
});

// 師傅在簽署頁編輯（公開，token 保護；已回簽不可改）
router.put('/sign/:token', (req, res) => {
  const form = db.prepare(`SELECT id, status FROM acceptance_forms WHERE share_token=?`).get(req.params.token);
  if (!form) return res.status(404).json({ error: '找不到驗收單' });
  if (form.status === 'signed') return res.status(400).json({ error: '已回簽不可修改，如需重簽請通知客服解鎖' });
  const b = req.body || {};
  db.prepare(`UPDATE acceptance_forms SET items_json=?, notice_content=?, updated_at=CURRENT_TIMESTAMP WHERE share_token=?`)
    .run(typeof b.items === 'string' ? b.items : JSON.stringify(b.items || []), b.notice_content ?? '', req.params.token);
  res.json({ ok: true });
});

// 客戶簽名（公開）
router.post('/sign/:token', (req, res) => {
  const form = db.prepare(`SELECT id, status FROM acceptance_forms WHERE share_token=?`).get(req.params.token);
  if (!form) return res.status(404).json({ error: '找不到驗收單' });
  if (form.status === 'signed') return res.json({ ok: true, already: true });
  const { signature, confirm, staff_id, items, notice_content } = req.body || {};
  if (!signature) return res.status(400).json({ error: '請先簽名' });
  const itemsJson = items != null ? (typeof items === 'string' ? items : JSON.stringify(items)) : null;
  db.prepare(`UPDATE acceptance_forms SET status='signed', client_signature=?, client_signed_at=CURRENT_TIMESTAMP,
      confirm_json=?, signed_by_staff=COALESCE(?, signed_by_staff, opened_by),
      items_json=COALESCE(?, items_json), notice_content=COALESCE(?, notice_content), updated_at=CURRENT_TIMESTAMP
      WHERE share_token=?`)
    .run(signature, JSON.stringify(confirm || {}), staff_id || null, itemsJson, notice_content ?? null, req.params.token);
  res.json({ ok: true });
});

// 驗收單清單（客服/主管/會計/老闆）：只列已開啟的（已回簽 or 師傅已開啟）
router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無檢視驗收單清單權限' });
  let sql = `
    SELECT af.id, af.case_id, af.dispatch_id, af.status, af.client_signed_at, af.updated_at, af.share_token,
           c.case_number, c.title, cl.name AS client_name,
           u.name AS opened_by_name, us.name AS signed_by_name
    FROM acceptance_forms af
    JOIN cases c ON c.id = af.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users u ON u.id = af.opened_by
    LEFT JOIN users us ON us.id = af.signed_by_staff
    WHERE af.status IN ('draft','signed')`;
  const params = [];
  if (me.role !== 'owner') { sql += ` AND (c.org_id = ? OR af.org_id = ?)`; params.push(me.org_id, me.org_id); }
  sql += ` ORDER BY (af.status='signed') DESC, af.updated_at DESC LIMIT 300`;
  res.json(db.prepare(sql).all(...params));
});

// 解鎖重簽（客服/主管/會計/老闆）：清掉簽名、回 draft，記錄解鎖人
router.post('/:id/unlock', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canManage(me)) return res.status(403).json({ error: '無解鎖權限' });
  const form = db.prepare(`SELECT id, status FROM acceptance_forms WHERE id=?`).get(req.params.id);
  if (!form) return res.status(404).json({ error: '找不到驗收單' });
  db.prepare(`UPDATE acceptance_forms SET status='draft', client_signature=NULL, client_signed_at=NULL,
      unlocked_by=?, unlocked_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(me.id, req.params.id);
  res.json({ ok: true });
});

function hydrate(form) {
  let items = [], confirm = {};
  try { items = JSON.parse(form.items_json || '[]'); } catch (e) {}
  try { confirm = JSON.parse(form.confirm_json || '{}'); } catch (e) {}
  return { ...form, items, confirm };
}

module.exports = router;
