let currentUser = null;
let currentTab = 'feed';

const $ = (sel) => document.querySelector(sel);

// ---------- API helper ----------
async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const opts = { method, credentials: 'same-origin' };
  if (body) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Utilities ----------
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(dateStr) {
  // SQLite datetime('now') is UTC
  const date = new Date(dateStr + 'Z');
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function avatarHtml(username, pic, size) {
  const sizeClass = size ? ` avatar-${size}` : '';
  if (pic) {
    return `<div class="avatar${sizeClass} avatar-img"><img src="/uploads/${pic}" alt="${escapeHtml(username)}"></div>`;
  }
  const initial = (username[0] || '?').toUpperCase();
  return `<div class="avatar${sizeClass}">${escapeHtml(initial)}</div>`;
}

// Low-res thumbnail URL for a shared image. The feed/profile grid show these
// so the page loads fast; the full-resolution original is only fetched when the
// user opens the lightbox. If a thumbnail is missing (generation failed), the
// browser 404s and we fall back to the original via onerror.
function thumbUrl(filename) {
  return `/uploads/${filename}.thumb.jpg`;
}

// ---------- Views ----------
function showAuth() {
  $('#auth-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}

function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#current-username').textContent = currentUser.username;
  renderUserMenuAvatar();
  closeUserMenu();
  loadFeed();
}

// ---------- User menu (dropdown) ----------
function renderUserMenuAvatar() {
  const el = $('#user-menu-avatar');
  if (currentUser.profile_pic) {
    el.innerHTML = `<img src="/uploads/${currentUser.profile_pic}" alt="">`;
  } else {
    el.textContent = (currentUser.username[0] || '?').toUpperCase();
  }
}

function openUserMenu() {
  $('#user-menu').classList.remove('hidden');
  $('#user-menu-btn').classList.add('open');
  $('#user-menu-btn').setAttribute('aria-expanded', 'true');
}

function closeUserMenu() {
  $('#user-menu').classList.add('hidden');
  $('#user-menu-btn').classList.remove('open');
  $('#user-menu-btn').setAttribute('aria-expanded', 'false');
}

function toggleUserMenu() {
  if ($('#user-menu').classList.contains('hidden')) openUserMenu();
  else closeUserMenu();
}

// ---------- Auth ----------
let authMode = 'login'; // 'login' | 'signup'
let inviteRequired = false; // set from /api/config; shows the invite-code field on signup

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-signup').classList.toggle('active', mode === 'signup');
  $('#auth-submit-btn').textContent = mode === 'login' ? 'Log in' : 'Sign up';
  $('#password-input').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#invite-input').classList.toggle('hidden', !(mode === 'signup' && inviteRequired));
  $('#auth-error').textContent = '';
}

async function submitAuth() {
  const username = $('#username-input').value.trim();
  const password = $('#password-input').value;
  if (!username || !password) {
    $('#auth-error').textContent = 'Enter a username and password';
    return;
  }
  const btn = $('#auth-submit-btn');
  btn.disabled = true;
  try {
    $('#auth-error').textContent = '';
    const path = authMode === 'login' ? '/api/login' : '/api/signup';
    const body = { username, password };
    if (authMode === 'signup' && inviteRequired) {
      body.inviteCode = $('#invite-input').value.trim();
    }
    currentUser = await api(path, { method: 'POST', body });
    showApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  currentUser = null;
  showAuth();
}

// ---------- Change password ----------
function openPwModal() {
  $('#pw-current').value = '';
  $('#pw-new').value = '';
  $('#pw-confirm').value = '';
  $('#pw-error').textContent = '';
  $('#pw-modal').classList.remove('hidden');
  updateModalOpenState();
  $('#pw-current').focus();
}

function closePwModal() {
  $('#pw-modal').classList.add('hidden');
  updateModalOpenState();
}

async function savePassword() {
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  const confirm = $('#pw-confirm').value;
  if (!current || !next) {
    $('#pw-error').textContent = 'Fill in all fields';
    return;
  }
  if (next.length < 6) {
    $('#pw-error').textContent = 'New password must be at least 6 characters';
    return;
  }
  if (next !== confirm) {
    $('#pw-error').textContent = 'New passwords do not match';
    return;
  }
  const btn = $('#pw-save');
  btn.disabled = true;
  try {
    $('#pw-error').textContent = '';
    await api('/api/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    closePwModal();
  } catch (err) {
    $('#pw-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Feed ----------
async function loadFeed() {
  const feed = $('#feed');
  feed.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const images = await api('/api/images');
    renderFeed(images);
  } catch (err) {
    feed.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderFeed(images) {
  const feed = $('#feed');
  if (!images.length) {
    feed.innerHTML = `<p class="empty">No images yet. Share the first one!</p>`;
    return;
  }
  feed.innerHTML = images.map((img) => imageCardHtml(img)).join('');
  images.forEach((img) => attachCardEvents(img));
}

function imageCardHtml(post, forModal = false) {
  const liked = post.liked_by_me > 0;
  const images = post.images && post.images.length ? post.images : [{ id: post.id, filename: post.filename }];
  const multi = images.length > 1;

  // Single image keeps the original simple markup; multiple images become a carousel.
  // We show the low-res thumbnail; clicking opens the lightbox with the full-res original.
  const media = multi
    ? carouselHtml(images)
    : `<div class="image-wrap"><img src="${thumbUrl(images[0].filename)}" data-full="/uploads/${images[0].filename}" alt="Shared image" loading="lazy" onerror="this.onerror=null;this.src=this.dataset.full"></div>`;

  // Description + actions + comments. In the post modal these live in a
  // scrollable box (.post-scroll) so the image and the close button stay in view.
  const detail = `
    ${post.description ? `<div class="image-description">${escapeHtml(post.description)}</div>` : ''}
    <div class="card-actions">
      <button class="like-btn ${liked ? 'liked' : ''}" title="Like / Unlike">
        <svg viewBox="0 0 24 24" width="26" height="26">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      </button>
      <button class="comment-btn" title="Comment">
        <svg viewBox="0 0 24 24" width="26" height="26">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
        </svg>
      </button>
      <span class="like-count">${post.like_count} like${post.like_count === 1 ? '' : 's'}</span>
    </div>
    <div class="comments" data-comments></div>`;
  const middle = forModal ? `<div class="post-scroll">${detail}</div>` : detail;

  return `
  <article class="card image-card" data-id="${post.id}">
    <div class="card-header">
      <div class="author-link" data-username="${escapeHtml(post.author)}" title="View profile">
        ${avatarHtml(post.author, post.author_pic)}
        <span class="author">${escapeHtml(post.author)}</span>
      </div>
      <span class="time">${timeAgo(post.created_at)}</span>
      ${post.author === currentUser.username ? '<button class="edit-desc-btn" title="Edit description">&#9998;</button>' : ''}
      ${post.author === currentUser.username ? '<button class="delete-btn" title="Delete post">&#10005;</button>' : ''}
    </div>
    ${media}
    ${middle}
    <div class="comment-form">
      <input type="text" placeholder="Add a comment…" maxlength="500">
      <button class="post-btn">Post</button>
    </div>
  </article>`;
}

// Build the horizontally-scrolling carousel for a multi-image post.
function carouselHtml(images) {
  const slides = images.map((img, i) => `
    <div class="carousel-slide">
      <div class="image-wrap">
        <img src="${thumbUrl(img.filename)}" data-full="/uploads/${img.filename}" alt="Shared image ${i + 1} of ${images.length}" loading="lazy" onerror="this.onerror=null;this.src=this.dataset.full">
      </div>
    </div>`).join('');
  const dots = images.map((_, i) => `<span class="carousel-dot ${i === 0 ? 'active' : ''}" data-index="${i}"></span>`).join('');
  return `
  <div class="carousel" data-count="${images.length}">
    <div class="carousel-track">${slides}</div>
    <button class="carousel-arrow prev" type="button" title="Previous" aria-label="Previous image">&#8249;</button>
    <button class="carousel-arrow next" type="button" title="Next" aria-label="Next image">&#8250;</button>
    <span class="carousel-counter">1/${images.length}</span>
    <div class="carousel-dots">${dots}</div>
  </div>`;
}

const REACTION_EMOJIS = ['❤️', '😮', '😂', '👍', '😢'];

function reactionToggleHtml(c) {
  const reactions = c.reactions || {};
  const activeEmojis = REACTION_EMOJIS.filter((e) => (reactions[e] || 0) > 0);
  if (activeEmojis.length === 0) {
    return `<button class="reaction-toggle" title="React"><span class="reaction-smiley">&#128578;</span></button>`;
  }
  const summary = activeEmojis.map((e) => `${e}${reactions[e] > 1 ? `<sup>${reactions[e]}</sup>` : ''}`).join(' ');
  return `<button class="reaction-toggle has-reactions" title="React"><span class="reaction-summary">${summary}</span></button>`;
}

function reactionPickerHtml(c) {
  const reactions = c.reactions || {};
  const mine = reactions._mine || [];
  return REACTION_EMOJIS.map((emoji) => {
    const count = reactions[emoji] || 0;
    const active = mine.includes(emoji);
    return `<button class="comment-reaction ${active ? 'active' : ''}" data-emoji="${emoji}" title="${emoji}">${emoji}${count > 0 ? ` <span class="reaction-count">${count}</span>` : ''}</button>`;
  }).join('');
}

function commentHtml(c) {
  const canDelete = c.author === currentUser.username;
  return `
    <div class="comment" data-comment-id="${c.id}">
      <span class="comment-author">${escapeHtml(c.author)}</span>
      <span class="comment-text">${escapeHtml(c.text)}</span>
      <div class="comment-meta">
        <span class="comment-time">${timeAgo(c.created_at)}</span>
        ${canDelete ? '<button class="delete-comment" title="Delete comment">delete</button>' : ''}
        <div class="comment-reaction-wrap">
          ${reactionToggleHtml(c)}
          <div class="reaction-picker hidden">${reactionPickerHtml(c)}</div>
        </div>
      </div>
    </div>`;
}

function renderComments(el, comments) {
  if (!comments.length) {
    el.innerHTML = '<p class="no-comments">No comments yet. Start the conversation.</p>';
    return;
  }
  el.innerHTML = comments.map(commentHtml).join('');
}

async function loadCommentsForCard(card, imageId) {
  const commentsEl = card.querySelector('[data-comments]');
  try {
    const comments = await api(`/api/images/${imageId}/comments`);
    renderComments(commentsEl, comments);
    attachCommentDeleteButtons(card);
  } catch { /* ignore */ }
}

function attachCommentDeleteButtons(card) {
  card.querySelectorAll('.delete-comment').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const commentEl = btn.closest('.comment');
      const commentId = commentEl.dataset.commentId;
      if (!confirm('Delete this comment?')) return;
      try {
        await api(`/api/comments/${commentId}`, { method: 'DELETE' });
        commentEl.remove();
        const commentsEl = card.querySelector('[data-comments]');
        if (!commentsEl.querySelector('.comment')) {
          renderComments(commentsEl, []);
        }
      } catch (err) {
        alert(err.message);
      }
    });
  });
  // Wire up reaction toggle buttons (open/close the picker)
  card.querySelectorAll('.reaction-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = btn.closest('.comment-reaction-wrap');
      const picker = wrap.querySelector('.reaction-picker');
      const wasHidden = picker.classList.contains('hidden');
      // Close any other open pickers in this card
      card.querySelectorAll('.reaction-picker:not(.hidden)').forEach((p) => {
        if (p !== picker) p.classList.add('hidden');
      });
      picker.classList.toggle('hidden', !wasHidden);
    });
  });
  // Wire up reaction buttons inside the picker
  card.querySelectorAll('.comment-reaction').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCommentReaction(btn);
    });
  });
}

