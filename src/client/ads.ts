export interface AdProvider {
  /** Resolves true only when the player watched the ad to completion. */
  rewarded(): Promise<boolean>;
  interstitial(): Promise<void>;
}

type AdBreakFn = (opts: Record<string, unknown>) => void;
declare global {
  interface Window {
    adBreak?: AdBreakFn;
    adConfig?: (opts: Record<string, unknown>) => void;
  }
}

/** Google AdSense H5 Games Ads (Ad Placement API). Loaded by the layout when PUBLIC_ADSENSE_CLIENT is set. */
const adsenseProvider = (adBreak: AdBreakFn): AdProvider => ({
  rewarded: () =>
    new Promise((resolve) => {
      let granted = false;
      adBreak({
        type: 'reward',
        name: 'reward',
        beforeReward: (showAdFn: () => void) => showAdFn(),
        adViewed: () => (granted = true),
        adDismissed: () => (granted = false),
        adBreakDone: () => resolve(granted),
      });
    }),
  interstitial: () =>
    new Promise((resolve) => adBreak({ type: 'next', name: 'interstitial', adBreakDone: () => resolve() })),
});

/** Local stand-in so the full pause → ad → reward flow can be exercised without an ad network. */
const mockProvider: AdProvider = {
  rewarded: () => showMock({ seconds: 5, rewarded: true }) as Promise<boolean>,
  interstitial: () => showMock({ seconds: 3, rewarded: false }).then(() => undefined),
};

function showMock({ seconds, rewarded }: { seconds: number; rewarded: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'mg-ad-overlay';
    el.innerHTML = `
      <div class="mg-ad-card">
        <span class="mg-ad-label">${rewarded ? 'Rewarded ad' : 'Ad break'} · placeholder</span>
        <div class="mg-ad-creative">Your sponsor here</div>
        <div class="mg-ad-footer">
          <span class="mg-ad-count"></span>
          ${rewarded ? '<button type="button" class="btn ghost" data-act="skip">Skip (no reward)</button>' : ''}
          <button type="button" class="btn" data-act="claim" hidden>${rewarded ? 'Claim reward' : 'Continue'}</button>
        </div>
      </div>`;
    document.body.append(el);
    const count = el.querySelector<HTMLElement>('.mg-ad-count')!;
    const claim = el.querySelector<HTMLButtonElement>('[data-act="claim"]')!;
    let left = seconds;
    const tick = () => {
      count.textContent = left > 0 ? `${rewarded ? 'Reward' : 'Resuming'} in ${left}s` : 'Done';
      if (left-- <= 0) {
        clearInterval(timer);
        if (rewarded) claim.hidden = false;
        else finish(false);
      }
    };
    const timer = setInterval(tick, 1000);
    tick();
    const finish = (granted: boolean) => {
      clearInterval(timer);
      el.remove();
      resolve(granted);
    };
    claim.addEventListener('click', () => finish(true));
    el.querySelector('[data-act="skip"]')?.addEventListener('click', () => finish(false));
  });
}

export function getAdProvider(): AdProvider {
  return window.adBreak ? adsenseProvider(window.adBreak) : mockProvider;
}
