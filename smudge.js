/**
 * smudge — spatial ATProto comments as oil smudge marks
 *
 * Drop-in ES module. All CSS injected via JS. No build step.
 *
 * Config via data-* attributes on the script tag:
 *   data-page          (required) canonical page URL
 *   data-api           (optional) backend base URL, defaults to origin
 *   data-oauth-client-id (optional) URL to client-metadata.json
 *   data-isso          (optional) Isso instance URL for anonymous fallback
 *   data-isso-uri      (optional) Isso thread URI, defaults to page path
 *   data-lexicon       (optional) ATProto collection NSID, defaults to computer.sims.smudge
 */

const SCRIPT = document.currentScript;
const CONFIG = {
  page:          SCRIPT?.getAttribute('data-page') || window.location.pathname.replace(/^\//, ''),
  api:           SCRIPT?.getAttribute('data-api') || '',
  oauthClientId: SCRIPT?.getAttribute('data-oauth-client-id') || '/smudge/client-metadata.json',
  isso:          SCRIPT?.getAttribute('data-isso') || '',
  issoUri:       SCRIPT?.getAttribute('data-isso-uri') || '',
  lexicon:       SCRIPT?.getAttribute('data-lexicon') || 'computer.sims.smudge',
};

// ── state ──────────────────────────────────────────────────────────────
let oauthClient = null;
let oauthAgent = null;     // authenticated agent (has createRecord, etc.)
let oauthSession = null;   // { did, handle }
let layerVisible = false;
let comments = [];
const profileCache = {};

// ── styles ─────────────────────────────────────────────────────────────
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* ── toggle button ── */
    .smudge-toggle {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 10000;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: rgba(30,30,30,0.8);
      color: #aaa;
      font-size: 20px;
      cursor: pointer;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: background 0.2s, transform 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    }
    .smudge-toggle:hover { background: rgba(50,50,50,0.9); transform: scale(1.08); }
    .smudge-toggle.active { background: rgba(80,60,40,0.9); color: #d4a; }

    /* ── smudge layer ── */
    .smudge-layer {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 9000;
    }
    .smudge-layer.active {
      pointer-events: auto;
    }

    /* ── individual smudge ── */
    .smudge {
      position: absolute;
      width: 34px;
      height: 28px;
      border-radius: 47% 53% 42% 58% / 55% 45% 55% 45%;
      background: rgba(60, 45, 30, 0.45);
      mix-blend-mode: multiply;
      cursor: pointer;
      transition: transform 0.25s ease, opacity 0.25s ease;
      pointer-events: auto;
    }
    .smudge:hover {
      transform: scale(1.4);
      opacity: 1 !important;
      z-index: 9500;
    }
    .smudge.isso-smudge {
      opacity: 0.35;
      background: rgba(80, 70, 60, 0.3);
      width: 26px;
      height: 22px;
    }

    /* ── tooltip ── */
    .smudge-tooltip {
      position: absolute;
      z-index: 9600;
      background: rgba(20, 18, 16, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 14px 16px;
      max-width: 280px;
      min-width: 160px;
      color: #ddd;
      font-family: 'Georgia', serif;
      font-size: 13px;
      line-height: 1.5;
      pointer-events: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      animation: smudge-fade-in 0.2s ease;
    }
    @keyframes smudge-fade-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .smudge-tooltip-author {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 11px;
      color: #999;
    }
    .smudge-tooltip-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      object-fit: cover;
    }
    .smudge-tooltip-handle { color: #aaa; }
    .smudge-tooltip-text {
      word-break: break-word;
      white-space: pre-wrap;
    }
    .smudge-tooltip-time {
      margin-top: 8px;
      font-size: 10px;
      color: #666;
    }
    .smudge-tooltip-anon {
      font-style: italic;
      color: #777;
      font-size: 11px;
      margin-bottom: 6px;
    }

    /* ── compose popup ── */
    .smudge-compose {
      position: absolute;
      z-index: 9700;
      background: rgba(20, 18, 16, 0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      padding: 20px;
      width: 300px;
      color: #ddd;
      font-family: 'Georgia', serif;
      box-shadow: 0 12px 48px rgba(0,0,0,0.7);
      animation: smudge-fade-in 0.2s ease;
    }
    .smudge-compose h3 {
      margin: 0 0 14px;
      font-size: 14px;
      color: #bbb;
      font-weight: normal;
    }
    .smudge-compose textarea {
      width: 100%;
      min-height: 80px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: #ddd;
      font-family: 'Georgia', serif;
      font-size: 13px;
      padding: 10px;
      resize: vertical;
      box-sizing: border-box;
    }
    .smudge-compose textarea:focus {
      outline: none;
      border-color: rgba(255,255,255,0.2);
    }
    .smudge-compose-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    .smudge-btn {
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      font-family: 'Georgia', serif;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .smudge-btn-primary {
      background: rgba(120, 80, 40, 0.7);
      color: #eee;
    }
    .smudge-btn-primary:hover { background: rgba(140, 95, 50, 0.85); }
    .smudge-btn-secondary {
      background: rgba(255,255,255,0.08);
      color: #aaa;
    }
    .smudge-btn-secondary:hover { background: rgba(255,255,255,0.14); }
    .smudge-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* ── auth choice ── */
    .smudge-auth-choice {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 4px;
    }
    .smudge-auth-btn {
      border: none;
      border-radius: 8px;
      padding: 12px 16px;
      font-family: 'Georgia', serif;
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
    }
    .smudge-auth-btn.primary {
      background: rgba(100, 70, 35, 0.7);
      color: #eee;
    }
    .smudge-auth-btn.primary:hover { background: rgba(120, 85, 45, 0.85); }
    .smudge-auth-btn.secondary {
      background: rgba(255,255,255,0.06);
      color: #888;
      font-size: 12px;
    }
    .smudge-auth-btn.secondary:hover { background: rgba(255,255,255,0.1); }

    /* ── nudge ── */
    .smudge-nudge {
      font-size: 13px;
      line-height: 1.6;
      color: #aaa;
      margin-bottom: 14px;
    }
    .smudge-nudge-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    /* ── long-press progress ── */
    .smudge-press-ring {
      position: absolute;
      pointer-events: none;
      z-index: 9650;
      width: 60px;
      height: 60px;
      margin-left: -30px;
      margin-top: -30px;
      border-radius: 50%;
      border: 2px solid transparent;
      box-sizing: border-box;
    }
    .smudge-press-ring.active {
      animation: smudge-ring-fill 3s linear forwards;
    }
    @keyframes smudge-ring-fill {
      0%   { border-color: rgba(80,60,30,0.0); transform: scale(0.5); background: rgba(80,60,30,0.0); }
      20%  { border-color: rgba(80,60,30,0.3); transform: scale(0.7); background: rgba(80,60,30,0.05); }
      80%  { border-color: rgba(120,80,30,0.6); transform: scale(1.0); background: rgba(80,60,30,0.12); }
      100% { border-color: rgba(160,100,40,0.8); transform: scale(1.1); background: rgba(80,60,30,0.2); }
    }

    /* ── sign-in status ── */
    .smudge-status {
      position: fixed;
      bottom: 80px;
      right: 24px;
      z-index: 10001;
      font-family: monospace;
      font-size: 11px;
      color: #777;
      background: rgba(20,18,16,0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      padding: 8px 12px;
      border-radius: 8px;
      max-width: 200px;
      pointer-events: auto;
      cursor: pointer;
      display: none;
    }
    .smudge-status.visible { display: block; }
  `;
  document.head.appendChild(style);
}

// ── DOM setup ──────────────────────────────────────────────────────────
let layer, toggleBtn, statusEl, pressRing;
let activeTooltip = null;
let activeCompose = null;

function createDOM() {
  // Find the content container (the page's main positioned element)
  const container = document.querySelector('.content-container')
    || document.querySelector('[style*="position: relative"]')
    || document.body;

  // Smudge overlay layer
  layer = document.createElement('div');
  layer.className = 'smudge-layer';
  container.appendChild(layer);

  // Toggle button
  toggleBtn = document.createElement('button');
  toggleBtn.className = 'smudge-toggle';
  toggleBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 1 0 20 10 10 0 0 1 0-20" opacity="0.3"/></svg>`;
  toggleBtn.title = 'toggle smudges';
  toggleBtn.addEventListener('click', toggleLayer);
  document.body.appendChild(toggleBtn);

  // Status indicator
  statusEl = document.createElement('div');
  statusEl.className = 'smudge-status';
  statusEl.addEventListener('click', handleSignIn);
  document.body.appendChild(statusEl);

  // Press ring (for long-press animation)
  pressRing = document.createElement('div');
  pressRing.className = 'smudge-press-ring';
  container.appendChild(pressRing);

  // Long-press handling on the layer
  setupLongPress();
}

function toggleLayer() {
  layerVisible = !layerVisible;
  layer.classList.toggle('active', layerVisible);
  toggleBtn.classList.toggle('active', layerVisible);
  if (!layerVisible) {
    closeTooltip();
    closeCompose();
  }
  updateStatus();
}

function updateStatus() {
  if (!layerVisible) {
    statusEl.classList.remove('visible');
    return;
  }
  if (oauthSession) {
    statusEl.textContent = `signed in as @${oauthSession.handle}`;
    statusEl.title = 'click to sign out';
    statusEl.classList.add('visible');
  } else {
    statusEl.textContent = 'tap to sign in with ATProto';
    statusEl.title = 'sign in to leave marks';
    statusEl.classList.add('visible');
  }
}

// ── long-press detection ───────────────────────────────────────────────
let pressTimer = null;
let pressPos = null;
let pressStartTime = 0;

function setupLongPress() {
  layer.addEventListener('pointerdown', onPressStart);
  layer.addEventListener('pointerup', onPressEnd);
  layer.addEventListener('pointercancel', onPressEnd);
  layer.addEventListener('pointermove', onPressMove);

  // Also close tooltip/compose on clicks in empty space
  layer.addEventListener('click', (e) => {
    if (e.target === layer) {
      closeTooltip();
      closeCompose();
    }
  });
}

function onPressStart(e) {
  // Only trigger on the layer background, not on smudges or popups
  if (e.target !== layer) return;

  const rect = layer.getBoundingClientRect();
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  // Position relative to the layer (absolute coords within the container)
  pressPos = {
    x: e.clientX - rect.left + layer.scrollLeft,
    y: e.clientY - rect.top + layer.scrollTop,
    pageX: e.clientX + scrollX,
    pageY: e.clientY + scrollY,
  };

  // Account for container offset
  const container = layer.parentElement;
  if (container) {
    const cRect = container.getBoundingClientRect();
    pressPos.x = e.clientX - cRect.left + scrollX;
    pressPos.y = e.clientY - cRect.top + scrollY;
  }

  pressStartTime = Date.now();

  // Show progress ring
  pressRing.style.left = pressPos.x + 'px';
  pressRing.style.top = pressPos.y + 'px';
  pressRing.classList.remove('active');
  void pressRing.offsetWidth; // reflow
  pressRing.classList.add('active');

  pressTimer = setTimeout(() => {
    // 3 seconds elapsed — open compose
    pressRing.classList.remove('active');
    closeTooltip();
    closeCompose();
    openCompose(pressPos.x, pressPos.y);
    pressTimer = null;
  }, 3000);
}

function onPressEnd() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  pressRing.classList.remove('active');
}

function onPressMove(e) {
  if (!pressTimer || !pressPos) return;
  const dx = e.clientX - (pressPos.pageX - (window.scrollX || window.pageXOffset));
  const dy = e.clientY - (pressPos.pageY - (window.scrollY || window.pageYOffset));
  if (Math.sqrt(dx * dx + dy * dy) > 20) {
    clearTimeout(pressTimer);
    pressTimer = null;
    pressRing.classList.remove('active');
  }
}

// ── tooltip ────────────────────────────────────────────────────────────
function closeTooltip() {
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
}

function showTooltip(comment, smudgeEl) {
  closeTooltip();

  const tip = document.createElement('div');
  tip.className = 'smudge-tooltip';

  const x = parseInt(smudgeEl.style.left) + 40;
  const y = parseInt(smudgeEl.style.top) - 10;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';

  if (comment.source === 'isso') {
    tip.innerHTML = `
      <div class="smudge-tooltip-anon">anonymous</div>
      <div class="smudge-tooltip-text">${escapeHtml(comment.text)}</div>
      <div class="smudge-tooltip-time">${formatTime(comment.createdAt)}</div>
    `;
  } else {
    const profile = profileCache[comment.did] || {};
    const avatarHtml = profile.avatar
      ? `<img class="smudge-tooltip-avatar" src="${escapeHtml(profile.avatar)}" alt="">`
      : '';
    const handle = profile.handle || comment.handle || comment.did?.slice(0, 16) + '...';
    const displayName = profile.displayName || '';

    tip.innerHTML = `
      <div class="smudge-tooltip-author">
        ${avatarHtml}
        <span>
          ${displayName ? `<strong>${escapeHtml(displayName)}</strong> ` : ''}
          <span class="smudge-tooltip-handle">@${escapeHtml(handle)}</span>
        </span>
      </div>
      <div class="smudge-tooltip-text">${escapeHtml(comment.text)}</div>
      <div class="smudge-tooltip-time">${formatTime(comment.createdAt)}</div>
    `;
  }

  layer.appendChild(tip);
  activeTooltip = tip;

  // Adjust if tooltip goes off-screen
  requestAnimationFrame(() => {
    const tipRect = tip.getBoundingClientRect();
    if (tipRect.right > window.innerWidth - 20) {
      tip.style.left = (parseInt(smudgeEl.style.left) - tip.offsetWidth - 10) + 'px';
    }
  });
}

// ── compose ────────────────────────────────────────────────────────────
function closeCompose() {
  if (activeCompose) {
    activeCompose.remove();
    activeCompose = null;
  }
}

function openCompose(x, y) {
  closeCompose();

  const popup = document.createElement('div');
  popup.className = 'smudge-compose';
  popup.style.left = x + 'px';
  popup.style.top = y + 'px';

  // Decide what to show based on auth state
  if (oauthSession) {
    showComposeForm(popup, x, y, 'atproto');
  } else {
    showAuthChoice(popup, x, y);
  }

  layer.appendChild(popup);
  activeCompose = popup;

  // Adjust position if off-screen
  requestAnimationFrame(() => {
    const r = popup.getBoundingClientRect();
    if (r.right > window.innerWidth - 20) {
      popup.style.left = (x - popup.offsetWidth - 10) + 'px';
    }
    if (r.bottom > window.innerHeight - 20) {
      popup.style.top = (y - popup.offsetHeight) + 'px';
    }
  });
}

function showAuthChoice(popup, x, y) {
  const hasIsso = !!CONFIG.isso;

  popup.innerHTML = `
    <h3>leave a mark</h3>
    <div class="smudge-auth-choice">
      <button class="smudge-auth-btn primary" data-action="signin">sign in with atmosphere</button>
      ${hasIsso ? '<button class="smudge-auth-btn secondary" data-action="anon">leave anonymous mark</button>' : ''}
    </div>
    <div class="smudge-compose-actions">
      <button class="smudge-btn smudge-btn-secondary" data-action="cancel">cancel</button>
    </div>
  `;

  popup.querySelector('[data-action="signin"]').addEventListener('click', () => {
    handleSignIn();
    closeCompose();
  });

  if (hasIsso) {
    popup.querySelector('[data-action="anon"]').addEventListener('click', () => {
      showNudge(popup, x, y);
    });
  }

  popup.querySelector('[data-action="cancel"]').addEventListener('click', closeCompose);
}

function showNudge(popup, x, y) {
  popup.innerHTML = `
    <div class="smudge-nudge">
      with an atmosphere account, your words are yours to keep forever — stored in your own data vault, not mine. and you give me nothing. still want to go anonymous?
    </div>
    <div class="smudge-nudge-actions">
      <button class="smudge-btn smudge-btn-primary" data-action="signup">ok, sign me up</button>
      <button class="smudge-btn smudge-btn-secondary" data-action="stay-anon">stay anonymous</button>
    </div>
  `;

  popup.querySelector('[data-action="signup"]').addEventListener('click', () => {
    window.open('https://bsky.app/', '_blank');
    closeCompose();
  });

  popup.querySelector('[data-action="stay-anon"]').addEventListener('click', () => {
    showComposeForm(popup, x, y, 'isso');
  });
}

function showComposeForm(popup, x, y, mode) {
  const label = mode === 'atproto'
    ? `leaving mark as @${oauthSession?.handle || '...'}`
    : 'anonymous mark';

  popup.innerHTML = `
    <h3>${escapeHtml(label)}</h3>
    <textarea placeholder="leave your mark..." maxlength="3000" autofocus></textarea>
    <div class="smudge-compose-actions">
      <button class="smudge-btn smudge-btn-secondary" data-action="cancel">cancel</button>
      <button class="smudge-btn smudge-btn-primary" data-action="submit">leave mark</button>
    </div>
  `;

  const textarea = popup.querySelector('textarea');
  const submitBtn = popup.querySelector('[data-action="submit"]');

  requestAnimationFrame(() => textarea.focus());

  popup.querySelector('[data-action="cancel"]').addEventListener('click', closeCompose);
  submitBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'leaving mark...';

    try {
      if (mode === 'atproto') {
        await submitAtprotoComment(text, x, y);
      } else {
        await submitIssoComment(text, x, y);
      }
      closeCompose();
      await loadComments(); // refresh
    } catch (err) {
      console.error('[smudge] submit error:', err);
      submitBtn.textContent = 'error — try again';
      submitBtn.disabled = false;
    }
  });
}

// ── ATProto comment submission ─────────────────────────────────────────
async function submitAtprotoComment(text, posX, posY) {
  if (!oauthAgent) throw new Error('not signed in');

  const now = new Date().toISOString();
  // ATProto record gets the full URL for portability
  const fullPageUrl = `${window.location.origin}/${CONFIG.page}`;
  const record = {
    $type: CONFIG.lexicon,
    text,
    pageUrl: fullPageUrl,
    positionX: Math.round(posX),
    positionY: Math.round(posY),
    createdAt: now,
  };

  // Write to user's PDS
  const res = await oauthAgent.com.atproto.repo.createRecord({
    repo: oauthSession.did,
    collection: CONFIG.lexicon,
    record,
  });

  // Extract rkey from the URI
  const rkey = res.data.uri.split('/').pop();

  // Index on our backend
  await fetch(`${CONFIG.api}/api/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      did: oauthSession.did,
      rkey,
      page: CONFIG.page,
      text,
      positionX: Math.round(posX),
      positionY: Math.round(posY),
      createdAt: now,
      handle: oauthSession.handle,
    }),
  });
}

// ── Isso comment submission ────────────────────────────────────────────
async function submitIssoComment(text, posX, posY) {
  const issoUri = CONFIG.issoUri || `/${CONFIG.page}`;

  await fetch(`${CONFIG.isso}/api/new?uri=${encodeURIComponent(issoUri)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      website: `pos:${Math.round(posX)},${Math.round(posY)}`,
    }),
  });
}

