const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// 取得某案件的場勘單（或建立新的）
router.get('/cases/:id/survey-form', requireAuth, (req, res) => {
  let form = db.prepare(`SELECT sf.*, u.name as surveyor_name FROM survey_forms sf
    LEFT JOIN users u ON u.id = sf.surveyor_id
    WHERE sf.case_id = ? ORDER BY sf.created_at DESC LIMIT 1`).get(req.params.id);
  if (!form) return res.json(null);
  try { form.findings = JSON.parse(form.findings || '[]'); } catch { form.findings = []; }
  res.json(form);
});

// 建立場勘單
router.post('/cases/:id/survey-form', requireAuth, (req, res) => {
  const case_id = Number(req.params.id);
  const me = req.session.user;
  const { surveyor_id, survey_date, site_contact, site_phone, site_address,
          findings, photos_note, extra_notes } = req.body;

  const existing = db.prepare(`SELECT id FROM survey_forms WHERE case_id = ?`).get(case_id);
  if (existing) return res.status(400).json({ error: '此案件已有場勘單，請使用更新 API' });

  const token = genToken();
  const result = db.prepare(`
    INSERT INTO survey_forms (case_id, share_token, surveyor_id, survey_date,
      site_contact, site_phone, site_address, findings, photos_note, extra_notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(case_id, token,
    surveyor_id ?? me.id, survey_date ?? null,
    site_contact ?? null, site_phone ?? null, site_address ?? null,
    JSON.stringify(findings ?? []),
    photos_note ?? null, extra_notes ?? null, me.id);

  // 案件狀態升為 survey_scheduled
  const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(case_id);
  if (['inquiry','quoted'].includes(c?.status)) {
    db.prepare(`UPDATE cases SET status='survey_scheduled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(case_id);
  }

  res.json({ ok: true, id: result.lastInsertRowid, token });
});

// 更新場勘單
router.put('/cases/:id/survey-form', requireAuth, (req, res) => {
  const { surveyor_id, survey_date, site_contact, site_phone, site_address,
          findings, photos_note, extra_notes, status } = req.body;

  db.prepare(`UPDATE survey_forms SET
    surveyor_id=?, survey_date=?, site_contact=?, site_phone=?, site_address=?,
    findings=?, photos_note=?, extra_notes=?, status=?, updated_at=CURRENT_TIMESTAMP
    WHERE case_id=?`).run(
    surveyor_id ?? null, survey_date ?? null,
    site_contact ?? null, site_phone ?? null, site_address ?? null,
    JSON.stringify(findings ?? []),
    photos_note ?? null, extra_notes ?? null,
    status || 'draft', req.params.id);

  const form = db.prepare(`SELECT share_token FROM survey_forms WHERE case_id=?`).get(req.params.id);
  res.json({ ok: true, token: form?.share_token });
});

// ── 公開頁面（客戶簽名用，不需登入）────────────────────────────
// GET /api/survey/sign/:token  → 取場勘單資料（不含金額）
router.get('/sign/:token', (req, res) => {
  const form = db.prepare(`
    SELECT sf.*, c.title, c.case_number, c.location,
           cl.name as client_name, cl.phone as client_phone,
           u.name as surveyor_name, o.name as org_name
    FROM survey_forms sf
    JOIN cases c ON c.id = sf.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN users u ON u.id = sf.surveyor_id
    LEFT JOIN orgs o ON o.id = c.org_id
    WHERE sf.share_token = ?
  `).get(req.params.token);
  if (!form) return res.status(404).json({ error: '找不到場勘單' });
  try { form.findings = JSON.parse(form.findings || '[]'); } catch { form.findings = []; }
  res.json(form);
});

// POST /api/survey/sign/:token  → 客戶提交簽名
router.post('/sign/:token', (req, res) => {
  const { signature } = req.body;
  if (!signature) return res.status(400).json({ error: '請提供簽名' });

  const form = db.prepare(`SELECT id, case_id, status FROM survey_forms WHERE share_token=?`).get(req.params.token);
  if (!form) return res.status(404).json({ error: '找不到場勘單' });
  if (form.status === 'signed') return res.status(400).json({ error: '此場勘單已完成簽名' });

  db.prepare(`UPDATE survey_forms SET status='signed', client_signature=?, client_signed_at=CURRENT_TIMESTAMP WHERE share_token=?`)
    .run(signature, req.params.token);

  // 案件狀態升為 surveyed
  db.prepare(`UPDATE cases SET status='surveyed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(form.case_id);

  res.json({ ok: true });
});

module.exports = router;
