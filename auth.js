'use strict';

const express = require('express');
const axios   = require('axios');
const { v7: uuidv7 } = require('uuid');
const db      = require('./db');
const { signAccessToken, generateRefreshToken, refreshExpiresAt, verifySHA256 } = require('./tokens');
const { authLimiter } = require('./middleware');

const router = express.Router();
router.use(authLimiter);

const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const BACKEND_URL          = process.env.BACKEND_URL || 'https://insighta-backend.vercel.app';
const FRONTEND_URL         = process.env.FRONTEND_URL || 'https://insighta-web.vercel.app';

function utcNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// ── GET /auth/github ──────────────────────────────────────────────────────────
// CLI sends: ?state=X&code_challenge=Y&code_challenge_method=S256&cli_redirect=http://localhost:PORT/callback
// Web sends: (nothing — backend generates state)
router.get('/github', async (req, res) => {
  const { state, code_challenge, cli_redirect } = req.query;

  if (state && code_challenge) {
    // CLI flow — store PKCE state
    await db.savePkceState(state, code_challenge, cli_redirect || null);
    const params = new URLSearchParams({
      client_id:    GITHUB_CLIENT_ID,
      redirect_uri: `${BACKEND_URL}/auth/github/callback`,
      scope:        'read:user user:email',
      state,
    });
    return res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  }

  // Web flow — generate state server-side
  const webState = uuidv7();
  await db.savePkceState(webState, '__web__', null);
  const params = new URLSearchParams({
    client_id:    GITHUB_CLIENT_ID,
    redirect_uri: `${BACKEND_URL}/auth/github/callback`,
    scope:        'read:user user:email',
    state:        webState,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ── GET /auth/github/callback ─────────────────────────────────────────────────
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).json({ status: 'error', message: 'Missing code or state' });
  }

  const pkce = await db.getPkceState(state);
  if (!pkce) {
    return res.status(400).json({ status: 'error', message: 'Invalid or expired state' });
  }

  const isCli = pkce.code_challenge !== '__web__';

  if (isCli && pkce.cli_redirect) {
    // Redirect to CLI local server with code — CLI will call /auth/token to complete
    const u = new URL(pkce.cli_redirect);
    u.searchParams.set('code', code);
    u.searchParams.set('state', state);
    return res.redirect(u.toString());
  }

  // Web flow — exchange immediately
  const tokens = await exchangeAndIssue(code, state, null);
  if (!tokens) return res.status(502).json({ status: 'error', message: 'GitHub exchange failed' });

  res.cookie('access_token', tokens.access_token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 3 * 60 * 1000 });
  res.cookie('refresh_token', tokens.refresh_token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 });
  res.redirect(`${FRONTEND_URL}/dashboard`);
});

// ── POST /auth/token (CLI only) ───────────────────────────────────────────────
router.post('/token', async (req, res) => {
  const { code, code_verifier, state } = req.body;
  if (!code || !code_verifier || !state) {
    return res.status(400).json({ status: 'error', message: 'Missing code, code_verifier, or state' });
  }

  const pkce = await db.getPkceState(state);
  if (!pkce) {
    return res.status(400).json({ status: 'error', message: 'Invalid or expired state' });
  }

  // Verify PKCE
  if (!verifySHA256(code_verifier, pkce.code_challenge)) {
    return res.status(400).json({ status: 'error', message: 'PKCE verification failed' });
  }

  const tokens = await exchangeAndIssue(code, state, null);
  if (!tokens) return res.status(502).json({ status: 'error', message: 'GitHub exchange failed' });

  return res.json({ status: 'success', ...tokens });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const token = req.body.refresh_token || (req.cookies && req.cookies.refresh_token);
  if (!token) return res.status(400).json({ status: 'error', message: 'Missing refresh token' });

  const stored = await db.consumeRefreshToken(token);
  if (!stored) return res.status(401).json({ status: 'error', message: 'Invalid or expired refresh token' });

  if (new Date(stored.expires_at) < new Date()) {
    return res.status(401).json({ status: 'error', message: 'Refresh token expired' });
  }

  const user = await db.findUserById(stored.user_id);
  if (!user || !user.is_active) return res.status(403).json({ status: 'error', message: 'Account disabled' });

  const newAccess  = signAccessToken(user);
  const newRefresh = generateRefreshToken();
  const expiresAt  = refreshExpiresAt();
  await db.saveRefreshToken(uuidv7(), user.id, newRefresh, expiresAt);

  if (req.cookies && req.cookies.refresh_token) {
    res.cookie('access_token',  newAccess,  { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 3 * 60 * 1000 });
    res.cookie('refresh_token', newRefresh, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 });
  }

  return res.json({ status: 'success', access_token: newAccess, refresh_token: newRefresh });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const token = req.body.refresh_token || (req.cookies && req.cookies.refresh_token);
  if (token) await db.consumeRefreshToken(token);
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  return res.json({ status: 'success', message: 'Logged out' });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
const { requireAuth } = require('./middleware');
router.get('/me', requireAuth, (req, res) => {
  const { id, username, email, avatar_url, role, created_at } = req.user;
  res.json({ status: 'success', data: { id, username, email, avatar_url, role, created_at } });
});

// ── Helper: exchange code with GitHub + issue tokens ─────────────────────────
async function exchangeAndIssue(code, state, redirectUri) {
  try {
    const ghRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id:     GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  `${BACKEND_URL}/auth/github/callback`,
      },
      { headers: { Accept: 'application/json' } }
    );

    const ghToken = ghRes.data.access_token;
    if (!ghToken) return null;

    const [userRes, emailRes] = await Promise.all([
      axios.get('https://api.github.com/user', { headers: { Authorization: `Bearer ${ghToken}` } }),
      axios.get('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${ghToken}` } }).catch(() => ({ data: [] })),
    ]);

    const ghUser   = userRes.data;
    const primary  = (emailRes.data || []).find(e => e.primary)?.email || ghUser.email || '';
    const now      = utcNow();

    const user = await db.upsertUser({
      id:            uuidv7(),
      github_id:     String(ghUser.id),
      username:      ghUser.login,
      email:         primary,
      avatar_url:    ghUser.avatar_url,
      last_login_at: now,
      created_at:    now,
    });

    // Delete state after use
    await db.consumePkceState(state);

    const access_token  = signAccessToken(user);
    const refresh_token = generateRefreshToken();
    await db.saveRefreshToken(uuidv7(), user.id, refresh_token, refreshExpiresAt());

    return { access_token, refresh_token, user: { id: user.id, username: user.username, role: user.role } };
  } catch (e) {
    console.error('exchangeAndIssue error:', e.message);
    return null;
  }
}

module.exports = router;
