const { sql } = require('./db');
const { uid } = require('./util');

// Best-effort — a logging failure should never block the action it's
// describing (an upload/delete that already succeeded shouldn't 500 out).
async function logActivity(session, { action, targetType, targetId, targetName, boardId, boardName }) {
  try {
    await sql`
      INSERT INTO activity_log (id, user_id, user_name, user_email, action, target_type, target_id, target_name, board_id, board_name, created_at)
      VALUES (${uid()}, ${session.sub}, ${session.name}, ${session.email}, ${action}, ${targetType || null}, ${targetId || null}, ${targetName || null}, ${boardId || null}, ${boardName || null}, ${Date.now()})
    `;
  } catch (err) {
    console.error('Activity log write failed', err);
  }
}

module.exports = { logActivity };
