const { buildClearCookie, SESSION_COOKIE } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Set-Cookie', buildClearCookie(SESSION_COOKIE));
  res.status(204).end();
};
