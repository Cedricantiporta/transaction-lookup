const { formidable } = require('formidable');
const fs = require('fs');
const { put, del } = require('@vercel/blob');
const { sql, ensureSchema, imageRow, readJson, send } = require('./_lib/db');
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

  if (req.method === 'GET') {
    const { boardId } = req.query;
    if (!boardId) return send(res, 400, { error: 'Provide ?boardId=' });
    const { rows } = await sql`
      SELECT * FROM images WHERE board_id = ${boardId} ORDER BY created_at DESC
    `;
    return send(res, 200, rows.map(imageRow));
  }

  if (req.method === 'POST') {
    let fields, files;
    try {
      ({ fields, files } = await parseMultipart(req));
    } catch (err) {
      console.error('Upload parse failed', err);
      return send(res, 400, { error: 'Could not read upload (file may be too large).' });
    }

    const boardId = first(fields.boardId);
    const name = (first(fields.name) || 'Untitled').toString().trim() || 'Untitled';
    const width = Number(first(fields.width)) || null;
    const height = Number(first(fields.height)) || null;
    const colorField = (first(fields.color) || '').toString();
    const dominantColor = /^#[0-9a-fA-F]{6}$/.test(colorField) ? colorField : null;
    const thumbFile = first(files.thumb);
    const fullFile = first(files.full);

    if (!boardId || !thumbFile || !fullFile) {
      return send(res, 400, { error: 'boardId, thumb, and full are required' });
    }

    const id = uid();
    try {
      const [thumbBlob, fullBlob] = await Promise.all([
        put(`boards/${boardId}/${id}-thumb.jpg`, fs.createReadStream(thumbFile.filepath), {
          access: 'public', contentType: thumbFile.mimetype || 'image/jpeg',
        }),
        put(`boards/${boardId}/${id}-full.jpg`, fs.createReadStream(fullFile.filepath), {
          access: 'public', contentType: fullFile.mimetype || 'image/jpeg',
        }),
      ]);

      const image = {
        id, boardId, categoryId: null, name, width, height,
        size: fullFile.size, thumbUrl: thumbBlob.url, fullUrl: fullBlob.url,
        createdAt: Date.now(), dominantColor,
      };
      await sql`
        INSERT INTO images (id, board_id, category_id, name, width, height, size, thumb_url, full_url, created_at, dominant_color)
        VALUES (${image.id}, ${image.boardId}, NULL, ${image.name}, ${image.width}, ${image.height}, ${image.size}, ${image.thumbUrl}, ${image.fullUrl}, ${image.createdAt}, ${image.dominantColor})
      `;
      return send(res, 201, image);
    } catch (err) {
      console.error('Image upload failed', err);
      return send(res, 500, { error: 'Upload failed' });
    } finally {
      [thumbFile, fullFile].forEach((f) => { if (f && f.filepath) fs.unlink(f.filepath, () => {}); });
    }
  }

  const id = req.query.id;
  if (!id) return send(res, 400, { error: 'Missing ?id=' });

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    let touched = false;

    if (has('name')) {
      const name = (body.name || 'Untitled').toString().trim() || 'Untitled';
      await sql`UPDATE images SET name = ${name} WHERE id = ${id}`;
      touched = true;
    }
    if (has('categoryId')) {
      await sql`UPDATE images SET category_id = ${body.categoryId} WHERE id = ${id}`;
      touched = true;
    }
    if (has('boardId')) {
      await sql`UPDATE images SET board_id = ${body.boardId} WHERE id = ${id}`;
      touched = true;
    }
    if (!touched) return send(res, 400, { error: 'Nothing to update' });

    const { rows } = await sql`SELECT * FROM images WHERE id = ${id}`;
    if (!rows.length) return send(res, 404, { error: 'Image not found' });
    return send(res, 200, imageRow(rows[0]));
  }

  if (req.method === 'DELETE') {
    const { rows } = await sql`SELECT thumb_url, full_url FROM images WHERE id = ${id}`;
    if (!rows.length) return send(res, 404, { error: 'Image not found' });
    await sql`DELETE FROM images WHERE id = ${id}`;
    const urls = [rows[0].thumb_url, rows[0].full_url].filter(Boolean);
    if (urls.length) {
      try { await del(urls); } catch (err) { console.error('Blob cleanup failed', err); }
    }
    return send(res, 204, null);
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
};
