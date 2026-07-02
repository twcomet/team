const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ── 我的任務清單 ──────────────────────────────────────────────
// 顯示條件：
//   1. 被加入派工（dispatch_users）
//   2. 被指派為場勘人員（surveyor_id）
//   3. 被明確指派為業務/客服（收到 assign 型通知）
// 排除：靜態設定的業務欄位（sales_id）不會自動觸發
// 排除：使用者已點「已完成」但無新派工或新指派的案件
router.get('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const tasks = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.scheduled_date, c.survey_date,
           c.quoted_price, c.final_price, c.payment_status, c.location,
           c.sales_id, c.cs_id,
           cl.name AS client_name, cl.phone AS client_phone,
           sf.worker_token AS survey_worker_token,
           CASE WHEN c.surveyor_id = ? THEN 1 ELSE 0 END AS is_surveyor,
           (SELECT d.dispatch_type || '|' || d.scheduled_date
            FROM dispatches d JOIN dispatch_users du ON du.dispatch_id = d.id
            WHERE d.case_id = c.id AND du.user_id = ?
              AND d.status NOT IN ('cancelled')
              AND d.scheduled_date >= date('now','-1 day')
            ORDER BY d.scheduled_date ASC LIMIT 1) AS next_dispatch,
           (SELECT d.id FROM dispatches d JOIN dispatch_users du ON du.dispatch_id = d.id
            WHERE d.case_id = c.id AND du.user_id = ? AND d.status NOT IN ('cancelled')
              AND d.scheduled_date >= date('now','-1 day')
            ORDER BY d.scheduled_date ASC LIMIT 1) AS next_dispatch_id,
           (SELECT d.notes FROM dispatches d JOIN dispatch_users du ON du.dispatch_id = d.id
            WHERE d.case_id = c.id AND du.user_id = ? AND d.status NOT IN ('cancelled')
              AND d.scheduled_date >= date('now','-1 day')
            ORDER BY d.scheduled_date ASC LIMIT 1) AS next_dispatch_notes,
           (SELECT d.scheduled_time FROM dispatches d JOIN dispatch_users du ON du.dispatch_id = d.id
            WHERE d.case_id = c.id AND du.user_id = ? AND d.status NOT IN ('cancelled')
              AND d.scheduled_date >= date('now','-1 day')
            ORDER BY d.scheduled_date ASC LIMIT 1) AS next_dispatch_time,
           c.photo_upload_url, c.entry_info, c.desired_entry_date,
           (SELECT u.name FROM users u WHERE u.id = c.surveyor_id) AS surveyor_name,
           (SELECT COUNT(*) FROM dispatches d JOIN dispatch_users du ON du.dispatch_id = d.id
            WHERE d.case_id = c.id AND du.user_id = ?) AS dispatch_count,
           CASE WHEN EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = ? AND n.entity = 'cases' AND n.entity_id = c.id AND n.type = 'assign'
           ) THEN 1 ELSE 0 END AS was_assigned,
           CASE WHEN EXISTS (
             SELECT 1 FROM user_task_dismissals utd
             WHERE utd.user_id = ? AND utd.case_id = c.id
             AND NOT EXISTS (
               SELECT 1 FROM dispatches d2 JOIN dispatch_users du2 ON du2.dispatch_id = d2.id
               WHERE d2.case_id = c.id AND du2.user_id = ? AND d2.status NOT IN ('cancelled') AND d2.created_at > utd.dismissed_at
             )
             AND NOT EXISTS (
               SELECT 1 FROM notifications n2
               WHERE n2.user_id = ? AND n2.entity = 'cases' AND n2.entity_id = c.id AND n2.created_at > utd.dismissed_at
             )
           ) THEN 1 ELSE 0 END AS is_done,
           (SELECT COUNT(*) FROM work_reports w WHERE w.case_id = c.id AND w.reporter_id = ?) AS my_report_count
    FROM cases c
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN survey_forms sf ON sf.case_id = c.id
    WHERE c.status NOT IN ('closed','invalid')
      AND (
        c.surveyor_id = ?
        OR EXISTS (
          SELECT 1 FROM dispatches d JOIN dispatch_users du ON du.dispatch_id = d.id
          WHERE d.case_id = c.id AND du.user_id = ? AND d.status NOT IN ('cancelled')
        )
        OR EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = ? AND n.entity = 'cases' AND n.entity_id = c.id AND n.type = 'assign'
        )
      )
    ORDER BY
      CASE WHEN c.scheduled_date IS NOT NULL THEN c.scheduled_date ELSE '9999-12-31' END ASC,
      c.created_at DESC
  `).all(uid, uid, uid, uid, uid, uid, uid, uid, uid, uid, uid, uid, uid, uid);
  res.json(tasks);
});

// ── 標記已完成（移到「已完成」區，不消失、可再打開）─────────────
router.post('/:caseId/dismiss', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const caseId = parseInt(req.params.caseId);
  if (!caseId) return res.status(400).json({ error: 'invalid id' });
  db.prepare(`
    INSERT OR REPLACE INTO user_task_dismissals (user_id, case_id, dismissed_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(uid, caseId);
  res.json({ ok: true });
});

// ── 取消完成（把任務從「已完成」拉回進行中）───────────────────
router.post('/:caseId/undismiss', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const caseId = parseInt(req.params.caseId);
  if (!caseId) return res.status(400).json({ error: 'invalid id' });
  db.prepare(`DELETE FROM user_task_dismissals WHERE user_id=? AND case_id=?`).run(uid, caseId);
  res.json({ ok: true });
});

module.exports = router;
