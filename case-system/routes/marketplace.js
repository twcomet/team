const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { pushMessage } = require('./webhook');
const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '../public/uploads/completion');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`),
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── 案件廣場（區域過濾）──────────────────────────────────────

// GET /api/marketplace — 開放案件池（依技師區域過濾）
router.get('/', requireAuth, (req, res) => {
  const uid  = req.session.user.id;
  const user = db.prepare(`SELECT region_id FROM users WHERE id=?`).get(uid);
  // HQ/總部可看全部；技師只看自己區域
  const regionFilter = user?.region_id
    ? `AND (c.region_id = ${user.region_id} OR c.region_id IS NULL)`
    : '';

  const rows = db.prepare(`
    SELECT c.id, c.case_number, c.case_type, c.location,
           c.title, c.description, c.outsource_types,
           c.quoted_price, c.final_price, c.survey_fee, c.install_fee,
           c.status, c.created_at,
           r.name AS region_name,
           ca.id AS app_id, ca.apply_type AS app_type, ca.status AS app_status
    FROM cases c
    LEFT JOIN regions r ON r.id = c.region_id
    LEFT JOIN case_applications ca ON ca.case_id = c.id AND ca.applicant_id = ?
    WHERE c.outsource_open = 1
      AND c.assigned_technician_id IS NULL
      ${regionFilter}
    ORDER BY c.created_at DESC
  `).all(uid);

  res.json(rows.map(r => ({
    ...r,
    outsource_types: JSON.parse(r.outsource_types || '[]'),
    quoted_price: r.app_status === 'approved' ? r.quoted_price : null,
    final_price:  r.app_status === 'approved' ? r.final_price  : null,
  })));
});

// GET /api/marketplace/my-tasks — 技師的指定任務（HQ 直接指派）
router.get('/my-tasks', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const tasks = db.prepare(`
    SELECT c.id, c.case_number, c.case_type, c.location,
           c.title, c.description, c.status, c.created_at, c.scheduled_date,
           cl.name AS client_name, cl.phone AS client_phone, cl.address AS client_address,
           r.name AS region_name,
           dq.id AS dq_id, dq.status AS dq_status, dq.notified_at, dq.response_deadline,
           dq.task_progress, dq.completion_notes, dq.completion_photos, dq.progress_updated_at
    FROM cases c
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN regions r  ON r.id  = c.region_id
    LEFT JOIN dispatch_queue dq ON dq.case_id = c.id AND dq.technician_id = ?
                                AND dq.status IN ('pending','accepted')
    WHERE c.assigned_technician_id = ?
      AND c.outsource_open = 0
    ORDER BY c.scheduled_date ASC, c.updated_at DESC
  `).all(uid, uid);
  res.json(tasks.map(t => ({ ...t, completion_photos: JSON.parse(t.completion_photos || '[]') })));
});

// PUT /api/marketplace/tasks/:caseId/progress — 更新任務進度
router.put('/tasks/:caseId/progress', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { task_progress, completion_notes } = req.body;
  const valid = ['pending','in_progress','completed'];
  if (!valid.includes(task_progress)) return res.status(400).json({ error: '無效進度狀態' });

  const dq = db.prepare(`SELECT id FROM dispatch_queue WHERE case_id=? AND technician_id=? AND status='accepted'`).get(req.params.caseId, uid);
  if (!dq) return res.status(404).json({ error: '任務不存在或尚未接受' });

  db.prepare(`UPDATE dispatch_queue SET task_progress=?, completion_notes=?, progress_updated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(task_progress, completion_notes || null, dq.id);

  if (task_progress === 'completed') {
    const me = db.prepare(`SELECT name FROM users WHERE id=?`).get(uid);
    const c  = db.prepare(`SELECT case_number, title FROM cases WHERE id=?`).get(req.params.caseId);
    const hqUsers = db.prepare(`SELECT id, line_user_id FROM users WHERE role IN ('owner','manager','staff') AND active=1`).all();
    const notif = db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`);
    const msg = `✅ 技師完工回報\n技師：${me?.name}\n案件：${c?.case_number} ${c?.title}${completion_notes ? '\n備註：' + completion_notes : ''}`;
    for (const u of hqUsers) {
      notif.run(u.id, '技師完工回報', `${me?.name} 完成 ${c?.case_number}`, req.params.caseId, `/case-detail?id=${req.params.caseId}`);
      if (u.line_user_id) pushMessage(u.line_user_id, msg);
    }
  }
  res.json({ ok: true });
});

// POST /api/marketplace/tasks/:caseId/photos — 上傳完工照片
router.post('/tasks/:caseId/photos', requireAuth, upload.array('photos', 10), (req, res) => {
  const uid = req.session.user.id;
  const dq = db.prepare(`SELECT id, completion_photos FROM dispatch_queue WHERE case_id=? AND technician_id=? AND status='accepted'`).get(req.params.caseId, uid);
  if (!dq) return res.status(404).json({ error: '任務不存在或尚未接受' });

  const existing = JSON.parse(dq.completion_photos || '[]');
  const newPhotos = (req.files || []).map(f => `/uploads/completion/${f.filename}`);
  const all = [...existing, ...newPhotos];
  db.prepare(`UPDATE dispatch_queue SET completion_photos=?, progress_updated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(JSON.stringify(all), dq.id);
  res.json({ ok: true, photos: all });
});

