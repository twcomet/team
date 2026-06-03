const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const TYPE_LABELS = { catalog: '膜料本', sample: '樣本費', survey_fee: '場勘費', other: '其他預收款' };

// ── 列出所有預收款（全域管理頁用）──────────────────────────────
router.get('/all', requireAuth, (req, res) => {
  const { type, status, accounting_verified } = req.query;
  const where = ['1=1'];
  const params = [];
  if (type)   { where.push('cd.type = ?');   params.push(type); }
  if (status) { where.push('cd.status = ?'); params.push(status); }
  if (accounting_verified !== undefined && accounting_verified !== '') {
    where.push('cd.accounting_verified = ?');
    params.push(parseInt(accounting_verified));
  }
  const rows = db.prepare(`
    SELECT cd.*,
           cl.name AS client_name,
           ac.case_number AS applied_case_number,
           lc.case_number AS linked_case_number,
           u.name  AS created_by_name,
           av.name AS verified_by_name
    FROM client_deposits cd
    LEFT JOIN clients cl ON cd.client_id = cl.id
    LEFT JOIN cases ac   ON cd.applied_case_id = ac.id
    LEFT JOIN cases lc   ON cd.linked_case_id  = lc.id
    LEFT JOIN users u    ON cd.created_by = u.id
    LEFT JOIN users av   ON cd.accounting_verified_by = av.id
    WHERE ${where.join(' AND ')}
    ORDER BY cd.collected_at DESC, cd.created_at DESC
  `).all(...params);
  res.json(rows);
});

// ── 列出某客戶的預收款 ────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { client_id, status } = req.query;
  if (!client_id) return res.status(400).json({ error: '缺少 client_id' });

  const where = ['cd.client_id = ?'];
  const params = [client_id];
  if (status) { where.push('cd.status = ?'); params.push(status); }

  const rows = db.prepare(`
    SELECT cd.*,
           c.case_number  AS applied_case_number,
           lc.case_number AS linked_case_number,
           u.name AS created_by_name,
           av.name AS verified_by_name
    FROM client_deposits cd
    LEFT JOIN cases c    ON cd.applied_case_id = c.id
    LEFT JOIN cases lc   ON cd.linked_case_id  = lc.id
    LEFT JOIN users u    ON cd.created_by = u.id
    LEFT JOIN users av   ON cd.accounting_verified_by = av.id
    WHERE ${where.join(' AND ')}
    ORDER BY cd.collected_at DESC, cd.created_at DESC
  `).all(...params);

  res.json(rows);
});

// ── 新增預收款 ────────────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  const { client_id, type = 'catalog', amount, collected_at, note, product_name, linked_case_id } = req.body;
  if (!client_id) return res.status(400).json({ error: '缺少 client_id' });
  if (type !== 'sample' && (!amount || parseFloat(amount) <= 0))
    return res.status(400).json({ error: '金額必須大於 0' });
  if (type === 'survey_fee' && !linked_case_id)
    return res.status(400).json({ error: '場勘費必須關聯案件' });

  try {
    const amt = parseFloat(amount) || 0;
    const dateVal = collected_at || new Date().toISOString().slice(0, 10);
    const typeLabel = TYPE_LABELS[type] || '預收款';
    const client = db.prepare(`SELECT name FROM clients WHERE id=?`).get(client_id);
    if (!client) return res.status(400).json({ error: '找不到客戶，請重新選擇' });
    const clientName = client.name;

    const initCaseId = linked_case_id ? parseInt(linked_case_id) : null;
    const r = db.prepare(`
      INSERT INTO client_deposits (client_id, type, amount, collected_at, note, product_name, linked_case_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(parseInt(client_id), type, amt, dateVal, note || null,
           product_name || null, initCaseId, req.session.user.id);

    // 同步寫入收支流水帳
    if (amt > 0) {
      const org = db.prepare(`SELECT org_id FROM clients WHERE id=?`).get(client_id);
      db.prepare(`
        INSERT INTO ledger_entries (date, type, category, amount, description, org_id, created_by, source_ref)
        VALUES (?, 'income', ?, ?, ?, ?, ?, ?)
      `).run(
        dateVal,
        typeLabel,
        amt,
        `${clientName}－${typeLabel}${product_name ? `（${product_name}）` : ''}${note ? `，${note}` : ''}`,
        org?.org_id || null,
        req.session.user.id,
        `client_deposit:${r.lastInsertRowid}`
      );
    }

    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    console.error('新增預收款失敗:', e.message);
    res.status(500).json({ error: '儲存失敗：' + e.message });
  }
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

// ── 會計核銷 ──────────────────────────────────────────────────
router.patch('/:id/verify', requireAuth, (req, res) => {
  const dep = db.prepare(`SELECT * FROM client_deposits WHERE id = ?`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'not found' });
  if (dep.accounting_verified) return res.status(400).json({ error: '此筆預收款已核銷' });

  db.prepare(`
    UPDATE client_deposits
    SET accounting_verified=1, accounting_verified_at=?, accounting_verified_by=?
    WHERE id=?
  `).run(new Date().toISOString(), req.session.user.id, req.params.id);

  res.json({ ok: true });
});

// ── 刪除（owner / hq_accounting / can_delete，且限待折抵未核銷）──
router.delete('/:id', requireAuth, (req, res) => {
  const me = req.session.user;
  if (me.role !== 'owner' && me.role !== 'hq_accounting' && !me.can_delete) return res.status(403).json({ error: '無刪除權限' });
  const dep = db.prepare(`SELECT status, accounting_verified FROM client_deposits WHERE id = ?`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: '只有待折抵的預收款可以刪除' });
  if (dep.accounting_verified) return res.status(400).json({ error: '已核銷的預收款無法刪除' });
  db.prepare(`DELETE FROM client_deposits WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 取得案件可折抵的預收款（已核銷待折抵 + 該案件已套用）────────
router.get('/for-case/:case_id', requireAuth, (req, res) => {
  const c = db.prepare(`SELECT client_id, survey_fee, survey_fee_paid, survey_fee_actual, survey_fee_credited FROM cases WHERE id = ?`).get(req.params.case_id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const deposits = c.client_id ? db.prepare(`
    SELECT cd.*, cc.case_number AS applied_case_number
    FROM client_deposits cd
    LEFT JOIN cases cc ON cd.applied_case_id = cc.id
    WHERE cd.client_id = ?
      AND (
        (cd.status = 'pending' AND cd.accounting_verified = 1)
        OR cd.applied_case_id = ?
      )
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
