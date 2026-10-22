import { errorDetails, sendErrorEvent } from './site-events';
import { getAdProvider } from './ads';
import { gameFrameSrc } from './frame-src';

export interface PlayerGame {
  id: string;
  title: string;
  stage: 'pending' | 'rejected' | 'proving' | 'live';
}

export interface PlayerOptions {
  cdnOrigin: string;
  /** Persist the game's localStorage to the signed-in user's Supabase cloud save instead of this browser. */
  cloudSaves?: boolean;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
  /** SP-6: owner preview token for their own pending/rejected game (the CDN 404s those otherwise). */
  previewToken?: string | null;
  /** Share-link bundle. Present only for /p/<token>, which must load this version and no other. */
  bundleVersion?: number;
}

export interface PlayerHandle {
  frame: HTMLIFrameElement;
  destroy(): void;
}

const MAX_SAVE_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const CLOUD_SAVE_DEBOUNCE_MS = 1500;

/** Last save each game reported this page load. Restart reuses it, so there's no round trip and no race with the in-flight cloud write. */
const recentSaves = new Map<string, string>();
const preloadedSaves = new Map<string, Promise<string>>();

/** Start fetching the cloud save before the player clicks Play, so the launch doesn't wait on it. */
export function preloadSave(gameId: string, cloud: boolean) {
  if (cloud && !preloadedSaves.has(gameId)) preloadedSaves.set(gameId, loadSave(gameId, `mg:save:${gameId}`, true));
}

function takeSave(gameId: string, saveKey: string, cloud: boolean): Promise<string> {
  const recent = recentSaves.get(gameId);
  if (recent !== undefined) return Promise.resolve(recent);
  const preloaded = preloadedSaves.get(gameId);
  preloadedSaves.delete(gameId);
  return preloaded ?? loadSave(gameId, saveKey, cloud);
}

async function loadSave(gameId: string, saveKey: string, cloud: boolean): Promise<string> {
  const local = localStorage.getItem(saveKey) ?? '{}';
  if (!cloud) return local;
  try {
    const res = await fetch(`/api/saves/${gameId}`);
    const { data } = res.ok ? ((await res.json()) as { data: Record<string, string> | null }) : { data: null };
    // No cloud save yet: carry over progress made while logged out (it gets uploaded on the next write).
    return data ? JSON.stringify(data) : local;
  } catch {
    return local;
  }
}

/**
 * Mounts a game inside a sandboxed, opaque-origin iframe and runs the portal side of the
 * postMessage protocol: telemetry, ad breaks, rewarded ads, and save persistence.
 */
