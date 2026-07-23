const express = require('express');
const router  = express.Router();
const db      = require('../db');
const gdrive  = require('../lib/gdrive');
const { requireAuth } = require('../middleware/auth');
const { createBindToken, buildBindLink } = require('../lib/client-bind');

// ── 列表（含分頁、狀態篩選、關鍵字搜尋）──────────────────────────
router.get('/', requireAuth, (req, res) => {
  const { status, q, page = 1, limit = 40, case_status } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const where  = [];
  const params = [];

  const wantGroup = req.query.is_group === '1' || req.query.is_group === 'true';
  if (wantGroup) where.push(`i.is_group=1`);   // 群組篩選：不管名稱/狀態，一律列出所有群組對話

  if (case_status) {
    // 依「關聯案件狀態」撈：跨全部詢問（不限詢問本身狀態），比對該客戶的案件階段
    where.push(`COALESCE(cc.status, (SELECT status FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) = ?`);
    params.push(case_status);
  } else if (q && (!status || status === 'all')) {
    // 搜尋 + 全部：跨「所有狀態」搜（含已轉案 / 無效 / 結案 / 隱藏），確保任何客戶都找得到
    // 不加任何狀態限制
  } else if (wantGroup && (!status || status === 'all')) {
    // 群組篩選 + 全部：列出所有群組（跨全狀態），不再限縮 new/in_progress
  } else if (!status || status === 'all') {
    // 全部（瀏覽，未搜尋）：待處理收件匣 = 新詢問 + 進行中，與上方「全部」badge 一致
    // 已轉案有自己的分頁；要找已轉案客戶請用搜尋（搜尋會跨所有狀態）
    where.push(`i.status IN ('new','in_progress')`);
  } else if (status === 'converted') {
    // 已轉案：排除案件已結案或已設為無效保存的
    where.push(`i.status='converted' AND (cc.status IS NULL OR cc.status NOT IN ('closed','invalid'))`);
  } else if (status === 'invalid') {
    // 無效：(1) 詢問本身標記無效 + (2) 已轉案但案件被設為無效保存
    where.push(`(i.status='invalid' OR (i.status='converted' AND cc.status='invalid'))`);
  } else if (status === 'case_closed') {
    // 結案：已轉案且對應案件已結案
    where.push(`(i.status='converted' AND cc.status='closed')`);
  } else {
    where.push(`i.status=?`); params.push(status);
  }

  if (q) {
    // 搜尋範圍：暱稱 / 最後訊息 / 客服備註 / 該客戶所有案件的編號與案名 / 所有對話內容
    where.push(`(
      i.display_name LIKE ? OR i.last_message LIKE ? OR i.staff_note LIKE ?
      OR EXISTS (SELECT 1 FROM cases xc
                 WHERE (xc.client_id = i.client_id OR xc.line_source = i.line_user_id)
                   AND (xc.case_number LIKE ? OR xc.title LIKE ?))
      OR EXISTS (SELECT 1 FROM line_inquiry_messages m
                 WHERE m.inquiry_id = i.id AND m.content LIKE ?)
      OR EXISTS (SELECT 1 FROM line_inquiry_notes n
                 WHERE n.inquiry_id = i.id AND n.content LIKE ?)
    )`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const ws = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`
    SELECT COUNT(*) as n FROM line_inquiries i
    LEFT JOIN cases cc ON i.converted_case_id = cc.id ${ws}
  `).get(...params)?.n || 0;

  const rows  = db.prepare(`
    SELECT i.*,
           c.phone, c.email, c.address,
           cc.case_number AS converted_case_number,
           cc.status      AS converted_case_status,
           su.name AS sales_name,
           cu.name AS cs_name,
           o.name  AS org_name,
           o.type  AS org_type,
           (SELECT m.direction FROM line_inquiry_messages m WHERE m.inquiry_id=i.id ORDER BY m.id DESC LIMIT 1) AS last_dir,
           COALESCE(cc.status,      (SELECT status      FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_status,
           COALESCE(cc.case_number, (SELECT case_number FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_number,
           COALESCE(cc.id,          (SELECT id          FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_id,
           COALESCE(cc.title,       (SELECT title       FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_title
    FROM line_inquiries i
    LEFT JOIN clients c  ON i.client_id = c.id
    LEFT JOIN cases   cc ON i.converted_case_id = cc.id
    LEFT JOIN users   su ON i.sales_id = su.id
    LEFT JOIN users   cu ON i.cs_id = cu.id
    LEFT JOIN orgs    o  ON i.org_id = o.id
    ${ws}
    ORDER BY i.last_message_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({ rows, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── 狀態統計（用於 badge）────────────────────────────────────
router.get('/stats', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN i.status='new'         THEN 1 ELSE 0 END) as new,
      SUM(CASE WHEN i.status='in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN i.status='converted'   AND (cc.status IS NULL OR cc.status NOT IN ('closed','invalid')) THEN 1 ELSE 0 END) as converted,
      SUM(CASE WHEN i.status='invalid'     OR  (i.status='converted' AND cc.status='invalid') THEN 1 ELSE 0 END) as invalid,
      SUM(CASE WHEN i.status='hidden'      THEN 1 ELSE 0 END) as hidden,
      SUM(CASE WHEN i.status='converted'   AND cc.status='closed' THEN 1 ELSE 0 END) as case_closed,
      SUM(CASE WHEN i.status IN ('new','in_progress')
                AND i.last_message_at >= datetime('now','-7 days')
                AND (i.replied_at IS NULL OR i.replied_at < i.last_message_at)
                AND (SELECT m.direction FROM line_inquiry_messages m WHERE m.inquiry_id=i.id ORDER BY m.id DESC LIMIT 1)='in'
               THEN 1 ELSE 0 END) as awaiting,
      SUM(CASE WHEN i.status IN ('new','in_progress') AND i.ai_needs_human=1 THEN 1 ELSE 0 END) as needs_human,
      SUM(CASE WHEN i.status='converted' AND (cc.status IS NULL OR cc.status NOT IN ('closed','invalid'))
                AND i.last_message_at >= datetime('now','-7 days')
                AND (i.replied_at IS NULL OR i.replied_at < i.last_message_at)
                AND (SELECT m.direction FROM line_inquiry_messages m WHERE m.inquiry_id=i.id ORDER BY m.id DESC LIMIT 1)='in'
               THEN 1 ELSE 0 END) as converted_awaiting
    FROM line_inquiries i
    LEFT JOIN cases cc ON i.converted_case_id = cc.id
  `).get();
  res.json({
    new:         row.new         || 0,
    in_progress: row.in_progress || 0,
    converted:   row.converted   || 0,
    invalid:     row.invalid     || 0,
    hidden:      row.hidden      || 0,
    case_closed: row.case_closed || 0,
    awaiting:    row.awaiting     || 0,
    needs_human: row.needs_human || 0,
    converted_awaiting: row.converted_awaiting || 0,
  });
});

// ── 單筆詳情 + 對話記錄 ──────────────────────────────────────
// ── 所有用過的標籤（供新增時自動完成／快速選用）── 需定義在 /:id 之前，否則會被 /:id 攔截
router.get('/tags/all', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT tags FROM line_inquiries WHERE tags IS NOT NULL AND tags!='' AND tags!='[]'`).all();
  const set = new Set();
  for (const r of rows) { try { (JSON.parse(r.tags) || []).forEach(t => { const s = String(t || '').trim(); if (s) set.add(s); }); } catch {} }
  res.json({ tags: [...set].sort() });
});

router.get('/:id', requireAuth, (req, res) => {
  const inq = db.prepare(`
    SELECT i.*, c.phone, c.email, c.address,
           c.name AS client_name, c.line_user_id AS client_line_user_id, c.bind_org_mismatch AS client_bind_mismatch,
           cc.case_number AS converted_case_number,
           su.name AS sales_name, su.id AS sales_id_val,
           cu.name AS cs_name,    cu.id AS cs_id_val,
           o.name  AS org_name,
           o.type  AS org_type,
           COALESCE(cc.status,      (SELECT status      FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_status,
           COALESCE(cc.case_number, (SELECT case_number FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_number,
           COALESCE(cc.id,          (SELECT id          FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_id,
           COALESCE(cc.title,       (SELECT title       FROM cases WHERE (client_id=i.client_id OR line_source=i.line_user_id) AND status NOT IN ('closed','invalid') ORDER BY id DESC LIMIT 1)) AS cust_case_title
    FROM line_inquiries i
    LEFT JOIN clients c  ON i.client_id = c.id
    LEFT JOIN cases   cc ON i.converted_case_id = cc.id
    LEFT JOIN users   su ON i.sales_id = su.id
    LEFT JOIN users   cu ON i.cs_id = cu.id
    LEFT JOIN orgs    o  ON i.org_id = o.id
    WHERE i.id=?
  `).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });

  const messages = db.prepare(`
    SELECT m.*, u.name AS sender_name
    FROM line_inquiry_messages m
    LEFT JOIN users u ON m.sent_by = u.id
    WHERE m.inquiry_id=?
    ORDER BY m.created_at ASC, m.id ASC
  `).all(req.params.id);

  // 這位客人名下的所有案件（一個客人可有多筆訂單 → 多顆「進案場」按鈕）
  const custCases = db.prepare(`
    SELECT id, case_number, title, status FROM cases
    WHERE (client_id = ? OR line_source = ?) AND status NOT IN ('invalid')
    ORDER BY id DESC LIMIT 12
  `).all(inq.client_id, inq.line_user_id);

  res.json({ ...inq, messages, cust_cases: custCases });
});

// ── 指派負責業務 / 負責客服 ───────────────────────────────────
router.put('/:id/assign', requireAuth, (req, res) => {
  const { sales_id, cs_id } = req.body;
  db.prepare(`UPDATE line_inquiries SET sales_id=?, cs_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(sales_id || null, cs_id || null, req.params.id);
  res.json({ ok: true });
});

// ── 更新狀態 ─────────────────────────────────────────────────
router.put('/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  if (!['new', 'in_progress', 'invalid', 'hidden'].includes(status))
    return res.status(400).json({ error: 'invalid status' });
  db.prepare(`UPDATE line_inquiries SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, req.params.id);
  res.json({ ok: true });
});

// ── 更新備註 ─────────────────────────────────────────────────
router.put('/:id/note', requireAuth, (req, res) => {
  const { note } = req.body;
  db.prepare(`UPDATE line_inquiries SET staff_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(note ?? null, req.params.id);
  res.json({ ok: true });
});

// ── 記事本（多筆內部備註，客人看不到）───────────────────────────
router.get('/:id/notes', requireAuth, (req, res) => {
  // 舊的單筆「內部備註」(staff_note) 首次載入時自動搬進記事本，並清空原欄位（冪等）
  const inq = db.prepare(`SELECT staff_note FROM line_inquiries WHERE id=?`).get(req.params.id);
  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM line_inquiry_notes WHERE inquiry_id=?`).get(req.params.id);
  if (inq && (inq.staff_note || '').trim() && cnt.n === 0) {
    const u = req.session.user;
    db.prepare(`INSERT INTO line_inquiry_notes (inquiry_id, content, created_by, created_by_name) VALUES (?,?,?,?)`)
      .run(req.params.id, inq.staff_note, u.id, u.name);
    db.prepare(`UPDATE line_inquiries SET staff_note='' WHERE id=?`).run(req.params.id);
  }
  const rows = db.prepare(`SELECT id, content, created_by_name, created_at, updated_at
    FROM line_inquiry_notes WHERE inquiry_id=? ORDER BY id DESC`).all(req.params.id);
  res.json(rows);
});
router.post('/:id/notes', requireAuth, (req, res) => {
  const content = (req.body && req.body.content || '').toString();
  const u = req.session.user;
  const info = db.prepare(`INSERT INTO line_inquiry_notes (inquiry_id, content, created_by, created_by_name)
    VALUES (?,?,?,?)`).run(req.params.id, content, u.id, u.name);
  const row = db.prepare(`SELECT id, content, created_by_name, created_at, updated_at
    FROM line_inquiry_notes WHERE id=?`).get(info.lastInsertRowid);
  res.json({ ok: true, note: row });
});
router.put('/:id/notes/:noteId', requireAuth, (req, res) => {
  const content = (req.body && req.body.content || '').toString();
  const info = db.prepare(`UPDATE line_inquiry_notes SET content=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND inquiry_id=?`).run(content, req.params.noteId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
router.delete('/:id/notes/:noteId', requireAuth, (req, res) => {
  const info = db.prepare(`DELETE FROM line_inquiry_notes WHERE id=? AND inquiry_id=?`)
    .run(req.params.noteId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── 更新客戶資料 ──────────────────────────────────────────────
router.put('/:id/client', requireAuth, (req, res) => {
  const { name, phone, email, address } = req.body;
  const inq = db.prepare(`SELECT client_id FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });

  if (inq.client_id) {
    const cols = []; const vals = [];
    if (name    !== undefined) { cols.push('name=?');    vals.push(name); }
    if (phone   !== undefined) { cols.push('phone=?');   vals.push(phone); }
    if (email   !== undefined) { cols.push('email=?');   vals.push(email); }
    if (address !== undefined) { cols.push('address=?'); vals.push(address); }
    if (cols.length)
      db.prepare(`UPDATE clients SET ${cols.join(',')} WHERE id=?`).run(...vals, inq.client_id);
  }
  if (name !== undefined) {
    const trimmed = (name || '').trim();
    if (trimmed) {
      // 手動輸入名稱 → 鎖定，之後新訊息不再覆蓋
      db.prepare(`UPDATE line_inquiries SET display_name=?, name_locked=1 WHERE id=?`).run(trimmed, req.params.id);
    } else {
      // 清空手動名稱 → 解鎖，恢復顯示 LINE 原始名稱
      db.prepare(`UPDATE line_inquiries SET display_name=COALESCE(NULLIF(line_original_name,''), display_name), name_locked=0 WHERE id=?`).run(req.params.id);
    }
  }
  res.json({ ok: true });
});

// ── 轉換為案件 ───────────────────────────────────────────────
router.post('/:id/convert', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq)                    return res.status(404).json({ error: 'not found' });
  if (inq.status === 'converted') return res.status(400).json({ error: '已轉案' });

  const { case_type = 'other', title, notes, to_survey } = req.body;
  const initStatus = to_survey ? 'survey_pending' : 'inquiry';   // 勾「直接約場勘」→ 案件直接進待排場勘
  const u   = req.session.user;
  const org = db.prepare(`SELECT id FROM orgs WHERE type='hq' LIMIT 1`).get();
  const orgId = org?.id || null;

  // 產生案件編號
  const now    = new Date();
  const prefix = `HX${String(now.getFullYear()).slice(-2)}${String(now.getMonth()+1).padStart(2,'0')}`;
  const last   = db.prepare(`SELECT case_number FROM cases WHERE case_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  const seq    = last ? (parseInt(last.case_number.split('-')[1]) || 0) + 1 : 1;
  const caseNumber = `${prefix}-${String(seq).padStart(3,'0')}`;

  const r = db.prepare(`
    INSERT INTO cases (
      case_number, org_id, case_type, client_id,
      title, description, line_source, source_type,
      status, case_group, priority, created_by,
      sales_id, cs_id, line_display_name, line_official_name, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'line', ?, 'inquiry', 'normal', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    caseNumber, orgId, case_type, inq.client_id,
    title || inq.display_name || '（未命名）',
    notes || inq.last_message || '',
    inq.line_user_id, initStatus, u.id,
    inq.sales_id || null, inq.cs_id || null,
    inq.display_name || null, inq.display_name || null
  );
  if (to_survey) db.prepare(`UPDATE cases SET survey_pending_at=CURRENT_TIMESTAMP WHERE id=?`).run(r.lastInsertRowid);

  db.prepare(`
    UPDATE line_inquiries
    SET status='converted', converted_case_id=?, converted_at=CURRENT_TIMESTAMP,
        converted_by=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(r.lastInsertRowid, u.id, inq.id);

  gdrive.safeEnsureCaseFolder(r.lastInsertRowid); // LINE 詢問轉案件也自動建雲端資料夾（best-effort，不阻塞）

  res.json({ ok: true, case_id: r.lastInsertRowid, case_number: caseNumber, to_survey: !!to_survey });
});

// ── 客戶標籤：儲存此詢問的標籤（JSON 陣列）──
router.put('/:id/tags', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT id FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });
  let tags = Array.isArray(req.body.tags) ? req.body.tags : [];
  tags = [...new Set(tags.map(t => String(t || '').trim()).filter(Boolean))].slice(0, 30);  // 去空白、去重、上限30
  db.prepare(`UPDATE line_inquiries SET tags=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(tags), inq.id);
  res.json({ ok: true, tags });
});

// ── 關聯到「現有案件」：把此 LINE 對話（含群組的 LINE ID）綁到既有案件 ──
// 用 converted_case_id 當綁定鍵（不污染案件的「Line@來源名稱」欄位）；並把群組名補進案件「LINE ID 名稱」
router.post('/:id/link-case', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });
  const caseId = parseInt(req.body.case_id);
  const cs = caseId ? db.prepare(`SELECT id, case_number, client_id, line_display_name FROM cases WHERE id=?`).get(caseId) : null;
  if (!cs) return res.status(404).json({ error: '找不到案件' });
  const u = req.session.user;

  // 詢問 → 綁到此案件（沿用轉案的 converted 機制；client 沒綁過就接上案件的客戶）
  db.prepare(`
    UPDATE line_inquiries
    SET status='converted', converted_case_id=?, converted_at=CURRENT_TIMESTAMP, converted_by=?,
        client_id=COALESCE(client_id, ?), updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(caseId, u.id, cs.client_id || null, inq.id);

  // 案件 → 補上「LINE ID 名稱」(群組/客戶顯示名)，讓案件頁看得到這段對話（原本有值就不覆蓋）
  db.prepare(`UPDATE cases SET line_display_name=COALESCE(NULLIF(line_display_name,''), ?), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(inq.display_name || null, caseId);

  res.json({ ok: true, case_id: caseId, case_number: cs.case_number });
});

// ── 透過 LINE 回覆客戶 ────────────────────────────────────────
router.post('/:id/reply', requireAuth, async (req, res) => {
  const { message, reply_to_id } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '訊息不可空白' });

  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });

  // 依「該詢問所屬的 LINE 頻道」取對應 token（多 OA/分店），查不到才退回預設；
  // 修：原本一律用預設 token，客人若在非預設 OA→LINE 回 200 但實際不會送達（訊息在系統看得到、客人卻收不到）
  let token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (inq.channel_id) {
    const ch = db.prepare(`SELECT channel_token, channel_name FROM line_channels WHERE id=?`).get(inq.channel_id);
    if (ch && ch.channel_token) token = ch.channel_token;
  }
  if (!token) return res.status(503).json({ error: 'LINE_CHANNEL_ACCESS_TOKEN 未設定' });

  // 針對某則訊息回覆：取該訊息的 quoteToken（LINE 引用回覆）＋內容快照（供本系統顯示）
  let quoteToken = null, replyPreview = null, replyToId = null;
  if (reply_to_id) {
    const src = db.prepare(`SELECT id, content, quote_token FROM line_inquiry_messages WHERE id=? AND inquiry_id=?`).get(reply_to_id, inq.id);
    if (src) { replyToId = src.id; replyPreview = (src.content || '').slice(0, 120); quoteToken = src.quote_token || null; }
  }

  // 傳送前先確認客人在此 OA 可被推播：非群組時查 profile，404/403＝未加好友/已封鎖/ID有誤
  // → LINE push 對非好友會回 200 但不送達（系統看得到、客人收不到）。先擋下來給客服明確提示，別假裝送出。
  if (!inq.is_group && inq.line_user_id) {
    try {
      const prof = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(inq.line_user_id), { headers: { Authorization: `Bearer ${token}` } });
      if (prof.status === 404 || prof.status === 403) {
        console.warn('[line reply] profile unreachable', { inquiry: inq.id, to: inq.line_user_id, status: prof.status });
        return res.status(409).json({ error: '這位客人在官方帳號查不到（可能沒把繪新官方帳號加為好友、已封鎖，或這通對話其實是從其他工具／群組進來的）。系統直接回覆會送不到他，請改用官方帳號後台回覆。' });
      }
    } catch (e) { /* profile 查詢失敗（網路等）不阻擋，仍嘗試推播 */ }
  }

  const outMsg = { type: 'text', text: message.trim() };
  if (quoteToken) outMsg.quoteToken = quoteToken;   // 只有客人訊息帶 quoteToken 時才能引用
  const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: inq.line_user_id, messages: [outMsg] })
  });

  if (!pushRes.ok) {
    const err = await pushRes.text().catch(() => '');
    console.error('[line reply push] FAIL', { inquiry: inq.id, channel_id: inq.channel_id, to: inq.line_user_id, status: pushRes.status, err });
    return res.status(502).json({ error: 'LINE 傳送失敗（' + pushRes.status + '）：' + (err || '請確認客人所在的 LINE 官方帳號與系統設定一致') });
  }
  // 200 也記一筆(含 x-line-request-id)，方便對照客人是否真的收到（LINE push 200 不代表一定送達，如客人已封鎖/非此 OA 好友）
  console.log('[line reply push] OK', { inquiry: inq.id, channel_id: inq.channel_id, to: inq.line_user_id, reqId: pushRes.headers.get('x-line-request-id') || '' });

  db.prepare(`
    INSERT INTO line_inquiry_messages (inquiry_id, direction, msg_type, content, sent_by, reply_to_id, reply_to_preview)
    VALUES (?, 'out', 'text', ?, ?, ?, ?)
  `).run(inq.id, message.trim(), req.session.user.id, replyToId, replyPreview);

  // 送出後清掉 AI 草稿（已由真人處理）
  db.prepare(`UPDATE line_inquiries SET updated_at=CURRENT_TIMESTAMP, ai_draft=NULL, ai_draft_at=NULL, ai_needs_human=0, ai_needs_human_reason=NULL WHERE id=?`).run(inq.id);
  res.json({ ok: true });
});

