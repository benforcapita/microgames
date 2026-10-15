export function gameFrameSrc(cdnOrigin: string, gameId: string, embedOrigin: string, save: string, previewToken?: string | null): string {
  const base = cdnOrigin.replace(/\/$/, '');
  const pt = previewToken ? `&pt=${encodeURIComponent(previewToken)}` : '';
  return `${base}/g/${gameId}/index.html?embed=${encodeURIComponent(embedOrigin)}${pt}#mgs=${encodeURIComponent(save)}`;
}
