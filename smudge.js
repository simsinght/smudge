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

const SCRIPT = document.currentScript || document.querySelector('script[src*="smudge"]');
const CONFIG = {
  page:          SCRIPT?.getAttribute('data-page') || window.location.pathname.replace(/^\//, ''),
  api:           SCRIPT?.getAttribute('data-api') || '',
  oauthClientId: SCRIPT?.getAttribute('data-oauth-client-id') || '/smudge/client-metadata.json',
  isso:          SCRIPT?.getAttribute('data-isso') || '',
  issoUri:       SCRIPT?.getAttribute('data-isso-uri') || '',
  lexicon:       SCRIPT?.getAttribute('data-lexicon') || 'computer.sims.smudge',
};

console.log('[smudge] SCRIPT element:', SCRIPT);
console.log('[smudge] CONFIG:', CONFIG);

// ── state ──────────────────────────────────────────────────────────────
let oauthClient = null;
let oauthAgent = null;     // Agent instance (has .com.atproto.repo.createRecord, etc.)
let oauthSession = null;   // { did, handle }
let AgentClass = null;     // stored from dynamic import
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
      bottom: clamp(16px, 1.8vw, 32px);
      right: clamp(16px, 1.8vw, 32px);
      z-index: 10000;
      width: clamp(48px, 3.5vw, 120px);
      height: clamp(48px, 3.5vw, 120px);
      border-radius: 50%;
      border: none;
      background: rgba(30,30,30,0.8);
      color: #aaa;
      font-size: clamp(20px, 1.5vw, 48px);
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
      background: rgba(0,0,0,0.001); /* needed for hit-testing on transparent layers */
    }

    /* ── fixed UI overlay — immune to page zoom ── */
    .smudge-ui-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 10000;
    }
    .smudge-ui-overlay > * {
      pointer-events: auto;
    }

    /* ── individual smudge ── */
    .smudge {
      position: absolute;
      cursor: pointer;
      pointer-events: auto;
      transition: filter 0.4s ease, transform 0.5s ease;
    }
    .smudge:hover {
      filter: brightness(1.3);
      z-index: 9500;
    }
    .smudge svg {
      display: block;
    }
    .smudge .smudge-shimmer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: 50%;
      filter: blur(12px);
      mix-blend-mode: screen;
      opacity: 0.5;
      transition: opacity 0.5s ease;
    }
    .smudge:hover .smudge-shimmer {
      opacity: 0.85;
    }
    .smudge.isso-smudge {
      opacity: 0.4;
      filter: saturate(0.4) brightness(0.7);
    }

    /* ── tooltip ── */
    .smudge-tooltip {
      position: fixed;
      z-index: 10001;
      background: rgba(20, 18, 16, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: clamp(10px, 0.9vw, 20px);
      padding: clamp(12px, 1vw, 24px) clamp(14px, 1.2vw, 28px);
      max-width: clamp(240px, 20vw, 480px);
      min-width: clamp(140px, 12vw, 280px);
      color: #ddd;
      font-family: 'Georgia', serif;
      font-size: clamp(13px, 1vw, 24px);
      line-height: 1.5;
      pointer-events: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      animation: smudge-fade-in 0.2s ease;
    }
    @keyframes smudge-fade-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .smudge-tooltip-meta {
      display: flex;
      align-items: center;
      gap: clamp(5px, 0.5vw, 10px);
      margin-bottom: clamp(4px, 0.4vw, 10px);
      font-size: clamp(10px, 0.75vw, 18px);
      color: #888;
    }
    .smudge-tooltip-avatar {
      width: clamp(18px, 1.4vw, 36px);
      height: clamp(18px, 1.4vw, 36px);
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }
    .smudge-tooltip-handle { color: #aaa; }
    .smudge-tooltip-sep { color: #555; }
    .smudge-tooltip-time { color: #666; }
    .smudge-tooltip-text {
      word-break: break-word;
      white-space: pre-wrap;
    }
    .smudge-tooltip-anon {
      font-style: italic;
      color: #777;
      font-size: clamp(10px, 0.75vw, 18px);
    }
    .smudge-tooltip-footer {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      margin-top: clamp(4px, 0.4vw, 10px);
    }
    .smudge-btn-delete {
      background: none;
      border: none;
      color: #866;
      font-family: 'Georgia', serif;
      font-size: clamp(10px, 0.75vw, 18px);
      cursor: pointer;
      padding: clamp(2px, 0.2vw, 6px) clamp(6px, 0.5vw, 12px);
      border-radius: clamp(4px, 0.4vw, 8px);
      transition: background 0.15s, color 0.15s;
    }
    .smudge-btn-delete:hover {
      background: rgba(180, 80, 80, 0.2);
      color: #c88;
    }
    .smudge-btn-delete:disabled { opacity: 0.5; cursor: default; }

    /* ── sign-in popup ── */
    .smudge-signin {
      position: fixed;
      z-index: 10002;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(20, 18, 16, 0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: clamp(12px, 1vw, 22px);
      padding: clamp(20px, 1.8vw, 40px);
      width: clamp(280px, 22vw, 460px);
      color: #ddd;
      font-family: 'Georgia', serif;
      box-shadow: 0 12px 48px rgba(0,0,0,0.7);
      animation: smudge-fade-in 0.2s ease;
    }
    .smudge-signin h3 {
      margin: 0 0 clamp(12px, 1vw, 22px);
      font-size: clamp(15px, 1.2vw, 26px);
      color: #ccc;
      font-weight: normal;
    }
    .smudge-signin input[type="text"] {
      width: 100%;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: clamp(6px, 0.6vw, 14px);
      color: #ddd;
      font-family: 'Georgia', serif;
      font-size: clamp(14px, 1.1vw, 24px);
      padding: clamp(10px, 0.9vw, 20px);
      box-sizing: border-box;
    }
    .smudge-signin input[type="text"]:focus {
      outline: none;
      border-color: rgba(255,255,255,0.25);
    }
    .smudge-signin input[type="text"]::placeholder { color: #666; }
    .smudge-signin-hint {
      margin-top: clamp(10px, 0.9vw, 20px);
      font-size: clamp(12px, 0.9vw, 20px);
      color: #888;
      line-height: 1.5;
    }
    .smudge-signin-hint a {
      color: #b89860;
      text-decoration: none;
    }
    .smudge-signin-hint a:hover { text-decoration: underline; }
    .smudge-signin-actions {
      display: flex;
      justify-content: flex-end;
      gap: clamp(6px, 0.6vw, 14px);
      margin-top: clamp(14px, 1.2vw, 26px);
    }

    /* ── compose popup ── */
    .smudge-compose {
      position: fixed;
      z-index: 10002;
      background: rgba(20, 18, 16, 0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: clamp(12px, 1vw, 22px);
      padding: clamp(16px, 1.5vw, 36px);
      width: clamp(280px, 22vw, 500px);
      color: #ddd;
      font-family: 'Georgia', serif;
      box-shadow: 0 12px 48px rgba(0,0,0,0.7);
      animation: smudge-fade-in 0.2s ease;
    }
    .smudge-compose h3 {
      margin: 0 0 clamp(10px, 1vw, 22px);
      font-size: clamp(14px, 1.1vw, 24px);
      color: #bbb;
      font-weight: normal;
    }
    .smudge-compose textarea {
      width: 100%;
      min-height: clamp(70px, 6vw, 140px);
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: clamp(6px, 0.6vw, 14px);
      color: #ddd;
      font-family: 'Georgia', serif;
      font-size: clamp(13px, 1vw, 24px);
      padding: clamp(8px, 0.75vw, 18px);
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
      gap: clamp(6px, 0.6vw, 14px);
      margin-top: clamp(10px, 0.9vw, 20px);
    }
    .smudge-btn {
      border: none;
      border-radius: clamp(6px, 0.6vw, 14px);
      padding: clamp(7px, 0.6vw, 16px) clamp(14px, 1.2vw, 30px);
      font-family: 'Georgia', serif;
      font-size: clamp(12px, 0.9vw, 22px);
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
      gap: clamp(8px, 0.75vw, 18px);
      margin-bottom: 4px;
    }
    .smudge-auth-btn {
      border: none;
      border-radius: clamp(6px, 0.6vw, 14px);
      padding: clamp(10px, 0.9vw, 22px) clamp(14px, 1.2vw, 28px);
      font-family: 'Georgia', serif;
      font-size: clamp(13px, 1vw, 24px);
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
      font-size: clamp(12px, 0.9vw, 22px);
    }
    .smudge-auth-btn.secondary:hover { background: rgba(255,255,255,0.1); }

    /* ── nudge ── */
    .smudge-nudge {
      font-size: clamp(13px, 1vw, 24px);
      line-height: 1.6;
      color: #aaa;
      margin-bottom: clamp(10px, 1vw, 22px);
    }
    .smudge-nudge-actions {
      display: flex;
      gap: clamp(6px, 0.6vw, 14px);
      flex-wrap: wrap;
    }

    /* ── long-press progress ── */
    .smudge-press-indicator {
      position: fixed;
      pointer-events: none;
      z-index: 9650;
      width: clamp(48px, 3.5vw, 120px);
      height: clamp(48px, 3.5vw, 120px);
      margin-left: 0;
      margin-top: 0;
      display: none;
    }
    .smudge-press-indicator.active {
      display: block;
    }
    .smudge-press-indicator svg {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.4));
    }
    .smudge-press-indicator .ring {
      fill: none;
      stroke: rgba(180,130,60,0.8);
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: 132;
      stroke-dashoffset: 132;
      transform-origin: center;
      transform: rotate(-90deg);
    }
    .smudge-press-indicator.active .ring {
      animation: smudge-ring-draw var(--smudge-hold-time, 1s) linear forwards;
    }
    .smudge-press-indicator .bubble {
      fill: rgba(200,170,120,0.9);
      stroke: rgba(240,210,150,0.8);
      stroke-width: 1.5;
    }
    .smudge-press-indicator .bubble-icon {
      fill: rgba(50,35,20,0.9);
      font-size: 14px;
    }
    @keyframes smudge-ring-draw {
      0%   { stroke-dashoffset: 132; }
      100% { stroke-dashoffset: 0; }
    }

    /* ── sign-in status ── */
    .smudge-status {
      position: fixed;
      bottom: clamp(72px, 6vw, 160px);
      right: clamp(16px, 1.8vw, 32px);
      z-index: 10001;
      font-family: monospace;
      font-size: clamp(11px, 0.85vw, 20px);
      color: #777;
      background: rgba(20,18,16,0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      padding: clamp(6px, 0.6vw, 14px) clamp(10px, 0.9vw, 20px);
      border-radius: clamp(6px, 0.6vw, 14px);
      max-width: clamp(180px, 15vw, 360px);
      pointer-events: auto;
      cursor: pointer;
      display: none;
    }
    .smudge-status.visible { display: block; }
  `;
  document.head.appendChild(style);
}

// ── DOM setup ──────────────────────────────────────────────────────────
let layer, uiOverlay, toggleBtn, statusEl, pressRing;
let activeTooltip = null;
let activeCompose = null;
let lastClientX = 0, lastClientY = 0; // track viewport coords for UI positioning

function createDOM() {
  // Find the content container (the page's main positioned element)
  const container = document.querySelector('.content-container')
    || document.querySelector('[style*="position: relative"]')
    || document.body;

  // Smudge overlay layer — lives in the content container for dot positioning
  layer = document.createElement('div');
  layer.className = 'smudge-layer';
  container.appendChild(layer);

  // Fixed UI overlay — on documentElement to avoid containing block issues
  // (transforms/filters on body or ancestors break position:fixed)
  uiOverlay = document.createElement('div');
  uiOverlay.className = 'smudge-ui-overlay';
  document.documentElement.appendChild(uiOverlay);

  // Toggle button
  toggleBtn = document.createElement('button');
  toggleBtn.className = 'smudge-toggle';
  toggleBtn.innerHTML = `<svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4,4 h16 a2,2 0 0 1 2,2 v10 a2,2 0 0 1 -2,2 h-8 l-4,4 v-4 h-4 a2,2 0 0 1 -2,-2 v-10 a2,2 0 0 1 2,-2z"/><line x1="8" y1="9.5" x2="8" y2="9.5" stroke-width="3" stroke-linecap="round"/><line x1="12" y1="9.5" x2="12" y2="9.5" stroke-width="3" stroke-linecap="round"/><line x1="16" y1="9.5" x2="16" y2="9.5" stroke-width="3" stroke-linecap="round"/></svg>`;
  toggleBtn.title = 'toggle smudges';
  toggleBtn.addEventListener('click', toggleLayer);
  uiOverlay.appendChild(toggleBtn);

  // Status indicator
  statusEl = document.createElement('div');
  statusEl.className = 'smudge-status';
  statusEl.addEventListener('click', handleSignIn);
  uiOverlay.appendChild(statusEl);

  // Press indicator (chat bubble with completing ring)
  pressRing = document.createElement('div');
  pressRing.className = 'smudge-press-indicator';
  pressRing.innerHTML = `<svg viewBox="0 0 48 48">
    <circle class="ring" cx="24" cy="24" r="21"/>
    <path class="bubble" d="M16,14 h16 a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h-8 l-4,4 v-4 h-4 a4,4 0 0 1 -4,-4 v-10 a4,4 0 0 1 4,-4z"/>
    <text class="bubble-icon" x="24" y="27" text-anchor="middle" font-size="12">...</text>
  </svg>`;
  uiOverlay.appendChild(pressRing);

  // Long-press handling on the layer
  setupLongPress();
}

function toggleLayer() {
  layerVisible = !layerVisible;
  console.log('[smudge] toggleLayer, visible:', layerVisible, 'layer classes:', layer.className);
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
  console.log('[smudge] setupLongPress, layer:', layer, 'parent:', layer.parentElement);
  layer.addEventListener('pointerdown', onPressStart);
  layer.addEventListener('pointerup', onPressEnd);
  layer.addEventListener('pointercancel', onPressEnd);
  layer.addEventListener('pointermove', onPressMove);

  // Close tooltip/compose on clicks in empty space, but not right after a long-press
  layer.addEventListener('click', (e) => {
    if (e.target === layer && !activeCompose) {
      closeTooltip();
    }
  });

  // Dismiss tooltip when clicking anywhere outside it
  document.addEventListener('click', (e) => {
    if (activeTooltip && !activeTooltip.contains(e.target) && !e.target.classList.contains('smudge')) {
      closeTooltip();
    }
  });
}

function onPressStart(e) {
  console.log('[smudge] pointerdown, target:', e.target, 'isLayer:', e.target === layer, 'layerVisible:', layerVisible);
  // Only trigger on the layer background, not on smudges or popups
  if (e.target !== layer) return;
  console.log('[smudge] long-press started, will fire in 3s');

  // Container-relative coords for storing the smudge position
  const container = layer.parentElement;
  const cRect = container ? container.getBoundingClientRect() : layer.getBoundingClientRect();
  pressPos = {
    x: e.clientX - cRect.left,
    y: e.clientY - cRect.top,
  };
  // Viewport coords for UI positioning
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  console.log('[smudge] press container pos:', pressPos.x, pressPos.y, 'viewport:', lastClientX, lastClientY);

  pressStartTime = Date.now();

  // Show progress indicator offset to upper-right of press point
  pressRing.style.left = (e.clientX + 20) + 'px';
  pressRing.style.top = (e.clientY - 60) + 'px';
  pressRing.classList.remove('active');
  void pressRing.offsetWidth; // reflow
  pressRing.classList.add('active');

  pressTimer = setTimeout(() => {
    // long-press elapsed — open compose
    console.log('[smudge] long-press complete, opening compose at', pressPos.x, pressPos.y);
    pressRing.classList.remove('active');
    closeTooltip();
    closeCompose();
    openCompose(pressPos.x, pressPos.y);
    pressTimer = null;
  }, 1000); // TODO: restore to 3000
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
  const dx = e.clientX - lastClientX;
  const dy = e.clientY - lastClientY;
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

  // Measure off-screen first to get dimensions
  tip.style.visibility = 'hidden';
  tip.style.position = 'fixed';
  tip.style.left = '0';
  tip.style.top = '0';

  const isOwn = oauthSession && comment.source === 'atproto' && comment.did === oauthSession.did;
  const deleteHtml = isOwn
    ? `<button class="smudge-btn smudge-btn-delete" data-action="delete">remove</button>`
    : '';

  if (comment.source === 'isso') {
    tip.innerHTML = `
      <div class="smudge-tooltip-meta">
        <span class="smudge-tooltip-anon">anonymous</span>
        <span class="smudge-tooltip-sep">&middot;</span>
        <span class="smudge-tooltip-time">${formatTime(comment.createdAt)}</span>
      </div>
      <div class="smudge-tooltip-text">${escapeHtml(comment.text)}</div>
    `;
  } else {
    const profile = profileCache[comment.did] || {};
    const avatarHtml = profile.avatar
      ? `<img class="smudge-tooltip-avatar" src="${escapeHtml(profile.avatar)}" alt="">`
      : '';
    const handle = profile.handle || comment.handle || comment.did?.slice(0, 16) + '...';
    const displayName = profile.displayName || '';
    const nameHtml = displayName
      ? `<strong>${escapeHtml(displayName)}</strong>`
      : `<span class="smudge-tooltip-handle">@${escapeHtml(handle)}</span>`;

    tip.innerHTML = `
      <div class="smudge-tooltip-meta">
        ${avatarHtml}
        ${nameHtml}
        <span class="smudge-tooltip-sep">&middot;</span>
        <span class="smudge-tooltip-time">${formatTime(comment.createdAt)}</span>
      </div>
      <div class="smudge-tooltip-text">${escapeHtml(comment.text)}</div>
      ${deleteHtml ? `<div class="smudge-tooltip-footer">${deleteHtml}</div>` : ''}
    `;
  }

  if (isOwn) {
    tip.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.textContent = 'removing...';
      btn.disabled = true;
      try {
        await deleteSmudge(comment);
        closeTooltip();
        smudgeEl.remove();
      } catch (err) {
        console.error('[smudge] delete error:', err);
        btn.textContent = 'error';
      }
    });
  }

  // Append hidden to measure, then position in one step
  uiOverlay.appendChild(tip);
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const smudgeRect = smudgeEl.getBoundingClientRect();
  const pad = 10;

  let x = smudgeRect.left + smudgeRect.width / 2 - tipW / 2;
  let y = smudgeRect.top - 8 - tipH;

  // Clamp horizontally
  if (x < pad) x = pad;
  if (x + tipW > window.innerWidth - pad) x = window.innerWidth - pad - tipW;

  // Flip below if no room above
  if (y < pad) y = smudgeRect.bottom + 8;

  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
  tip.style.transform = 'none';
  tip.style.visibility = 'visible';
  activeTooltip = tip;
}

// ── compose ────────────────────────────────────────────────────────────
function closeCompose() {
  if (activeCompose) {
    activeCompose.remove();
    activeCompose = null;
  }
}

function openCompose(containerX, containerY) {
  closeCompose();

  const popup = document.createElement('div');
  popup.className = 'smudge-compose';
  // Position using stored viewport coords
  popup.style.left = lastClientX + 'px';
  popup.style.top = (lastClientY + 10) + 'px';

  // Decide what to show based on auth state
  if (oauthSession) {
    showComposeForm(popup, containerX, containerY, 'atproto');
  } else {
    showAuthChoice(popup, containerX, containerY);
  }

  uiOverlay.appendChild(popup);
  activeCompose = popup;

  // Adjust position if off-screen
  requestAnimationFrame(() => {
    const r = popup.getBoundingClientRect();
    if (r.right > window.innerWidth - 20) {
      popup.style.left = Math.max(10, window.innerWidth - r.width - 20) + 'px';
    }
    if (r.bottom > window.innerHeight - 20) {
      popup.style.top = Math.max(10, window.innerHeight - r.height - 20) + 'px';
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
    closeCompose();
    handleSignIn();
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
  console.log('[smudge] oauthAgent:', oauthAgent, 'has .com?', !!oauthAgent?.com, 'AgentClass?', !!AgentClass);
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
  let res;
  try {
    res = await oauthAgent.com.atproto.repo.createRecord({
      repo: oauthSession.did,
      collection: CONFIG.lexicon,
      record,
    });
  } catch (err) {
    console.error('[smudge] createRecord error:', err);
    if (err.status) console.error('[smudge] status:', err.status, 'body:', err.error, err.message);
    throw err;
  }
  console.log('[smudge] createRecord success:', res.data);

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

// ── delete smudge ─────────────────────────────────────────────────────
async function deleteSmudge(comment) {
  // Delete from user's PDS
  if (oauthAgent && comment.did === oauthSession?.did && comment.rkey) {
    try {
      await oauthAgent.com.atproto.repo.deleteRecord({
        repo: comment.did,
        collection: CONFIG.lexicon,
        rkey: comment.rkey,
      });
      console.log('[smudge] deleted from PDS:', comment.rkey);
    } catch (err) {
      console.error('[smudge] PDS delete error:', err);
    }
  }

  // Remove from backend index
  await fetch(`${CONFIG.api}/api/index`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      did: comment.did,
      rkey: comment.rkey,
      page: CONFIG.page,
    }),
  });

  // Remove from local state
  comments = comments.filter(c => !(c.did === comment.did && c.rkey === comment.rkey));
}

// ── Isso comment submission ────────────────────────────────────────────
async function submitIssoComment(text, posX, posY) {
  const issoUri = CONFIG.issoUri || `/${CONFIG.page}`;

  const issoRes = await fetch(`${CONFIG.isso}/new?uri=${encodeURIComponent(issoUri)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      author: '',
      email: '',
      website: `https://smudge.pos/${Math.round(posX)}/${Math.round(posY)}`,
      parent: null,
    }),
  });
  if (!issoRes.ok) {
    const body = await issoRes.text();
    console.error('[smudge] isso error:', issoRes.status, body);
    throw new Error(`Isso ${issoRes.status}: ${body}`);
  }
}

// ── OAuth sign-in ──────────────────────────────────────────────────────
async function initOAuth() {
  try {
    const { BrowserOAuthClient, Agent } = await import('./oauth-client-browser.js');
    AgentClass = Agent;

    const clientMetadataUrl = CONFIG.oauthClientId.startsWith('http')
      ? CONFIG.oauthClientId
      : window.location.origin + CONFIG.oauthClientId;

    const clientMetadata = await fetch(clientMetadataUrl).then(r => r.json());

    oauthClient = new BrowserOAuthClient({
      clientMetadata,
      handleResolver: 'https://bsky.social',
    });

    // Check for existing session (from previous sign-in or callback)
    const result = await oauthClient.init();
    if (result?.session) {
      await setSession(result.session);
    }
  } catch (err) {
    console.warn('[smudge] OAuth init (non-critical):', err.message);
  }
}

async function setSession(session) {
  oauthAgent = AgentClass ? new AgentClass(session) : session;
  oauthSession = {
    did: session.did,
    handle: session.handle || null,
  };

  // Resolve handle from public API if not on the session
  if (!oauthSession.handle || oauthSession.handle.startsWith('did:')) {
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(session.did)}`);
      if (res.ok) {
        const profile = await res.json();
        oauthSession.handle = profile.handle;
        profileCache[session.did] = {
          handle: profile.handle,
          displayName: profile.displayName || '',
          avatar: profile.avatar || '',
        };
      }
    } catch (err) {
      console.warn('[smudge] could not resolve handle:', err.message);
    }
    oauthSession.handle = oauthSession.handle || session.did;
  }

  updateStatus();
}

async function handleSignIn() {
  if (oauthSession) {
    // Already signed in — sign out and clear stored credentials
    const did = oauthSession.did;
    oauthAgent = null;
    oauthSession = null;
    if (oauthClient) {
      try { await oauthClient.revoke(did); } catch (e) {
        console.warn('[smudge] revoke failed, clearing storage:', e.message);
      }
    }
    // Belt-and-suspenders: clear IndexedDB stores the OAuth client uses
    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name && db.name.includes('atproto')) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    } catch (e) { /* ignore */ }
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

    // Show sign-in popup
    showSignInPopup();
  } catch (err) {
    console.error('[smudge] sign-in error:', err);
  }
}

let activeSignIn = null;

function closeSignIn() {
  if (activeSignIn) {
    activeSignIn.remove();
    activeSignIn = null;
  }
}

function showSignInPopup() {
  closeSignIn();
  closeCompose();
  closeTooltip();

  const popup = document.createElement('div');
  popup.className = 'smudge-signin';
  popup.innerHTML = `
    <h3>sign in with atmosphere</h3>
    <input type="text" placeholder="yourname.bsky.social" spellcheck="false" autocapitalize="off" autocomplete="off">
    <div class="smudge-signin-hint">
      don't have an account? <a href="#" data-action="signup">create one</a>
    </div>
    <div class="smudge-signin-actions">
      <button class="smudge-btn smudge-btn-secondary" data-action="cancel">cancel</button>
      <button class="smudge-btn smudge-btn-primary" data-action="signin">sign in</button>
    </div>
  `;

  const input = popup.querySelector('input');
  const signinBtn = popup.querySelector('[data-action="signin"]');

  async function doSignIn() {
    const handle = input.value.trim();
    if (!handle) return;
    signinBtn.disabled = true;
    signinBtn.textContent = 'connecting...';
    try {
      sessionStorage.setItem('smudge_return_to', window.location.href);
      await oauthClient.signIn(handle);
    } catch (err) {
      console.error('[smudge] sign-in error:', err);
      signinBtn.textContent = 'error — try again';
      signinBtn.disabled = false;
    }
  }

  signinBtn.addEventListener('click', doSignIn);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSignIn();
  });
  popup.querySelector('[data-action="signup"]').addEventListener('click', (e) => {
    e.preventDefault();
    input.value = 'bsky.social';
    doSignIn();
  });
  popup.querySelector('[data-action="cancel"]').addEventListener('click', closeSignIn);

  uiOverlay.appendChild(popup);
  activeSignIn = popup;
  requestAnimationFrame(() => input.focus());
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

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

let smudgeCounter = 0;

function createSmudgeSVG(seed, w, h, rotation) {
  const rand = seededRandom(seed);
  const uid = 's' + (smudgeCounter++);

  const turbBase = 0.012 + rand() * 0.015;
  const turbFreq = `${turbBase.toFixed(4)} ${(turbBase * 0.7 + rand() * 0.008).toFixed(4)}`;
  const turbSeed = Math.floor(rand() * 9999);
  const octaves = 3 + Math.floor(rand() * 3);
  const dispScale = 60 + rand() * 80;
  const hue = Math.floor(Math.random() * 360);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.style.transform = `rotate(${rotation}deg)`;

  svg.innerHTML = `
    <defs>
      <filter id="f-${uid}" x="-30%" y="-30%" width="160%" height="160%">
        <feTurbulence type="fractalNoise" baseFrequency="${turbFreq}" numOctaves="${octaves}" seed="${turbSeed}" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="${dispScale}" xChannelSelector="R" yChannelSelector="G"/>
        <feGaussianBlur stdDeviation="2"/>
      </filter>
      <linearGradient id="g-${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%"   stop-color="hsl(${hue}, 70%, 65%)"       stop-opacity="0.7"/>
        <stop offset="20%"  stop-color="hsl(${(hue+50)%360}, 75%, 60%)"  stop-opacity="0.8"/>
        <stop offset="40%"  stop-color="hsl(${(hue+120)%360}, 65%, 55%)" stop-opacity="0.75"/>
        <stop offset="60%"  stop-color="hsl(${(hue+200)%360}, 70%, 60%)" stop-opacity="0.8"/>
        <stop offset="80%"  stop-color="hsl(${(hue+280)%360}, 75%, 65%)" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="hsl(${(hue+340)%360}, 65%, 60%)" stop-opacity="0.6"/>
      </linearGradient>
      <radialGradient id="m-${uid}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="60%" stop-color="white" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <g filter="url(#f-${uid})">
      <ellipse cx="${w/2}" cy="${h/2}" rx="${w*0.38}" ry="${h*0.38}"
        fill="url(#g-${uid})" style="mix-blend-mode:screen"/>
      <ellipse cx="${w/2 + w*0.05}" cy="${h/2 - h*0.03}" rx="${w*0.3}" ry="${h*0.28}"
        fill="url(#g-${uid})" opacity="0.6" style="mix-blend-mode:overlay"/>
      <ellipse cx="${w/2 - w*0.08}" cy="${h/2 + h*0.05}" rx="${w*0.35}" ry="${h*0.15}"
        fill="url(#g-${uid})" opacity="0.4" style="mix-blend-mode:color-dodge"/>
    </g>
    <ellipse cx="${w/2}" cy="${h/2}" rx="${w/2}" ry="${h/2}"
      fill="url(#m-${uid})" style="mix-blend-mode:destination-in"/>
  `;

  return { svg, hue };
}

function renderSmudges() {
  layer.querySelectorAll('.smudge').forEach(el => el.remove());
  smudgeCounter = 0;
  console.log('[smudge] rendering', comments.length, 'smudges');

  for (const comment of comments) {
    const seed = hashStr(comment.text + (comment.did || '') + comment.createdAt);
    const rand = seededRandom(seed);

    const sizeBase = comment.source === 'isso' ? 0.7 : 1;
    const w = Math.round((50 + rand() * 30) * sizeBase);
    const h = Math.round((30 + rand() * 20) * sizeBase);
    const rotation = Math.round(rand() * 60 - 30);

    const smudge = document.createElement('div');
    smudge.className = 'smudge' + (comment.source === 'isso' ? ' isso-smudge' : '');
    smudge.style.left = ((comment.positionX || 0) - w / 2) + 'px';
    smudge.style.top = ((comment.positionY || 0) - h / 2) + 'px';
    smudge.style.width = w + 'px';
    smudge.style.height = h + 'px';

    const { svg, hue } = createSmudgeSVG(seed, w, h, rotation);
    smudge.appendChild(svg);

    // Shimmer overlay with independent random hue
    const shimmerHue = Math.floor(Math.random() * 360);
    const shimmer = document.createElement('div');
    shimmer.className = 'smudge-shimmer';
    shimmer.style.transform = `rotate(${rotation}deg)`;
    shimmer.style.background = `conic-gradient(
      from ${shimmerHue}deg,
      hsla(${shimmerHue}, 80%, 70%, 0.3),
      hsla(${(shimmerHue+60)%360}, 80%, 65%, 0.2),
      hsla(${(shimmerHue+120)%360}, 70%, 60%, 0.3),
      hsla(${(shimmerHue+180)%360}, 80%, 65%, 0.2),
      hsla(${(shimmerHue+240)%360}, 75%, 70%, 0.3),
      hsla(${(shimmerHue+300)%360}, 80%, 65%, 0.2),
      hsla(${(shimmerHue+360)%360}, 80%, 70%, 0.3)
    )`;
    smudge.appendChild(shimmer);

    smudge.addEventListener('mouseenter', () => {
      if (!activeCompose) showTooltip(comment, smudge);
    });
    smudge.addEventListener('mouseleave', () => {
      // Only dismiss if tooltip doesn't have a delete button (not "pinned")
      if (activeTooltip && !activeTooltip.querySelector('[data-action="delete"]')) {
        closeTooltip();
      }
    });
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
