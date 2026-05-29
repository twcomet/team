const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const TYPE_LABELS = { catalog: '膜料本', sample: '樣本費', other: '其他預收款' };

// ── 列出某客戶的預收款 ────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { client_id, status } = req.query;
  if (!client_id) return res.status(400).json({ error: '缺少 client_id' });

  const where = ['cd.client_id = ?'];
  const params = [client_id];
  if (status) { where.push('cd.status = ?'); params.push(status); }

  const rows = db.prepare(`
    SELECT cd.*,
           c.case_number AS applied_case_number,
           u.name AS created_by_name
    FROM client_deposits cd
    LEFT JOIN cases c ON cd.applied_case_id = c.id
    LEFT JOIN users u ON cd.created_by = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY cd.collected_at DESC, cd.created_at DESC
  `).all(...params);

  res.json(rows);
});

// ── 新增預收款 ────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const { client_id, type = 'catalog', amount, collected_at, note, product_name } = req.body;
  if (!client_id) return res.status(400).json({ error: '缺少 client_id' });
  if (type !== 'sample' && (!amount || parseFloat(amount) <= 0))
    return res.status(400).json({ error: '金額必須大於 0' });

  const r = db.prepare(`
    INSERT INTO client_deposits (client_id, type, amount, collected_at, note, product_name, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(client_id, type, parseFloat(amount) || 0, collected_at || null, note || null,
         product_name || null, req.session.user.id);

  res.json({ ok: true, id: r.lastInsertRowid });
});

// ── 更新狀態（applied / forfeited / refunded / pending）────────
router.patch('/:id/status', requireAuth, (req, res) => {
  const { status, applied_case_id, waive_note } = req.body;
  const allowed = ['pending', 'applied', 'forfeited', 'refunded'];
  if (!allowed.includes(status)) return res.status(400).json({ error: '無效狀態' });

  const dep = db.prepare(`SELECT * FROM client_deposits WHERE id = ?`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'not found' });

  const appliedAt = status === 'applied' ? new Date().toISOString().slice(0, 10) : null;
  const caseId    = status === 'applied' ? (applied_case_id || null) : null;

  db.prepare(`
    UPDATE client_deposits
    SET status=?, applied_case_id=?, applied_at=?, waive_note=?
    WHERE id=?
  `).run(status, caseId, appliedAt, waive_note || null, req.params.id);

  res.json({ ok: true });
});

// ── 刪除（僅限待折抵狀態）────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const dep = db.prepare(`SELECT status FROM client_deposits WHERE id = ?`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: '只有待折抵的預收款可以刪除' });
  db.prepare(`DELETE FROM client_deposits WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 取得案件可折抵的預收款（待折抵 + 該案件已套用）────────────
router.get('/for-case/:case_id', requireAuth, (req, res) => {
  const c = db.prepare(`SELECT client_id, survey_fee, survey_fee_paid, survey_fee_actual, survey_fee_credited FROM cases WHERE id = ?`).get(req.params.case_id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const deposits = c.client_id ? db.prepare(`
    SELECT cd.*, cc.case_number AS applied_case_number
    FROM client_deposits cd
    LEFT JOIN cases cc ON cd.applied_case_id = cc.id
    WHERE cd.client_id = ? AND (cd.status = 'pending' OR cd.applied_case_id = ?)
    ORDER BY cd.collected_at DESC
  `).all(c.client_id, req.params.case_id) : [];

  res.json({
    deposits,
    survey_fee:         c.survey_fee,
    survey_fee_paid:    !!c.survey_fee_paid,
    survey_fee_actual:  c.survey_fee_actual,
    survey_fee_credited: !!c.survey_fee_credited,
  });
});

module.exports = router;
