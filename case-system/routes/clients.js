const express = require('express');
const multer  = require('multer');
const db = require('../db');
const { requireAuth, orgFilterSQL } = require('../middleware/auth');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { sql: orgSql, params: orgPs } = orgFilterSQL(me, 'c.org_id');
  const clients = db.prepare(`
      SELECT c.*, o.name AS org_name, cc.name AS category_name, cc.discount_rate AS category_discount,
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
          invoice_email, invoice_needs, invoice_title } = req.body;
  if (!name) return res.status(400).json({ error: '請填入客戶姓名' });
  const result = db.prepare(`
    INSERT INTO clients (org_id, name, phone, email, address, source, discount, notes, created_by,
      tax_id, contact_person, capital, einvoice_code, client_level, payment_terms, discount_terms, referrer, line_group_name, category_id,
      invoice_email, invoice_needs, invoice_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(me.org_id, name, phone ?? null, email ?? null, address ?? null,
         source ?? null, discount ?? 1.0, notes ?? null, me.id,
         tax_id ?? null, contact_person ?? null, capital ?? null, einvoice_code ?? null,
         client_level ?? null, payment_terms ?? null, discount_terms ?? null, referrer ?? null,
         line_group_name ?? null, category_id ?? null,
         invoice_email ?? null, invoice_needs ?? null, invoice_title ?? null);
  const uid = req.session.user.id;
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(uid, 'create', 'clients', result.lastInsertRowid, `新增客戶：${name}`);
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/:id', requireAuth, (req, res) => {
  const { name, phone, email, address, source, discount, notes,
          tax_id, contact_person, capital, einvoice_code,
          client_level, payment_terms, discount_terms, referrer, line_group_name, category_id,
          invoice_email, invoice_needs, invoice_title } = req.body;
  db.prepare(`UPDATE clients SET name=?, phone=?, email=?, address=?, source=?, discount=?, notes=?,
    tax_id=?, contact_person=?, capital=?, einvoice_code=?, client_level=?, payment_terms=?, discount_terms=?, referrer=?, line_group_name=?, category_id=?,
    invoice_email=?, invoice_needs=?, invoice_title=?
    WHERE id=?`)
    .run(name, phone ?? null, email ?? null, address ?? null, source ?? null, discount ?? 1.0, notes ?? null,
         tax_id ?? null, contact_person ?? null, capital ?? null, einvoice_code ?? null,
         client_level ?? null, payment_terms ?? null, discount_terms ?? null, referrer ?? null,
         line_group_name ?? null, category_id ?? null,
         invoice_email ?? null, invoice_needs ?? null, invoice_title ?? null,
         req.params.id);
  db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(req.session.user.id, 'update', 'clients', req.params.id, `更新客戶：${name}`);
  res.json({ ok: true });
});

router.get('/:id', requireAuth, (req, res) => {
  const c = db.prepare(`
    SELECT cl.*, o.name AS org_name, cc.name AS category_name, cc.discount_rate AS category_discount,
      (SELECT GROUP_CONCAT(t.id||'|'||t.name||'|'||t.color)
        FROM client_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.client_id=cl.id) AS tags_csv
    FROM clients cl
    LEFT JOIN orgs o ON cl.org_id = o.id
    LEFT JOIN client_categories cc ON cc.id = cl.category_id
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

  res.json({ ...c, stats });
});

router.get('/:id/cases', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.final_price, c.payment_status,
           c.scheduled_date, c.created_at, c.contracted_at, c.address
    FROM cases c WHERE c.client_id = ? ORDER BY c.created_at DESC
  `).all(req.params.id);
  res.json(cases);
});

module.exports = router;
