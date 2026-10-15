export function gameFrameSrc(cdnOrigin: string, gameId: string, embedOrigin: string, save: string): string {
  const base = cdnOrigin.replace(/\/$/, '');
  return `${base}/g/${gameId}/index.html?embed=${encodeURIComponent(embedOrigin)}#mgs=${encodeURIComponent(save)}`;
}
