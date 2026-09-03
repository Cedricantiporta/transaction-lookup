# Moodboard

A minimalist, Apple-inspired moodboard app. Drag images in, organize them into
projects, tag them by category, and view them full screen — runs entirely in
your browser, offline, with no account or server involved.

## Features

- **Multiple moodboards** — sidebar of projects you can create, rename, and delete
- **Drag & drop or paste** images straight onto the board (plus a normal file picker)
- **Masonry and grid views**, with fast client-side generated thumbnails
- **Categories** — tag images per moodboard and filter with the category chips
- **Full-screen viewer** with keyboard navigation, renaming, and re-categorizing
- **Bin** — deleted images are held for 30 days (with an Undo toast) before being
  permanently purged automatically
- **Offline & local** — everything is stored on your device only; nothing is
  uploaded anywhere, and the app works with no network connection
- Multi-select, drag-to-move between moodboards, and downloads

## Tech

Vanilla HTML/CSS/JS — no bundler, no framework, no backend:

- **localStorage** holds board and category metadata
- **IndexedDB** holds the actual image data (as blobs), since it isn't
  limited to a few MB of strings the way localStorage is
- Images are client-resized to JPEG (a thumbnail and a capped ~2200px
  "full" view) before being stored, to keep things fast and compact

All data lives only in the browser that created it. Clearing site data (or
using a different browser/device/private window) starts a fresh moodboard.

## Running locally

```
npm install
npm run dev   # serves the static files at http://localhost:3000
```

You can also just open `index.html` directly in a browser, or serve the
folder with any static file server.
