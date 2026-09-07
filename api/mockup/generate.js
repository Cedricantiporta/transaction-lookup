const { put } = require('@vercel/blob');
const { sql, ensureSchema, imageRow, readJson, send } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logActivity } = require('../_lib/activity');
const { uid } = require('../_lib/util');

// Model id taken directly from the docs link the project owner provided:
// https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image
const GEMINI_MODEL = 'gemini-3.1-flash-lite-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MOCKUP_PROMPT = (itemName) =>
  `You are given two images: a blank product mockup photo (a ${itemName}) and a graphic design. ` +
  `Composite the second image (the design) onto the product in the first image as if it were printed ` +
  `or applied directly onto its surface. Match the product's perspective, curvature, folds, lighting, ` +
  `and shadows so the design looks physically real on the product, not pasted flat on top. Keep everything ` +
  `else in the original mockup photo unchanged — same background, same product, same framing. ` +
  `Output only the final composited product photo, nothing else.`;

async function fetchAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch source image (${res.status})`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), mimeType: contentType };
}

module.exports = async function handler(req, res) {
  await ensureSchema();
  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed. Use POST.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return send(res, 500, { error: 'GEMINI_API_KEY is not configured.' });

  const body = await readJson(req);
  const { mockupItemId, designImageId, boardId } = body;
  if (!mockupItemId || !designImageId || !boardId) {
    return send(res, 400, { error: 'mockupItemId, designImageId, and boardId are required' });
  }

  const [{ rows: itemRows }, { rows: designRows }] = await Promise.all([
    sql`SELECT * FROM mockup_items WHERE id = ${mockupItemId}`,
    sql`SELECT * FROM images WHERE id = ${designImageId}`,
  ]);
  if (!itemRows.length) return send(res, 404, { error: 'Mockup item not found' });
  if (!designRows.length) return send(res, 404, { error: 'Design image not found' });
  const mockupItem = itemRows[0];
  const design = designRows[0];

  try {
    const [itemImg, designImg] = await Promise.all([
      fetchAsBase64(mockupItem.image_url),
      fetchAsBase64(design.full_url),
    ]);

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: MOCKUP_PROMPT(mockupItem.name) },
            { inline_data: { mime_type: itemImg.mimeType, data: itemImg.base64 } },
            { inline_data: { mime_type: designImg.mimeType, data: designImg.base64 } },
          ],
        }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      console.error('Gemini API error', geminiRes.status, errText);
      return send(res, 502, { error: 'AI mockup generation failed. Check GEMINI_API_KEY and the model name.' });
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData || p.inline_data);
    const inline = imagePart?.inlineData || imagePart?.inline_data;
    if (!inline?.data) {
      console.error('Gemini response had no image part', JSON.stringify(geminiData).slice(0, 500));
      return send(res, 502, { error: 'AI did not return an image.' });
    }

    const resultBuffer = Buffer.from(inline.data, 'base64');
    const id = uid();
    const blob = await put(`boards/${boardId}/${id}-mockup.jpg`, resultBuffer, {
      access: 'public', contentType: inline.mimeType || 'image/jpeg',
    });

    const name = `${mockupItem.name} mockup`;
    const createdAt = Date.now();
    await sql`
      INSERT INTO images (id, board_id, category_id, name, width, height, size, thumb_url, full_url, created_at)
      VALUES (${id}, ${boardId}, NULL, ${name}, NULL, NULL, ${resultBuffer.length}, ${blob.url}, ${blob.url}, ${createdAt})
    `;
    const { rows: boardRows } = await sql`SELECT name FROM boards WHERE id = ${boardId}`;
    await logActivity(session, {
      action: 'create_mockup', targetType: 'image', targetId: id, targetName: name,
      boardId, boardName: boardRows[0]?.name,
    });

    return send(res, 201, imageRow({
      id, board_id: boardId, category_id: null, name, width: null, height: null,
      size: resultBuffer.length, thumb_url: blob.url, full_url: blob.url, created_at: createdAt, dominant_color: null,
    }));
  } catch (err) {
    console.error('Mockup generation failed', err);
    return send(res, 500, { error: 'AI mockup generation failed.' });
  }
};
