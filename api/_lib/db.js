const { neon } = require('@neondatabase/serverless');
const { uid } = require('./util');

// Support whichever env var name the connected Postgres/Neon integration
// happens to inject (Neon's own integration uses DATABASE_URL; the legacy
// Vercel Postgres integration used POSTGRES_URL).
const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING;

// fullResults gives back { rows, rowCount } like node-postgres, matching
// the shape every query in this API relies on. If no connection string is
// configured yet (storage not set up in the Vercel dashboard), fail lazily
// with a clear message instead of crashing at cold start.
const sql = connectionString
  ? neon(connectionString, { fullResults: true })
  : () => { throw new Error('Database not configured — set DATABASE_URL (or POSTGRES_URL) in your Vercel project.'); };

let schemaReady = null;

// Idempotent — safe to call on every invocation. Memoized per warm lambda
// so repeat requests on the same instance skip the round trip.
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS boards (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          board_order INTEGER NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL,
          type TEXT NOT NULL DEFAULT 'moodboard'
        )
      `;
      // Additive — 'moodboard' (shown in the sidebar), 'design' and
      // 'mockup' (folders used only by the mockup generator, never shown
      // as a regular moodboard).
      await sql`ALTER TABLE boards ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'moodboard'`;
      await sql`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS images (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          width INTEGER,
          height INTEGER,
          size INTEGER,
          thumb_url TEXT NOT NULL,
          full_url TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          dominant_color TEXT,
          colors TEXT
        )
      `;
      // Additive — safe on both a fresh table (already has the column) and
      // an existing deployed one created before this column existed.
      await sql`ALTER TABLE images ADD COLUMN IF NOT EXISTS dominant_color TEXT`;
      await sql`ALTER TABLE images ADD COLUMN IF NOT EXISTS colors TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS images_board_idx ON images(board_id)`;
      await sql`CREATE INDEX IF NOT EXISTS categories_board_idx ON categories(board_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT,
          picture TEXT,
          created_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS activity_log (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          user_name TEXT,
          user_email TEXT,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          target_name TEXT,
          board_id TEXT,
          board_name TEXT,
          created_at BIGINT NOT NULL
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log(created_at DESC)`;

      // One-time migration: mockup items used to live in their own table,
      // before mockup items and designs became regular boards/images (just
      // hidden from the main sidebar via type). If that old table exists
      // and still has rows nobody's migrated yet, fold them into a fresh
      // "Mockup Items" folder so nothing uploaded during testing is lost.
      // Non-fatal — a hiccup here shouldn't break the whole app.
      try {
        const { rows: tableCheck } = await sql`SELECT to_regclass('mockup_items') AS t`;
        if (tableCheck[0].t) {
          const { rows: oldItems } = await sql`SELECT * FROM mockup_items`;
          if (oldItems.length) {
            const { rows: existing } = await sql`SELECT id FROM boards WHERE type = 'mockup' LIMIT 1`;
            if (!existing.length) {
              const folderId = uid();
              await sql`
                INSERT INTO boards (id, name, color, board_order, created_at, type)
                VALUES (${folderId}, 'Mockup Items', '#ac8e68', 0, ${Date.now()}, 'mockup')
              `;
              for (const item of oldItems) {
                await sql`
                  INSERT INTO images (id, board_id, category_id, name, width, height, size, thumb_url, full_url, created_at)
                  VALUES (${item.id}, ${folderId}, NULL, ${item.name}, NULL, NULL, 0, ${item.image_url}, ${item.image_url}, ${item.created_at})
                `;
              }
            }
          }
        }
      } catch (err) {
        console.error('mockup_items migration failed (non-fatal)', err);
      }
    })().catch((err) => {
      schemaReady = null; // allow retry on next request if it failed
      throw err;
    });
  }
  return schemaReady;
}

function boardRow(r) {
  return { id: r.id, name: r.name, color: r.color, order: r.board_order, createdAt: Number(r.created_at), type: r.type };
}

function categoryRow(r) {
  return { id: r.id, boardId: r.board_id, name: r.name, color: r.color, createdAt: Number(r.created_at) };
}

function imageRow(r) {
  return {
    id: r.id,
    boardId: r.board_id,
    categoryId: r.category_id,
    name: r.name,
    width: r.width,
    height: r.height,
    size: r.size,
    thumbUrl: r.thumb_url,
    fullUrl: r.full_url,
    createdAt: Number(r.created_at),
    dominantColor: r.dominant_color,
    colors: parseColors(r.colors) || (r.dominant_color ? [r.dominant_color] : []),
  };
}

function parseColors(raw) {
  if (!raw) return null;
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : null; }
  catch { return null; }
}

function activityRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    targetName: r.target_name,
    boardId: r.board_id,
    boardName: r.board_name,
    createdAt: Number(r.created_at),
  };
}

// Vercel's Node runtime pre-parses JSON/urlencoded bodies into req.body but
// deliberately leaves multipart untouched — handle both cases.
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  if (data === null || data === undefined) return res.status(status).end();
  res.status(status).json(data);
}

module.exports = { sql, ensureSchema, boardRow, categoryRow, imageRow, activityRow, readJson, send };
