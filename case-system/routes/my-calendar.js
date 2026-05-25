const express = require('express');
const db      = require('../db');
const ical    = require('node-ical');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// iCal 快取（15 分鐘 TTL，避免頻繁拉 Google）
let icalCache = { events: [], fetchedAt: 0, urlsKey: '' };
const CACHE_TTL = 15 * 60 * 1000;

function getConfiguredUrls() {
  const multi  = db.prepare(`SELECT value FROM settings WHERE key='gcal_ical_urls'`).get();
  const single = db.prepare(`SELECT value FROM settings WHERE key='gcal_ical_url'`).get();
  let urls = [];
  if (multi?.value) {
    try { urls = JSON.parse(multi.value).filter(Boolean); } catch {}
  }
  // 向下相容：舊的單一 URL 若不在清單裡就補進來
  if (single?.value && !urls.includes(single.value)) urls.push(single.value);
  return urls;
}

async function fetchGCalEvents() {
  const now  = Date.now();
  const urls = getConfiguredUrls();
  if (!urls.length) return [];

  const urlsKey = urls.join('|');
  if (now - icalCache.fetchedAt < CACHE_TTL && icalCache.urlsKey === urlsKey) {
    return icalCache.events;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const limit = new Date(today); limit.setDate(limit.getDate() + 90);

  const parseEvents = raw =>
    Object.values(raw)
      .filter(e => e.type === 'VEVENT' && e.start)
      .map(e => {
        const start = e.start instanceof Date ? e.start : new Date(e.start);
        const end   = e.end   instanceof Date ? e.end   : (e.end ? new Date(e.end) : start);
        return {
          id:       e.uid,
          title:    e.summary     || '(公告)',
          note:     e.description || '',
          date:     start.toISOString().slice(0, 10),
          end_date: end.toISOString().slice(0, 10),
          source:   'gcal',
        };
      })
      .filter(e => { const d = new Date(e.date); return d >= today && d <= limit; });

  const results = await Promise.allSettled(urls.map(url => ical.async.fromURL(url)));

  const seen = new Set();
  const events = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => parseEvents(r.value))
    .filter(e => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.date.localeCompare(b.date));

  icalCache = { events, fetchedAt: now, urlsKey };
  return events;
}

// GET /api/my-calendar?year=&month=
router.get('/', requireAuth, async (req, res) => {
  const me = req.session.user;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const from  = `${year}-${String(month).padStart(2,'0')}-01`;
  const to    = `${year}-${String(month).padStart(2,'0')}-31`;

  // 我的派工排程（被指派到的 dispatches）
  const jobs = db.prepare(`
    SELECT
      d.id AS dispatch_id,
      d.scheduled_date AS date,
      d.scheduled_time,
      d.dispatch_type,
      c.id AS case_id, c.case_number, c.title,
      cl.name AS client_name,
      c.location,
      c.status AS case_status
    FROM dispatch_users du
    JOIN dispatches d ON d.id = du.dispatch_id
    JOIN cases c ON c.id = d.case_id
    LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE du.user_id = ?
      AND d.scheduled_date BETWEEN ? AND ?
      AND d.status != 'cancelled'
    ORDER BY d.scheduled_date, d.scheduled_time
  `).all(me.id, from, to);

  // Google 行事曆公告（只回傳這個月份的）
  const allGcal = await fetchGCalEvents();
  const announcements = allGcal.filter(e => e.date >= from && e.date <= to);

  res.json({ jobs, announcements });
});

module.exports = router;
