const { neon } = require('@neondatabase/serverless');

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
          created_at BIGINT NOT NULL
        )
      `;
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
          created_at BIGINT NOT NULL
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS images_board_idx ON images(board_id)`;
      await sql`CREATE INDEX IF NOT EXISTS categories_board_idx ON categories(board_id)`;
    })().catch((err) => {
      schemaReady = null; // allow retry on next request if it failed
      throw err;
    });
  }
  return schemaReady;
}

function boardRow(r) {
  return { id: r.id, name: r.name, color: r.color, order: r.board_order, createdAt: Number(r.created_at) };
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

module.exports = { sql, ensureSchema, boardRow, categoryRow, imageRow, readJson, send };
