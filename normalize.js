'use strict';

// Produces a deterministic cache key from a filter object so that
// semantically identical queries always hit the same cache entry,
// regardless of key order or value casing.
function normalizeFilters(filters) {
  if (!filters || !Object.keys(filters).length) return null;

  const out = {};

  if (filters.gender)     out.gender     = filters.gender.toLowerCase().trim();
  if (filters.age_group)  out.age_group  = filters.age_group.toLowerCase().trim();
  if (filters.country_id) out.country_id = filters.country_id.toUpperCase().trim();

  if (filters.min_age  != null) out.min_age  = Number(filters.min_age);
  if (filters.max_age  != null) out.max_age  = Number(filters.max_age);
  if (filters.min_gender_probability  != null) out.min_gender_probability  = Number(filters.min_gender_probability);
  if (filters.min_country_probability != null) out.min_country_probability = Number(filters.min_country_probability);

  if (filters.sort_by) out.sort_by = filters.sort_by;
  if (filters.order)   out.order   = filters.order;
  if (filters.page)    out.page    = Number(filters.page);
  if (filters.limit)   out.limit   = Number(filters.limit);

  // Sort keys so {"gender":"male","country_id":"NG"} === {"country_id":"NG","gender":"male"}
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];

  return JSON.stringify(sorted);
}

module.exports = { normalizeFilters };
