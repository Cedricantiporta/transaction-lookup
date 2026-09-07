const { sql, ensureSchema, categoryRow, readJson, send } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { uid, pickColor, methodNotAllowed } = require('./_lib/util');

module.exports = async function handler(req, res) {
  await ensureSchema();
  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    const { boardId } = req.query;
    // No boardId = return every category (fetched once at startup, then
    // filtered client-side per board to avoid a round trip on every switch).
    const { rows } = boardId
      ? await sql`SELECT * FROM categories WHERE board_id = ${boardId} ORDER BY created_at ASC`
      : await sql`SELECT * FROM categories ORDER BY created_at ASC`;
    return send(res, 200, rows.map(categoryRow));
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body.boardId || !body.name) return send(res, 400, { error: 'boardId and name are required' });
    const { rows: countRows } = await sql`SELECT COUNT(*)::int AS n FROM categories WHERE board_id = ${body.boardId}`;
    const category = {
      id: uid(),
      boardId: body.boardId,
      name: String(body.name).trim() || 'Category',
      color: body.color || pickColor(countRows[0].n),
      createdAt: Date.now(),
    };
    await sql`
      INSERT INTO categories (id, board_id, name, color, created_at)
      VALUES (${category.id}, ${category.boardId}, ${category.name}, ${category.color}, ${category.createdAt})
    `;
    return send(res, 201, category);
  }

  const id = req.query.id;
  if (!id) return send(res, 400, { error: 'Missing ?id=' });

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (typeof body.name === 'string') {
      const name = body.name.trim() || 'Category';
      const { rows } = await sql`UPDATE categories SET name = ${name} WHERE id = ${id} RETURNING *`;
      if (!rows.length) return send(res, 404, { error: 'Category not found' });
      return send(res, 200, categoryRow(rows[0]));
    }
    return send(res, 400, { error: 'Nothing to update' });
  }

  if (req.method === 'DELETE') {
    const { rowCount } = await sql`DELETE FROM categories WHERE id = ${id}`;
    if (!rowCount) return send(res, 404, { error: 'Category not found' });
    return send(res, 204, null);
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
};
