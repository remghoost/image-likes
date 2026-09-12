// ============================================================================
// COMPREHENSIVE SECURITY SMOKE TEST
// Run with:  node security_test.js
//   (the server must already be running on port 3999, e.g. `node server.js --port 3999`)
//
// ADAPTED to this app's REAL routes (verified against server.js):
//   - "Posts" are IMAGES:  POST /api/images  (multipart, field name "image")
//   - No single-image GET by id; the feed is GET /api/images (public)
//   - DELETE /api/images/:id            (ownership-checked -> 403 for non-owner)
//   - Comments: POST /api/images/:id/comments  {text}
//               DELETE /api/comments/:id       (ownership-checked -> 403)
//   - There is NO edit/caption endpoint, so no "edit another user's post" IDOR.
//   - Upload size limit is 25 MB (multer fileSize).
//   - Signup rate limit: 5 / 15 min / IP  (this shapes the test ordering below).
//
// RATE-LIMIT NOTE: this test performs 11 signups from a single IP. The app
// allows only 5 signups / 15 min / IP, so the test is designed to run ONCE per
// 15-minute window. Re-running within 15 min will 429 the signups (expected,
// not a bug) and the dependent sections will skip.
//
// WHO THIS FILE IS FOR (LLM): a "FAIL" usually means the vulnerable behavior is
// still present, not that the code is broken. Fix the app, not the expectation,
// unless a comment says the check itself was adapted to this app's routes.
//
// NOT COVERED (see MANUAL CHECKS at the bottom):
//   - Whether passwords are actually hashed (inspect the DB directly)
//   - Whether uploaded files execute when served (static-server config)
//   - Real browser-rendered XSS (frontend escaping, not the API)
// ============================================================================

const BASE = 'http://localhost:3999';

// A minimal valid 1x1 PNG (base64) so uploads pass the mime + extension filter.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function tinyPngBytes() {
  return new Uint8Array(Buffer.from(TINY_PNG_B64, 'base64'));
}