// ── OAuth sign-in ──────────────────────────────────────────────────────
async function initOAuth() {
  try {
    const { BrowserOAuthClient } = await import('https://esm.sh/@atproto/oauth-client-browser@0.3.20');

    const clientMetadataUrl = CONFIG.oauthClientId.startsWith('http')
      ? CONFIG.oauthClientId
      : window.location.origin + CONFIG.oauthClientId;

    oauthClient = new BrowserOAuthClient({
      clientMetadata: clientMetadataUrl,
      handleResolver: 'https://bsky.social',
    });

    // Check for existing session (from previous sign-in or callback)
    const result = await oauthClient.init();
    if (result?.session) {
      setSession(result.session);
    }
  } catch (err) {
    console.warn('[smudge] OAuth init (non-critical):', err.message);
  }
}

function setSession(session) {
  oauthAgent = session;
  oauthSession = {
    did: session.did,
    handle: session.handle || session.did,
  };
  updateStatus();
}

async function handleSignIn() {
  if (oauthSession) {
    // Already signed in — sign out
    oauthAgent = null;
    oauthSession = null;
    updateStatus();
    return;
  }

  try {
    if (!oauthClient) {
      await initOAuth();
    }
    if (!oauthClient) {
      console.error('[smudge] OAuth client not available');
      return;
    }

    // Store return URL for callback
    sessionStorage.setItem('smudge_return_to', window.location.href);

    // Start sign-in (will redirect to PDS authorization server)
    const handle = prompt('enter your handle (e.g. alice.bsky.social):');
    if (!handle) return;

    await oauthClient.signIn(handle);
    // Browser will redirect to PDS, then back to callback.html
  } catch (err) {
    console.error('[smudge] sign-in error:', err);
  }
}

