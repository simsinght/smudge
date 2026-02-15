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
// Detect touch-primary devices (phones/tablets) via pointer capability, not screen size
const isMobile = window.matchMedia('(pointer: coarse)').matches;

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
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
      touch-action: manipulation;
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
      pointer-events: none;
      opacity: 0;
      transition: filter 0.4s ease, transform 0.5s ease, opacity 0.4s ease;
    }
    .smudge-layer.active .smudge {
      pointer-events: auto;
      opacity: 1;
    }
    .smudge-layer.active .smudge.isso-smudge {
      opacity: 0.7;
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
      filter: saturate(0.7) brightness(0.85);
    }

    /* ── tooltip ── */
    .smudge-tooltip {
      position: absolute;
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
      position: absolute;
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
      position: absolute;
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
    @media (pointer: coarse) {
      .smudge-status {
        right: auto;
        bottom: auto;
        font-size: 13px;
        padding: 8px 12px;
        border-radius: 20px;
        max-width: none;
        color: #aaa;
        background: rgba(30,28,24,0.9);
        border: 1px solid rgba(255,255,255,0.1);
        text-align: right;
        white-space: nowrap;
      }
    }

    /* ── cluster badge ── */
    .smudge-cluster {
      position: absolute;
      cursor: pointer;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.4s ease, transform 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .smudge-layer.active .smudge-cluster {
      pointer-events: auto;
      opacity: 1;
    }
    .smudge-cluster:hover { transform: scale(1.15); }
    .smudge-cluster-count {
      position: absolute;
      top: -4px;
      right: -4px;
      background: rgba(180, 130, 60, 0.9);
      color: #fff;
      font-family: monospace;
      font-size: clamp(9px, 0.7vw, 16px);
      font-weight: bold;
      width: clamp(16px, 1.2vw, 28px);
      height: clamp(16px, 1.2vw, 28px);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      z-index: 1;
    }

    /* ── list panel ── */
    .smudge-list-btn {
      position: fixed;
      bottom: clamp(16px, 1.8vw, 32px);
      right: clamp(76px, 6vw, 164px);
      z-index: 10000;
      width: clamp(40px, 3vw, 100px);
      height: clamp(40px, 3vw, 100px);
      border-radius: 50%;
      border: none;
      background: rgba(30,30,30,0.8);
      color: #aaa;
      font-size: clamp(16px, 1.2vw, 40px);
      cursor: pointer;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: background 0.2s, transform 0.2s, opacity 0.3s;
      display: none;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    }
    .smudge-list-btn.visible { display: flex; }
    .smudge-list-btn:hover { background: rgba(50,50,50,0.9); transform: scale(1.08); }

    .smudge-list-panel {
      position: fixed;
      top: 0;
      right: 0;
      width: clamp(300px, 25vw, 500px);
      height: 100%;
      background: rgba(20, 18, 16, 0.96);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-left: 1px solid rgba(255,255,255,0.08);
      z-index: 10003;
      overflow-y: auto;
      transform: translateX(100%);
      transition: transform 0.3s ease;
      font-family: 'Georgia', serif;
      color: #ddd;
    }
    .smudge-list-panel.open { transform: translateX(0); }
    @media (pointer: coarse) {
      .smudge-list-panel {
        top: auto;
        bottom: 0;
        left: 0;
        right: 0;
        width: 100%;
        max-height: 75vh;
        border-left: none;
        border-top: 1px solid rgba(255,255,255,0.12);
        border-radius: 16px 16px 0 0;
        transform: translateY(100%);
      }
      .smudge-list-panel.open { transform: translateY(0); }
    }
    .smudge-list-header {
      position: sticky;
      top: 0;
      background: rgba(20, 18, 16, 0.98);
      padding: clamp(16px, 1.4vw, 32px);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 1;
    }
    .smudge-list-header h3 {
      margin: 0;
      font-size: clamp(14px, 1.1vw, 24px);
      font-weight: normal;
      color: #bbb;
    }
    .smudge-list-close {
      background: none;
      border: none;
      color: #777;
      font-size: clamp(18px, 1.4vw, 32px);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .smudge-list-close:hover { background: rgba(255,255,255,0.08); }
    .smudge-list-items { padding: clamp(8px, 0.6vw, 16px); }
    .smudge-list-item {
      padding: clamp(12px, 1vw, 22px);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer;
      border-radius: clamp(6px, 0.5vw, 12px);
      transition: background 0.15s;
    }
    .smudge-list-item:hover { background: rgba(255,255,255,0.04); }
    .smudge-list-item-meta {
      display: flex;
      align-items: center;
      gap: clamp(5px, 0.5vw, 10px);
      margin-bottom: clamp(4px, 0.3vw, 8px);
      font-size: clamp(10px, 0.75vw, 18px);
      color: #888;
    }
    .smudge-list-item-avatar {
      width: clamp(16px, 1.2vw, 28px);
      height: clamp(16px, 1.2vw, 28px);
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }
    .smudge-list-item-text {
      font-size: clamp(12px, 0.9vw, 20px);
      color: #ccc;
      line-height: 1.5;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .smudge-list-item-jump {
      font-size: clamp(9px, 0.7vw, 16px);
      color: #b89860;
      margin-top: clamp(4px, 0.3vw, 8px);
      display: inline-block;
    }
    .smudge-list-empty {
      text-align: center;
      color: #666;
      padding: clamp(30px, 3vw, 60px);
      font-size: clamp(13px, 1vw, 22px);
    }

    @media (pointer: coarse) {
      .smudge-list-header {
        position: relative;
        padding: 24px 18px 16px;
        justify-content: center;
      }
      .smudge-list-header::before {
        content: '';
        position: absolute;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        width: 40px;
        height: 5px;
        border-radius: 3px;
        background: rgba(255,255,255,0.35);
      }
      .smudge-list-header h3 { font-size: 19px; }
      .smudge-list-close {
        position: absolute;
        right: 8px;
        top: 16px;
        font-size: 32px;
        padding: 8px 14px;
        color: #aaa;
        background: rgba(255,255,255,0.08);
        border-radius: 50%;
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      .smudge-list-items { padding: 6px 14px 32px; }
      .smudge-list-item { padding: 16px 14px; }
      .smudge-list-item-meta { font-size: 16px; gap: 8px; margin-bottom: 8px; }
      .smudge-list-item-avatar { width: 28px; height: 28px; }
      .smudge-list-item-text { font-size: 18px; -webkit-line-clamp: 4; }
      .smudge-list-item-jump { font-size: 15px; margin-top: 8px; }
      .smudge-list-empty { font-size: 18px; padding: 40px; }
    }

    /* ── highlight pulse for jump-to ── */
    @keyframes smudge-highlight {
      0%   { filter: brightness(1) drop-shadow(0 0 0 transparent); }
      30%  { filter: brightness(2) drop-shadow(0 0 20px rgba(200,160,80,0.8)); }
      100% { filter: brightness(1) drop-shadow(0 0 0 transparent); }
    }
    .smudge-highlight {
      animation: smudge-highlight 1.2s ease forwards;
      z-index: 9600 !important;
    }
  `;
  document.head.appendChild(style);
}

// ── DOM setup ──────────────────────────────────────────────────────────
let layer, uiOverlay, toggleBtn, statusEl, pressRing, listBtn, listPanel;
let activeTooltip = null;
let tooltipPinned = false; // true when shown via click (stays open), false when via hover
let activeCompose = null;
let lastClientX = 0, lastClientY = 0;
// Map from smudge element to its comment data (for jump-to highlighting)
const smudgeElMap = new Map();

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

  // List button (shows when layer active)
  listBtn = document.createElement('button');
  listBtn.className = 'smudge-list-btn';
  listBtn.innerHTML = `<svg width="55%" height="55%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`;
  listBtn.title = 'view all marks';
  listBtn.addEventListener('click', toggleListPanel);
  uiOverlay.appendChild(listBtn);

  // List panel
  listPanel = document.createElement('div');
  listPanel.className = 'smudge-list-panel';
  uiOverlay.appendChild(listPanel);
  setupListPanelPullDismiss();

  // Press indicator (chat bubble with completing ring)
  pressRing = document.createElement('div');
  pressRing.className = 'smudge-press-indicator';
  pressRing.innerHTML = `<svg viewBox="0 0 48 48">
    <circle class="ring" cx="24" cy="24" r="21"/>
    <path class="bubble" d="M16,14 h16 a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h-8 l-4,4 v-4 h-4 a4,4 0 0 1 -4,-4 v-10 a4,4 0 0 1 4,-4z"/>
    <text class="bubble-icon" x="24" y="27" text-anchor="middle" font-size="12">...</text>
  </svg>`;
  layer.appendChild(pressRing);

  // Long-press handling on the layer
  setupLongPress();
}

function toggleLayer() {
  layerVisible = !layerVisible;
  layer.classList.toggle('active', layerVisible);
  toggleBtn.classList.toggle('active', layerVisible);
  listBtn.classList.toggle('visible', layerVisible);
  if (!layerVisible) {
    closeTooltip();
    closeCompose();
    closeListPanel();
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
    statusEl.title = 'tap to sign out';
    statusEl.classList.add('visible');
    clearTimeout(statusEl._fadeTimer);
    statusEl._fadeTimer = setTimeout(() => {
      if (oauthSession) statusEl.textContent = 'log out';
    }, 2000);
  } else {
    statusEl.textContent = 'sign in';
    statusEl.title = 'sign in to leave marks';
    statusEl.classList.add('visible');
  }
}

// ── long-press detection ───────────────────────────────────────────────
let pressTimer = null;
let pressPos = null;
let pressStartTime = 0;
let pressPointerId = null;
const activePointers = new Set();

function cancelPress() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  pressPointerId = null;
  pressRing.classList.remove('active');
}

function setupLongPress() {
  console.log('[smudge] setupLongPress, layer:', layer, 'parent:', layer.parentElement);
  layer.addEventListener('pointerdown', onPressStart);
  layer.addEventListener('pointerup', onPressEnd);
  layer.addEventListener('pointercancel', onPressEnd);
  layer.addEventListener('pointermove', onPressMove);

  // Track ALL pointers on the document — if a second finger lands anywhere, cancel
  document.addEventListener('pointerdown', (e) => {
    activePointers.add(e.pointerId);
    if (activePointers.size > 1) cancelPress();
  }, true);
  document.addEventListener('pointerup', (e) => activePointers.delete(e.pointerId), true);
  document.addEventListener('pointercancel', (e) => activePointers.delete(e.pointerId), true);

  // Prevent native context menu on long-press (mobile)
  // Magnifying glass / text selection suppressed via CSS: user-select:none, -webkit-touch-callout:none, touch-action:manipulation
  layer.addEventListener('contextmenu', (e) => { if (layerVisible) e.preventDefault(); });

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
  // Only trigger on the layer background, not on smudges or popups
  if (e.target !== layer) return;
  // Ignore if multiple fingers are already down (pinch/zoom)
  if (activePointers.size > 1) return;

  pressPointerId = e.pointerId;

  // Container-relative coords for storing the smudge position
  const container = layer.parentElement;
  const cRect = container ? container.getBoundingClientRect() : layer.getBoundingClientRect();
  pressPos = {
    x: e.clientX - cRect.left,
    y: e.clientY - cRect.top,
  };
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  pressStartTime = Date.now();

  // Show progress ring and start long-press timer (both touch and mouse)
  pressRing.style.left = (pressPos.x + 20) + 'px';
  pressRing.style.top = (pressPos.y - 60) + 'px';
  pressRing.classList.remove('active');
  void pressRing.offsetWidth; // reflow
  pressRing.classList.add('active');

  pressTimer = setTimeout(() => {
    pressRing.classList.remove('active');
    closeTooltip();
    closeCompose();
    openCompose(pressPos.x, pressPos.y);
    pressTimer = null;
  }, 1000);
}

function onPressEnd(e) {
  cancelPress();
}

function onPressMove(e) {
  if (!pressTimer || !pressPos || e.pointerId !== pressPointerId) return;
  const dx = e.clientX - lastClientX;
  const dy = e.clientY - lastClientY;
  if (Math.sqrt(dx * dx + dy * dy) > 10) {
    cancelPress();
  }
}

// ── tooltip ────────────────────────────────────────────────────────────
function closeTooltip() {
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
    tooltipPinned = false;
  }
}

function showTooltip(comment, smudgeEl) {
  closeTooltip();

  const tip = document.createElement('div');
  tip.className = 'smudge-tooltip';

  // Measure off-screen first to get dimensions
  tip.style.visibility = 'hidden';
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

  // Position tooltip in the layer near the smudge
  layer.appendChild(tip);
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const smLeft = parseFloat(smudgeEl.style.left) || 0;
  const smTop = parseFloat(smudgeEl.style.top) || 0;
  const smW = smudgeEl.offsetWidth;
  const smH = smudgeEl.offsetHeight;

  let x = smLeft + smW / 2 - tipW / 2;
  let y = smTop - 8 - tipH;
  const layerW = layer.offsetWidth || 1800;
  if (x < 10) x = 10;
  if (x + tipW > layerW - 10) x = layerW - 10 - tipW;
  if (y < 10) y = smTop + smH + 8;

  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
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

function scaleMobilePopup(popup) {
  if (!isMobile || !window.visualViewport) return;
  const scale = window.visualViewport.width / (window.screen.width || 375);
  const fs = Math.round(15 * scale);
  const pad = Math.round(18 * scale);
  const radius = Math.round(12 * scale);

  popup.style.fontSize = fs + 'px';
  popup.style.padding = pad + 'px';
  popup.style.borderRadius = radius + 'px';

  popup.querySelectorAll('h3').forEach(el => {
    el.style.fontSize = Math.round(17 * scale) + 'px';
    el.style.marginBottom = Math.round(14 * scale) + 'px';
  });
  popup.querySelectorAll('textarea').forEach(el => {
    el.style.fontSize = fs + 'px';
    el.style.padding = Math.round(10 * scale) + 'px';
    el.style.borderRadius = Math.round(8 * scale) + 'px';
    el.style.minHeight = Math.round(80 * scale) + 'px';
  });
  popup.querySelectorAll('.smudge-btn').forEach(el => {
    el.style.fontSize = Math.round(14 * scale) + 'px';
    el.style.padding = `${Math.round(10 * scale)}px ${Math.round(20 * scale)}px`;
    el.style.borderRadius = Math.round(8 * scale) + 'px';
  });
  popup.querySelectorAll('.smudge-auth-btn').forEach(el => {
    el.style.fontSize = fs + 'px';
    el.style.padding = `${Math.round(12 * scale)}px ${Math.round(16 * scale)}px`;
    el.style.borderRadius = Math.round(8 * scale) + 'px';
  });
  popup.querySelectorAll('.smudge-nudge').forEach(el => {
    el.style.fontSize = fs + 'px';
  });
  popup.querySelectorAll('input[type="text"]').forEach(el => {
    el.style.fontSize = fs + 'px';
    el.style.padding = Math.round(10 * scale) + 'px';
    el.style.borderRadius = Math.round(8 * scale) + 'px';
  });
  popup.querySelectorAll('.smudge-signin-hint').forEach(el => {
    el.style.fontSize = Math.round(13 * scale) + 'px';
  });
  popup.querySelectorAll('.smudge-signin-actions').forEach(el => {
    el.style.gap = Math.round(8 * scale) + 'px';
    el.style.marginTop = Math.round(14 * scale) + 'px';
  });
}

function openCompose(containerX, containerY) {
  closeCompose();

  const popup = document.createElement('div');
  popup.className = 'smudge-compose';

  // Decide what to show based on auth state
  if (oauthSession) {
    showComposeForm(popup, containerX, containerY, 'atproto');
  } else {
    showAuthChoice(popup, containerX, containerY);
  }

  if (isMobile && window.visualViewport) {
    const vv = window.visualViewport;
    // Use 90% of the visual viewport width, centered within it
    const pw = Math.round(vv.width * 0.9);
    const ml = Math.round(vv.width * 0.05);

    popup.style.position = 'fixed';
    popup.style.width = pw + 'px';
    popup.style.maxWidth = 'none';
    popup.style.left = (vv.offsetLeft + ml) + 'px';
    popup.style.top = (vv.offsetTop + vv.height * 0.2) + 'px';
    popup.style.transform = 'none';
    scaleMobilePopup(popup);
    uiOverlay.appendChild(popup);
  } else {
    // Desktop: position in layer near the press point
    layer.appendChild(popup);
    const popW = popup.offsetWidth;
    const popH = popup.offsetHeight;
    const layerW = layer.offsetWidth || 1800;
    const layerH = layer.offsetHeight || 6800;

    let x = containerX - popW / 2;
    let y = containerY + 20;
    if (x < 10) x = 10;
    if (x + popW > layerW - 10) x = layerW - 10 - popW;
    if (y + popH > layerH - 10) y = containerY - popH - 10;

    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  }
  activeCompose = popup;
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

  scaleMobilePopup(popup);

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
  scaleMobilePopup(popup);

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

  scaleMobilePopup(popup);

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

// ── list panel ──────────────────────────────────────────────────────────
function positionListPanelMobile() {
  if (!isMobile) return;
  // Page scroll is locked so we can use simple fixed positioning
  // Reset any viewport-tracking styles
  listPanel.style.left = '0';
  listPanel.style.width = '100%';
  listPanel.style.bottom = '0';
  listPanel.style.top = 'auto';
  listPanel.style.maxHeight = '75vh';
}

let _scrollLockPos = null;

function lockPageScroll() {
  if (_scrollLockPos !== null) return;
  _scrollLockPos = { x: window.scrollX, y: window.scrollY };
  document.body.style.overflow = 'hidden';
  document.body.style.touchAction = 'none';
  // iOS Safari needs position:fixed to truly prevent scroll, but that
  // resets scroll position, so we compensate with negative top
  document.body.style.position = 'fixed';
  document.body.style.top = -_scrollLockPos.y + 'px';
  document.body.style.left = -_scrollLockPos.x + 'px';
  document.body.style.width = '100%';
}

function unlockPageScroll() {
  if (_scrollLockPos === null) return;
  document.body.style.overflow = '';
  document.body.style.touchAction = '';
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.width = '';
  window.scrollTo(_scrollLockPos.x, _scrollLockPos.y);
  _scrollLockPos = null;
}

function toggleListPanel() {
  listPanel.classList.toggle('open');
  if (listPanel.classList.contains('open')) {
    positionListPanelMobile();
    populateListPanel();
    if (isMobile) lockPageScroll();
  } else {
    if (isMobile) unlockPageScroll();
  }
}

function closeListPanel() {
  listPanel.classList.remove('open');
  listPanel.style.transform = '';
  listPanel.style.transition = '';
  if (isMobile) unlockPageScroll();
}

function setupListPanelPullDismiss() {
  if (!isMobile) return;
  let startY = null;
  let currentY = 0;

  listPanel.addEventListener('touchstart', (e) => {
    // Only pull-to-dismiss if scrolled to top of list
    if (listPanel.scrollTop > 5) return;
    startY = e.touches[0].clientY;
    currentY = 0;
    listPanel.style.transition = 'none';
  }, { passive: true });

  listPanel.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) { currentY = 0; listPanel.style.transform = ''; return; }
    currentY = dy;
    listPanel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  listPanel.addEventListener('touchend', () => {
    if (startY === null) return;
    startY = null;
    if (currentY > 80) {
      // Dismiss
      listPanel.style.transition = 'transform 0.25s ease';
      listPanel.style.transform = 'translateY(100%)';
      setTimeout(() => closeListPanel(), 250);
    } else {
      // Snap back
      listPanel.style.transition = 'transform 0.2s ease';
      listPanel.style.transform = '';
    }
    currentY = 0;
  }, { passive: true });
}

function populateListPanel() {
  // Sort comments top-to-bottom by positionY
  const sorted = [...comments].sort((a, b) => (a.positionY || 0) - (b.positionY || 0));

  let html = `
    <div class="smudge-list-header">
      <h3>all marks (${comments.length})</h3>
      <button class="smudge-list-close">&times;</button>
    </div>
    <div class="smudge-list-items">
  `;

  if (sorted.length === 0) {
    html += `<div class="smudge-list-empty">no marks yet</div>`;
  }

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const profile = profileCache[c.did] || {};

    let metaHtml;
    if (c.source === 'isso') {
      metaHtml = `
        <span style="font-style:italic; color:#777;">anonymous</span>
        <span style="color:#555;">&middot;</span>
        <span style="color:#666;">${formatTime(c.createdAt)}</span>
      `;
    } else {
      const avatarHtml = profile.avatar
        ? `<img class="smudge-list-item-avatar" src="${escapeHtml(profile.avatar)}" alt="">`
        : '';
      const handle = profile.handle || c.handle || c.did?.slice(0, 16) + '...';
      const displayName = profile.displayName || '';
      const nameHtml = displayName
        ? `<strong>${escapeHtml(displayName)}</strong>`
        : `<span style="color:#aaa;">@${escapeHtml(handle)}</span>`;
      metaHtml = `
        ${avatarHtml} ${nameHtml}
        <span style="color:#555;">&middot;</span>
        <span style="color:#666;">${formatTime(c.createdAt)}</span>
      `;
    }

    html += `
      <div class="smudge-list-item" data-idx="${i}">
        <div class="smudge-list-item-meta">${metaHtml}</div>
        <div class="smudge-list-item-text">${escapeHtml(c.text)}</div>
        <span class="smudge-list-item-jump">jump to &rarr;</span>
      </div>
    `;
  }

  html += `</div>`;
  listPanel.innerHTML = html;

  // Close button
  listPanel.querySelector('.smudge-list-close').addEventListener('click', closeListPanel);

  // Jump-to handlers
  listPanel.querySelectorAll('.smudge-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.idx, 10);
      const c = sorted[idx];
      if (isMobile) closeListPanel();
      jumpToComment(c);
    });
  });
}

