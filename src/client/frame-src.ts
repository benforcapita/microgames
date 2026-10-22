export function gameFrameSrc(
  cdnOrigin: string,
  gameId: string,
  embedOrigin: string,
  save: string,
  previewToken?: string | null,
  bundleVersion?: number,
): string {
  const base = cdnOrigin.replace(/\/$/, '');
  const pt = previewToken ? `&pt=${encodeURIComponent(previewToken)}` : '';
  const versioned = bundleVersion !== undefined && Number.isSafeInteger(bundleVersion) && bundleVersion >= 1;
  const doc = versioned ? `${bundleVersion}/index.html` : 'index.html';
  return `${base}/g/${gameId}/${doc}?embed=${encodeURIComponent(embedOrigin)}${pt}#mgs=${encodeURIComponent(save)}`;
}