async function toggleCommentReaction(btn) {
  const commentEl = btn.closest('.comment');
  const commentId = commentEl.dataset.commentId;
  const emoji = btn.dataset.emoji;
  btn.disabled = true;
  try {
    const result = await api(`/api/comments/${commentId}/react`, { method: 'POST', body: { emoji } });
    // Update the button state
    btn.classList.toggle('active', result.reacted);
    const countEl = btn.querySelector('.reaction-count');
    if (result.count > 0) {
      if (countEl) {
        countEl.textContent = result.count;
      } else {
        btn.insertAdjacentHTML('beforeend', ` <span class="reaction-count">${result.count}</span>`);
      }
    } else if (countEl) {
      countEl.remove();
    }
    // Update the toggle button summary
    updateReactionToggle(commentEl);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

// Rebuild the reaction toggle button's summary from the picker's current state.
function updateReactionToggle(commentEl) {
  const toggle = commentEl.querySelector('.reaction-toggle');
  const picker = commentEl.querySelector('.reaction-picker');
  if (!toggle || !picker) return;
  const active = [];
  picker.querySelectorAll('.comment-reaction').forEach((b) => {
    const countEl = b.querySelector('.reaction-count');
    const count = countEl ? parseInt(countEl.textContent, 10) : 0;
    if (count > 0) active.push({ emoji: b.dataset.emoji, count });
  });
  if (active.length === 0) {
    toggle.classList.remove('has-reactions');
    toggle.innerHTML = '<span class="reaction-smiley">&#128578;</span>';
  } else {
    toggle.classList.add('has-reactions');
    const summary = active.map((a) => `${a.emoji}${a.count > 1 ? `<sup>${a.count}</sup>` : ''}`).join(' ');
    toggle.innerHTML = `<span class="reaction-summary">${summary}</span>`;
  }
}

// ---------- Card events ----------
function attachCardEvents(post, root) {
  const card = (root || document).querySelector(`.image-card[data-id="${post.id}"]`);
  if (!card) return;

  const likeBtn = card.querySelector('.like-btn');
  const likeCount = card.querySelector('.like-count');

  // Single click/tap opens the lightbox (full-res); double click/tap likes.
  // A short delay on the single click lets us tell the two apart: if a second
  // click lands within the window we cancel the lightbox and treat it as a like.
  const attachImageTap = (imageEl) => {
    let lastTap = 0;
    let clickTimer = null;
    let suppressClick = false;
    const openLightbox = () => {
      const full = imageEl.dataset.full;
      if (!full) return;
      const imgs = Array.from(card.querySelectorAll('.image-wrap img'))
        .map((el) => el.dataset.full)
        .filter(Boolean);
      openLightbox(imgs, Math.max(0, imgs.indexOf(full)));
    };
    const like = () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      toggleLike(post, card);
    };
    imageEl.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      if (clickTimer) return; // second click of a double-click — don't reschedule
      clickTimer = setTimeout(() => { clickTimer = null; openLightbox(); }, 250);
    });
    // Desktop: double-click likes (the two clicks above are already consumed).
    imageEl.addEventListener('dblclick', like);
    // Mobile: detect a double-tap in touchend. The click event(s) that follow a
    // double-tap are suppressed so the lightbox doesn't open right after a like.
    imageEl.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        suppressClick = true;
        like();
      }
      lastTap = now;
    });
  };
  card.querySelectorAll('.image-wrap img').forEach(attachImageTap);

  // Carousel navigation (only present on multi-image posts)
  const carousel = card.querySelector('.carousel');
  if (carousel) setupCarousel(carousel);

  // Click the author's name/avatar to view their profile.
  const authorLink = card.querySelector('.author-link');
  if (authorLink) {
    authorLink.addEventListener('click', () => {
      if (!$('#post-modal').classList.contains('hidden')) closePostModal();
      viewProfile(authorLink.dataset.username);
    });
  }

  likeBtn.addEventListener('click', () => toggleLike(post, card));

  // Comment form
  const input = card.querySelector('.comment-form input');
  const postBtn = card.querySelector('.post-btn');
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    postBtn.disabled = true;
    try {
      const comment = await api(`/api/images/${post.id}/comments`, { method: 'POST', body: { text } });
      input.value = '';
      const commentsEl = card.querySelector('[data-comments]');
      const placeholder = commentsEl.querySelector('.no-comments');
      if (placeholder) placeholder.remove();
      commentsEl.insertAdjacentHTML('beforeend', commentHtml(comment));
      attachCommentDeleteButtons(card);
    } catch (err) {
      alert(err.message);
    } finally {
      postBtn.disabled = false;
    }
  };
  postBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  // Edit description (only for your own posts)
  const editDescBtn = card.querySelector('.edit-desc-btn');
  if (editDescBtn) {
    editDescBtn.addEventListener('click', () => openEditDescModal(post, card));
  }

  // Delete post (removes all images in the post)
  const deleteBtn = card.querySelector('.delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this post?')) return;
      try {
        await api(`/api/images/${post.id}`, { method: 'DELETE' });
        card.remove();
        loadFeed();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  loadCommentsForCard(card, post.id);
}

