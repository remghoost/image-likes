const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const sharp = require('sharp');
const db = require('./db');

const app = express();

// --- CLI args ---
// Usage: node server.js [--import <folder>] [--as <username>] [--port <port>]
//                          [--cert <path>] [--key <path>]
//   --cert/--key (or TLS_CERT/TLS_KEY env vars) enable HTTPS. A PWA can only be
//   installed on Android when served over a *trusted* HTTPS connection, so pass
//   a publicly-trusted cert (Let's Encrypt, Tailscale, etc.) for phone install.
function parseArgs(argv) {
  const args = { import: null, as: null, port: null, cert: null, key: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--import' && argv[i + 1]) args.import = argv[++i];
    else if (argv[i] === '--as' && argv[i + 1]) args.as = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--cert' && argv[i + 1]) args.cert = argv[++i];
    else if (argv[i] === '--key' && argv[i + 1]) args.key = argv[++i];
  }
  if (process.env.TLS_CERT) args.cert = args.cert || process.env.TLS_CERT;
  if (process.env.TLS_KEY) args.key = args.key || process.env.TLS_KEY;
  return args;
}
const cliArgs = parseArgs(process.argv.slice(2));
const PORT = cliArgs.port || process.env.PORT || 3000;
// True when the server itself terminates TLS (cert/key provided).
const IS_HTTPS = !!(cliArgs.cert && cliArgs.key);

// Decide whether a given request arrived over HTTPS. This is what determines
// whether the session cookie gets the `Secure` flag (so it's refused over any
// accidental plaintext HTTP fallback). Two cases:
//   1. Direct HTTPS — we're serving TLS ourselves (cert/key provided).
//   2. Behind a reverse proxy (e.g. nginx) that terminates TLS and forwards
//      the original scheme via `X-Forwarded-Proto: https`.
// Kept conditional so local http://localhost testing doesn't drop the cookie
// (browsers silently refuse Secure cookies on non-HTTPS origins).
function isSecureRequest(req) {
  if (IS_HTTPS) return true;
  const proto = req && req.headers['x-forwarded-proto'];
  return proto === 'https';
}

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.json());

// --- PWA: serve the service worker and manifest with no-cache so updates
//     propagate to clients (a stale service worker would keep serving old code).
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.set('Content-Type', 'application/manifest+json; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// --- Security headers ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");
  next();
});

// --- Upload config ---
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Strict whitelist: only allow known image extensions (defense in depth on top of the mimetype filter)
    if (!ALLOWED_IMAGE_EXTS.has(ext)) return cb(new Error('Unsupported file type'));
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp|avif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// --- Thumbnails ---
// The feed and profile grid show a small, fast-loading version of each image.
// The full-resolution original is only fetched when the user opens the lightbox.
// We generate a JPEG thumbnail (max 800px on the long edge) alongside the
// original, named "<original>.thumb.jpg". Generation is best-effort: if it
// fails (e.g. an unusual format), the frontend falls back to the original.
const THUMB_MAX = 800;
const THUMB_QUALITY = 82;

function thumbName(filename) {
  return `${filename}.thumb.jpg`;
}

async function generateThumbnail(filename) {
  const src = path.join(uploadsDir, filename);
  const dest = path.join(uploadsDir, thumbName(filename));
  try {
    await sharp(src)
      .rotate() // respect EXIF orientation so thumbnails aren't sideways
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(dest);
    return true;
  } catch (err) {
    console.warn(`Thumbnail generation failed for ${filename}: ${err.message}`);
    // Clean up a partial file, if any.
    fs.unlink(dest, () => {});
    return false;
  }
}

// --- Auth helpers ---
// Passwords are hashed with scrypt (Node built-in, no extra dependency).
// Stored format: "scrypt:<salt hex>:<hash hex>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    created_at: user.created_at,
    bio: user.bio || '',
    profile_pic: user.profile_pic || null
  };
}

