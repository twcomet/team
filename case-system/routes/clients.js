const express = require('express');
const multer  = require('multer');
const db = require('../db');
const { requireAuth, orgFilterSQL } = require('../middleware/auth');
const { createBindToken, buildBindLink, channelForClient, bindDeepLink } = require('../lib/client-bind');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 輕量搜尋（給 autocomplete 用）
router.get('/search', requireAuth, (req, res) => {
  const me = req.session.user;
  const { q } = req.query;
  if (!q) return res.json([]);
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const like = `%${q}%`;
  // 修正：clients 無 contact 欄位(正確欄名為 contact_person)，舊查詢引用 c.contact 會 SQL 報錯→搜尋全壞
  const where = [`(c.name LIKE ? OR c.phone LIKE ? OR c.contact_person LIKE ? OR c.contact_mobile LIKE ? OR c.contact_phone LIKE ?)`];
  const params = [like, like, like, like, like, ...orgPs];
  if (orgSql) where.push(orgSql);
  const rows = db.prepare(`
    SELECT c.id, c.name, c.phone, c.contact_person AS contact FROM clients c
    WHERE ${where.join(' AND ')}
    ORDER BY c.name ASC LIMIT 20
  `).all(...params);
  res.json(rows);
});

// 報價單「儲存並建檔」：建立或更新客戶主檔，並把該案件連到此客戶（一步到位）
router.post('/upsert-for-case', requireAuth, (req, res) => {
  const me = req.session.user;
  const { case_id, client_id, name, tax_id, contact_person, contact_phone, address } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '請填客戶／公司名稱' });
  const nm = String(name).trim();
  let id = client_id ? Number(client_id) : null;
  if (id) {
    db.prepare(`UPDATE clients SET name=?, tax_id=?, contact_person=?, contact_phone=?, phone=COALESCE(NULLIF(?,''),phone), address=COALESCE(NULLIF(?,''),address) WHERE id=?`)
      .run(nm, tax_id || null, contact_person || null, contact_phone || null, contact_phone || '', address || '', id);
  } else {
    const r = db.prepare(`INSERT INTO clients (org_id, name, tax_id, contact_person, contact_phone, phone, address, created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(me.org_id, nm, tax_id || null, contact_person || null, contact_phone || null, contact_phone || null, address || null, me.id);
    id = r.lastInsertRowid;
  }
  if (case_id) db.prepare(`UPDATE cases SET client_id=? WHERE id=?`).run(id, case_id);
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(me.id, client_id ? 'update' : 'create', 'clients', id, `報價單建檔客戶：${nm}`);
  res.json({ ok: true, id, name: nm });
});

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const clients = db.prepare(`
      SELECT c.*, o.name AS org_name, cc.name AS category_name, cc.discount_rate AS category_discount, cb.name AS created_by_name,
        (SELECT COUNT(*) FROM cases cs WHERE cs.client_id=c.id
          AND cs.status IN ('contracted','payment','closed')
          AND cs.created_at >= datetime('now','-1 year')) AS orders_last_year,
        (SELECT COALESCE(SUM(cs.final_price),0) FROM cases cs WHERE cs.client_id=c.id
          AND cs.status IN ('contracted','payment','closed')) AS total_revenue,
        (SELECT GROUP_CONCAT(t.id||'|'||t.name||'|'||t.color)
          FROM client_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.client_id=c.id) AS tags_csv
      FROM clients c
      LEFT JOIN orgs o ON c.org_id = o.id
      LEFT JOIN client_categories cc ON cc.id = c.category_id
      LEFT JOIN users cb ON cb.id = c.created_by
      ${orgSql ? `WHERE ${orgSql}` : ''}
      ORDER BY c.created_at DESC
    `).all(...orgPs);
  clients.forEach(c => {
    c.tags = c.tags_csv
      ? c.tags_csv.split(',').map(s => { const [id,name,color]=s.split('|'); return {id:+id,name,color}; })
      : [];
    delete c.tags_csv;
  });
  res.json(clients);
});

// ── 名片 OCR ──────────────────────────────────────────────────
router.post('/ocr-card', requireAuth, upload.single('card'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請上傳圖片' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '未設定 ANTHROPIC_API_KEY' });

  const b64 = req.file.buffer.toString('base64');
  const mime = req.file.mimetype || 'image/jpeg';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
            { type: 'text', text: `這是一張名片圖片。請辨識名片上的資訊，只回傳以下 JSON 格式（找不到的填 null），不要任何說明文字：
{"name":null,"contact_person":null,"phone":null,"email":null,"address":null,"tax_id":null,"title":null}` }
          ]
        }]
      })
    });
    const apiData = await resp.json();
    // Anthropic API 本身回傳錯誤
    if (!resp.ok || apiData.type === 'error') {
      const msg = apiData.error?.message || `API 錯誤 ${resp.status}`;
      return res.status(500).json({ error: `辨識服務錯誤：${msg}` });
    }
    require('../lib/ai-usage').logUsage(db, { feature: 'client_ocr_card', userId: req.session.user?.id, model: 'claude-haiku-4-5-20251001', data: apiData });
    const text = apiData.content?.[0]?.text?.trim() || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      // Claude 說明無法辨識（圖片不是名片等）
      const hint = text.length > 0 ? `（${text.slice(0, 60)}）` : '';
      return res.status(422).json({ error: `圖片中找不到名片資訊，請確認上傳的是名片照片${hint}` });
    }
    const parsed = JSON.parse(match[0]);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { name, phone, email, address, source, discount, notes,
          tax_id, contact_person, capital, einvoice_code,
          client_level, payment_terms, discount_terms, referrer, line_group_name, category_id,
          invoice_email, invoice_needs, invoice_title,
          contact_phone, contact_mobile, company_address } = req.body;
  if (!name) return res.status(400).json({ error: '請填入客戶姓名' });
  const result = db.prepare(`
    INSERT INTO clients (org_id, name, phone, email, address, source, discount, notes, created_by,
      tax_id, contact_person, capital, einvoice_code, client_level, payment_terms, discount_terms, referrer, line_group_name, category_id,
      invoice_email, invoice_needs, invoice_title, contact_phone, contact_mobile, company_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(me.org_id, name, phone ?? null, email ?? null, address ?? null,
         source ?? null, discount ?? 1.0, notes ?? null, me.id,
         tax_id ?? null, contact_person ?? null, capital ?? null, einvoice_code ?? null,
         client_level ?? null, payment_terms ?? null, discount_terms ?? null, referrer ?? null,
         line_group_name ?? null, category_id ?? null,
         invoice_email ?? null, invoice_needs ?? null, invoice_title ?? null,
         contact_phone ?? null, contact_mobile ?? null, company_address ?? null);
  const uid = req.session.user.id;
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(uid, 'create', 'clients', result.lastInsertRowid, `新增客戶：${name}`);
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/:id', requireAuth, (req, res) => {
  const { name, phone, email, address, source, discount, notes,
          tax_id, contact_person, capital, einvoice_code,
          client_level, payment_terms, discount_terms, referrer, line_group_name, category_id,
          invoice_email, invoice_needs, invoice_title,
          contact_phone, contact_mobile, company_address } = req.body;
  db.prepare(`UPDATE clients SET name=?, phone=?, email=?, address=?, source=?, discount=?, notes=?,
    tax_id=?, contact_person=?, capital=?, einvoice_code=?, client_level=?, payment_terms=?, discount_terms=?, referrer=?, line_group_name=?, category_id=?,
    invoice_email=?, invoice_needs=?, invoice_title=?, contact_phone=?, contact_mobile=?, company_address=?
    WHERE id=?`)
    .run(name, phone ?? null, email ?? null, address ?? null, source ?? null, discount ?? 1.0, notes ?? null,
         tax_id ?? null, contact_person ?? null, capital ?? null, einvoice_code ?? null,
         client_level ?? null, payment_terms ?? null, discount_terms ?? null, referrer ?? null,
         line_group_name ?? null, category_id ?? null,
         invoice_email ?? null, invoice_needs ?? null, invoice_title ?? null,
         contact_phone ?? null, contact_mobile ?? null, company_address ?? null,
         req.params.id);
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(req.session.user.id, 'update', 'clients', req.params.id, `更新客戶：${name}`);
  res.json({ ok: true });
});

// 「重要客戶」＝有任何案件（進行中/結案/歷史）或任何金流（預收款）→ 非老闆不可直接刪，須申請審核
function clientImportant(id) {
  const r = db.prepare(`SELECT
    (SELECT COUNT(*) FROM cases WHERE client_id=?) AS cases,
    (SELECT COUNT(*) FROM client_deposits WHERE client_id=?) AS deps`).get(id, id);
  return (r.cases > 0) || (r.deps > 0);
}
function notifyOwners(title, body, url, entityId) {
  const owners = db.prepare(`SELECT id FROM users WHERE role='owner' AND active=1`).all();
  const ins = db.prepare(`INSERT INTO notifications (user_id, title, body, type, entity, entity_id, url) VALUES (?,?,?,'deletion','deletion_requests',?,?)`);
  for (const o of owners) ins.run(o.id, title, body, entityId || null, url || null);
}
const canReviewDeletion = (me) => me.role === 'owner';   // 刪除審核：只有老闆

// 刪除申請清單（審核頁用）— 老闆/主管
router.get('/deletion-requests', requireAuth, (req, res) => {
  if (!canReviewDeletion(req.session.user)) return res.status(403).json({ error: '無審核權限' });
  const rows = db.prepare(`
    SELECT dr.*, u.name AS requested_by_name, du.name AS decided_by_name,
           (SELECT COUNT(*) FROM cases WHERE client_id=dr.entity_id) AS case_count
    FROM deletion_requests dr
    LEFT JOIN users u  ON u.id = dr.requested_by
    LEFT JOIN users du ON du.id = dr.decided_by
    WHERE dr.entity='clients'
    ORDER BY (dr.status='pending') DESC, dr.id DESC LIMIT 200
  `).all();
  res.json(rows);
});

// 核准刪除申請 → 執行刪除 — 老闆/主管
router.post('/deletion-requests/:reqId/approve', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canReviewDeletion(me)) return res.status(403).json({ error: '無審核權限' });
  const dr = db.prepare(`SELECT * FROM deletion_requests WHERE id=? AND status='pending'`).get(req.params.reqId);
  if (!dr) return res.status(404).json({ error: '找不到待審申請（可能已處理）' });
  db.prepare(`DELETE FROM clients WHERE id=?`).run(dr.entity_id);
  db.prepare(`UPDATE deletion_requests SET status='approved', decided_by=?, decided_at=CURRENT_TIMESTAMP WHERE id=?`).run(me.id, dr.id);
  if (dr.requested_by) db.prepare(`INSERT INTO notifications (user_id, title, body, type) VALUES (?,?,?,'deletion')`)
    .run(dr.requested_by, `刪除已核准：${dr.entity_label || ''}`, `您申請刪除的客戶「${dr.entity_label || ''}」已由 ${me.name} 核准並刪除。`);
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(me.id, 'delete', 'clients', dr.entity_id, `核准刪除客戶：${dr.entity_label || ''}（申請人 ${dr.requested_by_name || dr.requested_by || ''}）`);
  res.json({ ok: true });
});

