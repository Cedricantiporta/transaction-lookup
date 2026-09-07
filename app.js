'use strict';

/* ============================================================
   Moodboard — a shared, minimalist image moodboard app.
   Data lives in Vercel Postgres + Vercel Blob (see /api); anyone
   with the link sees and edits the same boards.
   ============================================================ */

const THUMB_MAX_DIM = 720;
const THUMB_QUALITY = 0.84;
const FULL_MAX_DIM = 2200;
const FULL_QUALITY = 0.85;
const POLL_INTERVAL_MS = 15000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Last-known-good snapshots, used to paint instantly on load/board-switch
// while the real network request runs in the background.
function readCache(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* storage full or unavailable — skip caching, not fatal */ }
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function relativeDate(ts) {
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < day) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < day * 30) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ------------------------------- API layer ------------------------------- */

async function request(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { const data = await res.json(); if (data && data.error) message = data.error; } catch { /* ignore */ }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

const qs = (id) => `?id=${encodeURIComponent(id)}`;
const jsonBody = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const Api = {
  listBoards: () => request('/api/boards'),
  createBoard: (body) => request('/api/boards', { method: 'POST', ...jsonBody(body) }),
  renameBoard: (id, name) => request(`/api/boards${qs(id)}`, { method: 'PATCH', ...jsonBody({ name }) }),
  deleteBoard: (id) => request(`/api/boards${qs(id)}`, { method: 'DELETE' }),

  listCategories: (boardId) => request(boardId ? `/api/categories?boardId=${encodeURIComponent(boardId)}` : '/api/categories'),
  createCategory: (body) => request('/api/categories', { method: 'POST', ...jsonBody(body) }),
  renameCategory: (id, name) => request(`/api/categories${qs(id)}`, { method: 'PATCH', ...jsonBody({ name }) }),
  deleteCategory: (id) => request(`/api/categories${qs(id)}`, { method: 'DELETE' }),

  listImages: (boardId) => request(`/api/images?boardId=${encodeURIComponent(boardId)}`),
  uploadImage: (formData) => request('/api/images', { method: 'POST', body: formData }),
  patchImage: (id, body) => request(`/api/images${qs(id)}`, { method: 'PATCH', ...jsonBody(body) }),
  deleteImage: (id) => request(`/api/images${qs(id)}`, { method: 'DELETE' }),
};

/* ------------------------------- Image processing ------------------------------- */

function drawToJpeg(bitmap, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha — flatten transparent PNGs onto white instead of black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve({ blob, width: w, height: h }), 'image/jpeg', quality));
}

async function fileToThumb(file) {
  const bitmap = await createImageBitmap(file);
  const result = await drawToJpeg(bitmap, THUMB_MAX_DIM, THUMB_QUALITY);
  bitmap.close();
  return result;
}

async function fileToFull(file) {
  const bitmap = await createImageBitmap(file);
  const result = await drawToJpeg(bitmap, FULL_MAX_DIM, FULL_QUALITY);
  bitmap.close();
  return result;
}

async function computeDominantColor(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // skip mostly-transparent pixels
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      n++;
    }
    if (!n) return null;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/* ------------------------------- Color filter buckets ------------------------------- */

const COLOR_BUCKETS = [
  { key: 'red', label: 'Red', swatch: '#e0483e', hue: [345, 15] },
  { key: 'orange', label: 'Orange', swatch: '#e08a3e', hue: [15, 45] },
  { key: 'yellow', label: 'Yellow', swatch: '#e0c53e', hue: [45, 65] },
  { key: 'green', label: 'Green', swatch: '#5cb85c', hue: [65, 160] },
  { key: 'teal', label: 'Teal', swatch: '#3ea0a0', hue: [160, 195] },
  { key: 'blue', label: 'Blue', swatch: '#3e7fe0', hue: [195, 255] },
  { key: 'purple', label: 'Purple', swatch: '#8a5ce0', hue: [255, 290] },
  { key: 'pink', label: 'Pink', swatch: '#e05ca0', hue: [290, 345] },
  { key: 'brown', label: 'Brown', swatch: '#8a5a3c' },
  { key: 'black', label: 'Black', swatch: '#2b2b2d' },
  { key: 'white', label: 'White', swatch: '#f0f0f0' },
  { key: 'gray', label: 'Gray', swatch: '#9a9a9e' },
];
const COLOR_BUCKETS_BY_KEY = Object.fromEntries(COLOR_BUCKETS.map((b) => [b.key, b]));

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function bucketForColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const { h, s, l } = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  if (l < 12) return 'black';
  if (l > 92 && s < 12) return 'white';
  if (s < 14) return 'gray';
  if (l < 32 && h >= 15 && h < 55) return 'brown';
  const hued = COLOR_BUCKETS.find(({ hue }) => hue && (hue[0] <= hue[1] ? (h >= hue[0] && h < hue[1]) : (h >= hue[0] || h < hue[1])));
  return hued ? hued.key : 'gray';
}