// ── 綁定客戶：選一筆客戶檔，把綁定連結推進這通對話 ────────────────
// 客人點連結送出綁定碼後，webhook 會把 line_user_id 綁到該客戶檔（並自動合併去重）
router.post('/:id/send-bind-link', requireAuth, async (req, res) => {
  const { client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: '請選擇要綁定的客戶' });

  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq)               return res.status(404).json({ error: 'not found' });
  if (inq.is_group)       return res.status(400).json({ error: '群組對話無法用此方式綁定客戶' });
  if (!inq.line_user_id)  return res.status(400).json({ error: '此對話沒有可推送的 LINE ID' });

  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(client_id);
  if (!client)            return res.status(404).json({ error: '找不到客戶' });

  // token 的建檔店別以客戶檔為準（跨店由 webhook 依實際 OA 判斷並標記）
  const code = createBindToken(client.id, client.org_id || null, req.session.user.id);
  if (!code)              return res.status(500).json({ error: '產生綁定碼失敗，請重試' });

  const proto  = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const origin = `${proto}://${req.get('host')}`;
  const { link } = buildBindLink(client, code, origin);

  // 依對話所屬 OA 取 token（多分店）
  let token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (inq.channel_id) {
    const ch = db.prepare(`SELECT channel_token FROM line_channels WHERE id=?`).get(inq.channel_id);
    if (ch && ch.channel_token) token = ch.channel_token;
  }
  if (!token) return res.status(503).json({ error: 'LINE token 未設定' });

  // 先確認客人在此 OA 可被推播（同 reply：非好友/封鎖會回 200 但送不到）
  try {
    const prof = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(inq.line_user_id), { headers: { Authorization: `Bearer ${token}` } });
    if (prof.status === 404 || prof.status === 403)
      return res.status(409).json({ error: '這位客人在此官方帳號查不到（可能沒加好友、已封鎖，或這通對話來自其他工具／群組），無法推送綁定連結。' });
  } catch (e) { /* profile 查詢失敗不阻擋 */ }

  const text = `${client.name} 您好 🙌\n請點下方連結完成 LINE 綁定，之後繪新會直接透過這裡傳送報價單、場勘與驗收等資料給您：\n${link}`;
  const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: inq.line_user_id, messages: [{ type: 'text', text }] })
  });
  if (!pushRes.ok) {
    const err = await pushRes.text().catch(() => '');
    console.error('[send-bind-link] FAIL', { inquiry: inq.id, to: inq.line_user_id, status: pushRes.status, err });
    return res.status(502).json({ error: 'LINE 傳送失敗（' + pushRes.status + '），請確認客人所在的官方帳號與系統一致' });
  }

  db.prepare(`INSERT INTO line_inquiry_messages (inquiry_id, direction, msg_type, content, sent_by) VALUES (?, 'out', 'text', ?, ?)`)
    .run(inq.id, text, req.session.user.id);
  db.prepare(`UPDATE line_inquiries SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(inq.id);

  res.json({ ok: true, client_name: client.name });
});

// 取這通對話所屬 OA 的 { id, org_id }（給 applyBind 用；env-fallback 頻道回 null）
function inqChannel(inq) {
  if (!inq.channel_id) return null;
  return db.prepare(`SELECT id, org_id FROM line_channels WHERE id=?`).get(inq.channel_id) || null;
}

// ── 客戶資料編輯：直接關聯到「既有客戶檔」（客人免動手）────────────
// 把這通對話的 line_user_id 綁到選定客戶檔，合併去重、店別歸屬、跨店標記。
router.post('/:id/link-client', requireAuth, (req, res) => {
  const { client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: '請選擇要關聯的客戶' });
  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq)              return res.status(404).json({ error: 'not found' });
  if (inq.is_group)      return res.status(400).json({ error: '群組對話不適用此關聯' });
  if (!inq.line_user_id) return res.status(400).json({ error: '此對話沒有 LINE ID 可關聯' });
  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(client_id);
  if (!client)           return res.status(404).json({ error: '找不到客戶' });

  try {
    const r = applyBind(client.id, inq.line_user_id, inqChannel(inq), client.org_id);
    db.prepare(`UPDATE line_inquiries SET client_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(client.id, inq.id);
    res.json({ ok: true, client_id: client.id, client_name: client.name, mismatch: r ? r.mismatch : 0 });
  } catch (e) {
    console.error('link-client error:', e.message);
    res.status(500).json({ error: '關聯失敗：' + e.message });
  }
});