function commentKey(c) {
  if (c.did && c.rkey) return `atproto:${c.did}:${c.rkey}`;
  if (c.source === 'isso' && c.id != null) return `isso:${c.id}`;
  return `pos:${c.positionX}:${c.positionY}:${c.text}`;
}

function jumpToComment(comment) {
  // Find the smudge element for this comment
  const key = commentKey(comment);
  let targetEl = null;
  for (const [el, arr] of smudgeElMap) {
    if (arr.some(c => commentKey(c) === key)) {
      targetEl = el;
      break;
    }
  }

  // Get the element's page position (or fall back to comment coords)
  let elX, elY;
  if (targetEl) {
    const rect = targetEl.getBoundingClientRect();
    elX = rect.left + window.scrollX + rect.width / 2;
    elY = rect.top + window.scrollY + rect.height / 2;
  } else {
    elX = comment.positionX || 0;
    elY = comment.positionY || 0;
  }

  // Account for the list panel taking up space on the right
  const panelW = (listPanel && listPanel.classList.contains('open'))
    ? listPanel.offsetWidth : 0;
  const availW = window.innerWidth - panelW;
  const availH = window.innerHeight;

  // Scroll so the smudge is centered in the available area
  const scrollX = elX - availW / 2;
  const scrollY = elY - availH / 2;
  window.scrollTo({ left: scrollX, top: scrollY, behavior: 'smooth' });

  // Highlight pulse
  if (targetEl) {
    targetEl.classList.remove('smudge-highlight');
    void targetEl.offsetWidth;
    targetEl.classList.add('smudge-highlight');
    setTimeout(() => targetEl.classList.remove('smudge-highlight'), 1500);
  }
}