// --- Session handling ---
// Sessions are random 32-byte tokens stored in the DB (sessions table), so the
// cookie value is unguessable and validated server-side (unlike a raw userId).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
  return token;
}

function getSessionUser(token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) || null;
}

function setSessionCookie(req, res, token) {
  // `Secure` is only added over HTTPS — browsers silently drop Secure cookies
  // on non-HTTPS origins, which would lock you out during local HTTP testing.
  const secure = isSecureRequest(req) ? ' Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(req, res) {
  const secure = isSecureRequest(req) ? ' Secure' : '';
  res.setHeader('Set-Cookie', `session=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`);
}

function requireUser(req, res, next) {
  const token = req.cookies && req.cookies.session;
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// Simple cookie parsing (no extra dependency needed)
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach(part => {
      const [k, ...v] = part.trim().split('=');
      if (k) req.cookies[k] = decodeURIComponent(v.join('='));
    });
  }
  next();
});

// --- Rate limiting (brute-force protection) ---
// Login: 5 attempts / 15 min per IP. Signup: 5 / 15 min per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in 15 minutes' }
});
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many signups, please try again in 15 minutes' }
});

// --- Auth routes ---
// Signup is gated behind an invite code when INVITE_CODE is set (for
// internet-facing deployments). Leave it unset for open local development.
const INVITE_CODE = process.env.INVITE_CODE;

app.post('/api/signup', signupLimiter, (req, res) => {
  if (INVITE_CODE && req.body.inviteCode !== INVITE_CODE) {
    return res.status(403).json({ error: 'Invalid invite code' });
  }
  const username = (req.body.username || '').trim();
  const password = req.body.password;
  if (!/^[a-zA-Z0-9_]{2,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-30 characters (letters, numbers, underscores)' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username is already taken' });
  }
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  setSessionCookie(req, res, createSession(user.id));
  res.json(publicUser(user));
});

app.post('/api/login', loginLimiter, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password;
  const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  // Same error for unknown user and wrong password (don't reveal which)
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  setSessionCookie(req, res, createSession(user.id));
  res.json(publicUser(user));
});

