const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const tasks = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.status, c.scheduled_date, c.survey_date,
           c.quoted_price, c.final_price, c.payment_status,
           cl.name AS client_name, cl.phone AS client_phone
    FROM cases c
    LEFT JOIN clients cl ON c.client_id = cl.id
    WHERE c.status NOT IN ('closed','invalid')
      AND (
        c.surveyor_id = ?
        OR c.sales_id = ?
        OR c.id IN (
          SELECT d.case_id FROM dispatches d
          JOIN dispatch_users du ON du.dispatch_id = d.id
          WHERE du.user_id = ?
        )
      )
    ORDER BY
      CASE WHEN c.scheduled_date IS NOT NULL THEN c.scheduled_date ELSE '9999-12-31' END,
      c.created_at DESC
  `).all(uid, uid, uid);
  res.json(tasks);
});

module.exports = router;
