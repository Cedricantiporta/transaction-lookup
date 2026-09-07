# Moodboard

A minimalist, Apple-inspired moodboard app. Drag images in, organize them into
projects, tag them by category, and view them full screen — shared with your
signed-in team, with an activity log of who did what.

## Features

- **Google sign-in required** — every visitor signs in with Google before
  seeing or editing anything; no anonymous access
- **Activity log** — every upload, delete, board create/delete, and
  move-between-boards is attributed to the signed-in user and visible from
  the sidebar's Activity panel
- **Multiple moodboards** — sidebar of projects you can create, rename, and delete
- **Drag & drop or paste** images straight onto the board (plus a normal file picker)
- **Masonry and grid views**, with fast client-side generated thumbnails
- **Color filter** — each image's average color is sampled at upload and
  bucketed into a small palette; filter chips only show colors actually
  present on the board
- **Categories** — tag images per moodboard and filter with the category chips
- **Move between moodboards** — drag a card onto a sidebar board, right-click
  → Move to, or bulk-move a multi-selection
- **Full-screen viewer** with keyboard navigation, renaming, and re-categorizing
- Deleting an image is immediate and permanent (with a confirmation prompt) —
  there's no bin or recovery window
- Live sync — changes made by others show up within ~15 seconds via
  lightweight polling
- Multi-select for bulk download, move, and delete

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
4. Set up Google sign-in (see below) and add its env vars.
5. Redeploy if it doesn't happen automatically.

That's it — the app provisions its own tables on first use.

## Setting up Google sign-in

The app gates everything behind Google OAuth — you'll need a Google Cloud
OAuth client, since that can only be created from Google's own dashboard:

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project → **APIs & Services → Credentials → Create Credentials →
   OAuth client ID** → Application type **Web application**.
2. Under **Authorized redirect URIs**, add:
   `https://<your-vercel-domain>/api/auth/callback`
   (add `http://localhost:3000/api/auth/callback` too if you'll run this
   locally via `vercel dev`). Preview deployments get a new random domain
   each time, so sign-in won't work there unless you add each one.
3. If prompted, configure the **OAuth consent screen** (External is fine for
   a small team — just add your teammates as test users if it's not
   published/verified).
4. Copy the **Client ID** and **Client Secret** into your Vercel project's
   Environment Variables:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `SESSION_SECRET` — any long random string (this signs the login
     session cookie; e.g. generate one with `openssl rand -hex 32`)
5. Redeploy.

Every visitor now has to sign in with Google before seeing anything. Sign-in
state is a signed cookie, not a database session — no extra query per
request.

## Production branch

Vercel's **Production Branch** setting (Project Settings → Git) should point
at `main`, which is the only branch meant to run this app's shared
Postgres + Blob backend. If a preview build from another branch is ever
manually promoted to Production, it overrides `main`'s deployment — Vercel
still records `main` as the intended build, but the promoted branch's code
is what's actually live until something re-deploys `main` (a new commit,
or a manual redeploy of an existing `main`-based build).

In particular, watch out for experimental branches that intentionally
diverge from the backend (e.g. a local-storage-only/offline variant) —
promoting one of those to Production silently stops the app from reading
`DATABASE_URL` or writing to Blob, with no error until someone tries an
action that hits the API.

## Running locally

```
npm install
npm run dev   # vercel dev — needs `vercel env pull` first for local credentials
```

The frontend alone (`index.html`/`app.js`/`styles.css`) can be served
statically, but the API routes need a linked Postgres + Blob store to work.
