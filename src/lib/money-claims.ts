// PAY-1: the site must not promise specific creator revenue numbers (percentages or money amounts).
// Finds a % or $ amount within WINDOW characters of 'revenue', 'payout', 'royalty', 'income' or 'earn'
// ($ amounts also near 'play(s)').
const WINDOW = 80;
const AMOUNT = /(?:\$\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent\b|usd\b|dollars?\b))/gi;
// % amounts: near revenue/payout/royalty/income/earn. $ amounts: also near play(s) ('$5 per 1,000 plays').
const TOPIC = /revenue|payout|royalt|income|\bearn/i;
const MONEY_TOPIC = /revenue|payout|royalt|income|\bearn|\bplays?\b/i;

export function findMoneyClaims(text: string): string[] {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const hits: string[] = [];
  for (const m of flat.matchAll(AMOUNT)) {
    const i = m.index ?? 0;
    const around = flat.slice(Math.max(0, i - WINDOW), i + m[0].length + WINDOW);
    const money = /^\$|usd|dollar/i.test(m[0]);
    if ((money ? MONEY_TOPIC : TOPIC).test(around)) hits.push(around.trim());
  }
  return hits;
}

// PAY-1: binding payment promises. Future, non-binding wording ("Revenue sharing for creators is planned") is fine.
const PROMISE = /\b(?:get(?:ting)? paid|(?:start|starts|begin|begins) earning|earn(?:s|ing)? (?:ad )?revenue|we(?:'ll| will)? pay you|pay you your share|your revenue share|earns several times more)\b/gi;

export function findPaymentPromises(text: string): string[] {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return [...flat.matchAll(PROMISE)].map((m) => m[0]);
}