export function mountPlayer(host: HTMLElement, game: PlayerGame, opts: PlayerOptions): PlayerHandle {
  const sessionId = crypto.randomUUID();
  const saveKey = `mg:save:${game.id}`;
  const monetized = game.stage === 'live';
  const ads = getAdProvider();

  const track = (type: string, value?: number, beacon = false) => {
    const body = JSON.stringify({ sessionId, gameId: game.id, type, value });
    if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }));
    else fetch('/api/telemetry', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  };

  const frame = document.createElement('iframe');
  frame.className = 'mg-frame';
  frame.title = game.title;
  frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
  frame.setAttribute('allow', 'autoplay; gamepad; accelerometer; gyroscope; fullscreen');
  frame.allowFullscreen = true;
  frame.setAttribute('referrerpolicy', 'no-referrer');
  // The fullscreen × is a child of the stage so native fullscreen can show it. Restart
  // replaces the frame and has to put that control back on top of the new iframe.
  const exit = host.querySelector('[data-fullscreen-exit]');
  host.replaceChildren(frame);
  if (exit) host.append(exit);
  // CSS immersive keeps focus on the toolbar so Escape reaches the portal. A late load
  // must not steal focus after exit has returned it to the fullscreen button.
  const focusFrame = () => {
    if (host.dataset.immersive === '1' || document.activeElement?.id === 'fullscreen') return;
    frame.focus();
  };
  focusFrame();

  let destroyed = false;
  let srcSet = false;
  let sessionStartTracked = false;

  const onLoad = () => {
    focusFrame();
    // A PAUSE posted before boot.js was listening is lost; re-send the current state to the fresh document.
    if (pauses.size) post('PAUSE');
    if (!destroyed && srcSet && !sessionStartTracked) {
      sessionStartTracked = true;
      track('session_start');
    }
  };
  frame.addEventListener('load', onLoad);

  takeSave(game.id, saveKey, !!opts.cloudSaves).then((save) => {
    if (!destroyed) {
      srcSet = true;
      frame.src = gameFrameSrc(opts.cdnOrigin, game.id, location.origin, save, opts.previewToken, opts.bundleVersion);
    }
  });

  let pendingSave: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const flushSave = () => {
    clearTimeout(saveTimer);
    if (pendingSave === null) return;
    const body = JSON.stringify({ items: JSON.parse(pendingSave) });
    pendingSave = null;
    fetch(`/api/saves/${game.id}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  };
  const persist = (json: string) => {
    recentSaves.set(game.id, json);
    if (!opts.cloudSaves) return localStorage.setItem(saveKey, json);
    pendingSave = json;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, CLOUD_SAVE_DEBOUNCE_MS);
  };

  const post = (type: string, data: Record<string, unknown> = {}) => frame.contentWindow?.postMessage({ type, ...data }, '*');

  let started = false, completed = false, crashed = false, ready = false;
  let activeMs = 0, lastTick = performance.now();

  // The game is paused while any reason holds: an ad is showing, the tab is hidden, or the stage is scrolled
  // off-screen. boot.js freezes rAF, the game clock and audio, so an unwatched game burns no GPU and doesn't
  // die off-screen. Active time only counts while nothing pauses it.
  const pauses = new Set<'ad' | 'hidden' | 'offscreen'>();
  const tick = () => {
    const now = performance.now();
    if (!pauses.size) activeMs += now - lastTick;
    lastTick = now;
  };
  const setPaused = (reason: 'ad' | 'hidden' | 'offscreen', on: boolean) => {
    if (pauses.has(reason) === on) return;
    tick();
    const was = pauses.size > 0;
    if (on) pauses.add(reason);
    else pauses.delete(reason);
    if (was !== pauses.size > 0) post(was ? 'RESUME' : 'PAUSE');
  };

  const runAd = async <T>(show: () => Promise<T>, fallback: T): Promise<T> => {
    if (!monetized || pauses.has('ad')) return fallback;
    setPaused('ad', true);
    try {
      return await show();
    } catch {
      return fallback;
    } finally {
      setPaused('ad', false);
    }
  };

  const onMessage = async (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
    const data = e.data as Record<string, unknown>;
    const type = String(data.type ?? '');
    switch (type) {
      case '__MG_FIRST_FRAME':
        track('first_frame', Number(data.ms) || 0);
        break;
      case '__MG_READY':
        if (!ready) (ready = true), track('ready', Number(data.ms) || 0);
        break;
      case '__MG_SNAPSHOT':
        // Canvas snapshots belong to the upload preview. Live play drops them.
        return;
      case '__MG_INPUT':
        if (!started) (started = true), track('start');
        break;
      case '__MG_CRASH':
        if (!crashed) {
          crashed = true;
          track('crash');
          sendErrorEvent({ gameId: game.id, details: errorDetails('game', data.message) });
        }
        break;
      case '__MG_STORAGE': {
        const json = JSON.stringify(data.items ?? {});
        if (json.length <= MAX_SAVE_BYTES) persist(json);
        break;
      }
      case 'GAME_OVER':
      case 'LEVEL_COMPLETE':
        if (!completed) (completed = true), (started = true), track('complete');
        recordScore(Number(data.score));
        break;
      case 'SUBMIT_SCORE':
        recordScore(Number(data.score));
        break;
      case 'REQUEST_REWARD_AD': {
        // Proving Grounds games are unmonetized: rewards are granted instantly, no ad.
        const granted = await runAd(() => ads.rewarded(), !monetized);
        post(granted ? 'REWARD_GRANTED' : 'REWARD_DENIED');
        break;
      }
      case 'REQUEST_AD_BREAK':
      case 'REQUEST_INTERSTITIAL':
        await runAd(() => ads.interstitial(), undefined);
        post('AD_BREAK_DONE');
        break;
      default:
        return;
    }
    opts.onEvent?.(type, data);
  };

  const recordScore = (score: number) => {
    if (!Number.isFinite(score)) return;
    const key = `mg:best:${game.id}`;
    const best = Number(localStorage.getItem(key) ?? -Infinity);
    if (score > best) localStorage.setItem(key, String(score));
    opts.onEvent?.('SCORE', { score, best: Math.max(score, best) });
  };

  const heartbeat = setInterval(() => {
    tick();
    if (started) track('heartbeat', activeMs);
  }, HEARTBEAT_MS);
  const flush = () => {
    tick();
    flushSave();
    if (started) track('heartbeat', activeMs, true);
  };
  const onVisibility = () => {
    const hidden = document.visibilityState === 'hidden';
    if (hidden) flush();
    setPaused('hidden', hidden);
  };
  onVisibility();
  const visibility = new IntersectionObserver(([entry]) => setPaused('offscreen', !entry.isIntersecting));
  visibility.observe(host);

  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    frame,
    destroy() {
      destroyed = true;
      frame.removeEventListener('load', onLoad);
      flush();
      clearInterval(heartbeat);
      visibility.disconnect();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      frame.remove();
    },
  };
}
