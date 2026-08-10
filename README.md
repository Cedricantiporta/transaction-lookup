# Moodboard

A minimalist, Apple-inspired moodboard app. Drag images in, organize them into
projects, tag them by category, and view them full screen — shared with
anyone who has the link, no login required.

## Features

- **Multiple moodboards** — sidebar of projects you can create, rename, and delete
- **Drag & drop or paste** images straight onto the board (plus a normal file picker)
- **Masonry and grid views**, with fast client-side generated thumbnails
- **Categories** — tag images per moodboard and filter with the category chips
- **Full-screen viewer** with keyboard navigation, renaming, and re-categorizing
- **Bin** — deleted images are held for 30 days (with an Undo toast) before being
  permanently purged automatically, on a daily schedule via a Vercel Cron Job
- **Shared** — anyone with the link sees and edits the same boards; open
  changes show up for others within ~15 seconds via lightweight polling
- Multi-select, drag-to-move between moodboards, and downloads

## Tech

Vanilla HTML/CSS/JS on the frontend — no bundler, no framework. The backend
is a handful of Vercel Serverless Functions under `/api`:

- **Vercel Postgres / Neon** for boards, categories, and image metadata
- **Vercel Blob** for the actual image files (a client-resized thumbnail and
  a client-resized "full" view, capped around 2200px to stay well under
  serverless request-size limits — this is a deliberate trade-off for
  reliability and zero build tooling, not literal original-file fidelity)

The database schema is created automatically on first request
(`CREATE TABLE IF NOT EXISTS`) — no manual migration step.

## One-time setup (in the Vercel dashboard)

1. Open this project → **Storage** tab.
2. Create a **Postgres** database (Neon) and connect it to the project.
3. Create a **Blob** store and connect it to the project.
4. Redeploy if it doesn't happen automatically.

That's it — the app provisions its own tables on first use.

## Running locally

```
npm install
npm run dev   # vercel dev — needs `vercel env pull` first for local credentials
```

The frontend alone (`index.html`/`app.js`/`styles.css`) can be served
statically, but the API routes need a linked Postgres + Blob store to work.