// GET /api/marketplace/my — 技師的申請記錄
router.get('/my', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const apps = db.prepare(`
    SELECT ca.*, c.case_number, c.case_type, c.location, c.title, c.description,
           c.quoted_price, c.final_price, c.survey_fee, c.install_fee,
           c.status AS case_status, c.outsource_types,
           cl.name AS client_name, cl.phone AS client_phone, cl.address AS client_address,
           r.name AS region_name, u.name AS reviewer_name
    FROM case_applications ca
    JOIN cases c ON c.id = ca.case_id
    LEFT JOIN clients cl  ON cl.id = c.client_id
    LEFT JOIN regions r   ON r.id  = c.region_id
    LEFT JOIN users u     ON u.id  = ca.reviewed_by
    WHERE ca.applicant_id = ?
    ORDER BY ca.created_at DESC
  `).all(uid);

  res.json(apps.map(a => ({
    ...a,
    outsource_types:  JSON.parse(a.outsource_types || '[]'),
    client_name:    a.status === 'approved' ? a.client_name    : null,
    client_phone:   a.status === 'approved' ? a.client_phone   : null,
    client_address: a.status === 'approved' ? a.client_address : null,
  })));
});

// POST /api/marketplace/:caseId/apply — 技師申請接案（案件池）
router.post('/:caseId/apply', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { apply_type } = req.body;
  const c = db.prepare(`SELECT id, case_number, title, outsource_open, outsource_types, region_id FROM cases WHERE id=?`).get(req.params.caseId);
  if (!c || !c.outsource_open) return res.status(404).json({ error: '案件不存在或未開放' });

  const types = JSON.parse(c.outsource_types || '[]');
  if (!types.includes(apply_type)) return res.status(400).json({ error: '此案件不開放該申請類型' });

  const existing = db.prepare(`SELECT id, status FROM case_applications WHERE case_id=? AND applicant_id=?`).get(c.id, uid);
  if (existing) {
    if (existing.status === 'rejected') {
      db.prepare(`UPDATE case_applications SET apply_type=?, status='pending', hq_note=NULL, reviewed_by=NULL, reviewed_at=NULL, created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(apply_type, existing.id);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: '您已申請過此案件' });
  }

  db.prepare(`INSERT INTO case_applications (case_id, applicant_id, apply_type) VALUES (?,?,?)`).run(c.id, uid, apply_type);

  // 系統內通知 + LINE 通知 HQ
  const me = db.prepare(`SELECT name FROM users WHERE id=?`).get(uid);
  const hqUsers = db.prepare(`SELECT id, line_user_id FROM users WHERE role IN ('owner','manager','staff') AND active=1`).all();
  const notif = db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`);
  const msg = `📋 技師申請接案\n技師：${me?.name}\n案件：${c.case_number} ${c.title}\n類型：${apply_type === 'full' ? '全案' : apply_type === 'survey' ? '場勘' : '施工'}`;
  for (const u of hqUsers) {
    notif.run(u.id, '技師申請接案', `${me?.name} 申請接案 ${c.case_number}（${apply_type}）`, c.id, `/case-detail?id=${c.id}`);
    if (u.line_user_id) pushMessage(u.line_user_id, msg);
  }

  res.json({ ok: true });
});

// POST /api/marketplace/direct-assign/:caseId — HQ 直接指派技師
router.post('/direct-assign/:caseId', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { technician_id, note } = req.body;
  if (!technician_id) return res.status(400).json({ error: '請選擇技師' });

  const c = db.prepare(`SELECT id, case_number, title FROM cases WHERE id=?`).get(req.params.caseId);
  if (!c) return res.status(404).json({ error: '案件不存在' });

  const tech = db.prepare(`SELECT id, name, line_user_id FROM users WHERE id=? AND active=1`).get(technician_id);
  if (!tech) return res.status(404).json({ error: '技師不存在' });

  const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2小時後逾時

  db.prepare(`UPDATE cases SET assigned_technician_id=?, outsource_open=0, status='dispatched', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(technician_id, c.id);

  // 寫入派案佇列
  db.prepare(`INSERT INTO dispatch_queue (case_id, technician_id, queue_position, notified_at, response_deadline, status) VALUES (?,?,1,CURRENT_TIMESTAMP,?,'pending')`)
    .run(c.id, technician_id, deadline);

  // 通知技師（系統 + LINE）
  const msg = `🔔 您有一筆指定案件\n案件：${c.case_number} ${c.title}\n${note ? '備註：' + note + '\n' : ''}請至派案系統確認是否接受。`;
  db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`)
    .run(technician_id, '您有指定案件', `${c.case_number} ${c.title}`, c.id, `/marketplace`);
  if (tech.line_user_id) pushMessage(tech.line_user_id, msg);

  res.json({ ok: true, technician_name: tech.name });
});

