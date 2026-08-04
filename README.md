# Moodboard

A minimalist, Apple-inspired moodboard app. Drag images in, organize them into
projects, tag them by category, and view them full screen — all running
entirely in your browser, no backend required.

## Features

- **Multiple moodboards** — sidebar of projects you can create, rename, and delete
- **Drag & drop or paste** images straight onto the board (plus a normal file picker)
- **Masonry and grid views**, with fast client-side generated thumbnails
- **Categories** — tag images per moodboard and filter with the category chips
- **Full-screen viewer** with keyboard navigation, renaming, and re-categorizing
- **Bin** — deleted images are held for 30 days (with an Undo toast) before being
  permanently purged automatically
- Multi-select, drag-to-move between moodboards, and downloads

## Tech

Vanilla HTML/CSS/JS, no build step, no dependencies. Images are stored locally
in the browser via IndexedDB, so everything loads instantly and works offline.

## Running it

Just open `index.html` in a browser, or serve the folder with any static file
server, e.g.:

```
npx serve .
```