// ── clustering ──────────────────────────────────────────────────────────
function clusterComments(commentList, cellSize = 150) {
  const cells = {};
  for (const c of commentList) {
    const cx = Math.floor((c.positionX || 0) / cellSize);
    const cy = Math.floor((c.positionY || 0) / cellSize);
    const key = `${cx},${cy}`;
    if (!cells[key]) cells[key] = [];
    cells[key].push(c);
  }
  return Object.values(cells);
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
    const { BrowserOAuthClient, Agent } = await import('./oauth-client-browser.js?v=2');
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

  // Show popup immediately (synchronous from tap) so iOS allows input.focus()
  showSignInPopup();

  // Init OAuth in background if needed — sign-in button will await it
  if (!oauthClient) {
    initOAuth().catch(err => console.error('[smudge] OAuth init error:', err));
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
      if (!oauthClient) await initOAuth();
      if (!oauthClient) throw new Error('OAuth client not available');
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

  if (isMobile && window.visualViewport) {
    const vv = window.visualViewport;
    const pw = Math.round(vv.width * 0.9);
    const ml = Math.round(vv.width * 0.05);

    popup.style.position = 'fixed';
    popup.style.width = pw + 'px';
    popup.style.maxWidth = 'none';
    popup.style.left = (vv.offsetLeft + ml) + 'px';
    popup.style.top = (vv.offsetTop + vv.height * 0.2) + 'px';
    popup.style.transform = 'none';
    scaleMobilePopup(popup);
  }

  uiOverlay.appendChild(popup);
  activeSignIn = popup;
  // iOS Safari only allows focus() with keyboard within the synchronous
  // call stack of a user gesture — no rAF or setTimeout wrappers
  input.focus();
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

function createSingleSmudge(comment) {
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
    if (!activeCompose && !tooltipPinned) showTooltip(comment, smudge);
  });
  smudge.addEventListener('mouseleave', () => {
    if (activeTooltip && !tooltipPinned) closeTooltip();
  });
  smudge.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCompose();
    showTooltip(comment, smudge);
    tooltipPinned = true;
  });

  smudgeElMap.set(smudge, [comment]);
  return smudge;
}

