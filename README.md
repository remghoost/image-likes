# Image Likes

A small Instagram-style app for sharing locally generated AI images. It has API functionality to allow an LLM to post images.


Node.js + Express + SQLite, with a vanilla-JS frontend (no build step, no frameworks).
Installable as a PWA (offline-capable), with optional HTTPS.

## Features

- Username + password accounts: sign up with a username (2–30 chars: letters, numbers,
  underscores) and a password (min 6 chars), then log in.
  Passwords are hashed with scrypt (Node built-in `crypto`, no extra dependency).
- Change your password from the account menu ("Change password").
- Manually reset any user's password from the command line (no email in this app, so there's
  no "send a reset link" flow — see `scripts/reset-password.js` below).
- Image posts (PNG/JPG/GIF/WebP/AVIF, max 25 MB each) with an optional description/caption.
  Up to **10 images per post** — multiple images become a swipeable carousel.
- Upload via file picker or **drag & drop**, with a preview grid before posting.
- Double-tap (or double-click) an image to like/unlike, with a heart-burst animation.
  A single tap/click opens the full-resolution image in a **lightbox**.
- Comments on posts (with author attribution); you can delete your own comments.
- **Emoji reactions** on comments (❤️ 😮 😂 👍 😢), toggleable per user.
- **Profiles**: an editable bio ("about me", max 150 chars) and a profile picture with a
  built-in crop/zoom tool. Click any author's name/avatar to view their profile and post grid.
- **Direct messages (DMs)** between users, with an unread badge on the DMs tab and 5-second
  polling while the DMs view is open.
- Edit a post's description after posting (pencil button on your own posts).
- Delete your own posts (removes all images in the post; likes/comments cascade).
- A "Blur" toggle that blurs every shared image on screen (preference remembered per browser).
- Fast feed: the server generates low-res JPEG thumbnails (max 800px) with `sharp`; the
  full-resolution original is only fetched when the lightbox opens.
- **PWA**: installable on phones/desktops; a service worker caches the app shell and
  uploaded images for offline use (API requests are never cached).
- Import a folder of images on startup (see CLI below).

## Running

```
npm install
npm start
```

Serves at `http://localhost:3000` and prints the LAN URL for other devices.

### CLI options

```
node server.js [--import <folder>] [--as <username>] [--port <port>] [--cert <path>] [--key <path>]
```

- `--import <folder>` — copies image files from the folder into `uploads/` and inserts
  them into the feed before the server starts. Idempotent: files already imported are
  skipped (matched by original filename, see `original_name` below).
