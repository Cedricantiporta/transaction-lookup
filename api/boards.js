const { del } = require('@vercel/blob');
const { sql, ensureSchema, boardRow, readJson, send } = require('./_lib/db');
const { uid, pickColor, methodNotAllowed } = require('./_lib/util');

module.exports = async function handler(req, res) {
  await ensureSchema();

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT b.*, COUNT(i.id) FILTER (WHERE i.deleted_at IS NULL) AS image_count
      FROM boards b
      LEFT JOIN images i ON i.board_id = b.id
      GROUP BY b.id
      ORDER BY b.board_order ASC, b.created_at ASC
    `;
    return send(res, 200, rows.map((r) => ({ ...boardRow(r), imageCount: Number(r.image_count) })));
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { rows: countRows } = await sql`SELECT COUNT(*)::int AS n FROM boards`;
    const order = countRows[0].n;
    const board = {
      id: uid(),
      name: (body.name || 'Untitled Moodboard').trim() || 'Untitled Moodboard',
      color: body.color || pickColor(order),
      order,
      createdAt: Date.now(),
    };
    await sql`
      INSERT INTO boards (id, name, color, board_order, created_at)
      VALUES (${board.id}, ${board.name}, ${board.color}, ${board.order}, ${board.createdAt})
    `;
    return send(res, 201, { ...board, imageCount: 0 });
  }

  const id = req.query.id;
  if (!id) return send(res, 400, { error: 'Missing ?id=' });

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (typeof body.name === 'string') {
      const name = body.name.trim() || 'Untitled Moodboard';
      const { rows } = await sql`UPDATE boards SET name = ${name} WHERE id = ${id} RETURNING *`;
      if (!rows.length) return send(res, 404, { error: 'Board not found' });
      return send(res, 200, boardRow(rows[0]));
    }
    return send(res, 400, { error: 'Nothing to update' });
  }

  if (req.method === 'DELETE') {
    const { rows: imgs } = await sql`SELECT thumb_url, full_url FROM images WHERE board_id = ${id}`;
    const { rowCount } = await sql`DELETE FROM boards WHERE id = ${id}`;
    if (!rowCount) return send(res, 404, { error: 'Board not found' });
    const urls = imgs.flatMap((r) => [r.thumb_url, r.full_url]).filter(Boolean);
    if (urls.length) {
      try { await del(urls); } catch (err) { console.error('Blob cleanup failed', err); }
    }
    return send(res, 204, null);
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
};
