// PAY-1: the site must not promise specific creator revenue numbers (percentages or money amounts)
// or number-free creator money claims (e.g. earn/make money, cuts of ad revenue, pay per unit, payouts, active monetize).
// Finds a % or $ amount within WINDOW characters of 'revenue', 'payout', 'royalty', 'income' or 'earn'
// ($ amounts also near 'play(s)'), plus number-free money claims.
const WINDOW = 80;
const AMOUNT = /(?:\$\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent\b|usd\b|dollars?\b))/gi;
// % amounts: near revenue/payout/royalty/income/earn. $ amounts: also near play(s) ('$5 per 1,000 plays').
const TOPIC = /revenue|payout|royalt|income|\bearn/i;
const MONEY_TOPIC = /revenue|payout|royalt|income|\bearn|\bplays?\b/i;

// PAY-1: number-free creator money claims.
const NUMBER_FREE: RegExp[] = [
  // earn/make/get money or cash
  /\b(?:earn(?:s|ing)?|make(?:s)?|making|get(?:s|ting)?)\s+(?:(?:real|some|extra)\s+)?(?:money|cash)\b/gi,
  // (a|your) cut/share/slice of (the) (ad|advertising) money/revenue/income/earnings/profit(s)
  /\b(?:cut|share|slice)\s+of\s+(?:the\s+)?(?:(?:ad|advertising)\s+)?(?:money|revenue|income|earnings|profits?)\b/gi,
  // pay/paid per unit
  /(?:\b(?:paid|pays|pay)\b|\$\s?\d[\d,.]*|\b\d[\d,.]*\s*(?:dollars?|usd\b))\s+(?:per|for\s+(?:every|each))\s+(?:plays?|games?|views?|installs?|downloads?)\b/gi,
  // payouts: (daily|weekly|monthly|instant|regular|guaranteed) payout(s) and payout(s) to|for creators|you|developers
  /\b(?:(?:daily|weekly|monthly|instant|regular|guaranteed)\s+payouts?(?:\s+(?:to|for)\s+(?:creators|you|developers))?|payouts?\s+(?:to|for)\s+(?:creators|you|developers))\b/gi,
  // monetize as an active verb
  /\b(?:monetize|monetise|monetizes|monetises|monetizing|monetising)\b/gi,
];

export function findMoneyClaims(text: string): string[] {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const hits: string[] = [];
  const matchedRanges: [number, number][] = [];
  for (const m of flat.matchAll(AMOUNT)) {
    const i = m.index ?? 0;
    const around = flat.slice(Math.max(0, i - WINDOW), i + m[0].length + WINDOW);
    const money = /^\$|usd|dollar/i.test(m[0]);
    if ((money ? MONEY_TOPIC : TOPIC).test(around)) {
      hits.push(around.trim());
      matchedRanges.push([i, i + m[0].length]);
    }
  }
  for (const re of NUMBER_FREE) {
    for (const m of flat.matchAll(re)) {
      const i = m.index ?? 0;
      const end = i + m[0].length;
      if (matchedRanges.some(([s, e]) => Math.max(s, i) < Math.min(e, end))) continue;
      matchedRanges.push([i, end]);
      const around = flat.slice(Math.max(0, i - WINDOW), end + WINDOW);
      hits.push(around.trim());
    }
  }
  return hits;
}

// PAY-1: binding payment promises. Future, non-binding wording ("Revenue sharing for creators is planned") is fine.
const PROMISE = /\b(?:get(?:ting)? paid|(?:start|starts|begin|begins) earning|earn(?:s|ing)? (?:ad )?revenue|we(?:'ll| will)? pay you|pay you your share|your revenue share|earns several times more)\b/gi;

export function findPaymentPromises(text: string): string[] {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return [...flat.matchAll(PROMISE)].map((m) => m[0]);
}
