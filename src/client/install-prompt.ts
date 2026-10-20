// PWA: registers the service worker and, on phones, offers to install Meshground as an app.
// Chromium (Android) fires `beforeinstallprompt`, so the banner's button opens the native install sheet.
// iOS has no install API: the banner explains Share → Add to Home Screen instead.

export const DISMISS_KEY = 'mg:install-dismissed';
/** After "Not now", stay quiet for this long. */
export const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

export type InstallPlatform = 'ios' | 'android' | 'other';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** iPadOS 13+ reports itself as a Mac; touch points tell them apart. */
export function detectPlatform(ua: string, maxTouchPoints = 0): InstallPlatform {
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export function recentlyDismissed(stored: string | null, now = Date.now()): boolean {
  const at = Number(stored);
  return Number.isFinite(at) && at > 0 && now - at < DISMISS_MS;
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {}
}

export function installPwa(): void {
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}), { once: true });
  }

  const banner = document.querySelector<HTMLElement>('[data-install-banner]');
  if (!banner || isStandalone()) return;
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  if (platform === 'other' || recentlyDismissed(readDismissed())) return;

  const installBtn = banner.querySelector<HTMLButtonElement>('[data-install-accept]')!;
  const hide = () => (banner.hidden = true);
  const show = (mode: InstallPlatform) => {
    banner.dataset.mode = mode;
    banner.hidden = false;
  };

  banner.querySelector('[data-install-dismiss]')?.addEventListener('click', () => {
    rememberDismissed();
    hide();
  });

  if (platform === 'ios') {
    show('ios');
    return;
  }

  // Layout.astro's inline head script stashes an event that fired before this module ran.
  const early = window as Window & { __mgInstallEvent?: BeforeInstallPromptEvent };
  let deferred: BeforeInstallPromptEvent | null = early.__mgInstallEvent ?? null;
  if (deferred) show('android');
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    show('android');
  });
  installBtn.addEventListener('click', async () => {
    if (!deferred) return;
    const prompt = deferred;
    deferred = null;
    hide();
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === 'dismissed') rememberDismissed();
  });
  addEventListener('appinstalled', hide);
}