app.post('/api/password', requireUser, (req, res) => {
  const current = req.body.currentPassword;
  const next = req.body.newPassword;
  if (typeof next !== 'string' || next.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  if (!verifyPassword(current, req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies.session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const token = req.cookies && req.cookies.session;
  const user = getSessionUser(token);
  res.json({ user: user ? publicUser(user) : null });
});

// Public config the frontend needs before login (e.g. whether signup requires
// an invite code). No sensitive data — safe to expose without auth.
app.get('/api/config', (req, res) => {
  res.json({ inviteRequired: !!INVITE_CODE });
});

// --- Profile routes ---
// Get a user's public profile: their info plus all their posts (grouped).
app.get('/api/users/:username', requireUser, (req, res) => {
  const username = (req.params.username || '').trim();
  const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const images = db.prepare(`
    SELECT i.id, i.filename, i.description, i.created_at, i.post_id, u.username AS author, u.profile_pic AS author_pic,
      (SELECT COUNT(*) FROM likes l WHERE l.image_id = i.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.image_id = i.id) AS comment_count,
      (SELECT COUNT(*) FROM likes l2 WHERE l2.image_id = i.id AND l2.user_id = ?) AS liked_by_me
    FROM images i
    JOIN users u ON u.id = i.user_id
    WHERE i.user_id = ?
    ORDER BY i.id DESC
  `).all(req.user.id, user.id);

  res.json({
    user: publicUser(user),
    posts: groupIntoPosts(images)
  });
});

// Update the current user's bio ("about me" section).
app.post('/api/profile/bio', requireUser, (req, res) => {
  const bio = (req.body.bio || '').trim();
  if (bio.length > 150) return res.status(400).json({ error: 'Bio too long (max 150 characters)' });
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio || null, req.user.id);
  res.json({ ok: true, bio });
});

// Upload a profile picture (replaces the existing one).
app.post('/api/profile/pic', requireUser, upload.single('pic'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const old = req.user.profile_pic;
  db.prepare('UPDATE users SET profile_pic = ? WHERE id = ?').run(req.file.filename, req.user.id);
  if (old) fs.unlink(path.join(uploadsDir, old), () => {});
  res.json({ ok: true, profile_pic: req.file.filename });
});

// Remove the current user's profile picture.
app.delete('/api/profile/pic', requireUser, (req, res) => {
  const old = req.user.profile_pic;
  db.prepare('UPDATE users SET profile_pic = NULL WHERE id = ?').run(req.user.id);
  if (old) fs.unlink(path.join(uploadsDir, old), () => {});
  res.json({ ok: true, profile_pic: null });
});

// --- Image routes ---
const MAX_IMAGES_PER_POST = 10;

// Group flat image rows (sorted by id DESC) into posts. A post is represented by
// its first (lowest-id) image — likes/comments are tied to that image — but the
// post is positioned in the feed by its newest (highest-id) image. The remaining
// images ride along in `images` (returned oldest-first for the carousel).
function groupIntoPosts(images) {
  const groups = new Map(); // postKey -> rows (in DESC order)
  for (const img of images) {
    const key = img.post_id || img.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(img);
  }
  const posts = [];
  const seen = new Set();
  for (const img of images) {
    const key = img.post_id || img.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = groups.get(key);
    const rep = rows.reduce((a, b) => (a.id < b.id ? a : b)); // lowest id = representative
    posts.push({
      id: rep.id,
      author: rep.author,
      author_pic: rep.author_pic || null,
      created_at: rep.created_at,
      description: rep.description,
      like_count: rep.like_count,
      comment_count: rep.comment_count,
      liked_by_me: rep.liked_by_me,
      images: rows.slice().reverse().map((r) => ({ id: r.id, filename: r.filename }))
    });
  }
  return posts;
}

app.post('/api/images', requireUser, upload.array('image', MAX_IMAGES_PER_POST), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No image uploaded' });
  const description = (req.body.description || '').trim();
  if (description.length > 500) return res.status(400).json({ error: 'Description too long (max 500 characters)' });

  const insert = db.prepare(
    'INSERT INTO images (user_id, filename, original_name, description, post_id) VALUES (?, ?, ?, ?, ?)'
  );
  // The first image's id becomes the post_id that groups the whole post.
  const firstInfo = insert.run(req.user.id, files[0].filename, null, description || null, null);
  const postId = firstInfo.lastInsertRowid;
  for (let i = 1; i < files.length; i++) {
    insert.run(req.user.id, files[i].filename, null, description || null, postId);
  }
  db.prepare('UPDATE images SET post_id = ? WHERE id = ?').run(postId, postId);

  // Generate low-res thumbnails so the feed loads fast. Best-effort: the post
  // is created even if a thumbnail fails (the frontend falls back to the original).
  await Promise.all(files.map((f) => generateThumbnail(f.filename)));

  const post = db.prepare(`
    SELECT i.id, i.description, i.created_at, u.username AS author,
      (SELECT COUNT(*) FROM likes l WHERE l.image_id = i.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.image_id = i.id) AS comment_count,
      (SELECT COUNT(*) FROM likes l2 WHERE l2.image_id = i.id AND l2.user_id = ?) AS liked_by_me
    FROM images i JOIN users u ON u.id = i.user_id WHERE i.id = ?
  `).get(req.user.id, postId);
  const postImages = db.prepare('SELECT id, filename FROM images WHERE post_id = ? ORDER BY id ASC').all(postId);
  res.json({
    id: post.id,
    author: post.author,
    created_at: post.created_at,
    description: post.description,
    like_count: post.like_count,
    comment_count: post.comment_count,
    liked_by_me: post.liked_by_me,
    images: postImages
  });
});

app.get('/api/images', requireUser, (req, res) => {
  const images = db.prepare(`
    SELECT i.id, i.filename, i.description, i.created_at, i.post_id, u.username AS author, u.profile_pic AS author_pic,
      (SELECT COUNT(*) FROM likes l WHERE l.image_id = i.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.image_id = i.id) AS comment_count,
      (SELECT COUNT(*) FROM likes l2 WHERE l2.image_id = i.id AND l2.user_id = ?) AS liked_by_me
    FROM images i
    JOIN users u ON u.id = i.user_id
    ORDER BY i.id DESC
  `).all(req.user.id);
  res.json(groupIntoPosts(images));
});

app.get('/api/liked', requireUser, (req, res) => {
  // Return every image that belongs to a post the user has liked. The like is
  // stored on the post's representative image, so we find liked posts first,
  // then pull in all of their images so the carousel renders fully.
  const images = db.prepare(`
    SELECT i.id, i.filename, i.description, i.created_at, i.post_id, u.username AS author, u.profile_pic AS author_pic,
      (SELECT COUNT(*) FROM likes l2 WHERE l2.image_id = i.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.image_id = i.id) AS comment_count,
      1 AS liked_by_me
    FROM images i
    JOIN users u ON u.id = i.user_id
    WHERE i.post_id IN (
      SELECT post_id FROM images
      WHERE id IN (SELECT image_id FROM likes WHERE user_id = ?)
    )
    ORDER BY i.id DESC
  `).all(req.user.id);
  res.json(groupIntoPosts(images));
});

app.delete('/api/images/:id', requireUser, (req, res) => {
  const image = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (image.user_id !== req.user.id) return res.status(403).json({ error: 'Not your image' });
  // Delete the whole post (all images sharing this post_id), not just one image.
  const postId = image.post_id || image.id;
  const postImages = db.prepare('SELECT filename FROM images WHERE post_id = ?').all(postId);
  db.prepare('DELETE FROM images WHERE post_id = ?').run(postId);
  for (const row of postImages) {
    fs.unlink(path.join(uploadsDir, row.filename), () => {});
    fs.unlink(path.join(uploadsDir, thumbName(row.filename)), () => {});
  }
  res.json({ ok: true });
});

// Update a post's description. The description is stored on every image row in
// the post, so we update all of them to keep the post consistent.
app.put('/api/images/:id/description', requireUser, (req, res) => {
  const image = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (image.user_id !== req.user.id) return res.status(403).json({ error: 'Not your post' });
  const description = (req.body.description || '').trim();
  if (description.length > 500) return res.status(400).json({ error: 'Description too long (max 500 characters)' });
  const postId = image.post_id || image.id;
  db.prepare('UPDATE images SET description = ? WHERE post_id = ?').run(description || null, postId);
  res.json({ ok: true, description });
});

// --- Folder import ---
// Copies image files from a folder into uploads/ and adds them to the feed.
// Idempotent: files already imported (matched by original filename) are skipped.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

function importFolder(folder, ownerUsername) {
  const absFolder = path.resolve(folder);
  if (!fs.existsSync(absFolder) || !fs.statSync(absFolder).isDirectory()) {
    console.error(`Import failed: "${folder}" is not a directory`);
    process.exit(1);
  }

  // Owner: use the given username, or create a default "importer" account
  // (auto-created accounts get a random password so they can't be logged into)
  let owner = db.prepare('SELECT * FROM users WHERE username = ?').get(ownerUsername || 'importer');
  if (!owner) {
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(ownerUsername || 'importer', hashPassword(crypto.randomBytes(24).toString('hex')));
    owner = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  const files = fs.readdirSync(absFolder).filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  const existing = new Set(
    db.prepare('SELECT original_name FROM images WHERE original_name IS NOT NULL').all().map((r) => r.original_name)
  );

  let imported = 0;
  let skipped = 0;
  const importedNames = [];
  for (const file of files) {
    if (existing.has(file)) { skipped++; continue; }
    const destName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file).toLowerCase()}`;
    fs.copyFileSync(path.join(absFolder, file), path.join(uploadsDir, destName));
    db.prepare('INSERT INTO images (user_id, filename, original_name) VALUES (?, ?, ?)').run(owner.id, destName, file);
    importedNames.push(destName);
    imported++;
  }

  // Generate thumbnails for the newly-imported images (best-effort).
  if (importedNames.length) {
    Promise.all(importedNames.map((name) => generateThumbnail(name))).then(() => {
      console.log(`Imported ${imported} image(s) from "${folder}" as ${owner.username}${skipped ? ` (${skipped} already imported, skipped)` : ''}`);
    });
  } else {
    console.log(`Imported ${imported} image(s) from "${folder}" as ${owner.username}${skipped ? ` (${skipped} already imported, skipped)` : ''}`);
  }
}

// --- Like routes (toggle: like if not liked, unlike if liked) ---
app.post('/api/images/:id/like', requireUser, (req, res) => {
  const image = db.prepare('SELECT id FROM images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });

  const existing = db.prepare('SELECT id FROM likes WHERE user_id = ? AND image_id = ?').get(req.user.id, image.id);
  let liked;
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    liked = false;
  } else {
    db.prepare('INSERT INTO likes (user_id, image_id) VALUES (?, ?)').run(req.user.id, image.id);
    liked = true;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE image_id = ?').get(image.id).n;
  res.json({ liked, like_count: count });
});

// --- Comment routes ---
const ALLOWED_REACTIONS = new Set(['❤️', '😮', '😂', '👍', '😢']);

// Fetch reactions for a set of comment ids, grouped by comment id.
// Returns { [commentId]: { [emoji]: count, _mine: [emojis the current user reacted with] } }
function getCommentReactions(commentIds, viewerId) {
  const result = {};
  if (!commentIds.length) return result;
  const placeholders = commentIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT cr.comment_id, cr.emoji, COUNT(*) AS count,
      (CASE WHEN cr.user_id = ? THEN 1 ELSE 0 END) AS is_mine
    FROM comment_reactions cr
    WHERE cr.comment_id IN (${placeholders})
    GROUP BY cr.comment_id, cr.emoji
  `).all(viewerId, ...commentIds);
  for (const row of rows) {
    if (!result[row.comment_id]) result[row.comment_id] = { _mine: [] };
    result[row.comment_id][row.emoji] = row.count;
    if (row.is_mine) result[row.comment_id]._mine.push(row.emoji);
  }
  return result;
}

