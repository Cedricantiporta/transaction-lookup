const crypto = require('crypto');
const { sign, buildStateCookie } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID is not configured.' });

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = `${proto}://${req.headers.host}/api/auth/callback`;
  const state = sign({ nonce: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 10 * 60 * 1000 });

  res.setHeader('Set-Cookie', buildStateCookie(state));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
};