// ── 客戶資料編輯：查不到 → 新增客戶檔並關聯 ──────────────────────
// force 未帶且偵測到疑似重複 → 回 409 附候選清單，讓客服先判斷（改關聯或確認新增）。
router.post('/:id/create-client', requireAuth, (req, res) => {
  const me = req.session.user;
  const { name, phone, email, address, force } = req.body || {};
  const nm = (name || '').trim();
  if (!nm)               return res.status(400).json({ error: '請輸入客戶名稱' });
  const inq = db.prepare(`SELECT * FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq)              return res.status(404).json({ error: 'not found' });
  if (inq.is_group)      return res.status(400).json({ error: '群組對話不適用此建檔' });
  if (!inq.line_user_id) return res.status(400).json({ error: '此對話沒有 LINE ID 可關聯' });

  // 相似/重複偵測：同名（去空白）或電話相同 → 提醒客服（除非 force）
  if (!force) {
    const nmKey = nm.replace(/\s+/g, '');
    const like = `%${nm}%`;
    const dups = db.prepare(`
      SELECT id, name, phone, contact_person AS contact, line_user_id
      FROM clients
      WHERE REPLACE(name,' ','') = ? OR name LIKE ?
         ${phone ? 'OR (phone IS NOT NULL AND phone=?)' : ''}
      ORDER BY (REPLACE(name,' ','')=?) DESC, id DESC LIMIT 8
    `).all(...(phone ? [nmKey, like, phone, nmKey] : [nmKey, like, nmKey]));
    if (dups.length) return res.status(409).json({ error: 'duplicate', duplicates: dups });
  }

  const ch = inqChannel(inq);
  const orgId = (ch && ch.org_id) || me.org_id || null;
  const r = db.prepare(`INSERT INTO clients (org_id, name, phone, email, address, source, created_by)
                        VALUES (?,?,?,?,?, 'LINE', ?)`)
    .run(orgId, nm, phone || null, email || null, address || null, me.id);
  const clientId = r.lastInsertRowid;

  applyBind(clientId, inq.line_user_id, ch, orgId);
  db.prepare(`UPDATE line_inquiries SET client_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(clientId, inq.id);
  res.json({ ok: true, client_id: clientId, client_name: nm });
});

// ── 標記已回覆（清掉待回覆紅燈）─────────────────────────────
// 用於同事在 LINE 官方帳號後台回覆、系統收不到那則回覆的情況。
// 設 replied_at=現在；當 replied_at >= last_message_at 即視為已回，紅燈熄滅。
// 若客人之後再傳新訊息，last_message_at 會更新超過 replied_at → 自動再次亮燈。
router.post('/:id/mark-replied', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT id FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE line_inquiries SET replied_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, ai_needs_human=0 WHERE id=?`).run(inq.id);
  res.json({ ok: true });
});

// ── 轉真人客服（設定 ai_needs_human 旗標；即使已轉案也可標記）──────
router.post('/:id/needs-human', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT id FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });
  const val = (req.body && req.body.value === 0) ? 0 : 1;
  db.prepare(`UPDATE line_inquiries SET ai_needs_human=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(val, inq.id);
  res.json({ ok: true });
});

