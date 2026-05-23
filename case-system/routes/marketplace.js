const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ── 案件廣場（學員可看）─────────────────────────────────────

// GET /api/marketplace — 所有開放外包案件（隱藏客戶資訊）
router.get('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const rows = db.prepare(`
    SELECT c.id, c.case_number, c.case_type, c.location,
           c.title, c.description, c.outsource_types,
           c.quoted_price, c.final_price, c.survey_fee, c.install_fee,
           c.status, c.created_at,
           o.name AS org_name,
           -- 本人申請記錄
           ca.id AS app_id, ca.apply_type AS app_type, ca.status AS app_status,
           -- 評分
           ROUND(AVG(cr2.score), 1) AS avg_rating
    FROM cases c
    LEFT JOIN orgs o ON o.id = c.org_id
    LEFT JOIN case_applications ca ON ca.case_id = c.id AND ca.applicant_id = ?
    LEFT JOIN case_ratings cr2 ON cr2.case_id = c.id
    WHERE c.outsource_open = 1
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all(uid);

  res.json(rows.map(r => ({
    ...r,
    outsource_types: JSON.parse(r.outsource_types || '[]'),
    // 隱藏金額（除非已審核通過）
    quoted_price: r.app_status === 'approved' ? r.quoted_price : null,
    final_price:  r.app_status === 'approved' ? r.final_price  : null,
  })));
});

// GET /api/marketplace/my — 學員自己的申請紀錄（含審核通過後的案件詳情）
router.get('/my', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const apps = db.prepare(`
    SELECT ca.*, c.case_number, c.case_type, c.location, c.title, c.description,
           c.quoted_price, c.final_price, c.survey_fee, c.install_fee,
           c.status AS case_status, c.outsource_types,
           cl.name AS client_name, cl.phone AS client_phone, cl.address AS client_address,
           o.name AS org_name,
           u.name AS reviewer_name
    FROM case_applications ca
    JOIN cases c ON c.id = ca.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    LEFT JOIN orgs o ON o.id = c.org_id
    LEFT JOIN users u ON u.id = ca.reviewed_by
    WHERE ca.applicant_id = ?
    ORDER BY ca.created_at DESC
  `).all(uid);

  res.json(apps.map(a => ({
    ...a,
    outsource_types: JSON.parse(a.outsource_types || '[]'),
    // 審核前隱藏客戶資訊
    client_name:    a.status === 'approved' ? a.client_name    : null,
    client_phone:   a.status === 'approved' ? a.client_phone   : null,
    client_address: a.status === 'approved' ? a.client_address : null,
  })));
});

// POST /api/marketplace/:caseId/apply — 學員申請
router.post('/:caseId/apply', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const { apply_type } = req.body;
  const c = db.prepare(`SELECT id, outsource_open, outsource_types FROM cases WHERE id = ?`).get(req.params.caseId);
  if (!c || !c.outsource_open) return res.status(404).json({ error: '案件不存在或未開放' });
  const types = JSON.parse(c.outsource_types || '[]');
  if (!types.includes(apply_type)) return res.status(400).json({ error: '此案件不開放該申請類型' });

  const existing = db.prepare(`SELECT id, status FROM case_applications WHERE case_id=? AND applicant_id=?`).get(c.id, uid);
  if (existing) {
    if (existing.status === 'rejected') {
      // 允許重新申請
      db.prepare(`UPDATE case_applications SET apply_type=?, status='pending', hq_note=NULL, reviewed_by=NULL, reviewed_at=NULL, created_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(apply_type, existing.id);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: '您已申請過此案件' });
  }

  db.prepare(`INSERT INTO case_applications (case_id, applicant_id, apply_type) VALUES (?,?,?)`)
    .run(c.id, uid, apply_type);

  // 通知總部（系統內通知）
  const hqUsers = db.prepare(`SELECT id FROM users WHERE role IN ('owner','vp','hq_cs') AND active=1`).all();
  const me = db.prepare(`SELECT name FROM users WHERE id=?`).get(uid);
  const insNotif = db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`);
  for (const u of hqUsers) {
    insNotif.run(u.id, '學員申請接案', `${me?.name} 申請接案 ${c.id}（${apply_type}）`, c.id, `/case-detail?id=${c.id}`);
  }

  res.json({ ok: true });
});

// GET /api/marketplace/applications — 總部查看所有申請（需 manage_users）
router.get('/applications', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { status } = req.query;
  let where = '1=1';
  const params = [];
  if (status) { where += ' AND ca.status=?'; params.push(status); }
  const rows = db.prepare(`
    SELECT ca.*, c.case_number, c.title, c.case_type, c.location,
           u.name AS applicant_name, u.username AS applicant_username,
           rv.name AS reviewer_name
    FROM case_applications ca
    JOIN cases c ON c.id = ca.case_id
    JOIN users u ON u.id = ca.applicant_id
    LEFT JOIN users rv ON rv.id = ca.reviewed_by
    WHERE ${where}
    ORDER BY ca.created_at DESC
  `).all(...params);
  res.json(rows);
});

