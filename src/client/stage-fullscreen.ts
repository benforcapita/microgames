// Site-level fullscreen for every game. The play page owns the button; this module owns the policy.
// There is no per-game hook: iPhone Safari has no element fullscreen, so a rejected or missing
// requestFullscreen / webkitRequestFullscreen falls back to a CSS stage that covers the viewport.

export const FULLSCREEN_ENTER_LABEL = '⛶ Fullscreen';
export const FULLSCREEN_EXIT_LABEL = '⛶ Exit fullscreen';

const IMMERSIVE_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['width', '100dvw'],
  ['height', '100dvh'],
  ['z-index', '900'],
  ['max-height', 'none'],
  ['aspect-ratio', 'auto'],
  ['border-radius', '0'],
  ['border', '0'],
  ['padding-top', 'env(safe-area-inset-top)'],
  ['padding-right', 'env(safe-area-inset-right)'],
  ['padding-bottom', 'env(safe-area-inset-bottom)'],
  ['padding-left', 'env(safe-area-inset-left)'],
];

const EXIT_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'fixed'],
  ['top', 'max(12px, env(safe-area-inset-top))'],
  ['right', 'max(12px, env(safe-area-inset-right))'],
  ['z-index', '901'],
  ['width', '44px'],
  ['height', '44px'],
  ['padding', '0'],
  ['border', '0'],
  ['border-radius', '999px'],
  ['background', '#11131bcc'],
  ['color', '#fff'],
  ['font', '700 22px/1 system-ui, sans-serif'],
  ['cursor', 'pointer'],
];

type WebkitStage = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void | Promise<void>;
  webkitCancelFullScreen?: () => void | Promise<void>;
};

/** The bits of `screen` this module calls. Real `Screen` satisfies it. */
export interface OrientationScreen {
  orientation?: {
    lock?: (orientation: 'landscape') => Promise<void>;
    unlock?: () => void | Promise<void>;
  };
}

export type FullscreenMode = 'native' | 'css' | 'off';

export interface StageFullscreenController {
  toggle(): Promise<FullscreenMode>;
  destroy(): void;
}

export interface StageFullscreenOptions {
  doc?: Document;
  /** Defaults to the page's `screen`. Pass null to skip orientation lock. */
  screen?: OrientationScreen | null;
}

type Mode = FullscreenMode;

function stageIsLandscape(stage: HTMLElement): boolean {
  // The shared player stage is 16:9. That box is the only landscape signal the player has;
  // there is no per-game orientation setting. A portrait or unlaid-out stage skips the lock.
  return stage.clientHeight > 0 && stage.clientWidth > stage.clientHeight;
}

function webkitDocument(doc: Document): WebkitDocument {
  return doc as WebkitDocument;
}

function nativeElement(doc: Document): Element | null {
  return doc.fullscreenElement ?? webkitDocument(doc).webkitFullscreenElement ?? null;
}

function isNativeActive(doc: Document, stage: HTMLElement): boolean {
  const current = nativeElement(doc);
  return !!current && (current === stage || stage.contains(current));
}