// ── 產生 / 重新產生 AI 建議回覆（草稿模式，不會傳給客人）──────────
router.post('/:id/ai-draft', requireAuth, async (req, res) => {
  try {
    const { generateInquiryDraft } = require('../lib/line-ai');
    const result = await generateInquiryDraft(req.params.id);
    if (!result) return res.status(400).json({ error: '此詢問最後一則不是客人的訊息，或沒有訊息可擬稿' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'AI 擬稿失敗：' + e.message });
  }
});

// ── 客服跟 AI 助手對話（co-pilot，幫忙擬/改訊息、找輔助資訊）─────
router.post('/:id/ai-chat', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: '缺少訊息' });
    const { chatWithAssistant } = require('../lib/line-ai');
    const reply = await chatWithAssistant(req.params.id, messages.slice(-20));
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: 'AI 回覆失敗：' + e.message });
  }
});

// ── 合併重複視窗結果報告（老闆）：存下的合併統計 + 現況即時複查 ──────
router.get('/dup-report', requireAuth, (req, res) => {
  if (req.session.user?.role !== 'owner') return res.status(403).json({ error: '僅限老闆' });
  let merge = null;
  try {
    const row = db.prepare(`SELECT detail, applied_at FROM _migrations WHERE name='merge_dup_inquiries_v1'`).get();
    if (row) merge = { ...(row.detail ? JSON.parse(row.detail) : {}), applied_at: row.applied_at };
  } catch (e) {}
  // 即時複查：合併後應該「沒有任何客人還有 >1 個視窗」
  const dupGroups = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT line_user_id FROM line_inquiries WHERE line_user_id IS NOT NULL
      GROUP BY line_user_id, COALESCE(channel_id,-1) HAVING COUNT(*) > 1
    )`).get().n;
  const totalInquiries   = db.prepare(`SELECT COUNT(*) n FROM line_inquiries`).get().n;
  const distinctCustomers = db.prepare(`SELECT COUNT(DISTINCT line_user_id) n FROM line_inquiries WHERE line_user_id IS NOT NULL`).get().n;
  res.json({
    ran: !!merge,
    merge,                                   // { mergedGroups, deletedThreads, movedMsgs, applied_at }
    live: { dupGroups, totalInquiries, distinctCustomers },
    ok: dupGroups === 0,                     // true = 已無重複視窗（合併成功）
  });
});

// ── 依案件撈出該客戶的所有 LINE 對話（案件詳情「客服對話紀錄」Tab 用）──
router.get('/by-case/:caseId', requireAuth, (req, res) => {
  const c = db.prepare(`SELECT id, client_id, line_source FROM cases WHERE id=?`).get(req.params.caseId);
  if (!c) return res.status(404).json({ error: 'not found' });
  const inqs = db.prepare(`
    SELECT id FROM line_inquiries
    WHERE converted_case_id = ?
       OR (client_id    IS NOT NULL AND client_id    = ?)
       OR (line_user_id  IS NOT NULL AND line_user_id = ?)
  `).all(c.id, c.client_id, c.line_source);
  if (!inqs.length) return res.json({ messages: [], inquiry_ids: [] });
  const ids = inqs.map(i => i.id);
  const ph  = ids.map(() => '?').join(',');
  const messages = db.prepare(`
    SELECT m.*, u.name AS sender_name
    FROM line_inquiry_messages m
    LEFT JOIN users u ON m.sent_by = u.id
    WHERE m.inquiry_id IN (${ph})
    ORDER BY m.created_at ASC, m.id ASC
  `).all(...ids);
  res.json({ messages, inquiry_ids: ids });
});

// ── AI 估價輔助：從對話＋照片萃取估價品項（草稿，需客服核對）──────
router.post('/:id/ai-estimate', requireAuth, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: '尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
    const { generateEstimateDraft } = require('../lib/line-ai');
    const result = await generateEstimateDraft(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'AI 估價失敗：' + e.message });
  }
});

// ── 刪除詢問（僅限已轉案 / 無效）────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  const inq = db.prepare(`SELECT status, display_name FROM line_inquiries WHERE id=?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'not found' });
  if (!['converted','invalid'].includes(inq.status))
    return res.status(400).json({ error: '只有已轉案或無效的詢問才可刪除' });
  db.prepare(`DELETE FROM line_inquiry_messages WHERE inquiry_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM line_inquiries WHERE id=?`).run(req.params.id);
  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
    .run(req.session.user.id, 'delete', 'line_inquiries', req.params.id, `刪除 LINE 詢問：${inq.display_name || ''}（${inq.status}）`);
  res.json({ ok: true });
});

module.exports = router;
