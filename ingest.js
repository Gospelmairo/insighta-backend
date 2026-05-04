'use strict';

const busboy         = require('busboy');
const { parse }      = require('csv-parse');
const { v7: uuidv7 } = require('uuid');
const db             = require('./db');
const { getNameByCode, COUNTRIES } = require('./countries');

const CHUNK_SIZE     = 500;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB guard

const VALID_GENDERS  = new Set(['male', 'female']);
const REQUIRED_COLS  = ['name', 'gender', 'age', 'country_id'];

function classifyAge(a) {
  return a <= 12 ? 'child' : a <= 19 ? 'teenager' : a <= 59 ? 'adult' : 'senior';
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Validate a raw CSV row object; return { profile } on success or { reason } on failure.
function validateRow(raw) {
  for (const col of REQUIRED_COLS) {
    if (!raw[col] || !String(raw[col]).trim()) {
      return { reason: 'missing_fields' };
    }
  }

  const name      = String(raw.name).trim().toLowerCase();
  const gender    = String(raw.gender).trim().toLowerCase();
  const ageRaw    = Number(raw.age);
  const countryId = String(raw.country_id).trim().toUpperCase();

  if (!name)                           return { reason: 'missing_fields' };
  if (!VALID_GENDERS.has(gender))      return { reason: 'invalid_gender' };
  if (!Number.isInteger(ageRaw) || ageRaw <= 0 || ageRaw > 120)
                                       return { reason: 'invalid_age' };
  if (!COUNTRIES[countryId])           return { reason: 'invalid_country' };

  return {
    profile: {
      id:                  uuidv7(),
      name,
      gender,
      gender_probability:  0.5,
      age:                 ageRaw,
      age_group:           classifyAge(ageRaw),
      country_id:          countryId,
      country_name:        getNameByCode(countryId),
      country_probability: 0.5,
      created_at:          utcNow(),
    },
  };
}

// Flush a chunk of validated profiles to the DB.
// Returns { inserted, duplicates }.
async function flushChunk(chunk) {
  const attempted = chunk.length;
  const inserted  = await db.bulkInsertProfiles(chunk);
  return { inserted, duplicates: attempted - inserted };
}

// POST /api/profiles/upload — streaming multipart CSV ingestion.
async function handleUpload(req, res) {
  const summary = {
    total_rows: 0,
    inserted:   0,
    skipped:    0,
    reasons:    { duplicate_name: 0, invalid_age: 0, missing_fields: 0, malformed: 0, invalid_gender: 0, invalid_country: 0 },
  };

  let bb;
  try {
    bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  } catch {
    return res.status(400).json({ status: 'error', message: 'Expected multipart/form-data' });
  }

  let settled = false;
  function respond(status, body) {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  }

  bb.on('file', (_field, fileStream, _info) => {
    const parser = parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });

    let chunk   = [];
    let pending = Promise.resolve();

    parser.on('readable', () => {
      let row;
      while ((row = parser.read()) !== null) {
        summary.total_rows++;

        let result;
        try { result = validateRow(row); }
        catch { result = { reason: 'malformed' }; }

        if (result.reason) {
          summary.skipped++;
          summary.reasons[result.reason] = (summary.reasons[result.reason] || 0) + 1;
          continue;
        }

        chunk.push(result.profile);

        if (chunk.length >= CHUNK_SIZE) {
          const toFlush = chunk;
          chunk = [];
          // Chain flushes so they stay ordered and don't pile up unbounded
          pending = pending.then(() => flushChunk(toFlush)).then(({ inserted, duplicates }) => {
            summary.inserted += inserted;
            summary.skipped  += duplicates;
            summary.reasons.duplicate_name += duplicates;
          });
        }
      }
    });

    parser.on('error', () => {
      summary.skipped++;
      summary.reasons.malformed++;
    });

    parser.on('end', () => {
      // Flush remaining rows
      const tail = chunk;
      pending = pending
        .then(() => tail.length ? flushChunk(tail) : { inserted: 0, duplicates: 0 })
        .then(({ inserted, duplicates }) => {
          summary.inserted += inserted;
          summary.skipped  += duplicates;
          summary.reasons.duplicate_name += duplicates;
        })
        .then(() => {
          // Remove zero-count reasons for a clean response
          for (const k of Object.keys(summary.reasons)) {
            if (!summary.reasons[k]) delete summary.reasons[k];
          }
          respond(200, { status: 'success', ...summary });
        })
        .catch(() => respond(500, { status: 'error', message: 'Internal error during ingestion' }));
    });

    fileStream.on('limit', () => {
      parser.destroy();
      respond(413, { status: 'error', message: 'File too large (max 100 MB)' });
    });

    fileStream.pipe(parser);
  });

  bb.on('error', () => respond(400, { status: 'error', message: 'Malformed upload' }));
  bb.on('finish', () => { /* handled in parser end */ });

  req.pipe(bb);
}

module.exports = { handleUpload };