function createClusterEl(cluster) {
  // Centroid position
  const cx = cluster.reduce((s, c) => s + (c.positionX || 0), 0) / cluster.length;
  const cy = cluster.reduce((s, c) => s + (c.positionY || 0), 0) / cluster.length;

  // Use the first comment's seed for the smudge visual
  const first = cluster[0];
  const seed = hashStr(first.text + (first.did || '') + first.createdAt);
  const rand = seededRandom(seed);

  const w = Math.round(60 + cluster.length * 5);
  const h = Math.round(40 + cluster.length * 3);
  const rotation = Math.round(rand() * 40 - 20);

  const el = document.createElement('div');
  el.className = 'smudge-cluster';
  el.style.left = (cx - w / 2) + 'px';
  el.style.top = (cy - h / 2) + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';

  const { svg } = createSmudgeSVG(seed, w, h, rotation);
  el.appendChild(svg);

  // Count badge
  const badge = document.createElement('div');
  badge.className = 'smudge-cluster-count';
  badge.textContent = cluster.length;
  el.appendChild(badge);

  // Hover to show cluster tooltip (desktop)
  el.addEventListener('mouseenter', () => {
    if (!activeCompose && !tooltipPinned) showClusterTooltip(cluster, el);
  });
  el.addEventListener('mouseleave', () => {
    if (activeTooltip && !tooltipPinned) closeTooltip();
  });
  // Click/tap to show cluster tooltip
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCompose();
    showClusterTooltip(cluster, el);
    tooltipPinned = true;
  });

  // Register all comments in the cluster to this element (for jump-to)
  smudgeElMap.set(el, cluster);

  return el;
}

