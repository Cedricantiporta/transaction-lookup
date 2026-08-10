const { del } = require('@vercel/blob');
const { sql, ensureSchema, send } = require('../_lib/db');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Runs daily via vercel.json's cron config. Also safe to hit manually —
// purging is idempotent and only ever removes items already past their
// 30-day bin deadline.
module.exports = async function handler(req, res) {
  await ensureSchema();

  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const { rows } = await sql`
    SELECT id, thumb_url, full_url FROM images
    WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}
  `;
  if (!rows.length) return send(res, 200, { purged: 0 });

  const ids = rows.map((r) => r.id);
  await sql`DELETE FROM images WHERE id = ANY(${ids})`;

  const urls = rows.flatMap((r) => [r.thumb_url, r.full_url]).filter(Boolean);
  if (urls.length) {
    try { await del(urls); } catch (err) { console.error('Blob cleanup failed during purge', err); }
  }

  return send(res, 200, { purged: rows.length });
};
