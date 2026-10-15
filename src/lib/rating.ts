export function ratingLabel(avg: number | null | undefined, count: number): string {
  if (!count || count <= 0 || avg == null || !Number.isFinite(avg)) {
    return 'No ratings yet';
  }
  return `★ ${avg.toFixed(1)} · ${count} ${count === 1 ? 'rating' : 'ratings'}`;
}