function showClusterTooltip(cluster, clusterEl) {
  closeTooltip();

  const tip = document.createElement('div');
  tip.className = 'smudge-tooltip';
  tip.style.visibility = 'hidden';
  tip.style.left = '0';
  tip.style.top = '0';
  tip.style.maxHeight = '300px';
  tip.style.overflowY = 'auto';

  let html = '';
  for (const c of cluster) {
    const profile = profileCache[c.did] || {};
    if (c.source === 'isso') {
      html += `
        <div style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.06);">
          <div class="smudge-tooltip-meta">
            <span class="smudge-tooltip-anon">anonymous</span>
            <span class="smudge-tooltip-sep">&middot;</span>
            <span class="smudge-tooltip-time">${formatTime(c.createdAt)}</span>
          </div>
          <div class="smudge-tooltip-text">${escapeHtml(c.text)}</div>
        </div>`;
    } else {
      const avatarHtml = profile.avatar
        ? `<img class="smudge-tooltip-avatar" src="${escapeHtml(profile.avatar)}" alt="">`
        : '';
      const handle = profile.handle || c.handle || c.did?.slice(0, 16) + '...';
      const displayName = profile.displayName || '';
      const nameHtml = displayName
        ? `<strong>${escapeHtml(displayName)}</strong>`
        : `<span class="smudge-tooltip-handle">@${escapeHtml(handle)}</span>`;
      html += `
        <div style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.06);">
          <div class="smudge-tooltip-meta">
            ${avatarHtml} ${nameHtml}
            <span class="smudge-tooltip-sep">&middot;</span>
            <span class="smudge-tooltip-time">${formatTime(c.createdAt)}</span>
          </div>
          <div class="smudge-tooltip-text">${escapeHtml(c.text)}</div>
        </div>`;
    }
  }
  // Remove last border
  tip.innerHTML = html;
  const lastChild = tip.querySelector('div:last-child');
  if (lastChild) lastChild.style.borderBottom = 'none';

  layer.appendChild(tip);
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const smLeft = parseFloat(clusterEl.style.left) || 0;
  const smTop = parseFloat(clusterEl.style.top) || 0;
  const smW = clusterEl.offsetWidth;
  const smH = clusterEl.offsetHeight;

  let x = smLeft + smW / 2 - tipW / 2;
  let y = smTop - 8 - tipH;
  const layerW = layer.offsetWidth || 1800;
  if (x < 10) x = 10;
  if (x + tipW > layerW - 10) x = layerW - 10 - tipW;
  if (y < 10) y = smTop + smH + 8;

  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
  tip.style.visibility = 'visible';
  activeTooltip = tip;
}

