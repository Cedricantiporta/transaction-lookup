const { getSession } = require('../_lib/auth');

// No DB round trip — this just verifies the signed cookie, so the frontend
// can check auth status on every boot without paying a database query.
module.exports = async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  res.status(200).json({ id: session.sub, email: session.email, name: session.name, picture: session.picture });
};