async function tryNative(stage: HTMLElement): Promise<boolean> {
  if (typeof stage.requestFullscreen === 'function') {
    try {
      await stage.requestFullscreen();
      return true;
    } catch {
      // Rejected (or missing a gesture). The prefixed API is the next try.
    }
  }
  const webkit = (stage as WebkitStage).webkitRequestFullscreen;
  if (typeof webkit === 'function') {
    try {
      await webkit.call(stage);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function exitNative(doc: Document): Promise<void> {
  const webkit = webkitDocument(doc);
  const exits = [doc.exitFullscreen?.bind(doc), webkit.webkitExitFullscreen?.bind(webkit), webkit.webkitCancelFullScreen?.bind(webkit)];
  for (const exit of exits) {
    if (typeof exit !== 'function') continue;
    try {
      await exit();
      return;
    } catch {
      // Try the next prefixed exit.
    }
  }
}

async function lockLandscape(screen: OrientationScreen | null): Promise<boolean> {
  const orientation = screen?.orientation;
  if (typeof orientation?.lock !== 'function') return false;
  try {
    await orientation.lock('landscape');
    return true;
  } catch {
    return false;
  }
}

async function unlockOrientation(screen: OrientationScreen | null): Promise<void> {
  const unlock = screen?.orientation?.unlock;
  if (typeof unlock !== 'function') return;
  try {
    await unlock.call(screen?.orientation);
  } catch {
    // Leaving fullscreen must succeed even when the lock cannot be cleared.
  }
}

function remember(el: HTMLElement, names: Iterable<readonly [string, string]>): Map<string, string> {
  const previous = new Map<string, string>();
  for (const [name, value] of names) {
    previous.set(name, el.style.getPropertyValue(name));
    el.style.setProperty(name, value);
  }
  return previous;
}

function restore(el: HTMLElement, previous: Map<string, string>): void {
  for (const [name, value] of previous) {
    if (value) el.style.setProperty(name, value);
    else el.style.removeProperty(name);
  }
}

function defaultScreen(): OrientationScreen | null {
  const host = globalThis as { screen?: OrientationScreen };
  return host.screen ?? null;
}

/**
 * Binds the toolbar button to the shared stage. Native fullscreen is preferred.
 * When the document cannot enter it, the stage is pinned over the page and a visible
 * exit control is added. Escape leaves that fallback. `fullscreenchange` (and the
 * webkit equivalent) keeps the toolbar label in sync when the browser leaves on its own.
 */
export function attachStageFullscreen(
  stage: HTMLElement,
  button: HTMLButtonElement,
  options: StageFullscreenOptions = {},
): StageFullscreenController {
  const doc = options.doc ?? document;
  const screen = options.screen === undefined ? defaultScreen() : options.screen;
  let mode: Mode = 'off';
  let locked = false;
  let exitButton: HTMLButtonElement | null = null;
  let stageStyle: Map<string, string> | null = null;
  let rootOverflow: Map<string, string> | null = null;
  let bodyOverflow: Map<string, string> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let destroyed = false;

  const setActive = (active: boolean) => {
    button.textContent = active ? FULLSCREEN_EXIT_LABEL : FULLSCREEN_ENTER_LABEL;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

  const hideExit = () => {
    exitButton?.remove();
    exitButton = null;
  };

  const clearImmersive = () => {
    delete stage.dataset.immersive;
    if (stageStyle) restore(stage, stageStyle);
    stageStyle = null;
    if (rootOverflow) restore(doc.documentElement, rootOverflow);
    rootOverflow = null;
    if (bodyOverflow) restore(doc.body, bodyOverflow);
    bodyOverflow = null;
    hideExit();
  };

  const showExit = () => {
    if (exitButton) return;
    const control = doc.createElement('button');
    control.type = 'button';
    control.textContent = '×';
    control.setAttribute('aria-label', 'Exit fullscreen');
    for (const [name, value] of EXIT_STYLE) control.style.setProperty(name, value);
    control.addEventListener('click', () => {
      void enqueue(leave);
    });
    doc.body.append(control);
    exitButton = control;
  };

  const applyImmersive = () => {
    stage.dataset.immersive = '1';
    stageStyle = remember(stage, IMMERSIVE_STYLE);
    rootOverflow = remember(doc.documentElement, [['overflow', 'hidden']]);
    bodyOverflow = remember(doc.body, [['overflow', 'hidden']]);
    showExit();
  };

  const releaseLock = async () => {
    if (!locked) return;
    locked = false;
    await unlockOrientation(screen);
  };

  const syncNative = () => {
    if (destroyed) return;
    if (isNativeActive(doc, stage)) {
      if (mode === 'css') clearImmersive();
      mode = 'native';
      setActive(true);
      return;
    }
    if (mode === 'native') {
      mode = 'off';
      setActive(false);
      void releaseLock();
    }
  };

  async function enter(): Promise<FullscreenMode> {
    const landscape = stageIsLandscape(stage);
    const native = await tryNative(stage);
    if (native) {
      mode = 'native';
      setActive(true);
    } else {
      applyImmersive();
      mode = 'css';
      setActive(true);
    }
    if (landscape) locked = await lockLandscape(screen);
    return mode;
  }

  async function leave(): Promise<FullscreenMode> {
    if (mode === 'native' || isNativeActive(doc, stage)) await exitNative(doc);
    clearImmersive();
    mode = 'off';
    setActive(false);
    await releaseLock();
    if (isNativeActive(doc, stage)) {
      mode = 'native';
      setActive(true);
    }
    return mode;
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const onFullscreen = () => syncNative();
  const onKey = (event: Event) => {
    // Cross-origin game frames do not retarget keys to the portal. Escape leaves whichever
    // mode is active when the event reaches this document; the X button covers the rest.
    if (mode === 'off') return;
    if (!('key' in event) || (event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    // exitFullscreen has to start in this event turn. A microtask later, Chromium
    // resolves the call without leaving the fullscreen element.
    if (mode === 'native' || isNativeActive(doc, stage)) {
      const exit = doc.exitFullscreen;
      if (typeof exit === 'function') void exit.call(doc).catch(() => {});
    }
    void enqueue(leave);
  };

  doc.addEventListener('fullscreenchange', onFullscreen);
  doc.addEventListener('webkitfullscreenchange', onFullscreen);
  doc.addEventListener('keydown', onKey);
  setActive(isNativeActive(doc, stage));
  if (isNativeActive(doc, stage)) mode = 'native';

  return {
    toggle() {
      if (destroyed) return Promise.resolve('off');
      const entering = mode === 'off' && !isNativeActive(doc, stage);
      return enqueue(entering ? enter : leave);
    },
    destroy() {
      destroyed = true;
      doc.removeEventListener('fullscreenchange', onFullscreen);
      doc.removeEventListener('webkitfullscreenchange', onFullscreen);
      doc.removeEventListener('keydown', onKey);
      clearImmersive();
      if (mode !== 'off') void releaseLock();
      mode = 'off';
      setActive(false);
    },
  };
}
