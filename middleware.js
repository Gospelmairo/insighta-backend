'use strict';

const { verifyAccessToken }      = require('./tokens');
const { findUserById, rlIncrement } = require('./db');

// ── DB-backed rate limiting (works across Vercel serverless instances) ────────
function makeDbLimiter(max, windowMs, keyFn) {
  return async (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    try {
      const hits = await rlIncrement(key, windowMs);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - hits));
      if (hits > max) {
        return res.status(429).json({ status: 'error', message: 'Too many requests' });
      }
    } catch {
      // If DB check fails, allow request through
    }
    next();
  };
}

const authLimiter = makeDbLimiter(10, 60 * 1000, (req) => `auth:${req.ip}`);
const apiLimiter  = makeDbLimiter(60, 60 * 1000, (req) => `api:${req.ip}`);

// ── Request logger ────────────────────────────────────────────────────────────
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      method: req.method,
      endpoint: req.originalUrl,
      status: res.statusCode,
      responseTime: `${Date.now() - start}ms`,
    }));
  });
  next();
}

// ── API Version check ─────────────────────────────────────────────────────────
function requireApiVersion(req, res, next) {
  if (req.headers['x-api-version'] !== '1') {
    return res.status(400).json({ status: 'error', message: 'API version header required' });
  }
  next();
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  let token = null;

  // Check Authorization header (CLI)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // Check HTTP-only cookie (web portal)
  if (!token && req.cookies && req.cookies.access_token) {
    token = req.cookies.access_token;
  }

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Authentication required' });
  }

  try {
    const payload = verifyAccessToken(token);
    const user    = await findUserById(payload.sub);

    if (!user) {
      return res.status(401).json({ status: 'error', message: 'User not found' });
    }
    if (!user.is_active) {
      return res.status(403).json({ status: 'error', message: 'Account is disabled' });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
  }
}

// ── Role middleware ───────────────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authLimiter, apiLimiter, requestLogger, requireApiVersion, requireAuth, requireRole };