/* ------------------------------- App state ------------------------------- */

const state = {
  boards: [],
  categories: [],
  images: [],
  currentBoardId: null,
  currentCategoryId: 'all',
  currentColorFilter: null,
  viewMode: localStorage.getItem('mb.viewMode') || 'masonry',
  search: '',
  selection: new Set(),
};

/* ------------------------------- Data operations ------------------------------- */

function boardById(id) { return state.boards.find((b) => b.id === id); }

async function refreshBoards() {
  state.boards = await Api.listBoards();
}

const MOBILE_BREAKPOINT = 640;

function setSidebarOpen(open) {
  $('#sidebar').classList.toggle('collapsed', !open);
  const backdrop = $('#sidebarBackdrop');
  if (backdrop) backdrop.hidden = !(open && window.innerWidth <= MOBILE_BREAKPOINT);
}

async function selectBoard(boardId) {
  state.currentBoardId = boardId;
  state.currentCategoryId = 'all';
  state.selection.clear();
  localStorage.setItem('mb.activeBoard', boardId);

  // Paint instantly from whatever we last saw for this board, then let the
  // real fetch below silently correct it once it lands.
  const cachedImages = readCache('mb.cache.images.' + boardId);
  if (cachedImages) {
    state.images = cachedImages;
    renderSidebar();
    renderCategoryBar();
    renderBoard();
  }

  state.images = await Api.listImages(boardId);
  writeCache('mb.cache.images.' + boardId, state.images);
  renderSidebar();
  renderCategoryBar();
  renderBoard();
  if (window.innerWidth <= MOBILE_BREAKPOINT) setSidebarOpen(false);
}

/* ------------------------------- Rendering ------------------------------- */

function renderSidebar() {
  const list = $('#boardList');
  list.innerHTML = '';
  state.boards.forEach((board) => {
    const item = document.createElement('div');
    item.className = 'board-item' + (state.currentBoardId === board.id ? ' active' : '');
    item.dataset.boardId = board.id;
    item.innerHTML = `
      <span class="board-item-swatch" style="background:${board.color}"></span>
      <span class="board-item-name" spellcheck="false">${escapeHtml(board.name)}</span>
      <span class="board-item-count">${board.imageCount ?? ''}</span>
      <button class="board-item-menu-btn" aria-label="Board options">
        <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="5" r="2.1" fill="currentColor"/><circle cx="12" cy="12" r="2.1" fill="currentColor"/><circle cx="12" cy="19" r="2.1" fill="currentColor"/></svg>
      </button>`;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.board-item-menu-btn') || e.target.isContentEditable) return;
      selectBoard(board.id);
    });

    const nameEl = $('.board-item-name', item);
    item.addEventListener('dblclick', (e) => { if (e.target === nameEl) startRenameBoard(board.id); });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = board.name; nameEl.blur(); }
    });
    nameEl.addEventListener('blur', () => commitBoardRename(board.id, nameEl));

    $('.board-item-menu-btn', item).addEventListener('click', (e) => {
      e.stopPropagation();
      openBoardMenu(e.currentTarget, board.id);
    });

    // drag images onto a sidebar board to move them
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const imageId = e.dataTransfer.getData('text/moodboard-image-id');
      if (imageId) moveImagesToBoard([imageId], board.id);
    });

    list.appendChild(item);
  });

  const active = boardById(state.currentBoardId);
  const titleEl = $('#boardTitle');
  if (active) {
    titleEl.textContent = active.name;
    titleEl.contentEditable = 'true';
    $('#boardSubtitle').textContent = `${state.images.length} image${state.images.length === 1 ? '' : 's'}`;
  }
}

