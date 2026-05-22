const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

function isAssignedOrOwner(uid, role, caseId) {
  if (role === 'owner') return true;
  return db.prepare(`
    SELECT 1 FROM cases c WHERE c.id = ?
    AND (c.surveyor_id = ? OR c.sales_id = ?
      OR EXISTS (
        SELECT 1 FROM dispatches d
        JOIN dispatch_users du ON du.dispatch_id = d.id
        WHERE d.case_id = c.id AND du.user_id = ?
      ))
  `).get(caseId, uid, uid, uid);
}

// GET /api/dispatch-detail/:id
router.get('/:id', requireAuth, (req, res) => {
  const { id: uid, role } = req.session.user;
  const caseId = req.params.id;

  if (!isAssignedOrOwner(uid, role, caseId))
    return res.status(403).json({ error: '無權限' });

  const c = db.prepare(`
    SELECT c.id, c.case_number, c.title, c.description, c.location,
           c.case_type, c.scheduled_date, c.survey_date, c.status,
           c.notes, c.entry_info, c.photo_upload_url,
           cl.name AS client_name, cl.phone AS client_phone,
           cl.address AS client_address, cl.contact_person
    FROM cases c
    LEFT JOIN clients cl ON c.client_id = cl.id
    WHERE c.id = ?
  `).get(caseId);

  if (!c) return res.status(404).json({ error: '案件不存在' });

  const dispatches = db.prepare(`
    SELECT d.*,
      GROUP_CONCAT(us.name, '、') AS workers
    FROM dispatches d
    LEFT JOIN dispatch_users du ON du.dispatch_id = d.id
    LEFT JOIN users us ON us.id = du.user_id
    WHERE d.case_id = ?
    GROUP BY d.id
    ORDER BY d.scheduled_date, d.scheduled_time
  `).all(caseId);

  const myDispatchIds = db.prepare(`
    SELECT d.id FROM dispatches d
    JOIN dispatch_users du ON du.dispatch_id = d.id
    WHERE d.case_id = ? AND du.user_id = ?
  `).all(caseId, uid).map(r => r.id);

  const materials = myDispatchIds.length
    ? db.prepare(`
        SELECT dm.*, u.name AS recorder_name
        FROM dispatch_materials dm
        LEFT JOIN users u ON u.id = dm.created_by
        WHERE dm.dispatch_id IN (${myDispatchIds.map(() => '?').join(',')})
        ORDER BY dm.created_at DESC
      `).all(...myDispatchIds)
    : [];

  const items = db.prepare(`
    SELECT description, material_brand, material_model, area, quantity, unit, location, notes
    FROM case_items WHERE case_id = ? ORDER BY sort_order, id
  `).all(caseId);

  res.json({ ...c, dispatches, myDispatchIds, materials, items });
});

// POST /api/dispatch-detail/:id/material
router.post('/:id/material', requireAuth, (req, res) => {
  const { id: uid, role } = req.session.user;
  const caseId = req.params.id;

  if (!isAssignedOrOwner(uid, role, caseId))
    return res.status(403).json({ error: '無權限' });

  const { dispatch_id, film_brand, film_model, meters_used, unit_cost, notes } = req.body;
  if (!film_model) return res.status(400).json({ error: '請填寫膜料型號' });

  db.prepare(`
    INSERT INTO dispatch_materials (dispatch_id, case_id, film_brand, film_model, meters_used, unit_cost, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(dispatch_id, caseId, film_brand || null, film_model, meters_used || 0, unit_cost || 0, notes || null, uid);

  res.json({ ok: true });
});

// DELETE /api/dispatch-detail/:id/material/:mid
router.delete('/:id/material/:mid', requireAuth, (req, res) => {
  const { id: uid, role } = req.session.user;
  const rec = db.prepare(`SELECT * FROM dispatch_materials WHERE id = ?`).get(req.params.mid);
  if (!rec) return res.status(404).json({ error: '不存在' });
  if (rec.created_by !== uid && role !== 'owner')
    return res.status(403).json({ error: '無權限' });
  db.prepare(`DELETE FROM dispatch_materials WHERE id = ?`).run(req.params.mid);
  res.json({ ok: true });
});

module.exports = router;
