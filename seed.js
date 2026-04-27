'use strict';

const axios          = require('axios');
const { v7: uuidv7 } = require('uuid');
const { init, pool } = require('./db');
const { getNameByCode } = require('./countries');

const SEED_URL = process.env.SEED_URL || process.argv[2];
function utcNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function classifyAge(a) { return a<=12?'child':a<=19?'teenager':a<=59?'adult':'senior'; }

async function seed() {
  if (!SEED_URL) { console.error('Usage: SEED_URL=<url> npm run seed'); process.exit(1); }
  await init();
  const { data } = await axios.get(SEED_URL);
  const profiles  = Array.isArray(data) ? data : data.profiles || data.data;
  console.log(`Seeding ${profiles.length} profiles...`);
  let ins = 0, skip = 0;
  for (const p of profiles) {
    const cid  = (p.country_id || '').toUpperCase();
    const age  = p.age ?? 0;
    try {
      const r = await pool.query(
        `INSERT INTO profiles (id,name,gender,gender_probability,age,age_group,country_id,country_name,country_probability,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (name) DO NOTHING`,
        [p.id||uuidv7(),(p.name||'').toLowerCase().trim(),p.gender||'',p.gender_probability??0,
         age,p.age_group||classifyAge(age),cid,p.country_name||getNameByCode(cid),p.country_probability??0,p.created_at||utcNow()]
      );
      r.rowCount > 0 ? ins++ : skip++;
    } catch (e) { console.warn(`Skip "${p.name}": ${e.message}`); skip++; }
  }
  console.log(`Done. Inserted: ${ins} | Skipped: ${skip}`);
  await pool.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
