const { sql, ensureSchema, activityRow, send } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { methodNotAllowed } = require('./_lib/util');

module.exports = async function handler(req, res) {
  await ensureSchema();
  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const { rows } = await sql`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50`;
  return send(res, 200, rows.map(activityRow));
};