// ── loading comments ───────────────────────────────────────────────────
async function loadComments() {
  try {
    const url = `${CONFIG.api}/api/comments?page=${encodeURIComponent(CONFIG.page)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    comments = await res.json();

    // Resolve ATProto profiles
    const dids = [...new Set(comments.filter(c => c.source === 'atproto' && c.did).map(c => c.did))];
    if (dids.length > 0) {
      await resolveProfiles(dids);
    }

    renderSmudges();
  } catch (err) {
    console.warn('[smudge] failed to load comments:', err.message);
  }
}

async function resolveProfiles(dids) {
  // Filter out already cached
  const uncached = dids.filter(d => !profileCache[d]);
  if (uncached.length === 0) return;

  // Batch in groups of 25 (API limit)
  for (let i = 0; i < uncached.length; i += 25) {
    const batch = uncached.slice(i, i + 25);
    const params = batch.map(d => `actors=${encodeURIComponent(d)}`).join('&');
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${params}`);
      if (res.ok) {
        const data = await res.json();
        for (const profile of data.profiles || []) {
          profileCache[profile.did] = {
            handle: profile.handle,
            displayName: profile.displayName || '',
            avatar: profile.avatar || '',
          };
        }
      }
    } catch (err) {
      console.warn('[smudge] profile resolution failed:', err.message);
    }
  }
}

