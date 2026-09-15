/**
 * Post image(s) to Image Likes as a given account.
 *
 * This is the "post" step in the LLM posting flow:
 *   1. Generate  -> ComfyUI writes image file(s) to disk
 *   2. Caption   -> the LLM writes a description
 *   3. Post      -> THIS script logs in and uploads the image(s) + description
 *
 * It is deliberately a single, self-contained command with a clean JSON result
 * on stdout (progress goes to stderr), so an LLM can call it and parse the
 * outcome without any extra tooling.
 *
 * Usage:
 *   node scripts/post.js --user <username> --password <password> \
 *                        --description "caption" \
 *                        --images <path> [<path> ...] \
 *                        [--server <url>]
 *
 * Options:
 *   --user <username>      account to post as          (or POST_USER env)
 *   --password <password>  that account's password     (or POST_PASSWORD env)
 *   --description <text>   caption for the post        (or POST_DESCRIPTION env)
 *   --images <path> ...    one or more image files; all become ONE carousel post
 *   --server <url>         base URL of the server      (or POST_SERVER env,
 *                          default http://localhost:3000)
 *
 * Notes:
 *   - Multiple --images values are uploaded together as a single multi-image
 *     (carousel) post, matching how the web app groups them.
 *   - Credentials are read from args first, then env, so a per-account batch
 *     file can bake in the username/password and only pass description + images.
 *   - The server must be running. If it isn't, the script exits with a clear
 *     error rather than hanging.
 */
const fs = require('fs');
const path = require('path');

// --- MIME types for the image extensions the server accepts ---
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
};

function log(msg) {
  // Progress goes to stderr so stdout stays clean JSON for the caller to parse.
  process.stderr.write(msg + '\n');
}

function fail(message, code = 1) {
  log(`ERROR: ${message}`);
  process.exit(code);
}

// --- Argument parsing ---
// --images may appear multiple times (or be space-separated); everything after
// the first --images value is treated as an image path until the next --flag.
function parseArgs(argv) {
  const args = { user: null, password: null, description: null, images: [], server: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') args.user = argv[++i];
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--description') args.description = argv[++i];
    else if (a === '--server') args.server = argv[++i];
    else if (a === '--images') {
      // Consume all following non-flag tokens as image paths.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.images.push(argv[++i]);
      }
    } else if (a === '--help' || a === '-h') {
      log('See the header comment in scripts/post.js for usage.');
      process.exit(0);
    }
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));

// Credentials: args win, then env (so a batch file can set env and pass only
// the per-post values).
const user = cli.user || process.env.POST_USER;
const password = cli.password || process.env.POST_PASSWORD;
const description = cli.description !== null ? cli.description : process.env.POST_DESCRIPTION;
const server = (cli.server || process.env.POST_SERVER || 'http://localhost:3000').replace(/\/+$/, '');
const images = cli.images;

// --- Validate inputs up front (fail fast with a clear message) ---
if (!user) fail('No username. Pass --user <username> or set POST_USER.');
if (password === undefined || password === null) fail('No password. Pass --password <password> or set POST_PASSWORD.');
if (!images.length) fail('No images. Pass --images <path> [more paths...].');
if (description !== undefined && description !== null && typeof description !== 'string') {
  fail('Description must be a string.');
}
const caption = (description || '').trim();
if (caption.length > 500) fail('Description too long (max 500 characters).');

// Resolve + validate every image path before touching the network.
const imageFiles = images.map((p) => {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail(`Image not found: ${p}`);
  }
  const ext = path.extname(abs).toLowerCase();
  if (!MIME[ext]) {
    fail(`Unsupported image type "${ext}" for ${p}. Allowed: ${Object.keys(MIME).join(', ')}`);
  }
  return abs;
});

// --- Login: POST /api/login, capture the session cookie ---
async function login() {
  let res;
  try {
    res = await fetch(`${server}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password })
    });
  } catch (err) {
    fail(`Could not reach the server at ${server} (${err.message}). Is it running?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail(`Login failed (${res.status}): ${body.error || 'unknown error'}`);
  }
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/session=([^;]+)/);
  if (!match) fail('Login succeeded but no session cookie was returned.');
  return match[1];
}

// --- Upload: POST /api/images (multipart, field "image", optional "description") ---
async function upload(sessionToken) {
  const form = new FormData();
  for (const abs of imageFiles) {
    const buf = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const blob = new Blob([buf], { type: MIME[ext] });
    form.append('image', blob, path.basename(abs));
  }
  if (caption) form.append('description', caption);

  let res;
  try {
    res = await fetch(`${server}/api/images`, {
      method: 'POST',
      headers: { Cookie: `session=${sessionToken}` },
      body: form
    });
  } catch (err) {
    fail(`Upload request failed (${err.message}).`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail(`Upload failed (${res.status}): ${body.error || 'unknown error'}`);
  }
  return body;
}

(async () => {
  log(`Posting ${imageFiles.length} image(s) as "${user}" to ${server}`);
  const token = await login();
  log('Logged in.');
  const post = await upload(token);
  log('Posted.');
  // Final result on stdout: clean JSON the caller (human or LLM) can parse.
  process.stdout.write(JSON.stringify({
    ok: true,
    post_id: post.id,
    author: post.author,
    description: post.description,
    image_count: post.images ? post.images.length : imageFiles.length,
    images: post.images ? post.images.map((i) => i.filename) : []
  }, null, 2) + '\n');
})().catch((err) => fail(err && err.message ? err.message : String(err)));
