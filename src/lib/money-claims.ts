// PAY-1: the site must not promise specific creator revenue numbers (percentages or money amounts).
// Finds a % or $ amount within WINDOW characters of 'revenue', 'payout' or 'royalty'.
const WINDOW = 80;
const AMOUNT = /(?:\$\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent\b|usd\b|dollars?\b))/gi;
const TOPIC = /revenue|payout|royalt/i;

export function findMoneyClaims(text: string): string[] {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const m of flat.matchAll(AMOUNT)) {
    const i = m.index ?? 0;
    const around = flat.slice(Math.max(0, i - WINDOW), i + m[0].length + WINDOW);
    if (TOPIC.test(around)) hits.push(around.trim());
  }
  return hits;
}