// PUT /api/marketplace/applications/:id — 總部審核
router.put('/applications/:id', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { status, hq_note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: '無效狀態' });
  const app = db.prepare(`SELECT * FROM case_applications WHERE id=?`).get(req.params.id);
  if (!app) return res.status(404).json({ error: '申請不存在' });

  db.prepare(`UPDATE case_applications SET status=?, hq_note=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, hq_note || null, req.session.user.id, req.params.id);

  // 通知學員審核結果
  const result = status === 'approved' ? '✅ 申請通過' : '❌ 申請未通過';
  const c = db.prepare(`SELECT case_number, title FROM cases WHERE id=?`).get(app.case_id);
  db.prepare(`INSERT INTO notifications (user_id,title,body,type,entity,entity_id,url) VALUES (?,?,?,'dispatch','cases',?,?)`)
    .run(app.applicant_id, result, `案件 ${c?.case_number} ${c?.title}\n${hq_note || ''}`, app.case_id, `/marketplace`);

  // 審核通過 → 自動將學員設為此案件的承接者
  if (status === 'approved') {
    if (app.apply_type === 'full' || app.apply_type === 'install') {
      db.prepare(`UPDATE cases SET is_outsourced=1, outsource_type=? WHERE id=?`)
        .run(app.apply_type === 'full' ? 'full' : 'install_only', app.case_id);
    }
  }

  res.json({ ok: true });
});

// PUT /api/cases/:id/outsource-setting — 總部設定開放外包
router.put('/case-setting/:id', requireAuth, (req, res) => {
  if (!req.session.user.manage_users) return res.status(403).json({ error: '權限不足' });
  const { outsource_open, outsource_types } = req.body;
  db.prepare(`UPDATE cases SET outsource_open=?, outsource_types=? WHERE id=?`)
    .run(outsource_open ? 1 : 0, JSON.stringify(outsource_types || []), req.params.id);
  res.json({ ok: true });
});

// GET /api/marketplace/student/:uid — 學員評分統計
router.get('/student/:uid', requireAuth, (req, res) => {
  const ratings = db.prepare(`
    SELECT cr.score, cr.comment, cr.created_at, c.case_number, c.title
    FROM case_ratings cr
    JOIN cases c ON c.id = cr.case_id
    WHERE cr.student_id = ?
    ORDER BY cr.created_at DESC
  `).all(req.params.uid);
  const avg = ratings.length ? (ratings.reduce((s,r)=>s+r.score,0)/ratings.length).toFixed(1) : null;
  res.json({ ratings, avg, count: ratings.length });
});

// POST /api/marketplace/rate/:caseId — 客戶評分（via share token 或登入）
router.post('/rate/:caseId', (req, res) => {
  const { student_id, score, comment } = req.body;
  if (!student_id || !score || score < 1 || score > 5) return res.status(400).json({ error: '請填寫評分（1-5）' });
  try {
    db.prepare(`INSERT INTO case_ratings (case_id, student_id, score, comment) VALUES (?,?,?,?)`)
      .run(req.params.caseId, student_id, score, comment || null);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: '已評分過' }); }
});

module.exports = router;
