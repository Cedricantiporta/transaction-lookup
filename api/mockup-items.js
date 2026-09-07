const { formidable } = require('formidable');
const fs = require('fs');
const { put, del } = require('@vercel/blob');
const { sql, ensureSchema, mockupItemRow, send } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { uid, methodNotAllowed } = require('./_lib/util');

function parseMultipart(req) {
  const form = formidable({ maxFileSize: 15 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

module.exports = async function handler(req, res) {
  await ensureSchema();
  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    const { rows } = await sql`SELECT * FROM mockup_items ORDER BY created_at DESC`;
    return send(res, 200, rows.map(mockupItemRow));
  }

  if (req.method === 'POST') {
    let fields, files;
    try {
      ({ fields, files } = await parseMultipart(req));
    } catch (err) {
      console.error('Mockup item upload parse failed', err);
      return send(res, 400, { error: 'Could not read upload (file may be too large).' });
    }
    const name = (first(fields.name) || 'Mockup item').toString().trim() || 'Mockup item';
    const file = first(files.image);
    if (!file) return send(res, 400, { error: 'image is required' });

    const id = uid();
    try {
      const blob = await put(`mockup-items/${id}.jpg`, fs.createReadStream(file.filepath), {
        access: 'public', contentType: file.mimetype || 'image/jpeg',
      });
      const item = { id, name, imageUrl: blob.url, createdAt: Date.now() };
      await sql`
        INSERT INTO mockup_items (id, name, image_url, created_at)
        VALUES (${item.id}, ${item.name}, ${item.imageUrl}, ${item.createdAt})
      `;
      return send(res, 201, item);
    } catch (err) {
      console.error('Mockup item upload failed', err);
      return send(res, 500, { error: 'Upload failed' });
    } finally {
      if (file.filepath) fs.unlink(file.filepath, () => {});
    }
  }

  const id = req.query.id;
  if (!id) return send(res, 400, { error: 'Missing ?id=' });

  if (req.method === 'DELETE') {
    const { rows } = await sql`SELECT image_url FROM mockup_items WHERE id = ${id}`;
    if (!rows.length) return send(res, 404, { error: 'Mockup item not found' });
    await sql`DELETE FROM mockup_items WHERE id = ${id}`;
    if (rows[0].image_url) {
      try { await del(rows[0].image_url); } catch (err) { console.error('Blob cleanup failed', err); }
    }
    return send(res, 204, null);
  }

  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
};
