/** Upload-page preview capture. The CDN never injects this flag into live games. */
export const PREVIEW_WAIT_MS = 8000;
export const PREVIEW_TIMEOUT_COPY = 'No preview captured, upload one.';

/** Flag script, then boot, inserted at the start of the preview document only. */
export function injectPreview(html: string, bootSource: string): string {
  const tag = `<script>window.__MG_PREVIEW=true</script><script>${bootSource}</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + tag);
  const lead = html.match(/^\s*(<!doctype[^>]*>)?\s*(<html[^>]*>)?/i)?.[0] ?? '';
  return lead + tag + html.slice(lead.length);
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
