const express    = require('express');
const crypto     = require('crypto');
const db         = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router     = express.Router();

function notifySurveyor(surveyorId, caseData, surveyDate, surveyTime, dispatchNote, assignerName, workerToken) {
  if (!surveyorId) return;
  const tech = db.prepare(`SELECT id, name, line_user_id FROM users WHERE id=?`).get(surveyorId);
  if (!tech) return;
  const dateStr = [surveyDate, surveyTime].filter(Boolean).join(' ');
  const taskUrl = workerToken
    ? `${process.env.APP_URL || ''}/survey-worker?token=${workerToken}`
    : `/survey-form?case_id=${caseData.id}`;
  const notifUrl = workerToken ? taskUrl : `/survey-form?case_id=${caseData.id}`;
  const msg = `📋 您被指派為場勘人員\n案件：${caseData.case_number} ${caseData.title}\n${dateStr ? '場勘時間：' + dateStr + '\n' : ''}地址：${caseData.location || '未填'}${dispatchNote ? '\n備注：' + dispatchNote : ''}\n指派者：${assignerName}${workerToken && process.env.APP_URL ? '\n查看場勘單：' + taskUrl : ''}`;
  db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`)
    .run(tech.id, '您有場勘任務', `${caseData.case_number} ${caseData.title}${dateStr ? ' @ ' + dateStr : ''}`, caseData.id, notifUrl);
  if (tech.line_user_id) pushMessage(tech.line_user_id, msg);
}

function createMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

// 取得某案件的場勘單
router.get('/cases/:id/survey-form', requireAuth, (req, res) => {
  let form = db.prepare(`SELECT sf.*, u.name as surveyor_name, u.username as surveyor_username
    FROM survey_forms sf
    LEFT JOIN users u ON u.id = sf.surveyor_id
    WHERE sf.case_id = ? ORDER BY sf.created_at DESC LIMIT 1`).get(req.params.id);
  if (!form) return res.json(null);
  try { form.findings = JSON.parse(form.findings || '[]'); } catch { form.findings = []; }
  try { form.checklist_data = JSON.parse(form.checklist_data || '[]'); } catch { form.checklist_data = []; }
  res.json(form);
});

// 建立場勘單
router.post('/cases/:id/survey-form', requireAuth, (req, res) => {
  const case_id = Number(req.params.id);
  const me = req.session.user;
  const { surveyor_id, survey_date, survey_time, site_contact, site_phone, site_address,
          findings, photos_note, extra_notes, dispatch_note, cs_notes, checklist_data,
          cs_service_note } = req.body;

  const existing = db.prepare(`SELECT id FROM survey_forms WHERE case_id = ?`).get(case_id);
  if (existing) return res.status(400).json({ error: '此案件已有場勘單，請使用更新 API' });

  const token = genToken();
  const workerToken = genToken();
  const result = db.prepare(`
    INSERT INTO survey_forms (case_id, share_token, worker_token, surveyor_id, survey_date, survey_time,
      site_contact, site_phone, site_address, findings, photos_note, extra_notes, dispatch_note,
      cs_notes, checklist_data, cs_service_note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(case_id, token, workerToken,
    surveyor_id ?? null, survey_date ?? null, survey_time ?? null,
    site_contact ?? null, site_phone ?? null, site_address ?? null,
    JSON.stringify(findings ?? []),
    photos_note ?? null, extra_notes ?? null, dispatch_note ?? null,
    cs_notes ?? null, JSON.stringify(checklist_data ?? []),
    cs_service_note ?? null, me.id);

  // 同步 cases.surveyor_id（供任務牆查詢）
  db.prepare(`UPDATE cases SET surveyor_id=? WHERE id=?`).run(surveyor_id ?? null, case_id);

  // 通知場勘人員
  if (surveyor_id) {
    const caseData = db.prepare(`SELECT id, case_number, title, location FROM cases WHERE id=?`).get(case_id);
    notifySurveyor(surveyor_id, caseData, survey_date, survey_time, dispatch_note, me.name, workerToken);
  }

  // 案件狀態升為 survey_scheduled
  const c = db.prepare(`SELECT status FROM cases WHERE id=?`).get(case_id);
  if (['inquiry','quoted'].includes(c?.status)) {
    db.prepare(`UPDATE cases SET status='survey_scheduled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(case_id);
  }

  res.json({ ok: true, id: result.lastInsertRowid, token });
});

// 更新場勘單
router.put('/cases/:id/survey-form', requireAuth, (req, res) => {
  const me = req.session.user;
  const { surveyor_id, survey_date, survey_time, site_contact, site_phone, site_address,
          findings, photos_note, extra_notes, dispatch_note, status,
          cs_notes, checklist_data, cs_service_note } = req.body;

  // 判斷場勘人員是否有變更 → 需重新通知
  const old = db.prepare(`SELECT surveyor_id, worker_token FROM survey_forms WHERE case_id=?`).get(req.params.id);
  const surveyorChanged = old && String(old.surveyor_id) !== String(surveyor_id ?? '');
  const existingWorkerToken = old?.worker_token || genToken();

  db.prepare(`UPDATE survey_forms SET
    surveyor_id=?, survey_date=?, survey_time=?, site_contact=?, site_phone=?, site_address=?,
    findings=?, photos_note=?, extra_notes=?, dispatch_note=?,
    cs_notes=?, checklist_data=?, cs_service_note=?, status=?,
    worker_token=COALESCE(worker_token, ?), updated_at=CURRENT_TIMESTAMP
    WHERE case_id=?`).run(
    surveyor_id ?? null, survey_date ?? null, survey_time ?? null,
    site_contact ?? null, site_phone ?? null, site_address ?? null,
    JSON.stringify(findings ?? []),
    photos_note ?? null, extra_notes ?? null, dispatch_note ?? null,
    cs_notes ?? null, JSON.stringify(checklist_data ?? []),
    cs_service_note ?? null, status || 'draft', existingWorkerToken, req.params.id);

  // 同步 cases.surveyor_id（供任務牆查詢）
  db.prepare(`UPDATE cases SET surveyor_id=? WHERE id=?`).run(surveyor_id ?? null, req.params.id);

  // 場勘人員有變更（且新增了人）→ 通知新的場勘人員
  if (surveyorChanged && surveyor_id) {
    const caseData = db.prepare(`SELECT id, case_number, title, location FROM cases WHERE id=?`).get(req.params.id);
    const wt = db.prepare(`SELECT worker_token FROM survey_forms WHERE case_id=?`).get(req.params.id)?.worker_token;
    notifySurveyor(surveyor_id, caseData, survey_date, survey_time, dispatch_note, me.name, wt);
  }

  const form = db.prepare(`SELECT share_token FROM survey_forms WHERE case_id=?`).get(req.params.id);
  res.json({ ok: true, token: form?.share_token });
});

// 重新通知場勘人員（手動觸發）
router.post('/cases/:id/re-notify', requireAuth, (req, res) => {
  const me = req.session.user;
  const form = db.prepare(`
    SELECT sf.*, c.id AS case_id, c.case_number, c.title, c.location
    FROM survey_forms sf JOIN cases c ON c.id = sf.case_id
    WHERE sf.case_id = ?
  `).get(req.params.id);
  if (!form) return res.status(404).json({ error: '找不到場勘單' });
  if (!form.surveyor_id) return res.status(400).json({ error: '尚未指派場勘人員' });
  const caseData = { id: form.case_id, case_number: form.case_number, title: form.title, location: form.location };
  notifySurveyor(form.surveyor_id, caseData, form.survey_date, form.survey_time, form.dispatch_note, me.name, form.worker_token);
  res.json({ ok: true });
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
  try { form.checklist_data = JSON.parse(form.checklist_data || '[]'); } catch { form.checklist_data = []; }
  res.json(form);
});

// GET /api/survey/worker/:token  → 師傅查看場勘任務（公開，不需登入）
router.get('/worker/:token', (req, res) => {
  const form = db.prepare(`
    SELECT sf.surveyor_id, sf.survey_date, sf.survey_time, sf.site_contact, sf.site_phone,
           sf.site_address, sf.dispatch_note, sf.findings, sf.extra_notes, sf.status,
           c.case_number, c.title, c.location,
           u.name as surveyor_name
    FROM survey_forms sf
    JOIN cases c ON c.id = sf.case_id
    LEFT JOIN users u ON u.id = sf.surveyor_id
    WHERE sf.worker_token = ?
  `).get(req.params.token);
  if (!form) return res.status(404).json({ error: '找不到場勘任務' });
  try { form.findings = JSON.parse(form.findings || '[]'); } catch { form.findings = []; }
  res.json(form);
});

// PATCH /api/survey/cases/:id/fee  → 更新場勘費相關欄位
router.patch('/cases/:id/fee', requireAuth, (req, res) => {
  const { survey_fee, survey_fee_paid, survey_fee_required, survey_fee_waive_note, survey_fee_actual } = req.body;
  db.prepare(`UPDATE cases SET
    survey_fee=?, survey_fee_paid=?,
    survey_fee_required=?, survey_fee_waive_note=?, survey_fee_actual=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(
      survey_fee ?? null,
      survey_fee_paid ? 1 : 0,
      survey_fee_required ?? null,
      survey_fee_waive_note || null,
      survey_fee_actual ?? null,
      req.params.id
    );
  res.json({ ok: true });
});

// POST /api/survey/cases/:id/send-link  → 寄場勘連結給客戶
router.post('/cases/:id/send-link', requireAuth, async (req, res) => {
  const { email, token } = req.body;
  if (!email || !token) return res.status(400).json({ error: '缺少參數' });
  const link = `${req.protocol}://${req.get('host')}/sign/${token}`;
  const mailer = createMailer();
  if (!mailer) {
    return res.status(200).json({ ok: false, link, error: '未設定 SMTP，請手動複製連結發送' });
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const c = db.prepare(`SELECT c.case_number, c.title FROM cases c JOIN survey_forms sf ON sf.case_id=c.id WHERE c.id=?`).get(req.params.id);
  try {
    await mailer.sendMail({
      from,
      to: email,
      subject: `【繪新國際】場勘單確認 ${c?.case_number || ''}`,
      html: `<p>您好，</p><p>請點擊以下連結查看場勘單資料，並完成簽名確認：</p><p><a href="${link}" style="color:#2563eb">${link}</a></p><p style="font-size:12px;color:#6b7280">繪新國際有限公司</p>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

  // 案件狀態升為 surveyed，記錄完成時間
  db.prepare(`UPDATE cases SET status='surveyed', surveyed_at=COALESCE(surveyed_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(form.case_id);

  res.json({ ok: true });
});

// ── 備註模板庫 CRUD ──────────────────────────────────────────
router.get('/note-templates', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM survey_note_templates ORDER BY category, sort_order, id`).all();
  res.json(rows);
});

router.post('/note-templates', requireAuth, (req, res) => {
  const { category, keyword, content, sort_order } = req.body;
  if (!keyword || !content) return res.status(400).json({ error: '缺少 keyword 或 content' });
  const r = db.prepare(`INSERT INTO survey_note_templates (category, keyword, content, sort_order) VALUES (?,?,?,?)`)
    .run(category || '一般', keyword, content, sort_order ?? 0);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/note-templates/:id', requireAuth, (req, res) => {
  const { category, keyword, content, sort_order } = req.body;
  db.prepare(`UPDATE survey_note_templates SET category=?, keyword=?, content=?, sort_order=? WHERE id=?`)
    .run(category || '一般', keyword, content, sort_order ?? 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/note-templates/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM survey_note_templates WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 施作檢查清單模板庫 CRUD ──────────────────────────────────
router.get('/checklist-templates', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM survey_checklist_templates ORDER BY category, sort_order, id`).all();
  // 回傳依 category 分組
  const grouped = {};
  rows.forEach(r => {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  });
  res.json({ rows, grouped, categories: Object.keys(grouped) });
});

router.post('/checklist-templates', requireAuth, (req, res) => {
  const { category, item, sort_order } = req.body;
  if (!category || !item) return res.status(400).json({ error: '缺少 category 或 item' });
  const r = db.prepare(`INSERT INTO survey_checklist_templates (category, item, sort_order) VALUES (?,?,?)`)
    .run(category, item, sort_order ?? 0);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/checklist-templates/:id', requireAuth, (req, res) => {
  const { category, item, sort_order } = req.body;
  db.prepare(`UPDATE survey_checklist_templates SET category=?, item=?, sort_order=? WHERE id=?`)
    .run(category, item, sort_order ?? 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/checklist-templates/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM survey_checklist_templates WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