function renderCategoryBar() {
  const bar = $('#categoryBar');
  bar.innerHTML = '';

  const cats = state.categories.filter((c) => c.boardId === state.currentBoardId);
  const allChip = makeChip('All', state.currentCategoryId === 'all', null, state.images.length);
  allChip.addEventListener('click', () => { state.currentCategoryId = 'all'; renderCategoryBar(); renderBoard(); });
  bar.appendChild(allChip);

  cats.forEach((cat) => {
    const count = state.images.filter((i) => i.categoryId === cat.id).length;
    const chip = makeChip(cat.name, state.currentCategoryId === cat.id, cat.color, count);
    chip.addEventListener('click', () => { state.currentCategoryId = cat.id; renderCategoryBar(); renderBoard(); });
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Rename category', onClick: () => renameCategoryPrompt(cat) },
        { label: 'Delete category', danger: true, onClick: () => deleteCategory(cat.id) },
      ]);
    });
    bar.appendChild(chip);
  });

  const addChip = document.createElement('button');
  addChip.className = 'chip chip-add';
  addChip.innerHTML = '+ New category';
  addChip.addEventListener('click', () => promptNewCategory());
  bar.appendChild(addChip);

  const presentBuckets = new Set(state.images.map((i) => bucketForColor(i.dominantColor)).filter(Boolean));
  if (presentBuckets.size > 1) {
    const divider = document.createElement('div');
    divider.className = 'category-bar-divider';
    bar.appendChild(divider);
    COLOR_BUCKETS.filter((b) => presentBuckets.has(b.key)).forEach((b) => {
      const swatch = document.createElement('button');
      swatch.className = 'color-swatch-btn' + (state.currentColorFilter === b.key ? ' active' : '');
      swatch.title = `Filter by ${b.label}`;
      swatch.setAttribute('aria-label', `Filter by ${b.label}`);
      swatch.style.setProperty('--swatch-color', b.swatch);
      swatch.addEventListener('click', () => {
        state.currentColorFilter = state.currentColorFilter === b.key ? null : b.key;
        renderCategoryBar();
        renderBoard();
      });
      bar.appendChild(swatch);
    });
  }
}

function makeChip(label, active, color, count) {
  const chip = document.createElement('button');
  chip.className = 'chip' + (active ? ' active' : '');
  chip.innerHTML = `${color ? `<span class="chip-dot" style="background:${color}"></span>` : ''}<span>${escapeHtml(label)}</span>${typeof count === 'number' ? `<span style="opacity:.55">${count}</span>` : ''}`;
  return chip;
}

function currentVisibleImages() {
  let list = state.images;
  if (state.currentCategoryId !== 'all') {
    list = list.filter((i) => i.categoryId === state.currentCategoryId);
  }
  if (state.currentColorFilter) {
    list = list.filter((i) => bucketForColor(i.dominantColor) === state.currentColorFilter);
  }
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter((i) => i.name.toLowerCase().includes(q));
  }
  return list;
}

function renderBoard() {
  const masonry = $('#masonry');
  const images = currentVisibleImages();
  masonry.classList.toggle('grid-mode', state.viewMode === 'grid');
  masonry.innerHTML = '';

  $('#emptyState').hidden = images.length > 0;
  if (images.length === 0) {
    if (state.search.trim()) {
      $('#emptyTitle').textContent = 'No matches';
      $('#emptySubtitle').textContent = `Nothing found for "${state.search.trim()}".`;
    } else if (state.currentCategoryId !== 'all') {
      $('#emptyTitle').textContent = 'No images in this category';
      $('#emptySubtitle').textContent = 'Assign images here from the card menu or the viewer.';
    } else {
      $('#emptyTitle').textContent = 'Nothing here yet';
      $('#emptySubtitle').textContent = 'Drag images in, or click Add Images to start this moodboard.';
    }
  }

  images.forEach((image, idx) => masonry.appendChild(renderCard(image, idx, images)));
  updateSelectionBar();
  updateDropTargetLabel();
}

function categoryFor(image) {
  return state.categories.find((c) => c.id === image.categoryId);
}

function renderCard(image, idx, listRef) {
  const card = document.createElement('div');
  card.className = 'card' + (state.selection.has(image.id) ? ' selected' : '');
  card.dataset.id = image.id;
  card.style.animationDelay = `${Math.min(idx, 24) * 18}ms`;
  card.draggable = true;

  const cat = categoryFor(image);

  card.innerHTML = `
    <div class="card-media">
      <img src="${image.thumbUrl}" alt="${escapeHtml(image.name)}" loading="lazy" decoding="async" fetchpriority="low" width="${image.width || 0}" height="${image.height || 0}">
      <div class="card-select-check">
        <svg viewBox="0 0 24 24" width="12" height="12"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="card-overlay">
        <div class="card-top-actions">
          <button class="card-action" data-action="menu" title="More"><svg viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></svg></button>
          <button class="card-action danger" data-action="delete" title="Delete"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
        <div class="card-bottom">
          <div class="card-name">${escapeHtml(image.name)}</div>
          <div class="card-tags">
            ${cat ? `<span class="card-cat-badge" style="background:${cat.color}dd">${escapeHtml(cat.name)}</span>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-action')) return handleCardAction(e, image);
    if (e.target.closest('.card-select-check') || e.metaKey || e.ctrlKey) {
      toggleSelection(image.id);
      return;
    }
    openLightbox(listRef, idx);
  });

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCardContextMenu(e.clientX, e.clientY, image);
  });

  if (card.draggable) {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/moodboard-image-id', image.id);
      e.dataTransfer.effectAllowed = 'move';
    });
  }

  return card;
}

