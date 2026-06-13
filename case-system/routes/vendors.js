const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

function requireVendorAccess(req, res, next) {
  const role = req.session.user?.role;
  if (role !== 'owner' && role !== 'hq_accounting') {
    return res.status(403).json({ error: '無權限' });
  }
  next();
}

// ── 供應商 CRUD ───────────────────────────────────────────────────

router.get('/', requireAuth, requireVendorAccess, (req, res) => {
  const rows = db.prepare(`
    SELECT v.*, GROUP_CONCAT(vb.brand, '、') as brands
    FROM vendors v
    LEFT JOIN vendor_brands vb ON vb.vendor_id = v.id
    WHERE v.active=1
    GROUP BY v.id
    ORDER BY v.name
  `).all();
  res.json(rows);
});

router.get('/:id', requireAuth, requireVendorAccess, (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: '找不到供應商' });
  v.brands = db.prepare(`SELECT * FROM vendor_brands WHERE vendor_id=? ORDER BY brand`).all(v.id);
  res.json(v);
});

router.post('/', requireAuth, requireVendorAccess, (req, res) => {
  const { name, contact, phone, email, address,
          bank_name, bank_branch, bank_account, bank_account_name,
          payment_terms, notes, category } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填入供應商名稱' });
  try {
    const r = db.prepare(`
      INSERT INTO vendors (name, category, contact, phone, email, address,
        bank_name, bank_branch, bank_account, bank_account_name,
        payment_terms, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(name.trim(), category||'other', contact||null, phone||null, email||null, address||null,
           bank_name||null, bank_branch||null, bank_account||null, bank_account_name||null,
           payment_terms||null, notes||null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '供應商名稱已存在' });
    throw e;
  }
});

router.put('/:id', requireAuth, requireVendorAccess, (req, res) => {
  const { name, contact, phone, email, address,
          bank_name, bank_branch, bank_account, bank_account_name,
          payment_terms, notes, active, category } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填入供應商名稱' });
  const v = db.prepare(`SELECT id FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: '找不到供應商' });
  try {
    db.prepare(`
      UPDATE vendors SET name=?, category=?, contact=?, phone=?, email=?, address=?,
        bank_name=?, bank_branch=?, bank_account=?, bank_account_name=?,
        payment_terms=?, notes=?, active=?
      WHERE id=?
    `).run(name.trim(), category||'other', contact||null, phone||null, email||null, address||null,
           bank_name||null, bank_branch||null, bank_account||null, bank_account_name||null,
           payment_terms||null, notes||null, active??1, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '供應商名稱已存在' });
    throw e;
  }
});

router.delete('/:id', requireAuth, requireVendorAccess, (req, res) => {
  if (req.query.permanent === '1') {
    if (req.session.user.role !== 'owner') return res.status(403).json({ error: '僅限老闆可永久刪除供應商' });
    const poCount = db.prepare(`SELECT COUNT(*) cnt FROM purchase_orders WHERE vendor_id=?`).get(req.params.id).cnt;
    if (poCount > 0) return res.status(400).json({ error: `此供應商有 ${poCount} 筆採購單記錄，無法刪除（可改用「停用」）` });
    db.prepare(`DELETE FROM vendor_brands WHERE vendor_id=?`).run(req.params.id);
    db.prepare(`DELETE FROM vendors WHERE id=?`).run(req.params.id);
  } else {
    db.prepare(`UPDATE vendors SET active=0 WHERE id=?`).run(req.params.id);
  }
  res.json({ ok: true });
});

// ── 品牌對應 ──────────────────────────────────────────────────────

router.get('/:id/brands', requireAuth, requireVendorAccess, (req, res) => {
  res.json(db.prepare(`SELECT * FROM vendor_brands WHERE vendor_id=? ORDER BY brand`).all(req.params.id));
});

router.post('/:id/brands', requireAuth, requireVendorAccess, (req, res) => {
  const { brand, notes } = req.body;
  if (!brand?.trim()) return res.status(400).json({ error: '請填入品牌名稱' });
  try {
    const r = db.prepare(`INSERT INTO vendor_brands (vendor_id, brand, notes) VALUES (?,?,?)`)
      .run(req.params.id, brand.trim(), notes||null);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '此品牌已存在' });
    throw e;
  }
});

router.delete('/:vendorId/brands/:brandId', requireAuth, requireVendorAccess, (req, res) => {
  db.prepare(`DELETE FROM vendor_brands WHERE id=? AND vendor_id=?`).run(req.params.brandId, req.params.vendorId);
  res.json({ ok: true });
});

module.exports = router;