// 駁回刪除申請 — 老闆/主管
router.post('/deletion-requests/:reqId/reject', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!canReviewDeletion(me)) return res.status(403).json({ error: '無審核權限' });
  const dr = db.prepare(`SELECT * FROM deletion_requests WHERE id=? AND status='pending'`).get(req.params.reqId);
  if (!dr) return res.status(404).json({ error: '找不到待審申請（可能已處理）' });
  const note = (req.body?.note || '').trim() || null;
  db.prepare(`UPDATE deletion_requests SET status='rejected', decided_by=?, decided_at=CURRENT_TIMESTAMP, decide_note=? WHERE id=?`).run(me.id, note, dr.id);
  if (dr.requested_by) db.prepare(`INSERT INTO notifications (user_id, title, body, type) VALUES (?,?,?,'deletion')`)
    .run(dr.requested_by, `刪除申請被駁回：${dr.entity_label || ''}`, `您申請刪除客戶「${dr.entity_label || ''}」已被 ${me.name} 駁回。${note ? '\n原因：'+note : ''}`);
  res.json({ ok: true });
});

// 客服申請刪除重要客戶（不直接刪，送審）
router.post('/:id/request-deletion', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.manage_users && !me.can_delete) return res.status(403).json({ error: '無刪除權限' });
  const client = db.prepare(`SELECT id, name FROM clients WHERE id=?`).get(req.params.id);
  if (!client) return res.status(404).json({ error: '找不到客戶' });
  const existing = db.prepare(`SELECT id FROM deletion_requests WHERE entity='clients' AND entity_id=? AND status='pending'`).get(client.id);
  if (existing) return res.json({ ok: true, already: true });
  const reason = (req.body?.reason || '').trim() || null;
  const r = db.prepare(`INSERT INTO deletion_requests (entity, entity_id, entity_label, reason, requested_by) VALUES ('clients',?,?,?,?)`)
    .run(client.id, client.name, reason, me.id);
  notifyOwners(`刪除申請：${client.name}`, `${me.name} 申請刪除客戶「${client.name}」${reason ? '\n原因：'+reason : ''}`, '/deletion-requests', r.lastInsertRowid);
  res.json({ ok: true, request_id: r.lastInsertRowid });
});