// ── rendering ──────────────────────────────────────────────────────────
function renderSmudges() {
  // Clear existing smudges (but keep tooltip, compose, pressRing)
  layer.querySelectorAll('.smudge').forEach(el => el.remove());

  for (const comment of comments) {
    const smudge = document.createElement('div');
    smudge.className = 'smudge' + (comment.source === 'isso' ? ' isso-smudge' : '');

    // Position
    smudge.style.left = (comment.positionX || 0) + 'px';
    smudge.style.top = (comment.positionY || 0) + 'px';

    // Randomize shape slightly for organic feel
    const seed = hashStr(comment.text + (comment.did || '') + comment.createdAt);
    const r1 = 40 + (seed % 20);
    const r2 = 100 - r1;
    const r3 = 35 + ((seed >> 4) % 25);
    const r4 = 100 - r3;
    const r5 = 45 + ((seed >> 8) % 20);
    const r6 = 100 - r5;
    const r7 = 40 + ((seed >> 12) % 20);
    const r8 = 100 - r7;
    smudge.style.borderRadius = `${r1}% ${r2}% ${r3}% ${r4}% / ${r5}% ${r6}% ${r7}% ${r8}%`;

    const rotation = ((seed >> 16) % 60) - 30;
    const scale = 0.85 + ((seed >> 20) % 30) / 100;
    smudge.style.transform = `rotate(${rotation}deg) scale(${scale})`;

    // Slight opacity variation
    if (comment.source !== 'isso') {
      smudge.style.opacity = 0.4 + ((seed >> 24) % 20) / 100;
    }

    smudge.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCompose();
      showTooltip(comment, smudge);
    });

    layer.appendChild(smudge);
  }
}

// ── utilities ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatTime(ts) {
  try {
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 2592000000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ── init ───────────────────────────────────────────────────────────────
async function init() {
  injectStyles();
  createDOM();

  // Try to restore OAuth session (non-blocking)
  initOAuth();

  // Load existing comments
  await loadComments();
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
