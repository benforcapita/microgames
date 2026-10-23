import { previewDocumentPath } from '../../cdn/csp.mjs';

export function gameFrameSrc(
  cdnOrigin: string,
  gameId: string,
  embedOrigin: string,
  save: string,
  previewToken?: string | null,
  bundleVersion?: number,
): string {
  const base = cdnOrigin.replace(/\/$/, '');
  const versioned = bundleVersion !== undefined && Number.isSafeInteger(bundleVersion) && bundleVersion >= 1;
  const embed = `embed=${encodeURIComponent(embedOrigin)}`;
  const hash = `#mgs=${encodeURIComponent(save)}`;
  if (previewToken && versioned) {
    return `${base}${previewDocumentPath(gameId, bundleVersion, previewToken)}?${embed}${hash}`;
  }
  const pt = previewToken ? `&pt=${encodeURIComponent(previewToken)}` : '';
  const doc = versioned ? `${bundleVersion}/index.html` : 'index.html';
  return `${base}/g/${gameId}/${doc}?${embed}${pt}${hash}`;
}
