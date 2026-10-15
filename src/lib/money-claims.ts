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
];

// FINDER-3 rules. Only these (plus the monetize verb, see below) honour a direct negation.
// The monetize verb rule predates FINDER-3 but lives here so 'We will never monetize your data' / 'no monetize button'
// stay allowed while 'No code needed, monetize your game today' is still flagged (clause boundary).
const NEGATABLE: RegExp[] = [
  // monetize as an active verb
  /\b(?:monetize|monetise|monetizes|monetises|monetizing|monetising)\b/gi,
  /\bfree\s+money\b/gi,
  /\bpaid\s+out\b/gi,
  /\brevenue\s+share\b/gi, // not "revenue sharing" (the planned, non-binding wording)
  /\bwe\s+share\s+(?:the\s+)?(?:ad|advertising)\s+revenue\b/gi,
  /\bwe\s+pay\s+(?:our\s+)?(?:creators|developers|you)\b/gi,
  /\byou(?:'ll|\s+will)\s+(?:be|get)\s+paid\b/gi,
  /\bcreators\s+(?:can\s+|will\s+)?earn\b/gi,
  /\bcash\s+out\s+(?:your\s+)?(?:earnings|revenue|money)\b/gi,
  /\bprofit\s+from\b/gi,
  /\bincome\b/gi,
  /\broyalt(?:y|ies)\b/gi,
  /\bmoneti[sz]ation\b/gi,
  // non-blocking extras
  /\bget\s+a\s+cut\b/gi,
  /\bearn\s+\$\$/gi,
  /\bearn\s+rewards\b/gi,
  /\bmoney[-\s]making\b/gi,
];

// A negation counts only inside the same clause (look-back stops at . : , ! ?) and directly before the term,
// with at most a little filler between ('never monetize', 'will never ever monetize', "don't take royalties").
const NEGATION_WORD = /^(?:no|never|not|don'?t|won'?t)$/i;
const FILLER = /^(?:will|ever|a|an|any|the|be|take)$/i;
const negated = (flat: string, i: number) => {
  const clause = flat.slice(0, i).split(/[.:,!?]/).pop() ?? '';
  const words = clause.trim().split(/\s+/).filter(Boolean);
  while (words.length && FILLER.test(words[words.length - 1])) words.pop();
  return words.length > 0 && NEGATION_WORD.test(words[words.length - 1]);
};

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
      // The whole reported window counts as matched, so a topic word inside it (e.g. '10% royalty') isn't reported twice.
      matchedRanges.push([Math.max(0, i - WINDOW), i + m[0].length + WINDOW]);
    }
  }
  const scan = (re: RegExp, honourNegation: boolean) => {
    for (const m of flat.matchAll(re)) {
      const i = m.index ?? 0;
      const end = i + m[0].length;
      if (matchedRanges.some(([s, e]) => Math.max(s, i) < Math.min(e, end))) continue;
      if (honourNegation && negated(flat, i)) continue;
      matchedRanges.push([i, end]);
      hits.push(flat.slice(Math.max(0, i - WINDOW), end + WINDOW).trim());
    }
  };
  for (const re of NUMBER_FREE) scan(re, false);
  for (const re of NEGATABLE) scan(re, true);
  return hits;
}

// PAY-1: binding payment promises. Future, non-binding wording ("Revenue sharing for creators is planned") is fine.
const PROMISE = /\b(?:get(?:ting)? paid|(?:start|starts|begin|begins) earning|earn(?:s|ing)? (?:ad )?revenue|we(?:'ll| will)? pay you|pay you your share|your revenue share|earns several times more)\b/gi;

export function findPaymentPromises(text: string): string[] {
  const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return [...flat.matchAll(PROMISE)].map((m) => m[0]);
}
