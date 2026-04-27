'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'insighta-dev-secret-change-in-prod';
const ACCESS_TTL  = 3 * 60;       // 3 minutes in seconds
const REFRESH_TTL = 5 * 60 * 1000; // 5 minutes in ms

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

function refreshExpiresAt() {
  return new Date(Date.now() + REFRESH_TTL).toISOString();
}

function verifySHA256(verifier, challenge) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  const b64  = hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return b64 === challenge;
}

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, refreshExpiresAt, verifySHA256 };