async function toggleLike(img, card, event) {
  const likeBtn = card.querySelector('.like-btn');
  const likeCount = card.querySelector('.like-count');
  try {
    const result = await api(`/api/images/${img.id}/like`, { method: 'POST' });
    img.liked_by_me = result.liked ? 1 : 0;
    img.like_count = result.like_count;
    likeBtn.classList.toggle('liked', result.liked);
    likeCount.textContent = `${result.like_count} like${result.like_count === 1 ? '' : 's'}`;
    if (result.liked) showHeartBurst(card);
  } catch (err) {
    alert(err.message);
  }
}

function showHeartBurst(card) {
  // For multi-image posts, burst on the currently-visible slide; otherwise the single image.
  const carousel = card.querySelector('.carousel');
  let wrap;
  if (carousel) {
    const index = carousel._index || 0;
    const slide = carousel.querySelectorAll('.carousel-slide')[index];
    wrap = slide ? slide.querySelector('.image-wrap') : card.querySelector('.image-wrap');
  } else {
    wrap = card.querySelector('.image-wrap');
  }
  const heart = document.createElement('div');
  heart.className = 'heart-burst';
  heart.textContent = '\u2764';
  wrap.appendChild(heart);
  setTimeout(() => heart.remove(), 850);
}

// ---------- Carousel (multi-image posts) ----------
// Wires up a horizontally-scrolling carousel: native scroll-snap for swiping,
// plus arrows, dots, and a counter that stay in sync with the scroll position.
function setupCarousel(carousel) {
  const track = carousel.querySelector('.carousel-track');
  const slides = Array.from(carousel.querySelectorAll('.carousel-slide'));
  const dots = Array.from(carousel.querySelectorAll('.carousel-dot'));
  const counter = carousel.querySelector('.carousel-counter');
  const prevBtn = carousel.querySelector('.carousel-arrow.prev');
  const nextBtn = carousel.querySelector('.carousel-arrow.next');
  const count = slides.length;
  carousel._index = 0;

  const slideWidth = () => slides[0] ? slides[0].getBoundingClientRect().width : track.clientWidth;

  function updateUI(index) {
    carousel._index = index;
    if (counter) counter.textContent = `${index + 1}/${count}`;
    dots.forEach((d, i) => d.classList.toggle('active', i === index));
    if (prevBtn) prevBtn.classList.toggle('disabled', index === 0);
    if (nextBtn) nextBtn.classList.toggle('disabled', index === count - 1);
  }

  function goTo(index) {
    const clamped = Math.max(0, Math.min(count - 1, index));
    track.scrollTo({ left: clamped * slideWidth(), behavior: 'smooth' });
  }

  // Keep the UI in sync as the user swipes/scrolls natively.
  let scrollTimer = null;
  track.addEventListener('scroll', () => {
    if (scrollTimer) return;
    scrollTimer = requestAnimationFrame(() => {
      scrollTimer = null;
      const w = slideWidth();
      if (w <= 0) return;
      const index = Math.round(track.scrollLeft / w);
      if (index !== carousel._index) updateUI(index);
    });
  });

  if (prevBtn) prevBtn.addEventListener('click', () => goTo((carousel._index || 0) - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goTo((carousel._index || 0) + 1));
  dots.forEach((dot) => dot.addEventListener('click', () => goTo(parseInt(dot.dataset.index, 10))));

  // Keyboard navigation when the carousel is focused.
  carousel.setAttribute('tabindex', '0');
  carousel.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo((carousel._index || 0) - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goTo((carousel._index || 0) + 1); }
  });

  updateUI(0);
}

