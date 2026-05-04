# SOLUTION.md — Stage 4B: System Optimization & Data Ingestion

## Part 1: Query Performance

### What was done
Three changes were made to reduce latency and database load:

**1. Composite index**
Added `idx_country_gender_age ON profiles(country_id, gender, age)` in `db.js`.

The individual indexes on `country_id`, `gender`, and `age` already existed. For combined filter queries — which are the dominant pattern — PostgreSQL still had to intersect multiple partial index scans. The composite index lets the planner satisfy all three filters in a single B-tree scan, reducing I/O significantly at tens of millions of rows.

Country leads the index because it has the highest cardinality reduction (narrows the row set the most before gender and age are applied).

**2. In-memory query result cache (`cache.js`)**
Results from `GET /api/profiles` and `GET /api/profiles/search` are cached in a TTL-bounded in-memory Map (5 min TTL, 1000 entry max).

The cache key is the normalized filter fingerprint (see Part 2). A cache hit bypasses the database entirely and returns in under 1ms. Given that analysts run the same demographic filters repeatedly throughout a session, hit rates in practice are high enough to significantly reduce database load.

TTL of 5 minutes aligns with the batch ingestion cadence — data freshness is already bounded by how often profiles are ingested, so stale cache within that window is acceptable.

No external cache store (Redis) was added — an in-memory Map is sufficient for a single-region, single-instance deployment and avoids infrastructure complexity.

**3. pg.Pool (already present)**
`pg.Pool` was already in use, providing connection reuse and limiting max concurrent connections to PostgreSQL. No change was needed.

### Before / After (estimated)

| Query | Before | After (cache miss) | After (cache hit) |
|---|---|---|---|
| Filter: country=NG, gender=male | ~400–800ms | ~80–150ms | < 2ms |
| Filter: age 20–35 | ~300–600ms | ~60–120ms | < 2ms |
| List all (page 1) | ~200–400ms | ~50–100ms | < 2ms |

*Measurements are estimates based on index scan improvement on 1M+ row tables. Actual numbers depend on DB host.*

---

## Part 2: Query Normalization

### Problem
`"Nigerian females between ages 20 and 45"` and `"Women aged 20–45 living in Nigeria"` both parse to:
```json
{ "gender": "female", "country_id": "NG", "min_age": 20, "max_age": 45 }
```
But without normalization, key ordering and value casing differences produce different JSON strings → different cache keys → cache misses.

### Solution (`normalize.js`)
Before checking or writing to cache, filters are passed through `normalizeFilters()`:
- String values are lowercased (gender, age_group) or uppercased (country_id)
- Numeric values are cast to `Number`
- Keys are sorted alphabetically

The resulting JSON string is deterministic: two queries with the same logical intent always produce the same cache key, regardless of how they were expressed.

### Constraints met
- Fully deterministic — no randomness, no AI
- Does not change the semantics of any filter — normalization only affects representation, not interpretation
- Applied to both the search endpoint (NLP-parsed filters) and the list endpoint (direct query param filters)

---

## Part 3: CSV Data Ingestion

### Endpoint
`POST /api/profiles/upload` — admin only, `multipart/form-data`, field name: `file`

Expected CSV columns (required): `name, gender, age, country_id`

### How it works (`ingest.js`)

**Streaming, not buffering**
The file is streamed through `busboy` (multipart parser) directly into `csv-parse` (CSV transform stream). At no point is the full file loaded into memory. Memory usage is proportional to the chunk size (500 rows), not the file size.

**Chunked bulk insert**
Valid rows are accumulated into chunks of 500. When a chunk is full, it is flushed to PostgreSQL using a single `INSERT ... SELECT unnest(...)` query — one round-trip per 500 rows instead of one per row. For a 500K-row file, this means ~1000 DB round-trips instead of 500,000.

**Validation per row**
Each row is validated before entering the chunk:
- Missing required fields → skip, reason: `missing_fields`
- Invalid age (non-numeric, ≤ 0, > 120) → skip, reason: `invalid_age`
- Unrecognised gender (not male/female) → skip, reason: `invalid_gender`
- Unrecognised country code → skip, reason: `invalid_country`
- Malformed row (parse error) → skip, reason: `malformed`

**Duplicate handling**
Bulk inserts use `ON CONFLICT (name) DO NOTHING`. Rows that conflict are silently skipped. The count of uninserted rows within each chunk is tracked as `duplicate_name`.

**Concurrency**
`pg.Pool` manages multiple concurrent DB connections. Concurrent uploads each get their own stream pipeline and pool connection — they do not block each other or query endpoints.

**Partial failure**
Rows already inserted are never rolled back. If processing fails mid-stream, whatever was inserted stays. This matches the requirement.

### Example response
```json
{
  "status": "success",
  "total_rows": 50000,
  "inserted": 48231,
  "skipped": 1769,
  "reasons": {
    "duplicate_name": 1203,
    "invalid_age": 312,
    "missing_fields": 254
  }
}
```
Reason keys with a count of 0 are omitted from the response.

### Edge cases handled
| Case | Behaviour |
|---|---|
| File > 100 MB | 413 response, stream aborted |
| Non-multipart request | 400 response |
| Row with wrong column count | Skipped, reason: malformed |
| Empty file | Returns total_rows: 0, inserted: 0 |
| All rows duplicate | inserted: 0, all counted as duplicate_name |
| Concurrent uploads | Each uses independent stream + pool connection, safe |
| DB error mid-chunk | Error propagated, already-inserted rows retained |
