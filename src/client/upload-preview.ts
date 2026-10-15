/** Upload-page preview capture. Live play iframes never use this flag. */
export const PREVIEW_WAIT_MS = 8000;
export const PREVIEW_TIMEOUT_COPY = 'No preview captured, upload one.';

export function withPreviewFlag(blobUrl: string): string {
  const url = new URL(blobUrl);
  url.searchParams.set('mg_preview', '1');
  return url.href;
}

export interface PreviewClock {
  schedule: (ms: number, fn: () => void) => number;
  cancel: (id: number) => void;
}

/** Fires `onTimeout` once if no snapshot arrives within PREVIEW_WAIT_MS. */
export function createPreviewWatch(clock: PreviewClock) {
  let timer = 0;
  let settled = false;
  return {
    start(onTimeout: () => void) {
      if (timer) clock.cancel(timer);
      timer = 0;
      settled = false;
      timer = clock.schedule(PREVIEW_WAIT_MS, () => {
        timer = 0;
        if (settled) return;
        settled = true;
        onTimeout();
      });
    },
    arrived() {
      settled = true;
      if (timer) clock.cancel(timer);
      timer = 0;
    },
    stop() {
      settled = true;
      if (timer) clock.cancel(timer);
      timer = 0;
    },
  };
}