// ---------- Upload (staged: pick/drop → preview → Post) ----------
const MAX_UPLOAD_IMAGES = 10;
let pendingFiles = []; // array of { file, url }

function setUploadStatus(msg, isErr) {
  const status = $('#upload-status');
  status.classList.toggle('err', !!isErr);
  status.textContent = msg || '';
}

function renderPreviewGrid() {
  const grid = $('#preview-grid');
  grid.innerHTML = '';
  pendingFiles.forEach((entry, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';
    const img = document.createElement('img');
    img.src = entry.url;
    img.alt = 'Preview';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preview-remove';
    remove.title = 'Remove image';
    remove.innerHTML = '&#10005;';
    remove.addEventListener('click', () => removePending(i));
    thumb.appendChild(img);
    thumb.appendChild(remove);
    grid.appendChild(thumb);
  });
}

function stageFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const files = Array.from(fileList);
  // Validate each file; reject the whole batch if any is invalid (clear message).
  for (const file of files) {
    if (!/^image\/(png|jpe?g|gif|webp|avif)$/.test(file.type)) {
      setUploadStatus('Only image files are allowed (png, jpg, gif, webp, avif)', true);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setUploadStatus('Image too large (max 25 MB)', true);
      return;
    }
  }
  // Enforce the per-post cap: keep what fits, warn if we had to drop some.
  let dropped = 0;
  for (const file of files) {
    if (pendingFiles.length >= MAX_UPLOAD_IMAGES) { dropped++; continue; }
    pendingFiles.push({ file, url: URL.createObjectURL(file) });
  }
  if (dropped > 0) {
    setUploadStatus(`Only ${MAX_UPLOAD_IMAGES} images per post — ${dropped} dropped`, true);
  } else {
    setUploadStatus('');
  }
  renderPreviewGrid();
  $('#upload-preview').classList.remove('hidden');
  $('#upload-actions').classList.remove('hidden');
  $('#description-input').focus();
}

function removePending(index) {
  const entry = pendingFiles[index];
  if (!entry) return;
  URL.revokeObjectURL(entry.url);
  pendingFiles.splice(index, 1);
  if (pendingFiles.length === 0) {
    clearPending();
  } else {
    renderPreviewGrid();
  }
}

function clearPending() {
  pendingFiles.forEach((entry) => URL.revokeObjectURL(entry.url));
  pendingFiles = [];
  $('#preview-grid').innerHTML = '';
  $('#upload-preview').classList.add('hidden');
  $('#upload-actions').classList.add('hidden');
}

async function postPending() {
  if (!pendingFiles.length) return;
  const btn = $('#post-btn');
  btn.disabled = true;
  setUploadStatus('Uploading…');
  const form = new FormData();
  pendingFiles.forEach((entry) => form.append('image', entry.file));
  const descInput = $('#description-input');
  const description = descInput.value.trim();
  if (description) form.append('description', description);
  try {
    await api('/api/images', { method: 'POST', body: form, isForm: true });
    clearPending();
    descInput.value = '';
    setUploadStatus('Shared!');
    setTimeout(() => setUploadStatus(''), 2000);
    loadFeed();
  } catch (err) {
    setUploadStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function handleUpload(e) {
  const files = e.target.files;
  e.target.value = '';
  stageFiles(files);
}

// ---------- Drag & drop upload ----------
function setupDragDrop() {
  const card = $('#upload-card');
  let dragDepth = 0;

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  card.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    card.classList.add('drag-over');
  });

  card.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // required to allow dropping
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  card.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) card.classList.remove('drag-over');
  });

  card.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    card.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files && files.length) stageFiles(files);
  });

  // Prevent the browser from opening the file if it's dropped outside the drop zone
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