// PUT /api/marketplace/tasks/:caseId/respond — 技師接受/拒絕指定案件
router.put('/tasks/:caseId/respond', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { accept, reason } = req.body;
  const c = db.prepare(`SELECT id, case_number, title FROM cases WHERE id=? AND assigned_technician_id=?`).get(req.params.caseId, uid);
  if (!c) return res.status(404).json({ error: '案件不存在或您非指派技師' });

  const dqStatus = accept ? 'accepted' : 'declined';
  db.prepare(`UPDATE dispatch_queue SET status=?, decline_reason=?, updated_at=CURRENT_TIMESTAMP WHERE case_id=? AND technician_id=? AND status='pending'`)
    .run(dqStatus, reason || null, c.id, uid);

  if (accept) {
    db.prepare(`UPDATE cases SET status='tech_accepted', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id);
  } else {
    db.prepare(`UPDATE cases SET assigned_technician_id=NULL, status='pending_dispatch', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(c.id);
  }

  // 通知 HQ
  const me = db.prepare(`SELECT name, line_user_id FROM users WHERE id=?`).get(uid);
  const icon = accept ? '✅' : '❌';
  const msg = `${icon} 技師${accept ? '接受' : '拒絕'}指定案件\n技師：${me?.name}\n案件：${c.case_number} ${c.title}${reason ? '\n原因：' + reason : ''}`;
  const hqUsers = db.prepare(`SELECT id, line_user_id FROM users WHERE role IN ('owner','manager') AND active=1`).all();
  const notif = db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`);
  for (const u of hqUsers) {
    notif.run(u.id, `技師${accept ? '接受' : '拒絕'}案件`, `${me?.name} ${accept ? '接受' : '拒絕'} ${c.case_number}`, c.id, `/case-detail?id=${c.id}`);
    if (u.line_user_id) pushMessage(u.line_user_id, msg);
  }

  res.json({ ok: true });
});

// GET /api/marketplace/applications — 總部查看所有申請
router.get('/applications', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { status } = req.query;
  let where = '1=1';
  const params = [];
  if (status) { where += ' AND ca.status=?'; params.push(status); }
  const rows = db.prepare(`
    SELECT ca.*, c.case_number, c.title, c.case_type, c.location,
           r.name AS region_name,
           u.name AS applicant_name, u.username AS applicant_username,
           rv.name AS reviewer_name
    FROM case_applications ca
    JOIN cases c  ON c.id = ca.case_id
    JOIN users u  ON u.id = ca.applicant_id
    LEFT JOIN regions r  ON r.id = c.region_id
    LEFT JOIN users rv   ON rv.id = ca.reviewed_by
    WHERE ${where}
    ORDER BY ca.created_at DESC
  `).all(...params);
  res.json(rows);
});

// PUT /api/marketplace/applications/:id — 總部審核申請
router.put('/applications/:id', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { status, hq_note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: '無效狀態' });

  const app = db.prepare(`SELECT * FROM case_applications WHERE id=?`).get(req.params.id);
  if (!app) return res.status(404).json({ error: '申請不存在' });

  db.prepare(`UPDATE case_applications SET status=?, hq_note=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, hq_note || null, req.session.user.id, req.params.id);

  const c = db.prepare(`SELECT case_number, title FROM cases WHERE id=?`).get(app.case_id);
  const tech = db.prepare(`SELECT name, line_user_id FROM users WHERE id=?`).get(app.applicant_id);

  // 通知技師審核結果（系統 + LINE）
  const icon = status === 'approved' ? '✅' : '❌';
  const resultText = status === 'approved' ? '接案申請通過' : '接案申請未通過';
  const lineMsg = `${icon} ${resultText}\n案件：${c?.case_number} ${c?.title}${hq_note ? '\n備註：' + hq_note : ''}`;
  db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`)
    .run(app.applicant_id, resultText, `${c?.case_number} ${c?.title}\n${hq_note || ''}`, app.case_id, `/marketplace`);
  if (tech?.line_user_id) pushMessage(tech.line_user_id, lineMsg);

  // 審核通過 → 設為承接技師，關閉案件池
  if (status === 'approved') {
    db.prepare(`UPDATE cases SET assigned_technician_id=?, outsource_open=0, status='tech_accepted', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(app.applicant_id, app.case_id);
    if (app.apply_type === 'full' || app.apply_type === 'install') {
      db.prepare(`UPDATE cases SET is_outsourced=1, outsource_type=? WHERE id=?`)
        .run(app.apply_type === 'full' ? 'full' : 'install_only', app.case_id);
    }
  }

  res.json({ ok: true });
});

