'use strict';

const { getCodeByName } = require('./countries');

const MALE_WORDS   = ['male','males','man','men','boy','boys','gentleman','gentlemen'];
const FEMALE_WORDS = ['female','females','woman','women','girl','girls','lady','ladies'];
const GROUP_MAP    = {
  child:'child',children:'child',kid:'child',kids:'child',
  teenager:'teenager',teenagers:'teenager',teen:'teenager',teens:'teenager',
  adolescent:'teenager',adolescents:'teenager',
  adult:'adult',adults:'adult',
  senior:'senior',seniors:'senior',elderly:'senior',elder:'senior',
};

function parseQuery(q) {
  if (!q || !q.trim()) return null;
  const filters = {};
  const lower   = q.toLowerCase().trim();
  const words   = lower.split(/\s+/);

  const hasMale   = words.some(w => MALE_WORDS.includes(w));
  const hasFemale = words.some(w => FEMALE_WORDS.includes(w));
  if (hasMale && !hasFemale)  filters.gender = 'male';
  if (hasFemale && !hasMale) filters.gender = 'female';

  if (words.includes('young') && !words.includes('younger')) {
    filters.min_age = 16;
    filters.max_age = 24;
  }

  for (const w of words) {
    if (GROUP_MAP[w]) { filters.age_group = GROUP_MAP[w]; break; }
  }

  const above   = lower.match(/(?:above|over|older than|at least)\s+(\d+)/);
  const below   = lower.match(/(?:below|under|younger than|at most)\s+(\d+)/);
  const between = lower.match(/between\s+(\d+)\s+and\s+(\d+)/);

  if (between) {
    filters.min_age = parseInt(between[1], 10);
    filters.max_age = parseInt(between[2], 10);
  } else {
    if (above) filters.min_age = parseInt(above[1], 10);
    if (below) filters.max_age = parseInt(below[1], 10);
  }

  const cMatch = lower.match(/(?:from|in)\s+([a-z\s]+?)(?:\s+(?:who|where|with|above|below|over|under|age|and|$)|$)/);
  if (cMatch) {
    const parts = cMatch[1].trim().split(' ');
    for (let len = parts.length; len >= 1; len--) {
      const code = getCodeByName(parts.slice(0, len).join(' '));
      if (code) { filters.country_id = code; break; }
    }
  }

  return Object.keys(filters).length === 0 ? null : filters;
}

module.exports = { parseQuery };
