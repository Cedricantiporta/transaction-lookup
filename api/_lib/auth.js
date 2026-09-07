const crypto = require('crypto');

const SESSION_COOKIE = 'mb_session';
const STATE_COOKIE = 'mb_oauth_state';
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured.');
  return secret;
}

// Minimal signed-cookie session — no JWT library, no server-side session
// store. Payload is base64url JSON; signature is HMAC-SHA256 over it.
function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verify(cookies[SESSION_COOKIE]);
}

// Route handlers must have already sent a response if this returns null.
function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Sign in required' });
    return null;
  }
  return session;
}

function buildCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function buildSessionCookie(user) {
  const token = sign({
    sub: user.id, email: user.email, name: user.name, picture: user.picture,
    exp: Date.now() + SESSION_MAX_AGE_S * 1000,
  });
  return buildCookie(SESSION_COOKIE, token, SESSION_MAX_AGE_S);
}

function buildStateCookie(state) {
  return buildCookie(STATE_COOKIE, state, 600); // 10 minutes, just for the OAuth round trip
}

function buildClearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  SESSION_COOKIE, STATE_COOKIE,
  sign, verify, parseCookies, getSession, requireAuth,
  buildSessionCookie, buildStateCookie, buildClearCookie,
};