function renderSmudges() {
  layer.querySelectorAll('.smudge, .smudge-cluster').forEach(el => el.remove());
  smudgeElMap.clear();
  smudgeCounter = 0;

  const clusters = clusterComments(comments, 150);

  for (const cluster of clusters) {
    if (cluster.length === 1) {
      layer.appendChild(createSingleSmudge(cluster[0]));
    } else {
      layer.appendChild(createClusterEl(cluster));
    }
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

// ── zoom compensation (mobile) ──────────────────────────────────────────
function setupZoomCompensation() {
  const vv = window.visualViewport;
  if (!vv || !isMobile) return;

  const screenW = window.screen.width || 375;

  // On iOS Safari, position:fixed is relative to the LAYOUT viewport,
  // not the visual viewport. When pinch-zoomed, we must manually
  // reposition buttons to track what the user actually sees.
  function update() {
    const scale = vv.width / screenW;
    // Cap sizes so they never exceed 12% of the smaller viewport dimension
    const maxSize = Math.min(vv.width, vv.height) * 0.12;
    const margin = Math.min(Math.round(16 * scale), maxSize * 0.4);
    const btnSize = Math.min(Math.round(48 * scale), maxSize);
    const listBtnSize = Math.min(Math.round(40 * scale), maxSize * 0.85);

    // Position toggle button at bottom-right of VISUAL viewport
    toggleBtn.style.position = 'fixed';
    toggleBtn.style.bottom = 'auto';
    toggleBtn.style.right = 'auto';
    toggleBtn.style.left = (vv.offsetLeft + vv.width - btnSize - margin) + 'px';
    toggleBtn.style.top = (vv.offsetTop + vv.height - btnSize - margin) + 'px';
    toggleBtn.style.width = btnSize + 'px';
    toggleBtn.style.height = btnSize + 'px';
    toggleBtn.style.fontSize = Math.round(20 * scale) + 'px';

    // Position list button to the left of toggle
    listBtn.style.position = 'fixed';
    listBtn.style.bottom = 'auto';
    listBtn.style.right = 'auto';
    listBtn.style.left = (vv.offsetLeft + vv.width - btnSize - margin - listBtnSize - Math.round(8 * scale)) + 'px';
    listBtn.style.top = (vv.offsetTop + vv.height - listBtnSize - margin + Math.round((btnSize - listBtnSize) / 2)) + 'px';
    listBtn.style.width = listBtnSize + 'px';
    listBtn.style.height = listBtnSize + 'px';

    // Position status above toggle, right-aligned with button's right edge
    // Toggle's right edge in layout coords:
    const toggleRightLC = vv.offsetLeft + vv.width - margin;
    const toggleTop = vv.offsetTop + vv.height - btnSize - margin;
    const layoutW = document.documentElement.clientWidth || window.innerWidth;
    const fs = Math.min(Math.round(13 * scale), btnSize * 0.3);
    const padV = Math.min(Math.round(8 * scale), btnSize * 0.16);
    const padH = Math.min(Math.round(12 * scale), btnSize * 0.25);
    statusEl.style.position = 'fixed';
    statusEl.style.bottom = 'auto';
    statusEl.style.left = 'auto';
    // right = distance from layout viewport right edge to toggle's right edge
    statusEl.style.right = (layoutW - toggleRightLC) + 'px';
    statusEl.style.fontSize = fs + 'px';
    statusEl.style.padding = `${padV}px ${padH}px`;
    statusEl.style.borderRadius = Math.round(20 * scale) + 'px';
    statusEl.style.whiteSpace = 'nowrap';
    statusEl.style.overflow = 'visible';
    statusEl.style.textOverflow = 'clip';
    statusEl.style.maxWidth = 'none';
    statusEl.style.top = (toggleTop - padV * 2 - fs - Math.round(6 * scale)) + 'px';
  }

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// ── init ───────────────────────────────────────────────────────────────
async function init() {
  injectStyles();
  createDOM();
  setupZoomCompensation();

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