function handleCardAction(e, image) {
  const action = e.target.closest('.card-action').dataset.action;
  e.stopPropagation();
  if (action === 'delete') confirmDeleteImages([image.id]);
  else if (action === 'menu') showCardContextMenu(e.clientX, e.clientY, image);
}

/* ------------------------------- Selection ------------------------------- */

function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
  renderBoard();
}

function clearSelection() { state.selection.clear(); renderBoard(); }

let selectionBarEl = null;
function ensureSelectionBar() {
  if (selectionBarEl) return selectionBarEl;
  selectionBarEl = document.createElement('div');
  selectionBarEl.className = 'selection-bar';
  document.body.appendChild(selectionBarEl);
  return selectionBarEl;
}

function updateSelectionBar() {
  const bar = ensureSelectionBar();
  const count = state.selection.size;
  bar.classList.toggle('visible', count > 0);
  if (count === 0) { bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <span class="selection-bar-count">${count} selected</span>
    <div class="selection-bar-divider"></div>
    <div class="selection-bar-actions">
      <button class="ghost-btn" data-a="download">Download</button>
      <button class="ghost-btn" data-a="move">Move to</button>
      <button class="ghost-btn danger" data-a="delete">Delete</button>
      <button class="icon-btn" data-a="clear" aria-label="Clear selection">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  bar.querySelector('[data-a="clear"]').addEventListener('click', clearSelection);
  const ids = () => Array.from(state.selection);
  bar.querySelector('[data-a="download"]').addEventListener('click', () => ids().forEach((id) => downloadImage(id)));
  bar.querySelector('[data-a="delete"]').addEventListener('click', () => confirmDeleteImages(ids()));
  bar.querySelector('[data-a="move"]').addEventListener('click', (e) => {
    const otherBoards = state.boards.filter((b) => b.id !== state.currentBoardId);
    if (!otherBoards.length) { showToast('No other moodboards to move to'); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    showContextMenu(rect.left, rect.top - 8 - otherBoards.length * 34, otherBoards.map((b) => ({
      label: b.name, swatch: b.color, onClick: () => moveImagesToBoard(ids(), b.id),
    })));
  });
}

/* ------------------------------- Board CRUD ------------------------------- */

async function createBoard() {
  const board = await Api.createBoard({});
  state.boards.push(board);
  await selectBoard(board.id);
  requestAnimationFrame(() => startRenameBoard(board.id, true));
}

function startRenameBoard(boardId, selectAll) {
  const item = $(`.board-item[data-board-id="${boardId}"]`);
  if (!item) return;
  const nameEl = $('.board-item-name', item);
  nameEl.contentEditable = 'true';
  nameEl.focus();
  if (selectAll) document.execCommand('selectAll', false, null);
}

async function commitBoardRename(boardId, nameEl) {
  nameEl.contentEditable = 'false';
  const board = boardById(boardId);
  const newName = nameEl.textContent.trim() || 'Untitled Moodboard';
  nameEl.textContent = newName;
  if (board.name !== newName) {
    const updated = await Api.renameBoard(boardId, newName);
    Object.assign(board, updated);
    if (state.currentBoardId === boardId) $('#boardTitle').textContent = board.name;
  }
}

function openBoardMenu(anchorEl, boardId) {
  const rect = anchorEl.getBoundingClientRect();
  showContextMenu(rect.right, rect.bottom + 4, [
    { label: 'Rename', onClick: () => startRenameBoard(boardId, true) },
    { label: 'Delete Moodboard', danger: true, onClick: () => confirmDeleteBoard(boardId) },
  ]);
}

async function confirmDeleteBoard(boardId) {
  const board = boardById(boardId);
  if (state.boards.length === 1) {
    showToast('You need at least one moodboard.');
    return;
  }
  const ok = await showConfirm({
    title: `Delete "${board.name}"?`,
    body: 'This permanently deletes the moodboard and every image inside it. This can’t be undone.',
    confirmLabel: 'Delete Moodboard',
  });
  if (!ok) return;

  await Api.deleteBoard(boardId);
  state.boards = state.boards.filter((b) => b.id !== boardId);
  state.categories = state.categories.filter((c) => c.boardId !== boardId);
  const next = state.boards[0];
  await selectBoard(next.id);
  showToast(`"${board.name}" deleted`);
}

/* ------------------------------- Category CRUD ------------------------------- */

async function promptNewCategory() {
  const name = await showTextPrompt({ title: 'New category', placeholder: 'e.g. Textures, Palette, References' });
  if (!name) return;
  const cat = await Api.createCategory({ boardId: state.currentBoardId, name });
  state.categories.push(cat);
  renderCategoryBar();
}

async function renameCategoryPrompt(cat) {
  const name = await showTextPrompt({ title: 'Rename category', placeholder: cat.name, initial: cat.name });
  if (!name) return;
  const updated = await Api.renameCategory(cat.id, name);
  Object.assign(cat, updated);
  renderCategoryBar();
  renderBoard();
}

async function deleteCategory(catId) {
  const ok = await showConfirm({
    title: 'Delete this category?',
    body: 'Images in it won’t be deleted, just uncategorized.',
    confirmLabel: 'Delete Category',
  });
  if (!ok) return;
  await Api.deleteCategory(catId);
  state.categories = state.categories.filter((c) => c.id !== catId);
  state.images.forEach((i) => { if (i.categoryId === catId) i.categoryId = null; });
  state.currentCategoryId = 'all';
  renderCategoryBar();
  renderBoard();
}

async function setImageCategory(imageId, categoryId) {
  const image = state.images.find((i) => i.id === imageId);
  if (!image) return;
  const updated = await Api.patchImage(imageId, { categoryId: categoryId || null });
  Object.assign(image, updated);
  renderCategoryBar();
  renderBoard();
}

/* ------------------------------- Image upload ------------------------------- */

function setUploadProgress({ current, total, previewUrl, fileName }) {
  const overlay = $('#uploadOverlay');
  overlay.hidden = false;
  const pct = total ? Math.round((current / total) * 100) : 0;
  $('#uploadProgressFill').style.width = pct + '%';
  $('#uploadProgressPct').textContent = pct + '%';
  $('#uploadProgressCount').textContent = `${Math.min(current + 1, total)} of ${total}`;
  $('#uploadTitle').textContent = fileName ? `Uploading “${fileName}”` : 'Finishing up…';
  const thumb = $('#uploadThumb');
  thumb.innerHTML = previewUrl ? `<img src="${previewUrl}" alt="">` : '';
}

function hideUploadProgress() {
  $('#uploadOverlay').hidden = true;
  $('#uploadThumb').innerHTML = '';
}

async function addImages(files, boardId = state.currentBoardId) {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;

  const total = imageFiles.length;
  let added = 0;

  for (let i = 0; i < total; i++) {
    const file = imageFiles[i];
    const previewUrl = URL.createObjectURL(file);
    setUploadProgress({ current: i, total, previewUrl, fileName: file.name });
    try {
      const [{ blob: thumbBlob }, { blob: fullBlob, width, height }, dominantColor] = await Promise.all([
        fileToThumb(file),
        fileToFull(file),
        computeDominantColor(file),
      ]);
      const form = new FormData();
      form.append('boardId', boardId);
      form.append('name', file.name.replace(/\.[^/.]+$/, '') || 'Untitled');
      form.append('width', width);
      form.append('height', height);
      form.append('color', dominantColor || '');
      form.append('thumb', thumbBlob, 'thumb.jpg');
      form.append('full', fullBlob, 'full.jpg');
      const image = await Api.uploadImage(form);
      if (boardId === state.currentBoardId) {
        state.images.unshift(image);
      }
      added++;
    } catch (err) {
      console.error('Failed to add image', file.name, err);
    } finally {
      URL.revokeObjectURL(previewUrl);
    }
  }

  setUploadProgress({ current: total, total, previewUrl: null, fileName: null });
  await new Promise((resolve) => setTimeout(resolve, 300));
  hideUploadProgress();

  await refreshBoards();
  renderSidebar();
  renderCategoryBar();
  renderBoard();
  const failed = total - added;
  showToast(`${added} image${added === 1 ? '' : 's'} added${failed ? ` · ${failed} failed` : ''}`);
}

/* ------------------------------- Delete ------------------------------- */

async function confirmDeleteImages(ids) {
  const ok = await showConfirm({
    title: `Delete ${ids.length} image${ids.length > 1 ? 's' : ''}?`,
    body: 'This can’t be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return false;
  await Promise.all(ids.map((id) => Api.deleteImage(id)));
  state.images = state.images.filter((i) => !ids.includes(i.id));
  state.selection.clear();
  await refreshBoards();
  renderSidebar();
  renderCategoryBar();
  renderBoard();
  showToast(`Deleted ${ids.length} image${ids.length > 1 ? 's' : ''}`);
  return true;
}

async function moveImagesToBoard(ids, boardId) {
  const images = state.images.filter((i) => ids.includes(i.id));
  if (!images.length) return;
  await Promise.all(ids.map((id) => Api.patchImage(id, { boardId, categoryId: null })));
  state.images = state.images.filter((i) => !ids.includes(i.id));
  state.selection.clear();
  await refreshBoards();
  renderSidebar();
  renderBoard();
  const board = boardById(boardId);
  showToast(`Moved to "${board.name}"`);
}

function downloadImage(id) {
  const image = state.images.find((i) => i.id === id);
  if (!image) return;
  const a = document.createElement('a');
  a.href = image.fullUrl;
  a.download = `${image.name}.jpg`;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ------------------------------- Context menu (cards) ------------------------------- */

function showCardContextMenu(x, y, image) {
  const cats = state.categories.filter((c) => c.boardId === image.boardId);
  const otherBoards = state.boards.filter((b) => b.id !== image.boardId);
  const items = [
    { label: 'View Full Screen', onClick: () => openLightbox(currentVisibleImages(), currentVisibleImages().findIndex((i) => i.id === image.id)) },
    { label: 'Download', onClick: () => downloadImage(image.id) },
    { sep: true },
    { label: 'Category', sub: [
      ...cats.map((c) => ({ label: c.name, swatch: c.color, onClick: () => setImageCategory(image.id, c.id) })),
      { label: '+ New category…', onClick: async () => {
        const name = await showTextPrompt({ title: 'New category', placeholder: 'Category name' });
        if (!name) return;
        const cat = await Api.createCategory({ boardId: image.boardId, name });
        state.categories.push(cat);
        await setImageCategory(image.id, cat.id);
      } },
    ] },
  ];
  if (otherBoards.length) {
    items.push({ label: 'Move to', sub: otherBoards.map((b) => ({
      label: b.name, swatch: b.color, onClick: () => moveImagesToBoard([image.id], b.id),
    })) });
  }
  items.push({ sep: true });
  items.push({ label: 'Delete', danger: true, onClick: () => confirmDeleteImages([image.id]) });
  showContextMenu(x, y, items);
}

let menuCloseHandler = null;
function showContextMenu(x, y, items) {
  const menu = $('#contextMenu');
  closeContextMenu();
  menu.innerHTML = '';
  renderMenuItems(menu, items);
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = `${Math.min(x, vw - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, vh - rect.height - 10)}px`;

  menuCloseHandler = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  setTimeout(() => {
    document.addEventListener('click', menuCloseHandler);
    document.addEventListener('contextmenu', menuCloseHandler);
  });
}

function renderMenuItems(container, items) {
  items.forEach((item) => {
    if (item.sep) { const d = document.createElement('div'); d.className = 'context-menu-sep'; container.appendChild(d); return; }
    if (item.sub) {
      const label = document.createElement('div');
      label.className = 'context-menu-label';
      label.textContent = item.label;
      container.appendChild(label);
      const sub = document.createElement('div');
      sub.className = 'context-menu-sub';
      renderMenuItems(sub, item.sub);
      container.appendChild(sub);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'context-menu-item' + (item.danger ? ' danger' : '');
    btn.innerHTML = `${item.swatch ? `<span class="context-menu-swatch" style="background:${item.swatch}"></span>` : ''}<span>${escapeHtml(item.label)}</span>`;
    btn.addEventListener('click', () => { closeContextMenu(); item.onClick(); });
    container.appendChild(btn);
  });
}

function closeContextMenu() {
  const menu = $('#contextMenu');
  menu.hidden = true;
  if (menuCloseHandler) {
    document.removeEventListener('click', menuCloseHandler);
    document.removeEventListener('contextmenu', menuCloseHandler);
    menuCloseHandler = null;
  }
}

/* ------------------------------- Lightbox ------------------------------- */

let lightboxList = [];
let lightboxIndex = 0;

function openLightbox(list, index) {
  lightboxList = list;
  lightboxIndex = index;
  renderLightbox();
  $('#lightbox').classList.add('open');
  $('#lightbox').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  $('#lightbox').classList.remove('open');
  $('#lightbox').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function navLightbox(delta) {
  const next = lightboxIndex + delta;
  if (next < 0 || next >= lightboxList.length) return;
  lightboxIndex = next;
  renderLightbox();
}

function renderLightbox() {
  const image = lightboxList[lightboxIndex];
  if (!image) return closeLightbox();
  const img = $('#lightboxImage');
  img.src = image.fullUrl;
  img.alt = image.name;

  $('#lightboxName').value = image.name;
  const board = boardById(image.boardId);
  $('#lightboxMeta').innerHTML = [
    `${image.width}×${image.height}px · ${formatBytes(image.size)}`,
    `Added ${relativeDate(image.createdAt)}`,
    board ? `In ${escapeHtml(board.name)}` : '',
  ].filter(Boolean).join('<br>');

  const select = $('#lightboxCategorySelect');
  const cats = state.categories.filter((c) => c.boardId === image.boardId);
  select.innerHTML = `<option value="">No category</option>` + cats.map((c) => `<option value="${c.id}" ${c.id === image.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');

  $('#lightboxPrev').disabled = lightboxIndex === 0;
  $('#lightboxNext').disabled = lightboxIndex === lightboxList.length - 1;
}

$('#lightboxClose').addEventListener('click', closeLightbox);
$('#lightboxBackdrop').addEventListener('click', closeLightbox);
$('#lightboxPrev').addEventListener('click', () => navLightbox(-1));
$('#lightboxNext').addEventListener('click', () => navLightbox(1));
$('#lightboxDownload').addEventListener('click', () => downloadImage(lightboxList[lightboxIndex].id));
$('#lightboxDelete').addEventListener('click', async () => {
  const image = lightboxList[lightboxIndex];
  if (await confirmDeleteImages([image.id])) closeLightbox();
});
$('#lightboxCategorySelect').addEventListener('change', (e) => {
  setImageCategory(lightboxList[lightboxIndex].id, e.target.value || null);
});
$('#lightboxName').addEventListener('change', async (e) => {
  const image = lightboxList[lightboxIndex];
  const updated = await Api.patchImage(image.id, { name: e.target.value.trim() || 'Untitled' });
  Object.assign(image, updated);
  e.target.value = image.name;
  renderBoard();
});

/* ------------------------------- Toasts ------------------------------- */

function showToast(message, opts = {}) {
  const stack = $('#toastStack');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  if (opts.actionLabel) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => { opts.onAction?.(); remove(); });
    toast.appendChild(btn);
  }
  stack.appendChild(toast);
  const timer = setTimeout(remove, opts.duration || 4000);
  function remove() {
    clearTimeout(timer);
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  }
}

/* ------------------------------- Modal (confirm + prompt) ------------------------------- */

function showConfirm({ title, body, confirmLabel = 'Confirm' }) {
  const backdrop = $('#modalBackdrop');
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modalConfirm').textContent = confirmLabel;
  backdrop.hidden = false;
  return new Promise((resolve) => {
    const cleanup = (result) => { backdrop.hidden = true; resolve(result); };
    $('#modalCancel').onclick = () => cleanup(false);
    $('#modalConfirm').onclick = () => cleanup(true);
    backdrop.onclick = (e) => { if (e.target === backdrop) cleanup(false); };
  });
}

function showTextPrompt({ title, placeholder = '', initial = '' }) {
  const backdrop = $('#modalBackdrop');
  const modal = $('#modal');
  const original = modal.innerHTML;
  modal.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <input type="text" id="promptInput" class="search-field" style="width:100%;margin-bottom:18px;padding:9px 11px;" placeholder="${escapeHtml(placeholder)}">
    <div class="modal-actions">
      <button class="ghost-btn" id="promptCancel">Cancel</button>
      <button class="primary-btn" id="promptOk">Save</button>
    </div>`;
  const input = $('#promptInput', modal);
  input.value = initial;
  backdrop.hidden = false;
  requestAnimationFrame(() => { input.focus(); input.select(); });

  return new Promise((resolve) => {
    const cleanup = (result) => { backdrop.hidden = true; modal.innerHTML = original; resolve(result); };
    $('#promptCancel', modal).onclick = () => cleanup(null);
    $('#promptOk', modal).onclick = () => cleanup(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cleanup(input.value.trim() || null);
      if (e.key === 'Escape') cleanup(null);
    });
    backdrop.onclick = (e) => { if (e.target === backdrop) cleanup(null); };
  });
}

/* ------------------------------- Upload wiring (drag & drop, file input) ------------------------------- */

function updateDropTargetLabel() {
  $('#dropTargetName').textContent = boardById(state.currentBoardId)?.name || 'this moodboard';
}

function initUpload() {
  const fileInput = $('#fileInput');
  $('#uploadBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { addImages(e.target.files); fileInput.value = ''; });

  const scroll = $('#boardScroll');
  let dragCounter = 0;
  scroll.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    scroll.classList.add('dragging');
  });
  scroll.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  scroll.addEventListener('dragleave', () => { dragCounter = Math.max(0, dragCounter - 1); if (dragCounter === 0) scroll.classList.remove('dragging'); });
  scroll.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    scroll.classList.remove('dragging');
    if (!e.dataTransfer.files?.length) return;
    addImages(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.isContentEditable)) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) addImages(files);
  });
}

/* ------------------------------- Misc UI wiring ------------------------------- */

function initTopbar() {
  $('#boardTitle').addEventListener('blur', async (e) => {
    const board = boardById(state.currentBoardId);
    const newName = e.target.textContent.trim() || 'Untitled Moodboard';
    e.target.textContent = newName;
    if (board.name !== newName) {
      const updated = await Api.renameBoard(board.id, newName);
      Object.assign(board, updated);
      renderSidebar();
    }
  });
  $('#boardTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderBoard(); });

  $$('.view-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      localStorage.setItem('mb.viewMode', state.viewMode);
      $$('.view-toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderBoard();
    });
  });
  $$('.view-toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.viewMode));

  $('#newBoardBtn').addEventListener('click', createBoard);

  $('#sidebarToggleBtn').addEventListener('click', () => {
    setSidebarOpen($('#sidebar').classList.contains('collapsed'));
  });
  $('#sidebarBackdrop').addEventListener('click', () => setSidebarOpen(false));
}

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').classList.contains('open')) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navLightbox(-1);
      if (e.key === 'ArrowRight') navLightbox(1);
      return;
    }
    if (!$('#modalBackdrop').hidden) return;
    if (e.key === 'Escape' && state.selection.size) clearSelection();
  });
}

