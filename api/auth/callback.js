const { verify, parseCookies, buildSessionCookie, buildClearCookie, STATE_COOKIE } = require('../_lib/auth');
const { sql, ensureSchema } = require('../_lib/db');

module.exports = async function handler(req, res) {
  await ensureSchema();

  const { code, state } = req.query;
  const cookies = parseCookies(req);
  const expectedState = cookies[STATE_COOKIE];

  if (!code || !state || state !== expectedState || !verify(state)) {
    res.writeHead(302, { Location: '/?auth_error=1' });
    return res.end();
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = `${proto}://${req.headers.host}/api/auth/callback`;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);
    const tokens = await tokenRes.json();

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) throw new Error(`Userinfo fetch failed (${userRes.status})`);
    const profile = await userRes.json(); // { sub, email, name, picture, ... }

    const now = Date.now();
    const { rows } = await sql`
      INSERT INTO users (id, email, name, picture, created_at, last_seen_at)
      VALUES (${profile.sub}, ${profile.email}, ${profile.name}, ${profile.picture}, ${now}, ${now})
      ON CONFLICT (id) DO UPDATE SET
        email = ${profile.email}, name = ${profile.name}, picture = ${profile.picture}, last_seen_at = ${now}
      RETURNING *
    `;
    const user = rows[0];

    res.setHeader('Set-Cookie', [buildSessionCookie(user), buildClearCookie(STATE_COOKIE)]);
    res.writeHead(302, { Location: '/' });
    res.end();
  } catch (err) {
    console.error('OAuth callback failed', err);
    res.setHeader('Set-Cookie', buildClearCookie(STATE_COOKIE));
    res.writeHead(302, { Location: '/?auth_error=1' });
    res.end();
  }
};