router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && !me.manage_users && !me.can_delete) return res.status(403).json({ error: '無刪除權限' });
  const client = db.prepare(`SELECT id, name FROM clients WHERE id=?`).get(req.params.id);
  if (!client) return res.status(404).json({ error: '找不到客戶' });
  const isOwner = me.role === 'owner';
  // 重要客戶（有案件/金流/成交/回簽）：只有老闆能直接刪；主管/客服須走「申請刪除」由老闆審核
  if (clientImportant(client.id) && !isOwner)
    return res.status(403).json({ error: '此客戶有案件或金流資料，請改用「申請刪除」由老闆審核', need_request: true });
  db.prepare(`DELETE FROM clients WHERE id=?`).run(client.id);
  // 若有待審申請，一併標記為已核准
  db.prepare(`UPDATE deletion_requests SET status='approved', decided_by=?, decided_at=CURRENT_TIMESTAMP WHERE entity='clients' AND entity_id=? AND status='pending'`).run(me.id, client.id);
  res.json({ ok: true });
});

router.get('/:id', requireAuth, (req, res) => {
  const c = db.prepare(`
    SELECT cl.*, o.name AS org_name, cc.name AS category_name, cc.discount_rate AS category_discount,
      lc.channel_name AS line_channel_name,
      (SELECT GROUP_CONCAT(t.id||'|'||t.name||'|'||t.color)
        FROM client_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.client_id=cl.id) AS tags_csv
    FROM clients cl
    LEFT JOIN orgs o ON cl.org_id = o.id
    LEFT JOIN client_categories cc ON cc.id = cl.category_id
    LEFT JOIN line_channels lc ON lc.id = cl.line_channel_id
    WHERE cl.id = ?
  `).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  c.tags = c.tags_csv
    ? c.tags_csv.split(',').map(s => { const [id,name,color]=s.split('|'); return {id:+id,name,color}; })
    : [];
  delete c.tags_csv;

  // 統計資料
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_cases,
      COUNT(CASE WHEN status NOT IN ('invalid','closed') THEN 1 END) AS active_cases,
      COUNT(CASE WHEN status = 'inquiry' OR status LIKE 'inquiry%' THEN 1 END) AS inquiry_count,
      COUNT(CASE WHEN status IN ('contracted','payment','closed') THEN 1 END) AS deal_count,
      COALESCE(SUM(CASE WHEN status IN ('contracted','payment','closed') THEN final_price END), 0) AS deal_total,
      COUNT(CASE WHEN status IN ('contracted','payment','closed')
                  AND contracted_at >= date('now','-1 year') THEN 1 END) AS deal_last_year,
      COALESCE(SUM(CASE WHEN status IN ('contracted','payment','closed')
                        AND contracted_at >= date('now','-1 year') THEN final_price END), 0) AS revenue_last_year,
      MAX(contracted_at) AS last_deal_at,
      MIN(created_at) AS first_case_at
    FROM cases WHERE client_id = ?
  `).get(req.params.id);

  // 刪除保護：重要客戶（有案件/金流）非老闆/主管須申請；帶出是否已有待審申請
  const is_important = clientImportant(c.id);
  const pending = db.prepare(`SELECT dr.id, dr.requested_at, u.name AS requested_by_name, dr.reason
    FROM deletion_requests dr LEFT JOIN users u ON u.id=dr.requested_by
    WHERE dr.entity='clients' AND dr.entity_id=? AND dr.status='pending' ORDER BY dr.id DESC LIMIT 1`).get(c.id) || null;
  res.json({ ...c, stats, is_important, pending_deletion: pending });
});

router.get('/:id/cases', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.final_price, c.payment_status,
           c.scheduled_date, c.created_at, c.contracted_at, c.location AS address
    FROM cases c WHERE c.client_id = ? ORDER BY c.created_at DESC
  `).all(req.params.id);
  res.json(cases);
});

