'use strict';

const express        = require('express');
const axios          = require('axios');
const { v7: uuidv7 } = require('uuid');
const db             = require('./db');
const { parseQuery } = require('./nlp');
const { getNameByCode } = require('./countries');
const { requireAuth, requireRole, requireApiVersion, apiLimiter } = require('./middleware');

const router = express.Router();
router.use(apiLimiter);
router.use(requireAuth);

router.use(requireApiVersion);

function utcNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function err(m)   { return { status: 'error', message: m }; }
function classifyAge(a) { return a<=12?'child':a<=19?'teenager':a<=59?'adult':'senior'; }

function fmt(p) {
  return {
    id: p.id, name: p.name, gender: p.gender,
    gender_probability:  Number(p.gender_probability),
    age: Number(p.age), age_group: p.age_group,
    country_id: p.country_id, country_name: p.country_name,
    country_probability: Number(p.country_probability),
    created_at: p.created_at,
  };
}

function paginationMeta(page, limit, total, basePath, query = {}) {
  const totalPages = Math.ceil(total / limit);
  const qs = (p) => {
    const q = { ...query, page: p, limit };
    return `${basePath}?${new URLSearchParams(q).toString()}`;
  };
  return {
    page, limit, total, total_pages: totalPages,
    links: {
      self: qs(page),
      next: page < totalPages ? qs(page + 1) : null,
      prev: page > 1 ? qs(page - 1) : null,
    },
  };
}

function parsePagination(q) {
  let page  = Math.max(1, parseInt(q.page,  10) || 1);
  let limit = Math.min(50, Math.max(1, parseInt(q.limit, 10) || 10));
  return { page, limit };
}

// ── GET /api/profiles/export ──────────────────────────────────────────────────
router.get('/export', async (req, res) => {
  const { format } = req.query;
  if (format !== 'csv') return res.status(400).json(err('Only format=csv is supported'));

  try {
    const { rows } = await db.findAllProfiles({ ...req.query, page: 1, limit: 100000 });
    const cols = ['id','name','gender','gender_probability','age','age_group','country_id','country_name','country_probability','created_at'];
    const header = cols.join(',');
    const body   = rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const ts     = new Date().toISOString().replace(/[:.]/g, '-');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="profiles_${ts}.csv"`);
    return res.send(`${header}\n${body}`);
  } catch (e) {
    console.error(e);
    return res.status(500).json(err('Internal server error'));
  }
});

// ── GET /api/profiles/search ──────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.status(400).json(err('Missing query parameter: q'));

  const filters = parseQuery(q);
  if (!filters) return res.status(400).json(err('Unable to interpret query'));

  const { page, limit } = parsePagination(req.query);
  try {
    const { total, rows } = await db.findAllProfiles({ ...filters, page, limit });
    const meta = paginationMeta(page, limit, total, '/api/profiles/search', { q, page, limit });
    return res.json({ status: 'success', ...meta, data: rows.map(fmt) });
  } catch (e) {
    return res.status(500).json(err('Internal server error'));
  }
});

// ── GET /api/profiles ─────────────────────────────────────────────────────────
const VALID_PARAMS = new Set(['gender','age_group','country_id','min_age','max_age',
  'min_gender_probability','min_country_probability','sort_by','order','page','limit']);

router.get('/', async (req, res) => {
  const unknown = Object.keys(req.query).filter(k => !VALID_PARAMS.has(k));
  if (unknown.length) return res.status(400).json(err('Invalid query parameters'));

  const { sort_by, order } = req.query;
  if (sort_by && !['age','created_at','gender_probability'].includes(sort_by)) return res.status(400).json(err('Invalid query parameters'));
  if (order   && !['asc','desc'].includes(order))  return res.status(400).json(err('Invalid query parameters'));

  const { page, limit } = parsePagination(req.query);
  const opts = {
    gender: req.query.gender || undefined,
    age_group: req.query.age_group || undefined,
    country_id: req.query.country_id || undefined,
    min_age:  req.query.min_age  != null ? Number(req.query.min_age)  : undefined,
    max_age:  req.query.max_age  != null ? Number(req.query.max_age)  : undefined,
    min_gender_probability:  req.query.min_gender_probability  != null ? Number(req.query.min_gender_probability)  : undefined,
    min_country_probability: req.query.min_country_probability != null ? Number(req.query.min_country_probability) : undefined,
    sort_by: sort_by || 'created_at', order: order || 'asc', page, limit,
  };

  try {
    const { total, rows } = await db.findAllProfiles(opts);
    const meta = paginationMeta(page, limit, total, '/api/profiles', { ...req.query, page, limit });
    return res.json({ status: 'success', ...meta, data: rows.map(fmt) });
  } catch (e) {
    return res.status(500).json(err('Internal server error'));
  }
});

// ── GET /api/profiles/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const p = await db.findProfileById(req.params.id);
    if (!p) return res.status(404).json(err('Profile not found'));
    return res.json({ status: 'success', data: fmt(p) });
  } catch (e) {
    return res.status(500).json(err('Internal server error'));
  }
});

// ── POST /api/profiles (admin only) ──────────────────────────────────────────
router.post('/', requireRole('admin'), async (req, res) => {
  const { name } = req.body;
  if (!name || name === '') return res.status(400).json(err('Name is required'));
  if (typeof name !== 'string') return res.status(422).json(err('Name must be a string'));

  const norm = name.trim().toLowerCase();
  if (!norm) return res.status(400).json(err('Name must not be blank'));

  const existing = await db.findProfileByName(norm);
  if (existing) return res.status(200).json({ status: 'success', message: 'Profile already exists', data: fmt(existing) });

  let gData, aData, nData;
  try {
    const [g, a, n] = await Promise.all([
      axios.get(`https://api.genderize.io/?name=${encodeURIComponent(norm)}`),
      axios.get(`https://api.agify.io/?name=${encodeURIComponent(norm)}`),
      axios.get(`https://api.nationalize.io/?name=${encodeURIComponent(norm)}`),
    ]);
    gData = g.data; aData = a.data; nData = n.data;
  } catch { return res.status(502).json(err('External API error')); }

  if (!gData.gender || gData.count === 0) return res.status(502).json(err('Genderize returned an invalid response'));
  if (aData.age == null)  return res.status(502).json(err('Agify returned an invalid response'));
  if (!nData.country?.length) return res.status(502).json(err('Nationalize returned an invalid response'));

  const top = nData.country.reduce((b, c) => c.probability > b.probability ? c : b);
  const profile = {
    id: uuidv7(), name: norm,
    gender: gData.gender, gender_probability: gData.probability,
    age: aData.age, age_group: classifyAge(aData.age),
    country_id: top.country_id, country_name: getNameByCode(top.country_id),
    country_probability: top.probability, created_at: utcNow(),
  };

  const saved = await db.insertProfile(profile);
  return res.status(201).json({ status: 'success', data: fmt(saved || profile) });
});

// ── DELETE /api/profiles/:id (admin only) ────────────────────────────────────
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const deleted = await db.deleteProfileById(req.params.id);
    if (!deleted) return res.status(404).json(err('Profile not found'));
    return res.status(204).send();
  } catch (e) {
    return res.status(500).json(err('Internal server error'));
  }
});

module.exports = router;
