/**
 * UP-2b: the Files page upload driver. Each form submit runs sign -> PUT -> finalize:
 * POST /api/games/<slug>/assets/sign mints a one-path signed Storage URL (JSON metadata only),
 * the file bytes PUT straight to Supabase Storage on that URL, then
 * POST /api/games/<slug>/assets/finalize scans the stored bytes and writes the manifest row.
 * File bytes never cross /api — the platform ruleset that blocked them there can't see them.
 *
 * Errors reuse the page's existing flash UI: when an endpoint answers with `flash` query params
 * (the same params assetUploadQuery produces for the old multipart flow) the page reloads with
 * them, so assetFlashMessage renders the identical message; messages without a flash mapping are
 * shown inline in #asset-error. A 401 sends the owner to /login like the old endpoint did.
 */

import { confirmPublicAssetChange } from '../lib/manual-review';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The `flash` param bag an error body may carry: string -> string only, anything else is dropped. */
function parseFlash(value: unknown): Record<string, string> | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const flash: Record<string, string> = {};
  for (const [key, v] of Object.entries(rec)) if (typeof v === 'string') flash[key] = v;
  return Object.keys(flash).length ? flash : null;
}

function apiError(data: unknown, fallback: string): { message: string; flash: Record<string, string> | null } {
  const rec = asRecord(data);
  const message = typeof rec?.message === 'string' && rec.message ? rec.message : fallback;
  return { message, flash: parseFlash(rec?.flash) };
}

function signResult(data: unknown): { path: string; uploadId: string; url: string } | null {
  const rec = asRecord(data);
  if (typeof rec?.path !== 'string' || typeof rec.uploadId !== 'string' || typeof rec.url !== 'string') return null;
  return { path: rec.path, uploadId: rec.uploadId, url: rec.url };
}

function finalizeResult(data: unknown): { path: string; warning: boolean } | null {
  const rec = asRecord(data);
  if (typeof rec?.path !== 'string') return null;
  return { path: rec.path, warning: typeof rec.warning === 'string' && rec.warning.length > 0 };
}

const STORAGE_ERROR = 'The file could not be stored. Try again.';
const NETWORK_ERROR = 'Upload failed. Check your connection and try again.';

/** XHR rather than fetch so the button can show real upload progress on the way to Storage. */
function putSigned(url: string, file: File, onProgress: (pct: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress(Math.round((ev.loaded / ev.total) * 100));
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}

/** Wires every upload form inside the Files page section. No-JS forms stay inert GETs. */
export function wireAssetUploads(root: HTMLElement): void {
  const api = root.dataset.assetsApi;
  const page = root.dataset.assetsPage ?? location.pathname;
  const errorBox = document.getElementById('asset-error');
  if (!api || !errorBox) return;

  const buttons = [...root.querySelectorAll<HTMLButtonElement>('form button[type="submit"]')];
  const toLogin = () => location.assign(`/login?next=${encodeURIComponent(page)}`);
  const toFlash = (query: Record<string, string>) => location.assign(`${page}?${new URLSearchParams(query)}`);
  const showInline = (message: string) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };

  const apiJson = async (url: string, body: unknown): Promise<{ status: number; data: unknown }> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const upload = async (form: HTMLFormElement) => {
    const pathInput = form.querySelector<HTMLInputElement>('input[name="path"]');
    const file = form.querySelector<HTMLInputElement>('input[name="file"]')?.files?.[0];
    const rawPath = (pathInput?.value ?? '').trim();
    const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!btn || !file) return;
    if (!confirmPublicAssetChange(root.dataset.reviewHold === '1', (message) => window.confirm(message))) return;

    const label = btn.textContent ?? '';
    const say = (text: string) => (btn.textContent = text);
    const restore = () => {
      buttons.forEach((b) => (b.disabled = false));
      btn.textContent = label;
    };
    const fail = (data: unknown, fallback = STORAGE_ERROR) => {
      const { message, flash } = apiError(data, fallback);
      if (flash) toFlash(flash);
      else {
        showInline(message);
        restore();
      }
    };

    buttons.forEach((b) => (b.disabled = true));
    errorBox.hidden = true;
    try {
      say('Uploading…');
      const signed = await apiJson(`${api}/sign`, {
        path: rawPath,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
      });
      if (signed.status === 401) return toLogin();
      if (signed.status !== 200) return fail(signed.data);
      const target = signResult(signed.data);
      if (!target) return fail(null);

      const put = await putSigned(target.url, file, (pct) => say(pct < 100 ? `Uploading… ${pct}%` : 'Saving…'));
      if (put < 200 || put >= 300) return toFlash({ error: 'storage' });

      say('Saving…');
      const done = await apiJson(`${api}/finalize`, { path: target.path, uploadId: target.uploadId });
      if (done.status === 401) return toLogin();
      if (done.status !== 200) return fail(done.data);
      const stored = finalizeResult(done.data);
      if (!stored) return fail(null);
      toFlash(stored.warning ? { uploaded: stored.path, warn: '1' } : { uploaded: stored.path });
    } catch {
      showInline(NETWORK_ERROR);
      restore();
    }
  };

  for (const form of root.querySelectorAll<HTMLFormElement>('form')) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void upload(form);
    });
  }
}