- `--as <username>` — owner of imported images. Defaults to an auto-created `importer` account.
- `--port <port>` — overrides the port (also honors `PORT` env var; default 3000).
- `--cert <path>` / `--key <path>` — serve over HTTPS (also honors `TLS_CERT`/`TLS_KEY`
  env vars). A PWA can only be installed on Android when served over a *trusted* HTTPS
  connection, so pass a publicly-trusted cert (Let's Encrypt, Tailscale, etc.) for phone
  installs.

### npm scripts

```
npm start               # node server.js
npm run icons           # regenerate the PWA icons in public/icons/
npm run reset-password  # node scripts/reset-password.js
npm run post            # node scripts/post.js
```

### Internet-facing deployment (invite-gated signup + HTTPS)

By default signup is open, which is fine for local use. To lock the app down for an
internet-facing deployment, set the `INVITE_CODE` environment variable before starting
the server:

```
INVITE_CODE=your-secret-code node server.js
```

When `INVITE_CODE` is set, `POST /api/signup` requires a matching `inviteCode` in the
request body (403 otherwise), and the signup form shows an "Invite code" field (the
frontend reads `GET /api/config`, which returns `{ inviteRequired: true }`). Tell
friends the code privately; rotate it by changing the env var and restarting.

**HTTPS.** Two options:

1. **The server terminates TLS itself** — pass `--cert`/`--key` (or `TLS_CERT`/`TLS_KEY`).
2. **A reverse proxy (e.g. nginx) terminates TLS** — the server detects
   `X-Forwarded-Proto: https` and behaves the same.

In both cases the session cookie gets the `Secure` flag (so it's refused over any
accidental plaintext HTTP fallback). The flag is only added over HTTPS, so local
`http://localhost` testing keeps working.

Note that the read routes (`/api/images`, `/api/liked`, `/api/users/:username`,
`/api/images/:id/comments`) require a logged-in session **regardless** of `INVITE_CODE`
— so nobody can browse content without a real account. Leave `INVITE_CODE` unset for
open local development.

### Resetting a password

There is no email in this app, so there's no "send a reset link" flow. Instead, the
owner resets a user's password from the command line on the host machine:

```
node scripts/reset-password.js <username> [newpassword]
node scripts/reset-password.js --list
```

- `<username>` — the account to reset (case-insensitive).
- `[newpassword]` — optional. If you provide it, that becomes the new password. If you
  omit it, a random password is generated and printed so you can share it with the user
  out-of-band (text, DM, in person, etc.).
- `--list` — prints all usernames (useful if you can't remember the exact spelling).

The script hashes the new password with the same scrypt scheme the app uses, writes it to
`users.password_hash`, and **logs out all of that user's existing sessions** so no stale
session keeps working after the reset. It's safe to run while the server is up (SQLite WAL
allows a second writer). The user then logs in with the new password and can change it
themselves via "Change password".

### Posting from a script (for LLM-driven posting)

`scripts/post.js` logs in as an account and uploads one or more images as a single
post (multiple images become a carousel). It's built to be called by an LLM: it
takes plain args, prints progress to **stderr**, and writes a clean JSON result to
**stdout** so the caller can parse success/failure and the post id.

```
node scripts/post.js --user <username> --password <password> \
                     --description "caption" \
                     --images <path> [<path> ...] \
                     [--server <url>]
```

- `--user` / `--password` — the account to post as. These can also come from the
  `POST_USER` / `POST_PASSWORD` env vars (args win), so a per-account wrapper can
  bake in the credentials and only pass the per-post values.
- `--description` — caption (max 500 chars). Also readable from `POST_DESCRIPTION`.
- `--images` — one or more image files; all are uploaded together as ONE post.
- `--server` — base URL (default `http://localhost:3000`, or `POST_SERVER` env).

Example (the test image in `test/`):

```
node scripts/post.js --user accountName --password accountPassword \
  --description "text description" \
  --images /path/to/image.png
```

On success it prints, e.g.:

```json
{ "ok": true, "post_id": 26, "author": "accountName", "description": "...", "image_count": 1, "images": ["..."] }
```

**Per-account batch wrappers.** For each account you can keep a small `.bat` wrapper
that bakes in that account's credentials and forwards the description + image args, so
the LLM only ever supplies the per-post values:

```
post-<account>.bat "description" image1 [image2 ...]
```

To make one, copy `scripts/account-script-template.bat` into `scripts/account_scripts/`,
rename it to `post-<account>.bat`, and edit the `POST_USER`/`POST_PASSWORD` lines.
(Per-account wrappers live in `scripts/account_scripts/`, which is gitignored so
credentials don't get committed.)

**The LLM posting flow.** The intended end-to-end flow is three decoupled steps,
each independently testable:

1. **Generate** — ComfyUI runs a workflow (the LLM writes the prompt) and writes
   image file(s) to disk.
2. **Caption** — the LLM writes the description text.
3. **Post** — the LLM calls `post.js` (or the account's batch wrapper) with the
   image path(s) + description, then reads the JSON result.

Keeping the steps separate means the LLM's job reduces to "produce files + text,
then call one command and parse the result" — no need to understand the app's
internals. The server must be running; if it isn't, the script exits with a clear
error instead of hanging.

## File layout

```
server.js          Express app: all API routes, auth, uploads, thumbnails, folder import, CLI parsing
db.js              Opens/creates the SQLite DB and runs schema + migrations
public/
  index.html       Single-page app markup (auth view + app view + modals + lightbox)
  style.css        Styling (Instagram-like), heart-burst animation
  app.js           All frontend logic (vanilla JS, no framework, no build step)
  sw.js            Service worker (PWA caching: app shell + uploads; API never cached)
  manifest.json    PWA manifest (installability, icons, standalone display)
  icons/           PWA icons (regenerate with `npm run icons`)
data/              SQLite database file (created on first run; gitignored)
uploads/           Uploaded/imported image files + generated .thumb.jpg thumbnails (gitignored)
scripts/
  reset-password.js  Manually reset a user's password (see "Resetting a password" above)
  generate-icons.js  Regenerates the PWA icons in public/icons/
  post.js            Log in as an account and post image(s) (see "Posting from a script")
  account-script-template.bat  Template for a per-account posting wrapper
  account_scripts/   Per-account posting wrappers (gitignored — contains credentials)
test/              Sample images for testing (gitignored)
app_served.js, sw_served.js  Stale root-level copies of the served frontend files (not used by the server)
```

## Architecture

### Backend (`server.js`)

Single-file Express app. Request flow:

1. `express.json()` parses JSON bodies.
2. A small **hand-rolled cookie parser** middleware populates `req.cookies`
   (there is deliberately no `cookie-parser` dependency).
3. Routes are plain Express handlers; auth-protected routes use the `requireUser`
   middleware, which reads the `session` cookie, looks up the session token in the
   `sessions` table, and loads the user from the DB.

**HTTPS:** when `--cert`/`--key` (or `TLS_CERT`/`TLS_KEY`) are provided, the app is
served by `https.createServer` instead of plain HTTP. `isSecureRequest()` decides
whether a given request arrived over HTTPS — either directly (we terminate TLS) or via
a reverse proxy that forwards `X-Forwarded-Proto: https`. That's what controls the
`Secure` flag on the session cookie.

**PWA serving:** `/sw.js` and `/manifest.json` are served with explicit `no-cache`
headers (via dedicated routes, ahead of the static middleware) so service-worker and
manifest updates propagate to clients — a stale service worker would keep serving old
code.

**Auth model (username + password):** `POST /api/signup` creates an account (username
must be unique and match `^[a-zA-Z0-9_]{2,30}$`, password min 6 chars) and
`POST /api/login` verifies the credentials. Both create a **session** (a random 32-byte
token stored in the `sessions` table) and set an `HttpOnly; SameSite=Lax` cookie
`session=<token>` on success (plus `Secure` over HTTPS); `POST /api/logout` deletes the
session row and clears the cookie. The cookie value is an unguessable token validated
server-side — **not** the user id — so it can't be guessed or spoofed. Sessions expire
after 30 days.
Passwords are hashed with **scrypt** (Node's built-in `crypto`, no extra dependency)
and stored as `scrypt:<salt hex>:<hash hex>` in `users.password_hash`. Verification
uses `crypto.timingSafeEqual` to avoid timing attacks, and login returns the same
"Invalid username or password" error for unknown users and wrong passwords.
`POST /api/password` (auth required) changes the current user's password after
verifying the current one.

**Read routes require auth:** the feed (`GET /api/images`), liked tab
(`GET /api/liked`), user profiles (`GET /api/users/:username`), and image comments
(`GET /api/images/:id/comments`) all require a logged-in session. Nobody can browse any
content without a real account — the app's own session cookie is the only gate, which is
what you want behind a reverse proxy (no separate Basic-Auth layer to fight with the PWA
standalone shell).

**Invite-gated signup:** when the `INVITE_CODE` env var is set, `POST /api/signup`
requires a matching `inviteCode` in the body (403 otherwise). `GET /api/config` returns
`{ inviteRequired: true }` so the frontend can show an invite-code field on the signup
form. Leave `INVITE_CODE` unset for open local development.

**Migrating existing passwordless accounts:** on startup, any user whose
`password_hash` is `NULL` (created before passwords existed) is given a random
temporary password, which is printed to the console. Log in with it, then use
"Change password" to set a real one.

**Uploads:** Multer (`diskStorage`) writes files directly to `uploads/` with a
timestamp+random filename, then rows are inserted into `images`.

**Posts (multi-image):** `POST /api/images` accepts up to 10 files (field `image`).
The first image's id becomes the post's `post_id`; the remaining images share it. A
post is represented by its first (lowest-id) image — likes and comments are tied to
that image — but the post is positioned in the feed by its newest image. `groupIntoPosts()`
turns the flat image rows back into post objects with an `images` array for the carousel.

**Thumbnails:** after each upload/import, `sharp` generates a JPEG thumbnail (max 800px
on the long edge, quality 82, EXIF-orientation aware) named `<original>.thumb.jpg`
alongside the original. The feed and profile grid show thumbnails; the full-res original
is only fetched by the lightbox. Generation is best-effort — if it fails, the frontend
falls back to the original via `onerror`. A startup backfill generates thumbnails for
any pre-existing images that don't have one yet (in batches of 10, in the background).

**Folder import:** `importFolder()` runs at startup if `--import` is given. It copies
each image file into `uploads/` and inserts a row with `original_name` set to the
source filename. That column is what makes re-runs idempotent (normal web uploads
leave `original_name` NULL). Imported images get thumbnails too.

### Database (`db.js`, SQLite via better-sqlite3)

- File: `data/image-likes.db` (WAL mode, foreign keys ON).
- `better-sqlite3` is **synchronous** — all DB calls in this codebase are sync by design.
- Schema is created with `CREATE TABLE IF NOT EXISTS` on startup; new columns are added
  via small migrations (see the `original_name`/`post_id`/`bio`/`profile_pic` migrations
  at the bottom of `db.js`). Follow that pattern when adding columns.

Tables:

| Table               | Columns                                                        | Notes |
|---------------------|----------------------------------------------------------------|-------|
| `users`             | `id`, `username` (UNIQUE, `COLLATE NOCASE`), `password_hash`, `bio`, `profile_pic`, `created_at` | Case-insensitive usernames; `password_hash` is `scrypt:<salt>:<hash>`; `bio` is an optional "about me" (max 150 chars); `profile_pic` is a filename in `uploads/` |
| `images`            | `id`, `user_id` → users, `filename`, `original_name`, `description`, `post_id`, `created_at` | `filename` is the name in `uploads/`; `original_name` is set only by folder imports; `description` is an optional caption (max 500 chars); `post_id` groups images into multi-image posts (the post's first image id) |
| `likes`             | `id`, `user_id` → users, `image_id` → images, `created_at`     | `UNIQUE(user_id, image_id)` — one like per user per image |
| `comments`          | `id`, `user_id` → users, `image_id` → images, `text`, `created_at` | |
| `comment_reactions` | `id`, `user_id` → users, `comment_id` → comments, `emoji`, `created_at` | `UNIQUE(user_id, comment_id, emoji)` — one reaction per user per comment per emoji |
| `sessions`          | `token` (PK), `user_id` → users, `created_at`, `expires_at` | Random 32-byte login tokens; 30-day expiry |
| `messages`          | `id`, `sender_id` → users, `recipient_id` → users, `text`, `created_at`, `read_at` | DMs; `read_at` is NULL until read; indexed on `(recipient_id, read_at)` and `sender_id` |

All foreign keys are `ON DELETE CASCADE`, so deleting a user or image cleans up
likes/comments/reactions/messages automatically.

**Timestamps:** `created_at` uses SQLite's `datetime('now')`, which is **UTC** and
stored as `YYYY-MM-DD HH:MM:SS` (no timezone suffix). The frontend appends `'Z'`
before parsing (see `timeAgo()` in `app.js`). Keep this convention if you add
timestamp handling.

### API

| Method | Path                      | Auth | Purpose |
|--------|---------------------------|------|---------|
| POST   | `/api/signup`             | no   | Create an account (username + password); sets the session cookie |
| POST   | `/api/login`              | no   | Log in with username + password; sets the session cookie |
| POST   | `/api/password`           | yes  | Change the current user's password (verifies the current one) |
| POST   | `/api/logout`             | no   | Clear the session cookie |
| GET    | `/api/me`                 | no   | Current user (or `{ user: null }`); includes `bio` and `profile_pic` |
| GET    | `/api/config`             | no   | Public config: `{ inviteRequired }` (drives the signup invite-code field) |
| POST   | `/api/profile/bio`        | yes  | Set the current user's bio (max 150 chars) |
| POST   | `/api/profile/pic`        | yes  | Upload a profile picture (multipart, field `pic`); replaces the existing one |
| DELETE | `/api/profile/pic`        | yes  | Remove the current user's profile picture |
| POST   | `/api/images`             | yes  | Upload a post: 1–10 images (multipart, field `image`, optional field `description` max 500 chars) |
| GET    | `/api/images`             | yes  | Feed, newest first; posts include `description`, `like_count`, `comment_count`, `liked_by_me`, `images[]` |
| GET    | `/api/liked`              | yes  | Posts liked by the current user, newest like first |
| DELETE | `/api/images/:id`         | yes  | Delete own post (all images sharing its `post_id`; also deletes the files from `uploads/`) |
| PUT    | `/api/images/:id/description` | yes | Update a post's description (max 500 chars) |
| POST   | `/api/images/:id/like`    | yes  | **Toggle** like; returns `{ liked, like_count }` |
| GET    | `/api/images/:id/comments`| yes  | Comments for an image, oldest first; each includes `reactions` |
| POST   | `/api/images/:id/comments`| yes  | Add a comment (max 500 chars) |
| DELETE | `/api/comments/:id`       | yes  | Delete own comment |
| POST   | `/api/comments/:id/react` | yes  | **Toggle** an emoji reaction on a comment (`{ emoji }`); returns `{ reacted, emoji, count }` |
| GET    | `/api/dms`                | yes  | Conversation list (other user, last message, unread count), most recent first |
| GET    | `/api/dms/unread`         | yes  | Total unread count across all conversations (`{ unread }`) |
| GET    | `/api/dms/:username/messages` | yes | Message history with a user, oldest first; each has a `mine` flag |
| POST   | `/api/dms/:username/messages` | yes | Send a message to a user (max 1000 chars) |
| POST   | `/api/dms/:username/read` | yes  | Mark all messages from a user as read |

The feed/liked queries compute `like_count`, `comment_count`, and `liked_by_me` with
correlated subqueries rather than joins, so images with zero likes/comments still appear.
They return flat image rows, which `groupIntoPosts()` folds into post objects (the
representative image carries the like/comment counts; the `images` array is
oldest-first for the carousel).

### Frontend (`public/`)

Single page, no framework, no build step — edit and refresh.

- `index.html` has two top-level views: `#auth-view` and `#app-view`, toggled with the
  `.hidden` class. The app view contains the feed, the profile view, and the DMs view,
  plus modals (change password, edit profile, crop photo, post detail, edit description)
  and the lightbox overlay.
- `app.js` structure: an `api()` fetch helper (throws on non-2xx with the server's
  `error` message), view switching, feed rendering, and per-card event wiring.
- **Rendering:** cards are built as HTML strings via `imageCardHtml()` /
  `commentHtml()`, then event listeners are attached in `attachCardEvents()`.
  All user-controlled strings go through `escapeHtml()` — keep it that way when
  adding new rendered fields (XSS).
- **Tabs:** Feed and DMs are the two header tabs; the profile view is reached by
  clicking an author's name/avatar (or "Profile" in the account menu). There is no
  Liked tab in the UI (the `/api/liked` endpoint still exists).
- **Double-tap like / single-tap lightbox:** `dblclick` for mouse plus a `touchend`
  handler with a 300 ms window for touch devices. Both call `toggleLike()`, which hits
  the toggle endpoint and updates the heart button, count, and (on like) plays the
  heart-burst animation. A single click/tap opens the lightbox with the full-res
  original (a 250 ms delay disambiguates single vs. double).
- **Carousels:** multi-image posts render as a horizontally-scrolling carousel
  (native scroll-snap for swiping, plus arrows, dots, and a counter kept in sync with
  the scroll position; arrow keys work when focused).
- **Lightbox:** full-resolution viewer with prev/next arrows, keyboard arrows, and
  swipe navigation for multi-image posts.
- **Reactions:** each comment has a reaction toggle that opens a picker of the five
  allowed emojis; toggling hits `POST /api/comments/:id/react` and updates counts in
  place.
- **Profiles:** the profile view shows the avatar, username, post count, and bio, plus
  a square post grid (multi-image posts get a count badge). Grid tiles open the post in
  a detail modal. Your own profile has "Edit profile" (bio + profile picture with a
  drag/zoom crop tool that renders a 512×512 circular JPEG client-side); someone else's
  has "Message" (jumps to a DM conversation) and "Back".
- **DMs:** a two-panel view (conversation list + chat). Opening a conversation marks
  its messages read. While the DMs view is open, the frontend polls every 5 seconds
  (`/api/dms/unread` plus the open conversation's messages) to pick up new messages —
  there are no websockets.
- **Blur toggle:** blurs every shared image on screen (feed, profile grid, post modal);
  profile pictures and upload previews stay sharp. The preference is stored in
  `localStorage`.
- **Uploads:** staged flow — pick/drop files → preview grid (remove individual images)
  → description → Post. Client-side validation mirrors the server's (type, 25 MB,
  10-image cap).
- **PWA:** `app.js` registers `/sw.js` on load, but only in a secure context
  (`https:` or `localhost`/`127.0.0.1`) — service workers aren't available on plain
  http. The service worker precaches the app shell (stale-while-revalidate), serves
  navigations network-first with a cached-shell fallback, caches `/uploads/*`
  cache-first, and never caches `/api/*`.

## Security

- **Password hashing:** scrypt (Node built-in `crypto`), random 16-byte salt, 64-byte
  hash, constant-time compare (`crypto.timingSafeEqual`). No plaintext or weak hashes.
- **Sessions:** random 32-byte tokens in the `sessions` table, sent as an
  `HttpOnly; SameSite=Lax` cookie (plus `Secure` over HTTPS). The cookie is a token
  (not the user id), so it can't be guessed or spoofed; logout deletes the row
  server-side. 30-day expiry.
- **Brute-force protection:** `express-rate-limit` on `/api/login` and `/api/signup`
  (5 attempts / 15 min per IP).
- **Read routes require auth:** the feed, liked tab, user profiles, and image comments
  all require a logged-in session, so no content is browsable without an account.
- **Invite-gated signup:** set `INVITE_CODE` to require an invite code on signup
  (403 without a match). `GET /api/config` exposes `inviteRequired` so the frontend can
  show the field. Leave it unset for open local development.
- **CSRF:** `SameSite=Lax` on the session cookie blocks cross-site cookie submission.
- **Security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and a strict `Content-Security-Policy`
  (`default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self';
  connect-src 'self'`).
- **Uploads:** Multer with a 25 MB limit, an image-mimetype filter, **and** a strict
  extension whitelist (`.png/.jpg/.jpeg/.gif/.webp/.avif`). Profile pictures go through
  the same upload pipeline.
- **SQL injection:** all queries are parameterized (better-sqlite3 prepared statements).
- **XSS:** the frontend escapes every user-controlled string via `escapeHtml()`.
- **Dependencies:** `npm audit` is clean (a `qs` override pins the transitive
  `qs` to a patched version). `sharp` is a native module with prebuilt binaries —
  `npm install` handles it.

## Gotchas / conventions for future edits

- **No build step.** `public/` is served as-is. Don't introduce a bundler without
  also updating how `server.js` serves static files.
- **Cookies are parsed manually** in `server.js`. If you add more cookies, extend
  that middleware (or add `cookie-parser` and remove the hand-rolled one).
- **`data/` and `uploads/` are gitignored** and created on first run. Deleting them
  resets the app (including all sessions — users will need to log in again).
- **`original_name` is load-bearing** for import idempotency. Don't clear it or reuse
  the column for something else.
- **`post_id` is load-bearing** for post grouping. Likes/comments attach to the post's
  representative (lowest-id) image, and deleting any image in a post deletes the whole
  post (all its files, including thumbnails).
- **Thumbnails are `<filename>.thumb.jpg`** in `uploads/`. The frontend relies on the
  404 → `onerror` fallback to the original, so keep the naming convention.
- **The like endpoint is a toggle**, not a set. The frontend relies on the returned
  `liked` boolean to update state. Same for comment reactions.
- **Deleting an image** removes the file from `uploads/` via `fs.unlink` (fire-and-forget).
- **No tests** exist. The app is meant to be exercised manually in a browser.
- **DMs use 5-second polling**, not websockets. The feed/profile do not poll at all —
  refresh the page (or switch tabs) to see changes made by the other user.
- **`/sw.js` and `/manifest.json` are served with no-cache** by dedicated routes ahead
  of the static middleware. Don't remove those routes — a stale service worker would
  keep serving old code.
- **`app_served.js` and `sw_served.js` at the repo root are stale copies** of the
  served frontend files (kept for debugging). The server only serves `public/` — edit
  those, not the root copies.
- **Local-network access** requires a Windows Firewall rule for the port (inbound TCP).
  The server itself binds to all interfaces.
