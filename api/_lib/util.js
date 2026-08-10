const crypto = require('crypto');

const PALETTE = [
  '#0071e3', '#ff9f0a', '#ff375f', '#30d158', '#bf5af2',
  '#64d2ff', '#ffd60a', '#ac8e68', '#5e5ce6', '#ff6482',
];

const uid = () => crypto.randomUUID();
const pickColor = (index) => PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  res.status(405).json({ error: `Method not allowed. Use ${allowed.join(', ')}.` });
}

module.exports = { uid, PALETTE, pickColor, methodNotAllowed };
