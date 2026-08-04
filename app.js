'use strict';

/* ============================================================
   Moodboard — a local-first, minimalist image moodboard app.
   No backend: everything lives in IndexedDB in this browser.
   ============================================================ */

const DB_NAME = 'moodboardDB';
const DB_VERSION = 1;
const BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const THUMB_MAX_DIM = 720;
const THUMB_QUALITY = 0.84;

const PALETTE = [
  '#0071e3', '#ff9f0a', '#ff375f', '#30d158', '#bf5af2',
  '#64d2ff', '#ffd60a', '#ac8e68', '#5e5ce6', '#ff6482'
];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pickColor(seedIndex) {
  return PALETTE[seedIndex % PALETTE.length];
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function daysLeft(deletedAt) {
  const remainMs = deletedAt + BIN_RETENTION_MS - Date.now();
  return Math.max(0, Math.ceil(remainMs / (24 * 60 * 60 * 1000)));
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

/* ------------------------------- IndexedDB layer ------------------------------- */

const DB = {
  _db: null,

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('boards')) {
          db.createObjectStore('boards', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('categories')) {
          const cats = db.createObjectStore('categories', { keyPath: 'id' });
          cats.createIndex('boardId', 'boardId');
        }
        if (!db.objectStoreNames.contains('images')) {
          const imgs = db.createObjectStore('images', { keyPath: 'id' });
          imgs.createIndex('boardId', 'boardId');
          imgs.createIndex('deletedAt', 'deletedAt');
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },

  async tx(storeNames, mode) {
    const db = await this.open();
    return db.transaction(storeNames, mode);
  },

  async getAll(store, indexName, query) {
    const tx = await this.tx(store, 'readonly');
    return new Promise((resolve, reject) => {
      const os = tx.objectStore(store);
      const target = indexName ? os.index(indexName) : os;
      const req = query !== undefined ? target.getAll(query) : target.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async put(store, value) {
    const tx = await this.tx(store, 'readwrite');
    return new Promise((resolve, reject) => {
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
    });
  },

  async delete(store, id) {
    const tx = await this.tx(store, 'readwrite');
    return new Promise((resolve, reject) => {
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteMany(store, ids) {
    const tx = await this.tx(store, 'readwrite');
    const os = tx.objectStore(store);
    ids.forEach((id) => os.delete(id));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

/* ------------------------------- Image processing ------------------------------- */

async function fileToThumb(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, THUMB_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY));
  return { blob, width: w, height: h };
}

async function fileNaturalSize(file) {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/* ------------------------------- App state ------------------------------- */

const state = {
  boards: [],
  categories: [],
  images: [],           // active images for current board (not deleted)
  binImages: [],         // all deleted images, across boards
  currentBoardId: null,
  currentView: 'bin',    // 'board' | 'bin'
  currentCategoryId: 'all',
  viewMode: localStorage.getItem('mb.viewMode') || 'masonry',
  search: '',
  selection: new Set(),
  objectUrls: new Map(), // imageId -> { thumb, full }
};

function objectUrlFor(image, kind) {
  const cache = state.objectUrls.get(image.id) || {};
  if (!cache[kind]) {
    cache[kind] = URL.createObjectURL(kind === 'thumb' ? image.thumbBlob : image.fullBlob);
    state.objectUrls.set(image.id, cache);
  }
  return cache[kind];
}

function revokeObjectUrls(imageId) {
  const cache = state.objectUrls.get(imageId);
  if (!cache) return;
  Object.values(cache).forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls.delete(imageId);
}

/* ------------------------------- Data operations ------------------------------- */

async function purgeExpired() {
  const deleted = await DB.getAll('images', 'deletedAt');
  const expired = deleted.filter((img) => img.deletedAt && Date.now() - img.deletedAt > BIN_RETENTION_MS);
  if (expired.length) {
    await DB.deleteMany('images', expired.map((i) => i.id));
  }
}

async function loadBoards() {
  state.boards = (await DB.getAll('boards')).sort((a, b) => a.order - b.order);
  if (state.boards.length === 0) {
    const board = { id: uid(), name: 'My Moodboard', color: pickColor(0), order: 0, createdAt: Date.now() };
    await DB.put('boards', board);
    state.boards = [board];
  }
}

async function loadCategories() {
  state.categories = await DB.getAll('categories');
}

async function loadImagesForBoard(boardId) {
  const all = await DB.getAll('images', 'boardId', boardId);
  state.images = all.filter((img) => !img.deletedAt).sort((a, b) => b.createdAt - a.createdAt);
}

async function loadBin() {
  const all = await DB.getAll('images', 'deletedAt');
  state.binImages = all.filter((img) => img.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
}

async function refreshStorageMeter() {
  const label = $('#storageMeterLabel');
  const fill = $('#storageMeterFill');
  if (!navigator.storage || !navigator.storage.estimate) { label.textContent = ''; return; }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    label.textContent = `${formatBytes(usage)} used`;
    fill.style.width = quota ? `${Math.min(100, (usage / quota) * 100)}%` : '0%';
  } catch { label.textContent = ''; }
}

/* ------------------------------- Rendering ------------------------------- */

function boardById(id) { return state.boards.find((b) => b.id === id); }

function renderSidebar() {
  const list = $('#boardList');
  list.innerHTML = '';
  state.boards.forEach((board) => {
    const item = document.createElement('div');
    item.className = 'board-item' + (state.currentView === 'board' && state.currentBoardId === board.id ? ' active' : '');
    item.dataset.boardId = board.id;
    item.draggable = false;
    item.innerHTML = `
      <span class="board-item-swatch" style="background:${board.color}"></span>
      <span class="board-item-name" spellcheck="false">${escapeHtml(board.name)}</span>
      <span class="board-item-count">${state.imageCounts?.[board.id] ?? ''}</span>
      <button class="board-item-menu-btn" aria-label="Board options">
        <svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
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

  $('#binCount').hidden = state.binImages.length === 0;
  $('#binCount').textContent = state.binImages.length;
  $('#binBtn').classList.toggle('active', state.currentView === 'bin');

  const active = state.currentView === 'board' ? boardById(state.currentBoardId) : null;
  const titleEl = $('#boardTitle');
  if (state.currentView === 'bin') {
    titleEl.textContent = 'Bin';
    titleEl.contentEditable = 'false';
    $('#boardSubtitle').textContent = 'Items are permanently deleted after 30 days';
  } else if (active) {
    titleEl.textContent = active.name;
    titleEl.contentEditable = 'true';
    $('#boardSubtitle').textContent = `${state.images.length} image${state.images.length === 1 ? '' : 's'}`;
  }
}

async function refreshImageCounts() {
  const counts = {};
  for (const b of state.boards) {
    const all = await DB.getAll('images', 'boardId', b.id);
    counts[b.id] = all.filter((i) => !i.deletedAt).length;
  }
  state.imageCounts = counts;
}

function renderCategoryBar() {
  const bar = $('#categoryBar');
  bar.innerHTML = '';
  if (state.currentView !== 'board') { bar.hidden = true; return; }
  bar.hidden = false;

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
}

function makeChip(label, active, color, count) {
  const chip = document.createElement('button');
  chip.className = 'chip' + (active ? ' active' : '');
  chip.innerHTML = `${color ? `<span class="chip-dot" style="background:${color}"></span>` : ''}<span>${escapeHtml(label)}</span>${typeof count === 'number' ? `<span style="opacity:.55">${count}</span>` : ''}`;
  return chip;
}

function currentVisibleImages() {
  const source = state.currentView === 'bin' ? state.binImages : state.images;
  let list = source;
  if (state.currentView === 'board' && state.currentCategoryId !== 'all') {
    list = list.filter((i) => i.categoryId === state.currentCategoryId);
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
    if (state.currentView === 'bin') {
      $('#emptyTitle').textContent = 'Bin is empty';
      $('#emptySubtitle').textContent = 'Images you move to the bin stay for 30 days before they’re gone for good.';
    } else if (state.search.trim()) {
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
  card.draggable = state.currentView === 'board';

  const cat = categoryFor(image);
  const isBin = state.currentView === 'bin';
  const board = isBin ? boardById(image.boardId) : null;

  card.innerHTML = `
    <div class="card-media">
      <img src="${objectUrlFor(image, 'thumb')}" alt="${escapeHtml(image.name)}" loading="lazy" width="${image.width}" height="${image.height}">
      <div class="card-select-check">
        <svg viewBox="0 0 24 24" width="12" height="12"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="card-overlay">
        <div class="card-top-actions">
          ${!isBin ? `<button class="card-action" data-action="menu" title="More"><svg viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></svg></button>` : ''}
          ${isBin
            ? `<button class="card-action" data-action="restore" title="Restore"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 4v6h6M4.5 13a8 8 0 1 0 2-8.4L4 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
               <button class="card-action danger" data-action="delete-forever" title="Delete forever"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
            : `<button class="card-action danger" data-action="bin" title="Move to bin"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`}
        </div>
        <div class="card-bottom">
          <div class="card-name">${escapeHtml(image.name)}</div>
          <div class="card-tags">
            ${cat ? `<span class="card-cat-badge" style="background:${cat.color}dd">${escapeHtml(cat.name)}</span>` : ''}
            ${board ? `<span class="card-cat-badge" style="background:${board.color}dd">${escapeHtml(board.name)}</span>` : ''}
          </div>
        </div>
      </div>
      ${isBin ? `<span class="bin-days-badge">${daysLeft(image.deletedAt)}d left</span>` : ''}
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
  if (action === 'bin') moveImagesToBin([image.id]);
  else if (action === 'restore') restoreImages([image.id]);
  else if (action === 'delete-forever') confirmDeleteForever([image.id]);
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
  const isBin = state.currentView === 'bin';
  bar.innerHTML = `
    <span class="selection-bar-count">${count} selected</span>
    <div class="selection-bar-divider"></div>
    <div class="selection-bar-actions">
      ${isBin
        ? `<button class="ghost-btn" data-a="restore">Restore</button>
           <button class="ghost-btn danger" data-a="delete-forever">Delete Forever</button>`
        : `<button class="ghost-btn" data-a="download">Download</button>
           <button class="ghost-btn danger" data-a="bin">Move to Bin</button>`}
      <button class="icon-btn" data-a="clear" aria-label="Clear selection">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  bar.querySelector('[data-a="clear"]').addEventListener('click', clearSelection);
  const ids = () => Array.from(state.selection);
  if (isBin) {
    bar.querySelector('[data-a="restore"]').addEventListener('click', () => restoreImages(ids()));
    bar.querySelector('[data-a="delete-forever"]').addEventListener('click', () => confirmDeleteForever(ids()));
  } else {
    bar.querySelector('[data-a="download"]').addEventListener('click', () => ids().forEach((id) => downloadImage(id)));
    bar.querySelector('[data-a="bin"]').addEventListener('click', () => moveImagesToBin(ids()));
  }
}

/* ------------------------------- Board CRUD ------------------------------- */

async function selectBoard(boardId) {
  state.currentView = 'board';
  state.currentBoardId = boardId;
  state.currentCategoryId = 'all';
  state.selection.clear();
  localStorage.setItem('mb.activeBoard', boardId);
  await loadImagesForBoard(boardId);
  renderSidebar();
  renderCategoryBar();
  renderBoard();
}

async function showBin() {
  state.currentView = 'bin';
  state.selection.clear();
  await loadBin();
  renderSidebar();
  renderCategoryBar();
  renderBoard();
}

async function createBoard() {
  const board = {
    id: uid(),
    name: 'Untitled Moodboard',
    color: pickColor(state.boards.length),
    order: state.boards.length,
    createdAt: Date.now(),
  };
  await DB.put('boards', board);
  state.boards.push(board);
  await refreshImageCounts();
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
    board.name = newName;
    await DB.put('boards', board);
    if (state.currentBoardId === boardId) $('#boardTitle').textContent = newName;
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

  const images = await DB.getAll('images', 'boardId', boardId);
  await DB.deleteMany('images', images.map((i) => i.id));
  images.forEach((i) => revokeObjectUrls(i.id));
  const cats = state.categories.filter((c) => c.boardId === boardId);
  await Promise.all(cats.map((c) => DB.delete('categories', c.id)));
  await DB.delete('boards', boardId);

  state.boards = state.boards.filter((b) => b.id !== boardId);
  state.categories = state.categories.filter((c) => c.boardId !== boardId);
  await refreshImageCounts();
  const next = state.boards[0];
  await selectBoard(next.id);
  showToast(`"${board.name}" deleted`);
}

/* ------------------------------- Category CRUD ------------------------------- */

async function promptNewCategory() {
  const name = await showTextPrompt({ title: 'New category', placeholder: 'e.g. Textures, Palette, References' });
  if (!name) return;
  const cats = state.categories.filter((c) => c.boardId === state.currentBoardId);
  const cat = { id: uid(), boardId: state.currentBoardId, name, color: pickColor(cats.length), createdAt: Date.now() };
  await DB.put('categories', cat);
  state.categories.push(cat);
  renderCategoryBar();
}

async function renameCategoryPrompt(cat) {
  const name = await showTextPrompt({ title: 'Rename category', placeholder: cat.name, initial: cat.name });
  if (!name) return;
  cat.name = name;
  await DB.put('categories', cat);
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
  const affected = await DB.getAll('images', 'boardId', state.currentBoardId);
  await Promise.all(affected.filter((i) => i.categoryId === catId).map((i) => { i.categoryId = null; return DB.put('images', i); }));
  await DB.delete('categories', catId);
  state.categories = state.categories.filter((c) => c.id !== catId);
  state.currentCategoryId = 'all';
  await loadImagesForBoard(state.currentBoardId);
  renderCategoryBar();
  renderBoard();
}

async function setImageCategory(imageId, categoryId) {
  const image = state.images.find((i) => i.id === imageId) || state.binImages.find((i) => i.id === imageId);
  if (!image) return;
  image.categoryId = categoryId || null;
  await DB.put('images', image);
  renderCategoryBar();
  renderBoard();
}

/* ------------------------------- Image upload ------------------------------- */

async function addImages(files, boardId = state.currentBoardId) {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;
  showToast(`Adding ${imageFiles.length} image${imageFiles.length > 1 ? 's' : ''}…`);

  let added = 0;
  for (const file of imageFiles) {
    try {
      const { blob: thumbBlob, width, height } = await fileToThumb(file);
      const image = {
        id: uid(),
        boardId,
        categoryId: null,
        name: file.name.replace(/\.[^/.]+$/, '') || 'Untitled',
        width, height,
        size: file.size,
        createdAt: Date.now(),
        deletedAt: undefined,
        thumbBlob,
        fullBlob: file,
      };
      await DB.put('images', image);
      if (boardId === state.currentBoardId && state.currentView === 'board') {
        state.images.unshift(image);
      }
      added++;
    } catch (err) {
      console.error('Failed to add image', file.name, err);
    }
  }
  await refreshImageCounts();
  renderSidebar();
  renderCategoryBar();
  renderBoard();
  refreshStorageMeter();
  showToast(`${added} image${added === 1 ? '' : 's'} added`);
}

/* ------------------------------- Bin operations ------------------------------- */

async function moveImagesToBin(ids) {
  const images = state.images.filter((i) => ids.includes(i.id));
  for (const img of images) {
    img.deletedAt = Date.now();
    await DB.put('images', img);
  }
  state.images = state.images.filter((i) => !ids.includes(i.id));
  state.selection.clear();
  await refreshImageCounts();
  await loadBin();
  renderSidebar();
  renderBoard();
  showToast(`Moved ${ids.length} image${ids.length > 1 ? 's' : ''} to Bin`, {
    actionLabel: 'Undo',
    onAction: async () => { await restoreImages(ids); },
  });
}

async function restoreImages(ids) {
  const images = state.binImages.filter((i) => ids.includes(i.id));
  for (const img of images) {
    delete img.deletedAt;
    await DB.put('images', img);
  }
  state.binImages = state.binImages.filter((i) => !ids.includes(i.id));
  state.selection.clear();
  await refreshImageCounts();
  if (state.currentView === 'board') await loadImagesForBoard(state.currentBoardId);
  renderSidebar();
  renderBoard();
  showToast(`Restored ${ids.length} image${ids.length > 1 ? 's' : ''}`);
}

async function confirmDeleteForever(ids) {
  const ok = await showConfirm({
    title: `Delete ${ids.length} image${ids.length > 1 ? 's' : ''} forever?`,
    body: 'This can’t be undone.',
    confirmLabel: 'Delete Forever',
  });
  if (!ok) return;
  await DB.deleteMany('images', ids);
  ids.forEach(revokeObjectUrls);
  state.binImages = state.binImages.filter((i) => !ids.includes(i.id));
  state.selection.clear();
  renderSidebar();
  renderBoard();
  refreshStorageMeter();
  showToast(`Deleted ${ids.length} image${ids.length > 1 ? 's' : ''} forever`);
}

async function moveImagesToBoard(ids, boardId) {
  const images = state.images.filter((i) => ids.includes(i.id));
  if (!images.length) return;
  for (const img of images) {
    img.boardId = boardId;
    img.categoryId = null;
    await DB.put('images', img);
  }
  state.images = state.images.filter((i) => !ids.includes(i.id));
  await refreshImageCounts();
  renderSidebar();
  renderBoard();
  const board = boardById(boardId);
  showToast(`Moved to "${board.name}"`);
}

function downloadImage(id) {
  const image = state.images.find((i) => i.id === id) || state.binImages.find((i) => i.id === id);
  if (!image) return;
  const a = document.createElement('a');
  a.href = objectUrlFor(image, 'full');
  a.download = image.name + guessExtension(image.fullBlob.type);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function guessExtension(mime) {
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif' };
  return map[mime] || '';
}

/* ------------------------------- Context menu (cards) ------------------------------- */

function showCardContextMenu(x, y, image) {
  const cats = state.categories.filter((c) => c.boardId === image.boardId);
  const items = [
    { label: 'View Full Screen', onClick: () => openLightbox(currentVisibleImages(), currentVisibleImages().findIndex((i) => i.id === image.id)) },
    { label: 'Download', onClick: () => downloadImage(image.id) },
    { sep: true },
    { label: 'Category', sub: [
      ...cats.map((c) => ({ label: c.name, swatch: c.color, onClick: () => setImageCategory(image.id, c.id) })),
      { label: '+ New category…', onClick: async () => {
        const name = await showTextPrompt({ title: 'New category', placeholder: 'Category name' });
        if (!name) return;
        const cat = { id: uid(), boardId: image.boardId, name, color: pickColor(cats.length), createdAt: Date.now() };
        await DB.put('categories', cat);
        state.categories.push(cat);
        await setImageCategory(image.id, cat.id);
      } },
    ] },
    { sep: true },
    { label: 'Move to Bin', danger: true, onClick: () => moveImagesToBin([image.id]) },
  ];
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
  img.src = objectUrlFor(image, 'full');
  img.alt = image.name;

  $('#lightboxName').value = image.name;
  const board = boardById(image.boardId);
  $('#lightboxMeta').innerHTML = [
    `${image.width}×${image.height}px · ${formatBytes(image.size)}`,
    `Added ${relativeDate(image.createdAt)}`,
    board ? `In ${escapeHtml(board.name)}` : '',
    image.deletedAt ? `In Bin · ${daysLeft(image.deletedAt)} days left` : '',
  ].filter(Boolean).join('<br>');

  const select = $('#lightboxCategorySelect');
  const cats = state.categories.filter((c) => c.boardId === image.boardId);
  select.innerHTML = `<option value="">No category</option>` + cats.map((c) => `<option value="${c.id}" ${c.id === image.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');

  $('#lightboxPrev').disabled = lightboxIndex === 0;
  $('#lightboxNext').disabled = lightboxIndex === lightboxList.length - 1;

  const binBtn = $('#lightboxBin');
  binBtn.innerHTML = image.deletedAt
    ? `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 4v6h6M4.5 13a8 8 0 1 0 2-8.4L4 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Restore`
    : `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> Move to Bin`;
}

$('#lightboxClose').addEventListener('click', closeLightbox);
$('#lightboxBackdrop').addEventListener('click', closeLightbox);
$('#lightboxPrev').addEventListener('click', () => navLightbox(-1));
$('#lightboxNext').addEventListener('click', () => navLightbox(1));
$('#lightboxDownload').addEventListener('click', () => downloadImage(lightboxList[lightboxIndex].id));
$('#lightboxBin').addEventListener('click', async () => {
  const image = lightboxList[lightboxIndex];
  if (image.deletedAt) await restoreImages([image.id]);
  else await moveImagesToBin([image.id]);
  closeLightbox();
});
$('#lightboxCategorySelect').addEventListener('change', (e) => {
  setImageCategory(lightboxList[lightboxIndex].id, e.target.value || null);
});
$('#lightboxName').addEventListener('change', async (e) => {
  const image = lightboxList[lightboxIndex];
  image.name = e.target.value.trim() || 'Untitled';
  e.target.value = image.name;
  await DB.put('images', image);
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
  const label = state.currentView === 'bin' ? 'a moodboard' : (boardById(state.currentBoardId)?.name || 'this moodboard');
  $('#dropTargetName').textContent = label;
}

function initUpload() {
  const fileInput = $('#fileInput');
  $('#uploadBtn').addEventListener('click', () => {
    if (state.currentView === 'bin') { showToast('Switch to a moodboard to add images'); return; }
    fileInput.click();
  });
  fileInput.addEventListener('change', (e) => { addImages(e.target.files); fileInput.value = ''; });

  const scroll = $('#boardScroll');
  let dragCounter = 0;
  scroll.addEventListener('dragenter', (e) => {
    if (state.currentView === 'bin') return;
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
    if (state.currentView === 'bin' || !e.dataTransfer.files?.length) return;
    addImages(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    if (state.currentView === 'bin') return;
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.isContentEditable)) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) addImages(files);
  });
}

/* ------------------------------- Misc UI wiring ------------------------------- */

function initTopbar() {
  $('#boardTitle').addEventListener('blur', async (e) => {
    if (state.currentView !== 'board') return;
    const board = boardById(state.currentBoardId);
    const newName = e.target.textContent.trim() || 'Untitled Moodboard';
    e.target.textContent = newName;
    if (board.name !== newName) { board.name = newName; await DB.put('boards', board); renderSidebar(); }
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
  $('#binBtn').addEventListener('click', showBin);

  $('#collapseSidebarBtn').addEventListener('click', () => {
    $('#sidebar').classList.add('collapsed');
    $('#expandSidebarBtn').hidden = false;
  });
  $('#expandSidebarBtn').addEventListener('click', () => {
    $('#sidebar').classList.remove('collapsed');
    $('#expandSidebarBtn').hidden = true;
  });
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

/* ------------------------------- Boot ------------------------------- */

async function init() {
  await purgeExpired();
  await loadBoards();
  await loadCategories();
  await refreshImageCounts();

  const savedBoard = localStorage.getItem('mb.activeBoard');
  const startBoard = boardById(savedBoard) ? savedBoard : state.boards[0].id;

  initTopbar();
  initUpload();
  initKeyboard();

  await selectBoard(startBoard);
  refreshStorageMeter();

  // periodic purge check in case the tab stays open past midnight
  setInterval(async () => {
    await purgeExpired();
    if (state.currentView === 'bin') await showBin();
  }, 60 * 60 * 1000);
}

init().catch((err) => {
  console.error('Failed to start Moodboard', err);
  document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#666;text-align:center;padding:20px;">
    <div><h2 style="color:#111;">Couldn’t load Moodboard</h2><p>Your browser may not support IndexedDB, or storage access is blocked.</p></div>
  </div>`;
});