app.get('/api/images/:id/comments', requireUser, (req, res) => {
  const comments = db.prepare(`
    SELECT c.id, c.text, c.created_at, u.username AS author
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.image_id = ?
    ORDER BY c.id ASC
  `).all(req.params.id);
  const reactions = getCommentReactions(comments.map((c) => c.id), req.user.id);
  for (const c of comments) {
    c.reactions = reactions[c.id] || {};
  }
  res.json(comments);
});

app.post('/api/images/:id/comments', requireUser, (req, res) => {
  const image = db.prepare('SELECT id FROM images WHERE id = ?').get(req.params.id);
  if (!image) return res.status(404).json({ error: 'Image not found' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  if (text.length > 500) return res.status(400).json({ error: 'Comment too long (max 500 characters)' });

  const info = db.prepare('INSERT INTO comments (user_id, image_id, text) VALUES (?, ?, ?)').run(req.user.id, image.id, text);
  const comment = db.prepare(`
    SELECT c.id, c.text, c.created_at, u.username AS author
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(info.lastInsertRowid);
  comment.reactions = {};
  res.json(comment);
});

app.delete('/api/comments/:id', requireUser, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'Not your comment' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
  res.json({ ok: true });
});

// Toggle an emoji reaction on a comment.
app.post('/api/comments/:id/react', requireUser, (req, res) => {
  const emoji = req.body.emoji;
  if (!ALLOWED_REACTIONS.has(emoji)) return res.status(400).json({ error: 'Invalid reaction' });
  const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  const existing = db.prepare('SELECT id FROM comment_reactions WHERE user_id = ? AND comment_id = ? AND emoji = ?')
    .get(req.user.id, comment.id, emoji);
  let reacted;
  if (existing) {
    db.prepare('DELETE FROM comment_reactions WHERE id = ?').run(existing.id);
    reacted = false;
  } else {
    db.prepare('INSERT INTO comment_reactions (user_id, comment_id, emoji) VALUES (?, ?, ?)')
      .run(req.user.id, comment.id, emoji);
    reacted = true;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM comment_reactions WHERE comment_id = ? AND emoji = ?')
    .get(comment.id, emoji).n;
  res.json({ reacted, emoji, count });
});

if (cliArgs.import) {
  importFolder(cliArgs.import, cliArgs.as);
}

// Backfill: generate thumbnails for any existing images that don't have one yet
// (e.g. images uploaded before thumbnails were introduced). Runs once at startup,
// in the background, so it doesn't block the server from starting.
(async function backfillThumbnails() {
  const rows = db.prepare('SELECT filename FROM images').all();
  const missing = rows.filter((r) => !fs.existsSync(path.join(uploadsDir, thumbName(r.filename))));
  if (!missing.length) return;
  console.log(`Generating thumbnails for ${missing.length} existing image(s)…`);
  // Process in small batches to avoid a burst of CPU/IO.
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    await Promise.all(batch.map((r) => generateThumbnail(r.filename)));
  }
  console.log('Thumbnail backfill complete.');
})();

// One-time migration: pre-existing passwordless accounts (password_hash IS NULL)
// would otherwise be locked out. Give each a random temporary password and print
// it so the owner can log in and then change it via "Change password".
(function migratePasswordlessUsers() {
  const rows = db.prepare('SELECT id, username FROM users WHERE password_hash IS NULL').all();
  if (!rows.length) return;
  for (const row of rows) {
    const temp = crypto.randomBytes(9).toString('base64url');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temp), row.id);
    console.log(`  Temporary password for "${row.username}": ${temp}`);
  }
  console.log('  Log in with the temporary password, then use "Change password" to set a new one.');
})();

// Find the LAN IPv4 address so we can print a URL other devices can use
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

// --- Start the server (HTTP, or HTTPS when a cert/key are provided) ---
// A PWA is only installable on Android over a *trusted* HTTPS connection, so
// for phone installs pass --cert/--key (or TLS_CERT/TLS_KEY) pointing at a
// publicly-trusted certificate.
function startServer() {
  const lanIp = getLanIp();
  if (cliArgs.cert && cliArgs.key) {
    const tlsOptions = {
      cert: fs.readFileSync(cliArgs.cert),
      key: fs.readFileSync(cliArgs.key)
    };
    const httpsServer = https.createServer(tlsOptions, app);
    httpsServer.listen(PORT, () => {
      console.log(`Image Likes (HTTPS) running at https://localhost:${PORT}`);
      if (lanIp) console.log(`On your local network:  https://${lanIp}:${PORT}`);
      console.log('  Note: the cert must be *trusted* by the device for the PWA to install.');
    });
  } else {
    app.listen(PORT, () => {
      console.log(`Image Likes running at http://localhost:${PORT}`);
      if (lanIp) {
        console.log(`On your local network:  http://${lanIp}:${PORT}`);
        console.log('  (Plain HTTP — the PWA will NOT install on Android. Use --cert/--key for a trusted HTTPS endpoint.)');
      }
    });
  }
}
startServer();