// ── LINE 綁定：產生綁定連結（客服在客戶詳情頁按）─────────────────
// 產一組新碼、作廢該客戶其他未使用的舊碼；回傳可分享連結。
// 有 basic_id 的 OA → 回一鍵深連結；否則回中轉頁 /bind/:code。
router.post('/:id/bind-link', requireAuth, (req, res) => {
  const me = req.session.user;
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(req.params.id);
  if (!client) return res.status(404).json({ error: '找不到客戶' });

  const code = createBindToken(client.id, client.org_id || me.org_id || null, me.id);
  if (!code) return res.status(500).json({ error: '產生綁定碼失敗，請重試' });

  const proto  = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const origin = `${proto}://${req.get('host')}`;
  const info = buildBindLink(client, code, origin);
  res.json({ code, ...info, expires_days: 30 });   // link / deep_link / page_url / via / oa_name
});

// ── LINE 綁定：中轉頁用（免登入，讀綁定碼狀態＋深連結）───────────
router.get('/bind-info/:code', (req, res) => {
  const token = db.prepare(`SELECT * FROM client_bind_tokens WHERE code=?`).get(req.params.code);
  if (!token)          return res.json({ ok: false, reason: 'notfound' });
  if (token.used_at)   return res.json({ ok: false, reason: 'used' });
  if (token.expires_at && db.prepare(`SELECT datetime(?) < datetime('now') AS x`).get(token.expires_at).x)
    return res.json({ ok: false, reason: 'expired' });
  const client = db.prepare(`SELECT id, name, org_id, line_channel_id FROM clients WHERE id=?`).get(token.client_id);
  if (!client)         return res.json({ ok: false, reason: 'notfound' });
  const ch = channelForClient(client);
  res.json({
    ok: true,
    code: token.code,
    client_name: client.name,
    oa_name: ch ? ch.channel_name : null,
    deep_link: ch ? bindDeepLink(ch.basic_id, token.code) : null,
  });
});

module.exports = router;
