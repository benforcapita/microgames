import { getAdProvider } from './ads';
import { gameFrameSrc } from './frame-src';

export interface PlayerGame {
  id: string;
  title: string;
  stage: 'proving' | 'live';
}

export interface PlayerOptions {
  cdnOrigin: string;
  /** Persist the game's localStorage to the signed-in user's Supabase cloud save instead of this browser. */
  cloudSaves?: boolean;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
  /** SP-6: owner preview token for their own pending/rejected game (the CDN 404s those otherwise). */
  previewToken?: string | null;
}

export interface PlayerHandle {
  frame: HTMLIFrameElement;
  destroy(): void;
}

const MAX_SAVE_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const CLOUD_SAVE_DEBOUNCE_MS = 1500;

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
  frame.setAttribute('allow', 'autoplay; gamepad; accelerometer; gyroscope');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  host.replaceChildren(frame);
  frame.focus();

  let destroyed = false;
  let srcSet = false;
  let sessionStartTracked = false;

  const onLoad = () => {
    frame.focus();
    if (!destroyed && srcSet && !sessionStartTracked) {
      sessionStartTracked = true;
      track('session_start');
    }
  };
  frame.addEventListener('load', onLoad);

  loadSave(game.id, saveKey, !!opts.cloudSaves).then((save) => {
    if (!destroyed) {
      srcSet = true;
      frame.src = gameFrameSrc(opts.cdnOrigin, game.id, location.origin, save, opts.previewToken);
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
    if (!opts.cloudSaves) return localStorage.setItem(saveKey, json);
    pendingSave = json;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, CLOUD_SAVE_DEBOUNCE_MS);
  };

  const post = (type: string, data: Record<string, unknown> = {}) => frame.contentWindow?.postMessage({ type, ...data }, '*');

  let started = false, completed = false, crashed = false, ready = false, adInFlight = false;
  let activeMs = 0, lastTick = performance.now();

  const runAd = async <T>(show: () => Promise<T>, fallback: T): Promise<T> => {
    if (!monetized || adInFlight) return fallback;
    adInFlight = true;
    post('PAUSE');
    try {
      return await show();
    } catch {
      return fallback;
    } finally {
      adInFlight = false;
      lastTick = performance.now();
      post('RESUME');
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
        if (!crashed) (crashed = true), track('crash');
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

  const tick = () => {
    const now = performance.now();
    if (document.visibilityState === 'visible' && !adInFlight) activeMs += now - lastTick;
    lastTick = now;
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
  const onVisibility = () => (document.visibilityState === 'hidden' ? flush() : (lastTick = performance.now()));

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
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      frame.remove();
    },
  };
}