/* ------------------------------- Live sync (lightweight polling) ------------------------------- */

function isUserBusy() {
  if ($('#lightbox').classList.contains('open')) return true;
  if (!$('#modalBackdrop').hidden) return true;
  if (!$('#contextMenu').hidden) return true;
  if (document.visibilityState !== 'visible') return true;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return true;
  return false;
}

function sig(list, keys) {
  return list.map((o) => keys.map((k) => o[k]).join('')).join('');
}

const BOARD_SIG_KEYS = ['id', 'name', 'color', 'order', 'imageCount'];
const IMAGE_SIG_KEYS = ['id', 'name', 'categoryId', 'boardId'];

async function pollTick() {
  if (isUserBusy()) return;
  try {
    const boards = await Api.listBoards();
    if (sig(boards, BOARD_SIG_KEYS) !== sig(state.boards, BOARD_SIG_KEYS)) {
      state.boards = boards;
      writeCache('mb.cache.boards', state.boards);
      if (!boardById(state.currentBoardId)) {
        if (state.boards.length) await selectBoard(state.boards[0].id);
        return;
      }
      renderSidebar();
    }
    const images = await Api.listImages(state.currentBoardId);
    if (sig(images, IMAGE_SIG_KEYS) !== sig(state.images, IMAGE_SIG_KEYS)) {
      state.images = images;
      writeCache('mb.cache.images.' + state.currentBoardId, state.images);
      renderCategoryBar();
      renderBoard();
    }
  } catch {
    // transient/offline — next tick retries
  }
}