// ---------- Tabs ----------
let viewingProfile = null; // username being viewed (null = your own profile)

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      switchView();
    });
  });
}

// Navigate to a user's profile (from clicking their name/avatar in the feed,
// or the "Profile" item in the account menu).
function viewProfile(username) {
  viewingProfile = username;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  currentTab = 'profile';
  switchView();
}

// Show/hide the feed vs. the profile view based on the active tab.
function switchView() {
  const isProfile = currentTab === 'profile';
  $('#upload-card').classList.toggle('hidden', isProfile);
  $('#feed').classList.toggle('hidden', isProfile);
  $('#profile-view').classList.toggle('hidden', !isProfile);
  if (isProfile) {
    loadProfile(viewingProfile || currentUser.username);
  } else {
    loadFeed();
  }
}

// ---------- Blur toggle ----------
// When on, blurs every shared image on screen (feed, profile grid, post
// modal). Profile pictures and upload previews stay sharp. The preference
// is remembered per browser.
const BLUR_KEY = 'imageLikesBlur';
let blurEnabled = false;

function applyBlur() {
  document.body.classList.toggle('images-blurred', blurEnabled);
  const btn = $('#blur-toggle');
  btn.classList.toggle('active', blurEnabled);
  btn.setAttribute('aria-pressed', String(blurEnabled));
  btn.title = blurEnabled ? 'Unblur all images' : 'Blur all images';
}

function setupBlurToggle() {
  try {
    blurEnabled = localStorage.getItem(BLUR_KEY) === '1';
  } catch { /* storage unavailable */ }
  applyBlur();
  $('#blur-toggle').addEventListener('click', () => {
    blurEnabled = !blurEnabled;
    try { localStorage.setItem(BLUR_KEY, blurEnabled ? '1' : '0'); } catch { /* ignore */ }
    applyBlur();
  });
}

// ---------- Profile ----------
let profilePosts = []; // posts for the currently-viewed profile (for the grid)

async function loadProfile(username) {
  const view = $('#profile-view');
  view.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const data = await api(`/api/users/${encodeURIComponent(username)}`);
    profilePosts = data.posts;
    renderProfile(data.user, data.posts);
  } catch (err) {
    view.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderProfile(user, posts) {
  const view = $('#profile-view');
  const isMe = user.username === currentUser.username;
  const postCount = posts.length;
  const grid = posts.length
    ? `<div class="profile-grid">${posts.map((p) => gridTileHtml(p)).join('')}</div>`
    : `<p class="empty profile-empty">${isMe ? 'No posts yet. Share your first image!' : 'No posts yet.'}</p>`;

  view.innerHTML = `
    <div class="profile-header card">
      <div class="profile-top">
        ${avatarHtml(user.username, user.profile_pic, 'xl')}
        <div class="profile-meta">
          <div class="profile-username-row">
            <span class="profile-username">${escapeHtml(user.username)}</span>
            ${isMe ? '<button id="edit-profile-btn" class="btn-ghost" type="button">Edit profile</button>' : '<button id="profile-back-btn" class="btn-ghost" type="button">&#8592; Back</button>'}
          </div>
          <div class="profile-stats">
            <span class="profile-stat"><strong>${postCount}</strong> post${postCount === 1 ? '' : 's'}</span>
          </div>
          ${user.bio ? `<p class="profile-bio">${escapeHtml(user.bio)}</p>` : ''}
        </div>
      </div>
    </div>
    ${grid}
  `;

  // Wire up grid tiles → open the post in a modal.
  view.querySelectorAll('.grid-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const id = parseInt(tile.dataset.id, 10);
      const post = profilePosts.find((p) => p.id === id);
      if (post) openPostModal(post);
    });
  });

  // Wire up the Edit profile button (only present for your own profile).
  const editBtn = $('#edit-profile-btn');
  if (editBtn) editBtn.addEventListener('click', () => openEditProfileModal(user));

  // Wire up the Back button (present when viewing someone else's profile).
  // Returns to the feed, where the author's name was clicked.
  const backBtn = $('#profile-back-btn');
  if (backBtn) backBtn.addEventListener('click', () => {
    viewingProfile = null;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="feed"]').classList.add('active');
    currentTab = 'feed';
    switchView();
  });
}

