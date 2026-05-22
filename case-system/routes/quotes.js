const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// 取得案件的最新報價單
router.get('/cases/:id', requireAuth, (req, res) => {
  const q = db.prepare(`
    SELECT qs.*, u.name as creator_name FROM quote_sheets qs
    LEFT JOIN users u ON u.id = qs.created_by
    WHERE qs.case_id = ? ORDER BY qs.id DESC LIMIT 1
  `).get(req.params.id);
  res.json(q || null);
});

// 建立或更新報價單（POST = upsert）
router.post('/cases/:id', requireAuth, (req, res) => {
  const case_id = Number(req.params.id);
  const me = req.session.user;
  const { valid_days, payment_terms, client_notes, client_type, discount_value } = req.body;
  const disc_val = parseFloat(discount_value) || 0;
  const disc_type = disc_val > 0 ? 'marketing' : 'none';

  const existing = db.prepare(`SELECT id, share_token FROM quote_sheets WHERE case_id = ?`).get(case_id);

  if (existing) {
    db.prepare(`
      UPDATE quote_sheets SET valid_days=?, payment_terms=?, client_notes=?,
        client_type=?, discount_type=?, discount_value=?, marketing_label='行銷優惠',
        status='sent', updated_at=CURRENT_TIMESTAMP
      WHERE case_id=?
    `).run(valid_days ?? 30, payment_terms ?? null, client_notes ?? null,
           client_type ?? 'owner', disc_type, disc_val, case_id);
    return res.json({ ok: true, token: existing.share_token });
  }

  const token = genToken();
  db.prepare(`
    INSERT INTO quote_sheets (case_id, share_token, valid_days, payment_terms, client_notes,
      client_type, discount_type, discount_value, marketing_label, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(case_id, token, valid_days ?? 30, payment_terms ?? null, client_notes ?? null,
         client_type ?? 'owner', disc_type, disc_val, '行銷優惠', 'sent', me.id);

  const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(case_id);
  if (c?.status === 'inquiry') {
    db.prepare(`UPDATE cases SET status='quoted', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(case_id);
  }

  res.json({ ok: true, token });
});

// 更新報價單設定
router.put('/cases/:id', requireAuth, (req, res) => {
  const { valid_days, payment_terms, client_notes, client_type, discount_value, status } = req.body;
  const disc_val = parseFloat(discount_value) || 0;
  const disc_type = disc_val > 0 ? 'marketing' : 'none';
  db.prepare(`
    UPDATE quote_sheets SET valid_days=?, payment_terms=?, client_notes=?,
      client_type=?, discount_type=?, discount_value=?, marketing_label='行銷優惠',
      status=?, updated_at=CURRENT_TIMESTAMP
    WHERE case_id=?
  `).run(valid_days ?? 30, payment_terms ?? null, client_notes ?? null,
         client_type ?? 'owner', disc_type, disc_val,
         status ?? 'sent', req.params.id);
  const q = db.prepare(`SELECT share_token FROM quote_sheets WHERE case_id=?`).get(req.params.id);
  res.json({ ok: true, token: q?.share_token });
});

// ── 公開頁面（客戶看報價，不需登入）────────────────────────────

router.get('/sign/:token', (req, res) => {
  const q = db.prepare(`
    SELECT qs.*, c.title, c.case_number, c.location,
           cl.name as client_name, cl.phone as client_phone,
           u.name as creator_name, o.name as org_name
    FROM quote_sheets qs
    JOIN cases c ON c.id = qs.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users u ON u.id = qs.created_by
    LEFT JOIN orgs o ON o.id = c.org_id
    WHERE qs.share_token = ?
  `).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });

  const items = db.prepare(`
    SELECT id, sort_order, item_type, description, location,
           width_cm, height_cm, quantity, unit, area,
           material_brand, material_model,
           client_unit_price, client_subtotal, subtotal
    FROM case_items WHERE case_id = ? ORDER BY sort_order, id
  `).all(q.case_id);

  // 對客小計：若有 client_unit_price 用 client_subtotal，否則用 subtotal
  const clientItems = items.map(i => ({
    ...i,
    display_subtotal: i.client_unit_price != null ? (i.client_subtotal || 0) : (i.subtotal || 0),
    display_unit_price: i.client_unit_price != null ? i.client_unit_price : null,
  }));

  res.json({ ...q, items: clientItems });
});

router.post('/sign/:token', (req, res) => {
  const { signature } = req.body;
  if (!signature) return res.status(400).json({ error: '請提供簽名' });

  const q = db.prepare(`SELECT id, case_id, status FROM quote_sheets WHERE share_token=?`).get(req.params.token);
  if (!q) return res.status(404).json({ error: '找不到報價單' });
  if (q.status === 'accepted') return res.status(400).json({ error: '此報價單已確認' });

  db.prepare(`
    UPDATE quote_sheets SET status='accepted', client_signature=?, client_accepted_at=CURRENT_TIMESTAMP
    WHERE share_token=?
  `).run(signature, req.params.token);

  // 客戶接受報價 → 案件升為已成交
  const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(q.case_id);
  if (['inquiry','quoted','surveyed','survey_scheduled'].includes(c?.status)) {
    db.prepare(`UPDATE cases SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(q.case_id);
  }

  res.json({ ok: true });
});

module.exports = router;