// PUT /api/marketplace/case-setting/:id — HQ 設定開放案件池（含區域）
router.put('/case-setting/:id', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { outsource_open, outsource_types, region_id } = req.body;
  db.prepare(`UPDATE cases SET outsource_open=?, outsource_types=?, region_id=COALESCE(?,region_id), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(outsource_open ? 1 : 0, JSON.stringify(outsource_types || []), region_id || null, req.params.id);
  res.json({ ok: true });
});

// GET /api/marketplace/pool-overview — HQ 案件池總覽（含各案申請列表）
router.get('/pool-overview', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });

  const cases = db.prepare(`
    SELECT c.id, c.case_number, c.case_type, c.title, c.location, c.status,
           c.outsource_open, c.is_outsourced, c.outsource_type,
           COALESCE(c.outsource_types, CASE WHEN c.is_outsourced=1 THEN json_array(COALESCE(c.outsource_type,'full')) ELSE '[]' END) AS outsource_types,
           c.region_id, c.updated_at,
           cl.name AS client_name,
           r.name  AS region_name,
           (SELECT COUNT(*) FROM case_applications ca WHERE ca.case_id=c.id AND ca.status='pending') AS pending_count,
           (SELECT COUNT(*) FROM case_applications ca WHERE ca.case_id=c.id)                           AS total_apps
    FROM cases c
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN regions  r ON r.id  = c.region_id
    WHERE c.outsource_open = 1 OR c.is_outsourced = 1
    ORDER BY c.updated_at DESC
  `).all();

  const allApps = db.prepare(`
    SELECT ca.*, u.name AS applicant_name, u.username AS applicant_username
    FROM case_applications ca
    JOIN cases c ON c.id = ca.case_id
    JOIN users u ON u.id = ca.applicant_id
    WHERE c.outsource_open = 1 OR c.is_outsourced = 1
    ORDER BY ca.created_at ASC
  `).all();

  const byCase = {};
  allApps.forEach(a => { (byCase[a.case_id] ||= []).push(a); });

  res.json(cases.map(c => ({
    ...c,
    outsource_types: JSON.parse(c.outsource_types || '[]'),
    applications: byCase[c.id] || []
  })));
});

// GET /api/marketplace/technicians — 取得可指派的技師列表（依區域）
router.get('/technicians', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { region_id } = req.query;
  let where = `u.active=1 AND u.role IN ('contractor_install','contractor_sales','dealer_technician','regional_partner')`;
  const params = [];
  if (region_id) { where += ` AND u.region_id=?`; params.push(region_id); }
  const rows = db.prepare(`
    SELECT u.id, u.name, u.username, u.technician_level, u.rating_avg, u.region_id,
           r.name AS region_name
    FROM users u
    LEFT JOIN regions r ON r.id = u.region_id
    WHERE ${where}
    ORDER BY u.technician_level DESC, u.rating_avg DESC
  `).all(...params);
  res.json(rows);
});

// GET /api/marketplace/regions — 取得區域列表
router.get('/regions', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id, name, type FROM regions WHERE status='active' ORDER BY id`).all();
  res.json(rows);
});

// GET /api/marketplace/student/:uid — 技師評分統計
router.get('/student/:uid', requireAuth, (req, res) => {
  const ratings = db.prepare(`
    SELECT cr.score, cr.comment, cr.created_at, c.case_number, c.title
    FROM case_ratings cr
    JOIN cases c ON c.id = cr.case_id
    WHERE cr.student_id=?
    ORDER BY cr.created_at DESC
  `).all(req.params.uid);
  const avg = ratings.length ? (ratings.reduce((s,r)=>s+r.score,0)/ratings.length).toFixed(1) : null;
  res.json({ ratings, avg, count: ratings.length });
});

// POST /api/marketplace/rate/:caseId — 客戶評分
router.post('/rate/:caseId', (req, res) => {
  const { student_id, score, comment } = req.body;
  if (!student_id || !score || score < 1 || score > 5) return res.status(400).json({ error: '請填寫評分（1-5）' });
  try {
    db.prepare(`INSERT INTO case_ratings (case_id, student_id, score, comment) VALUES (?,?,?,?)`).run(req.params.caseId, student_id, score, comment || null);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: '已評分過' }); }
});

module.exports = router;