// A single square tile in the profile grid. Multi-image posts show a small badge.
function gridTileHtml(post) {
  const images = post.images && post.images.length ? post.images : [{ id: post.id, filename: post.filename }];
  const multi = images.length > 1;
  return `
    <div class="grid-tile" data-id="${post.id}" title="${escapeHtml(post.description || 'View post')}">
      <img src="${thumbUrl(images[0].filename)}" alt="Post" loading="lazy" onerror="this.onerror=null;this.src='/uploads/${images[0].filename}'">
      ${multi ? `<span class="grid-multi">&#10514; ${images.length}</span>` : ''}
    </div>`;
}

// ---------- Post detail modal (grid tile → full post) ----------
function openPostModal(post) {
  const body = $('#post-modal-body');
  body.innerHTML = imageCardHtml(post, true);
  $('#post-modal').classList.remove('hidden');
  updateModalOpenState();
  // Wire up the card (likes, comments, carousel, delete) scoped to the modal body.
  attachCardEvents(post, body);
}

function closePostModal() {
  $('#post-modal').classList.add('hidden');
  updateModalOpenState();
  $('#post-modal-body').innerHTML = '';
}

// ---------- Lightbox (full-resolution image viewer) ----------
// Clicking a thumbnail opens this overlay, which loads the full-res original.
// Multi-image posts can be navigated with the arrows / keyboard / swipe.
let lightboxImages = []; // array of full-res URLs
let lightboxIndex = 0;

function openLightbox(urls, startIndex) {
  if (!urls || !urls.length) return;
  lightboxImages = urls;
  lightboxIndex = Math.max(0, Math.min(startIndex, urls.length - 1));
  const overlay = $('#lightbox');
  const img = $('#lightbox-img');
  const counter = $('#lightbox-counter');
  const prevBtn = $('#lightbox-prev');
  const nextBtn = $('#lightbox-next');
  const multi = urls.length > 1;
  overlay.classList.remove('hidden');
  updateModalOpenState();
  prevBtn.classList.toggle('hidden', !multi);
  nextBtn.classList.toggle('hidden', !multi);
  counter.textContent = multi ? `${lightboxIndex + 1}/${urls.length}` : '';
  showLightboxImage();
}

function showLightboxImage() {
  const img = $('#lightbox-img');
  const spinner = $('#lightbox-spinner');
  spinner.classList.remove('hidden');
  img.classList.add('loading');
  img.onload = () => {
    spinner.classList.add('hidden');
    img.classList.remove('loading');
  };
  img.src = lightboxImages[lightboxIndex];
}

function lightboxGo(delta) {
  if (lightboxImages.length < 2) return;
  lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
  const counter = $('#lightbox-counter');
  counter.textContent = `${lightboxIndex + 1}/${lightboxImages.length}`;
  showLightboxImage();
}

function closeLightbox() {
  const overlay = $('#lightbox');
  if (overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  updateModalOpenState();
  $('#lightbox-img').src = '';
  lightboxImages = [];
  lightboxIndex = 0;
}

function setupLightbox() {
  const overlay = $('#lightbox');
  const img = $('#lightbox-img');
  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#lightbox-prev').addEventListener('click', () => lightboxGo(-1));
  $('#lightbox-next').addEventListener('click', () => lightboxGo(1));
  // Click on the dark backdrop (not the image) closes the lightbox.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeLightbox();
  });
  // Keyboard: arrows navigate. (Escape is handled by the global handler, which
  // closes only the topmost layer — the lightbox — leaving any modal beneath it.)
  document.addEventListener('keydown', (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') lightboxGo(-1);
    else if (e.key === 'ArrowRight') lightboxGo(1);
  });
  // Swipe left/right to navigate (touch devices).
  let touchStartX = 0;
  img.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
  }, { passive: true });
  img.addEventListener('touchend', (e) => {
    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) lightboxGo(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// ---------- Edit description modal ----------
let editDescPost = null; // the post object being edited
let editDescCard = null; // the card element (for in-place UI update)

function openEditDescModal(post, card) {
  editDescPost = post;
  editDescCard = card;
  $('#edit-desc-input').value = post.description || '';
  updateEditDescCount();
  $('#edit-desc-error').textContent = '';
  $('#edit-desc-modal').classList.remove('hidden');
  updateModalOpenState();
  $('#edit-desc-input').focus();
}

function closeEditDescModal() {
  $('#edit-desc-modal').classList.add('hidden');
  updateModalOpenState();
  editDescPost = null;
  editDescCard = null;
}

function updateEditDescCount() {
  const len = $('#edit-desc-input').value.length;
  $('#edit-desc-count').textContent = `${len}/500`;
}

async function saveEditDesc() {
  const description = $('#edit-desc-input').value.trim();
  const btn = $('#edit-desc-save');
  btn.disabled = true;
  try {
    $('#edit-desc-error').textContent = '';
    const result = await api(`/api/images/${editDescPost.id}/description`, { method: 'PUT', body: { description } });
    // Update the post object in memory
    editDescPost.description = result.description;
    // Update the card's description in place
    if (editDescCard) {
      let descEl = editDescCard.querySelector('.image-description');
      if (result.description) {
        if (descEl) {
          descEl.textContent = result.description;
        } else {
          const actionsEl = editDescCard.querySelector('.card-actions');
          descEl = document.createElement('div');
          descEl.className = 'image-description';
          descEl.textContent = result.description;
          actionsEl.parentNode.insertBefore(descEl, actionsEl);
        }
      } else if (descEl) {
        descEl.remove();
      }
    }
    closeEditDescModal();
  } catch (err) {
    $('#edit-desc-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Edit profile modal (bio + profile picture) ----------
let editProfilePic = null; // { blob, url } of the cropped picture pending save
let editProfileUser = null; // the user object being edited

function openEditProfileModal(user) {
  editProfileUser = user;
  editProfilePic = null;
  $('#bio-input').value = user.bio || '';
  updateBioCount();
  renderEditProfilePic();
  $('#edit-profile-error').textContent = '';
  $('#edit-profile-modal').classList.remove('hidden');
  updateModalOpenState();
}

function closeEditProfileModal() {
  $('#edit-profile-modal').classList.add('hidden');
  updateModalOpenState();
  if (editProfilePic && editProfilePic.url) URL.revokeObjectURL(editProfilePic.url);
  editProfilePic = null;
}

function renderEditProfilePic() {
  const el = $('#edit-profile-pic');
  if (editProfilePic) {
    el.innerHTML = `<img src="${editProfilePic.url}" alt="Profile picture">`;
    el.classList.add('avatar-img');
  } else if (editProfileUser && editProfileUser.profile_pic) {
    el.innerHTML = `<img src="/uploads/${editProfileUser.profile_pic}" alt="Profile picture">`;
    el.classList.add('avatar-img');
  } else {
    el.innerHTML = escapeHtml((editProfileUser.username[0] || '?').toUpperCase());
    el.classList.remove('avatar-img');
  }
}

function updateBioCount() {
  const len = $('#bio-input').value.length;
  $('#bio-count').textContent = `${len}/150`;
}

async function saveEditProfile() {
  const bio = $('#bio-input').value.trim();
  const btn = $('#edit-profile-save');
  btn.disabled = true;
  try {
    $('#edit-profile-error').textContent = '';
    // Save the bio.
    await api('/api/profile/bio', { method: 'POST', body: { bio } });
    // Save the picture if the user picked a new one.
    if (editProfilePic) {
      const form = new FormData();
      form.append('pic', editProfilePic.blob, 'profile.jpg');
      await api('/api/profile/pic', { method: 'POST', body: form, isForm: true });
    }
    // Refresh the current user and re-render the profile.
    const { user } = await api('/api/me');
    currentUser = user;
    closeEditProfileModal();
    loadProfile(currentUser.username);
  } catch (err) {
    $('#edit-profile-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function removeProfilePic() {
  try {
    await api('/api/profile/pic', { method: 'DELETE' });
    const { user } = await api('/api/me');
    currentUser = user;
    editProfileUser = user;
    renderEditProfilePic();
    loadProfile(currentUser.username);
  } catch (err) {
    $('#edit-profile-error').textContent = err.message;
  }
}

// ---------- Crop / resize tool (profile picture) ----------
// The user drags to reposition and zooms (wheel / slider / pinch) to resize.
// On save we draw the visible circular region to a 512x512 canvas and upload it.
const CROP_SIZE = 512; // output square size in px
let cropState = null; // { img, scale, x, y, naturalW, naturalH, viewport }

function openCropModal(file) {
  if (!/^image\/(png|jpe?g|gif|webp|avif)$/.test(file.type)) {
    $('#crop-error').textContent = 'Only image files are allowed';
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    // Show the modal first so the viewport has a real size when initCrop
    // measures it (clientWidth is 0 while the modal is display:none).
    $('#crop-modal').classList.remove('hidden');
    updateModalOpenState();
    initCrop(img, url, file);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    $('#crop-error').textContent = 'Could not load that image';
  };
  img.src = url;
}

function initCrop(img, url, file) {
  const viewport = document.querySelector('.crop-viewport');
  const cropImg = $('#crop-img');
  cropImg.src = url;
  const vpSize = viewport.clientWidth; // square viewport
  // Fit the image to the viewport (cover) at scale 1.
  const coverScale = Math.max(vpSize / img.naturalWidth, vpSize / img.naturalHeight);
  cropState = {
    img, url, file,
    viewport,
    vpSize,
    baseScale: coverScale,
    scale: 1, // multiplier on top of baseScale
    x: 0, y: 0 // offset of the image's top-left from the viewport center
  };
  $('#crop-zoom').value = 1;
  $('#crop-error').textContent = '';
  applyCropTransform();
}

function applyCropTransform() {
  if (!cropState) return;
  const { img, baseScale, scale, x, y, vpSize } = cropState;
  const dispW = img.naturalWidth * baseScale * scale;
  const dispH = img.naturalHeight * baseScale * scale;
  const cropImg = $('#crop-img');
  cropImg.style.width = `${dispW}px`;
  cropImg.style.height = `${dispH}px`;
  // Center the image, then apply the user's pan offset.
  cropImg.style.left = `${vpSize / 2 - dispW / 2 + x}px`;
  cropImg.style.top = `${vpSize / 2 - dispH / 2 + y}px`;
}

// Set up once (in init). Handlers guard on cropState so they're inert when the
// crop modal is closed. Attaching to the persistent #crop-stage element and
// window exactly once avoids leaking listeners across multiple crop sessions.
function setupCropInteractions() {
  const stage = $('#crop-stage');
  const zoom = $('#crop-zoom');
  let dragging = false;
  let lastX = 0, lastY = 0;
  let pinchDist = 0;

  const startDrag = (clientX, clientY) => {
    if (!cropState) return;
    dragging = true;
    lastX = clientX;
    lastY = clientY;
  };
  const moveDrag = (clientX, clientY) => {
    if (!dragging || !cropState) return;
    cropState.x += clientX - lastX;
    cropState.y += clientY - lastY;
    lastX = clientX;
    lastY = clientY;
    applyCropTransform();
  };
  const endDrag = () => { dragging = false; };

  // Mouse
  stage.addEventListener('mousedown', (e) => { e.preventDefault(); startDrag(e.clientX, e.clientY); });
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endDrag);

  // Touch (single-finger pan, two-finger pinch zoom)
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      dragging = false;
      pinchDist = touchDistance(e.touches);
    }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) {
      e.preventDefault();
      moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const d = touchDistance(e.touches);
      if (pinchDist > 0 && cropState) {
        cropState.scale = clamp(cropState.scale * (d / pinchDist), 1, 4);
        $('#crop-zoom').value = cropState.scale;
        applyCropTransform();
      }
      pinchDist = d;
    }
  }, { passive: false });
  stage.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) { dragging = false; pinchDist = 0; }
  });

  // Wheel zoom
  stage.addEventListener('wheel', (e) => {
    if (!cropState) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    cropState.scale = clamp(cropState.scale * factor, 1, 4);
    zoom.value = cropState.scale;
    applyCropTransform();
  }, { passive: false });

  // Slider zoom
  zoom.addEventListener('input', () => {
    if (!cropState) return;
    cropState.scale = parseFloat(zoom.value);
    applyCropTransform();
  });
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function closeCropModal() {
  $('#crop-modal').classList.add('hidden');
  updateModalOpenState();
  if (cropState && cropState.url) URL.revokeObjectURL(cropState.url);
  cropState = null;
}

// Render the visible circular crop to a CROP_SIZE x CROP_SIZE canvas and return a blob.
function renderCroppedBlob() {
  const { img, baseScale, scale, x, y, vpSize } = cropState;
  const canvas = document.createElement('canvas');
  canvas.width = CROP_SIZE;
  canvas.height = CROP_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, CROP_SIZE, CROP_SIZE);

  // The viewport is vpSize px on screen; the output is CROP_SIZE px.
  const outScale = CROP_SIZE / vpSize;
  // On-screen position of the image's top-left (relative to viewport top-left).
  const dispW = img.naturalWidth * baseScale * scale;
  const dispH = img.naturalHeight * baseScale * scale;
  const left = vpSize / 2 - dispW / 2 + x;
  const top = vpSize / 2 - dispH / 2 + y;

  // Clip to the circle (the profile picture is round).
  ctx.save();
  ctx.beginPath();
  ctx.arc(CROP_SIZE / 2, CROP_SIZE / 2, CROP_SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  // Draw the image scaled to the output size, offset by the pan.
  ctx.drawImage(img, left * outScale, top * outScale, dispW * outScale, dispH * outScale);
  ctx.restore();

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
  });
}

async function saveCroppedPic() {
  if (!cropState) return;
  const btn = $('#crop-save');
  btn.disabled = true;
  try {
    const blob = await renderCroppedBlob();
    if (!blob) throw new Error('Could not process image');
    // Store it as the pending edit-profile picture (replaces any previous one).
    if (editProfilePic && editProfilePic.url) URL.revokeObjectURL(editProfilePic.url);
    editProfilePic = { blob, url: URL.createObjectURL(blob) };
    closeCropModal();
    renderEditProfilePic();
  } catch (err) {
    $('#crop-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Init ----------
async function init() {
  try {
    const { user } = await api('/api/me');
    currentUser = user;
  } catch {
    currentUser = null;
  }
  // Fetch public config (e.g. whether signup requires an invite code).
  try {
    const config = await api('/api/config');
    inviteRequired = !!config.inviteRequired;
  } catch {
    inviteRequired = false;
  }
  if (currentUser) showApp();
  else showAuth();

  $('#auth-submit-btn').addEventListener('click', submitAuth);
  $('#tab-login').addEventListener('click', () => setAuthMode('login'));
  $('#tab-signup').addEventListener('click', () => setAuthMode('signup'));
  $('#username-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  $('#password-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  $('#user-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUserMenu();
  });
  $('#profile-menu-btn').addEventListener('click', () => {
    closeUserMenu();
    viewProfile(null);
  });
  $('#change-pw-btn').addEventListener('click', () => {
    closeUserMenu();
    openPwModal();
  });
  $('#logout-btn').addEventListener('click', () => {
    closeUserMenu();
    logout();
  });
  $('#pw-cancel').addEventListener('click', closePwModal);
  $('#pw-save').addEventListener('click', savePassword);
  $('#pw-modal').addEventListener('click', (e) => { if (e.target.id === 'pw-modal') closePwModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals(); });
  $('#image-input').addEventListener('change', handleUpload);
  $('#post-btn').addEventListener('click', postPending);

  // Edit profile modal
  $('#edit-profile-cancel').addEventListener('click', closeEditProfileModal);
  $('#edit-profile-save').addEventListener('click', saveEditProfile);
  $('#edit-profile-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-profile-modal') closeEditProfileModal(); });
  $('#bio-input').addEventListener('input', updateBioCount);
  $('#edit-pic-btn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) openCropModal(input.files[0]);
    });
    input.click();
  });
  $('#remove-pic-btn').addEventListener('click', removeProfilePic);

  // Crop modal
  $('#crop-cancel').addEventListener('click', closeCropModal);
  $('#crop-save').addEventListener('click', saveCroppedPic);
  $('#crop-modal').addEventListener('click', (e) => { if (e.target.id === 'crop-modal') closeCropModal(); });

  // Post detail modal
  $('#post-modal-close').addEventListener('click', closePostModal);
  $('#post-modal').addEventListener('click', (e) => { if (e.target.id === 'post-modal') closePostModal(); });

  // Edit description modal
  $('#edit-desc-cancel').addEventListener('click', closeEditDescModal);
  $('#edit-desc-save').addEventListener('click', saveEditDesc);
  $('#edit-desc-modal').addEventListener('click', (e) => { if (e.target.id === 'edit-desc-modal') closeEditDescModal(); });
  $('#edit-desc-input').addEventListener('input', updateEditDescCount);

  setupCropInteractions();
  setupDragDrop();
  setupTabs();
  setupBlurToggle();
  setupLightbox();

  // Close any open reaction pickers when clicking outside them.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.comment-reaction-wrap')) {
      document.querySelectorAll('.reaction-picker:not(.hidden)').forEach((p) => p.classList.add('hidden'));
    }
  });

  // Close the account menu when clicking outside of it.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-area')) closeUserMenu();
  });
}

// Lock body scroll while any modal is open. Derived from the actual hidden
// state of each modal, so stacked modals (e.g. crop on top of edit profile)
// keep the lock until the last one closes.
function updateModalOpenState() {
  const anyOpen = ['pw-modal', 'edit-profile-modal', 'crop-modal', 'post-modal', 'edit-desc-modal', 'lightbox']
    .some((id) => !document.getElementById(id).classList.contains('hidden'));
  document.body.classList.toggle('modal-open', anyOpen);
}

// Close the topmost open layer (Escape key). The lightbox sits above the post
// modal, so when it's open we close only it — a second Escape then closes the
// modal beneath.
function closeAllModals() {
  if (!$('#lightbox').classList.contains('hidden')) { closeLightbox(); return; }
  if (!$('#pw-modal').classList.contains('hidden')) closePwModal();
  if (!$('#edit-profile-modal').classList.contains('hidden')) closeEditProfileModal();
  if (!$('#crop-modal').classList.contains('hidden')) closeCropModal();
  if (!$('#post-modal').classList.contains('hidden')) closePostModal();
  if (!$('#edit-desc-modal').classList.contains('hidden')) closeEditDescModal();
}

init();

// ---------- Service worker (PWA) ----------
// Register the service worker so the app can be installed and used offline.
// Only register over a secure context (https or localhost) — service workers
// are not available on plain http.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
