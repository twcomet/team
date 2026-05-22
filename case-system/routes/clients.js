const express = require('express');
const multer  = require('multer');
const db = require('../db');
const { requireAuth, orgFilter } = require('../middleware/auth');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const filter = orgFilter(me);
  const clients = filter.org_id
    ? db.prepare(`SELECT * FROM clients WHERE org_id = ? ORDER BY name`).all(filter.org_id)
    : db.prepare(`SELECT c.*, o.name as org_name FROM clients c LEFT JOIN orgs o ON c.org_id = o.id ORDER BY c.name`).all();
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
            { type: 'text', text: `請辨識這張名片上的資訊，以 JSON 格式回傳，欄位如下（找不到的填 null）：
{
  "name": "公司名稱或個人姓名",
  "contact_person": "聯絡人姓名（若與公司名不同）",
  "phone": "電話（行動或市話，取第一個）",
  "email": "email",
  "address": "地址",
  "tax_id": "統一編號（8位數字）",
  "title": "職稱"
}
只回傳 JSON，不要其他說明。` }
          ]
        }]
      })
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: '無法解析名片內容', raw: text });
    res.json(JSON.parse(match[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, (req, res) => {
  const me = req.session.user;
  const { name, phone, email, address, source, discount, notes,
          tax_id, contact_person, capital, einvoice_code,
          client_level, payment_terms, discount_terms, referrer, line_group_name } = req.body;
  if (!name) return res.status(400).json({ error: '請填入客戶姓名' });
  const result = db.prepare(`
    INSERT INTO clients (org_id, name, phone, email, address, source, discount, notes, created_by,
      tax_id, contact_person, capital, einvoice_code, client_level, payment_terms, discount_terms, referrer, line_group_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(me.org_id, name, phone ?? null, email ?? null, address ?? null,
         source ?? null, discount ?? 1.0, notes ?? null, me.id,
         tax_id ?? null, contact_person ?? null, capital ?? null, einvoice_code ?? null,
         client_level ?? null, payment_terms ?? null, discount_terms ?? null, referrer ?? null,
         line_group_name ?? null);
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/:id', requireAuth, (req, res) => {
  const { name, phone, email, address, source, discount, notes,
          tax_id, contact_person, capital, einvoice_code,
          client_level, payment_terms, discount_terms, referrer, line_group_name } = req.body;
  db.prepare(`UPDATE clients SET name=?, phone=?, email=?, address=?, source=?, discount=?, notes=?,
    tax_id=?, contact_person=?, capital=?, einvoice_code=?, client_level=?, payment_terms=?, discount_terms=?, referrer=?, line_group_name=?
    WHERE id=?`)
    .run(name, phone ?? null, email ?? null, address ?? null, source ?? null, discount ?? 1.0, notes ?? null,
         tax_id ?? null, contact_person ?? null, capital ?? null, einvoice_code ?? null,
         client_level ?? null, payment_terms ?? null, discount_terms ?? null, referrer ?? null,
         line_group_name ?? null, req.params.id);
  res.json({ ok: true });
});

router.get('/:id/cases', requireAuth, (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.final_price, c.payment_status, c.scheduled_date
    FROM cases c WHERE c.client_id = ? ORDER BY c.created_at DESC
  `).all(req.params.id);
  res.json(cases);
});

module.exports = router;