async function main() {
  let pass = 0, fail = 0, skip = 0;
  const check = (name, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
    cond ? pass++ : fail++;
  };
  const note = (msg) => console.log(`NOTE  ${msg}`);
  const skipped = (name, reason) => {
    console.log(`SKIP  ${name}  (${reason})`);
    skip++;
  };

  const rand = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Upload an image (multipart, field "image"). Returns { res, body }.
  async function uploadImage(filename, content, mimeType, cookie) {
    const form = new FormData();
    const blob = new Blob([content], { type: mimeType });
    form.append('image', blob, filename);
    const res = await fetch(BASE + '/api/images', { method: 'POST', headers: { Cookie: cookie }, body: form });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    return { res, body };
  }

  // ==========================================================================
  // SECTION 1: Baseline auth mechanics
  // ==========================================================================
  console.log('\n--- Section 1: Baseline auth ---');

  const me0 = await fetch(BASE + '/api/me');
  check('X-Content-Type-Options: nosniff', me0.headers.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options: DENY', me0.headers.get('x-frame-options') === 'DENY');
  check('CSP present', (me0.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  check('unauthenticated /api/me -> user null', (await me0.json()).user === null);

  const meOld = await fetch(BASE + '/api/me', { headers: { Cookie: 'userId=1' } });
  check('old userId=1 cookie ignored', (await meOld.json()).user === null);

  // ==========================================================================
  // SECTION 2: Provision two test users (A and B) for cross-user testing
  // ==========================================================================
  console.log('\n--- Section 2: Provisioning two test users ---');

  async function signup(username, password) {
    const su = await fetch(BASE + '/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const setCookie = su.headers.get('set-cookie') || '';
    const token = (setCookie.match(/session=([a-f0-9]{64})/) || [])[1];
    return { username, password, token, status: su.status };
  }

  const userA = await signup('sectA_' + rand(), 'testpass123!' + rand());
  const userB = await signup('sectB_' + rand(), 'testpass123!' + rand());
  check('user A signup succeeded with session token', !!userA.token);
  check('user B signup succeeded with session token', !!userB.token);

  const cookieA = `session=${userA.token}`;
  const cookieB = `session=${userB.token}`;

  // ==========================================================================
  // SECTION 3: IDOR / cross-user authorization (images + comments)
  // ==========================================================================
  console.log('\n--- Section 3: IDOR / cross-user authorization ---');

  let imageIdOfA = null;
  try {
    const { res, body } = await uploadImage('a_' + rand() + '.png', tinyPngBytes(), 'image/png', cookieA);
    if ((res.status === 200 || res.status === 201) && body && body.id) imageIdOfA = body.id;
  } catch (e) { /* upload failed */ }

  if (!imageIdOfA) {
    skipped('IDOR: delete another user\'s image / comment',
      'could not create an image via POST /api/images (multipart field "image") — check the server is up and not rate-limited');
  } else {
    // Public read: the feed is public by design in a social app.
    const feedAsB = await fetch(BASE + '/api/images', { headers: { Cookie: cookieB } });
    const feed = await feedAsB.json();
    const visible = feed.some(img => img.id === imageIdOfA);
    note(`User B can see User A's image in the public feed: ${visible} (public read is intentional for a social app)`);

    // Can User B DELETE User A's image? Should NEVER succeed.
    const deleteAsB = await fetch(BASE + `/api/images/${imageIdOfA}`, { method: 'DELETE', headers: { Cookie: cookieB } });
    check('User B CANNOT delete User A\'s image', deleteAsB.status === 403 || deleteAsB.status === 404 || deleteAsB.status === 401);

    // Comment-level IDOR: A comments on their image, B tries to delete it.
    let commentIdOfA = null;
    const cRes = await fetch(BASE + `/api/images/${imageIdOfA}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ text: 'A comment by A ' + rand() })
    });
    if (cRes.status === 200 || cRes.status === 201) {
      const cBody = await cRes.json();
      commentIdOfA = cBody.id || null;
    }
    if (commentIdOfA) {
      const delCommentAsB = await fetch(BASE + `/api/comments/${commentIdOfA}`, { method: 'DELETE', headers: { Cookie: cookieB } });
      check('User B CANNOT delete User A\'s comment', delCommentAsB.status === 403 || delCommentAsB.status === 404 || delCommentAsB.status === 401);
    } else {
      skipped('IDOR: delete another user\'s comment', 'could not create a comment to test');
    }

    // Confirm the image still exists (belt-and-suspenders).
    const verify = await fetch(BASE + '/api/images', { headers: { Cookie: cookieA } });
    const vFeed = await verify.json();
    check('image still exists after B\'s delete attempt', vFeed.some(img => img.id === imageIdOfA));
  }

  // NOTE: this app has no edit/caption endpoint, so there is no "edit another
  // user's post" IDOR. The write-side IDORs that DO exist (delete image,
  // delete comment) are covered above.

  // ==========================================================================
  // SECTION 4: File upload validation
  // ==========================================================================
  console.log('\n--- Section 4: File upload validation ---');

  try {
    // Disguised script: .jpg extension + image/jpeg mime, but HTML/JS content.
    // The server validates ONLY the declared mime type and extension (not magic
    // bytes), so this is ACCEPTED. A FAIL here is a REAL finding: the app does
    // not verify the file is actually an image. (Mitigated in practice by
    // X-Content-Type-Options: nosniff + serving as image/*, but still a weakness.)
    const fakeImage = await uploadImage('evil.jpg', '<script>alert(document.cookie)</script>', 'image/jpeg', cookieA);
    check('upload rejects non-image content disguised as .jpg (server checks mime+ext only, not magic bytes)',
      fakeImage.res.status === 400 || fakeImage.res.status === 415 || fakeImage.res.status === 422);

    // Path traversal in filename (no valid image extension -> rejected).
    const traversal = await uploadImage('../../../../etc/passwd', 'not an image', 'image/jpeg', cookieA);
    check('upload rejects path-traversal filename', traversal.res.status === 400 || traversal.res.status === 422 || traversal.res.status === 415);

    // SVG can embed <script>; the mime filter rejects image/svg+xml.
    const svgXss = await uploadImage('evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml', cookieA);
    check('upload rejects SVG with embedded script', svgXss.res.status !== 200 && svgXss.res.status !== 201);

    // Oversized file: app limit is 25 MB, so send 26 MB to exceed it.
    let oversizedStatus = null;
    try {
      const bigBlob = new Uint8Array(26 * 1024 * 1024).fill(65);
      const oversized = await uploadImage('big.jpg', bigBlob, 'image/jpeg', cookieA);
      oversizedStatus = oversized.res.status;
    } catch (e) {
      oversizedStatus = 'error: ' + e.message;
    }
    check('oversized upload (>25MB) rejected (not stored)', oversizedStatus !== 200 && oversizedStatus !== 201);
    note(`Oversized upload returned: ${oversizedStatus}. Rejected is good; a clean 413 would be better (no custom multer error handler currently).`);
  } catch (e) {
    skipped('file upload tests', `POST /api/images not reachable (error: ${e.message})`);
  }

  // MANUAL FOLLOW-UP: upload a real image, fetch its /uploads/<file> URL, and
  // confirm Content-Type is image/* and it is not executed as a script.

  // ==========================================================================
  // SECTION 5: Stored XSS (API layer) — via comments
  // ==========================================================================
  console.log('\n--- Section 5: Stored XSS (API layer) ---');

  const xssPayload = '<script>window.__xss_fired=true</script>';
  try {
    let targetImageId = imageIdOfA;
    if (!targetImageId) {
      const { res, body } = await uploadImage('xss_' + rand() + '.png', tinyPngBytes(), 'image/png', cookieA);
      if (res.status === 200 && body && body.id) targetImageId = body.id;
    }
    if (targetImageId) {
      const cRes = await fetch(BASE + `/api/images/${targetImageId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieA },
        body: JSON.stringify({ text: xssPayload })
      });
      if (cRes.status === 200 || cRes.status === 201) {
        const comments = await (await fetch(BASE + `/api/images/${targetImageId}/comments`, { headers: { Cookie: cookieA } })).json();
        const returned = comments.map(c => c.text).join('');
        check('XSS payload stored and retrievable via API (round-trip works)', returned.includes(xssPayload));
        note('The API stores/returns raw text BY DESIGN. This app mitigates stored XSS at the FRONTEND: public/app.js renders comments through escapeHtml(), so the payload is escaped before reaching the DOM. You must still manually open the app in a browser and confirm no script executes (see MANUAL CHECKS).');
      } else {
        skipped('stored XSS check', `comment creation returned ${cRes.status}`);
      }
    } else {
      skipped('stored XSS check', 'no image available to comment on');
    }
  } catch (e) {
    skipped('stored XSS check', `error: ${e.message}`);
  }

  // ==========================================================================
  // SECTION 6: Basic injection probes (login)
  // ==========================================================================
  console.log('\n--- Section 6: Basic injection probes ---');

  const injectionPayloads = [
    "' OR '1'='1",
    "admin'--",
    '{"$gt": ""}',
  ];
  for (const payload of injectionPayloads) {
    const r = await fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: payload, password: payload })
    });
    check(`login rejects injection-style payload (${JSON.stringify(payload).slice(0, 20)}...)`, r.status === 401 || r.status === 400);
  }
  note('The app uses better-sqlite3 with parameterized queries (?), so SQL/NoSQL injection is not applicable — these probes confirm the login path returns 401 for garbage input. (If a probe returns 429, that is the login rate limit, not a vulnerability.)');

  // ==========================================================================
  // SECTION 7: Mass assignment (run BEFORE the rate-limit hammer in Section 8)
  // ==========================================================================
  console.log('\n--- Section 7: Mass assignment ---');

  const maUser = 'sectMA_' + rand();
  const maSignup = await fetch(BASE + '/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: maUser, password: 'testpass123', isAdmin: true, role: 'admin', verified: true })
  });
  if (maSignup.status === 200) {
    const setCookie = maSignup.headers.get('set-cookie') || '';
    const maToken = (setCookie.match(/session=([a-f0-9]{64})/) || [])[1];
    const meMA = await fetch(BASE + '/api/me', { headers: { Cookie: `session=${maToken}` } });
    const meData = await meMA.json();
    const grantedAdmin = meData.user && (meData.user.isAdmin === true || meData.user.role === 'admin');
    check('signup body with isAdmin/role fields does NOT grant elevated privileges', !grantedAdmin);
    note('The signup handler only reads username+password, and /api/me only returns id/username/created_at, so injected privilege fields are ignored.');
  } else {
    skipped('mass assignment check', `signup with extra fields returned ${maSignup.status}, not 200 — inconclusive (likely rate-limited; run once per 15 min)`);
  }

  // ==========================================================================
  // SECTION 8: Signup rate limiting (run LAST — it exhausts the 5/15min budget)
  // ==========================================================================
  console.log('\n--- Section 8: Signup rate limiting ---');

  let lastSignupStatus = 0;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(BASE + '/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'spamtest' + rand(), password: 'testpass123' })
    });
    lastSignupStatus = r.status;
  }
  check('signup rate-limited after repeated rapid requests (429)', lastSignupStatus === 429);
  if (lastSignupStatus !== 429) {
    note('If this fails: an attacker can currently script-create unlimited accounts. (Note: this test itself consumes the 5/15min signup budget, so run it once per window.)');
  }

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);

  console.log(`
--- MANUAL CHECKS (cannot be automated via HTTP — do these by hand) ---
1. Open the DB (data/image-likes.db) and confirm password_hash values are
   "scrypt:<salt>:<hash>" strings, NOT plaintext. (This app uses Node's
   crypto.scryptSync — verify a sample row.)
2. Upload a real image, then open its /uploads/<file> URL directly and confirm
   Content-Type is image/* and it doesn't execute as a script.
3. View a comment containing the XSS payload IN THE BROWSER and confirm the
   frontend escapes it (public/app.js uses escapeHtml) rather than executing it.
4. Check that .env / secrets are in .gitignore and never committed
   (run: git log --all --full-history -- .env).
5. Confirm session cookies get the 'Secure' flag once running over HTTPS
   (currently set as HttpOnly; SameSite=Lax — add Secure for production).
`);

  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