function startPolling() {
  setInterval(pollTick, POLL_INTERVAL_MS);
}

/* ------------------------------- Boot ------------------------------- */

// Lets the boot screen stay up until whatever images are already in the
// DOM have actually loaded (or failed), capped so one slow/broken image
// can't hold the app hostage.
function waitForVisibleImages(maxWaitMs = 900) {
  const pending = $$('#masonry img').filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(pending.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))),
    new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
}

function hideBootScreen() {
  const boot = $('#bootScreen');
  if (!boot) return;
  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 400);
}

async function init() {
  initTopbar();
  initUpload();
  initKeyboard();
  setSidebarOpen(window.innerWidth > MOBILE_BREAKPOINT);

  const savedBoard = localStorage.getItem('mb.activeBoard');

  // Paint instantly from last visit's data (if any) so the UI never sits
  // blank while the network request below is in flight.
  const cachedBoards = readCache('mb.cache.boards');
  let paintedFromCache = false;
  if (cachedBoards && cachedBoards.length) {
    state.boards = cachedBoards;
    state.categories = readCache('mb.cache.categories') || [];
    const startBoard = boardById(savedBoard) ? savedBoard : state.boards[0].id;
    state.currentBoardId = startBoard;
    state.currentCategoryId = 'all';
    state.images = readCache('mb.cache.images.' + startBoard) || [];
    renderSidebar();
    renderCategoryBar();
    renderBoard();
    paintedFromCache = true;
    await waitForVisibleImages();
    hideBootScreen();
  }

  try {
    state.boards = await Api.listBoards();
    if (!state.boards.length) {
      const board = await Api.createBoard({});
      state.boards = [board];
    }
    state.categories = await Api.listCategories();
    writeCache('mb.cache.boards', state.boards);
    writeCache('mb.cache.categories', state.categories);

    const startBoard = boardById(savedBoard) ? savedBoard : state.boards[0].id;
    await selectBoard(startBoard);

    if (!paintedFromCache) {
      await waitForVisibleImages();
      hideBootScreen();
    }
  } catch (err) {
    hideBootScreen();
    if (!cachedBoards) throw err; // nothing cached to fall back on — surface the real error
    console.error('Background refresh failed, showing last cached data', err);
  }

  startPolling();
}

init().catch((err) => {
  console.error('Failed to start Moodboard', err);
  hideBootScreen();
  document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#666;text-align:center;padding:20px;">
    <div><h2 style="color:#111;">Couldn’t load Moodboard</h2><p>The shared backend might not be set up yet, or is temporarily unreachable. Check the browser console for details.</p></div>
  </div>`;
});
