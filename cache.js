'use strict';

const TTL_MS   = 5 * 60 * 1000; // 5 minutes
const MAX_SIZE = 1000;

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { store.delete(key); return null; }
  return entry.value;
}

function set(key, value) {
  if (store.size >= MAX_SIZE) {
    store.delete(store.keys().next().value); // evict oldest
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

function invalidate() {
  store.clear();
}

module.exports = { get, set, invalidate };
