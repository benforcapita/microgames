// MG-11: the write shapes that move a game to the live stage. One list shared by the
// static file guard (no-auto-live.test.ts) and the live-DB catalog check
// (no-auto-live.db.test.ts) so a new evasion shape only has to be added once.
// This file is scanned by the guard itself: keep comments and pattern names free of
// the literal shapes the regexes match (they avoid flagging their own escaped
// source, but a plain-language "stage = 'live'" in a comment would hit).

export interface LiveStageWrite {
  /** Short label used in failure messages; must not itself match `re`. */
  name: string;
  re: RegExp;
  /** Only meaningful inside SQL text (plpgsql); the file guard applies it to .sql only. */
  sqlOnly?: boolean;
}

// Each matcher targets a write shape only. Comparisons (`where stage = 'live'`,
// `game.stage === 'live'`, `stage in ('proving','live')`), type unions and read options
// (`listGames({ stage: 'live' })`) must not match — the guard's self-test pins that down.
export const LIVE_STAGE_WRITE_PATTERNS: LiveStageWrite[] = [
  {
    name: 'update set-clause reaching the live stage literal',
    // A set clause whose column list reaches stage := live-literal (first or later
    // column, bare or quoted). The column-list shape keeps `where stage = 'live'` and
    // `set x = '…' where stage = 'live'` from matching.
    re: /\bset\s+(?:[\w."]+\s*=\s*[^,;=]+,\s*)*"?stage"?\s*=\s*'live'/i,
  },
  {
    name: 'update row-value form reaching the live stage literal',
    // Row-value assignment: a parenthesised column list containing stage whose value
    // list contains the live literal. Position-insensitive on purpose — the literal in
    // any slot of a row-value write that touches stage is suspect.
    re: /\bset\s*\(\s*[\w.",\s]*\bstage\b[\w.",\s]*\)\s*=\s*\((?:[^();]|\([^()]*\))*'live'/i,
  },
  {
    name: 'insert into games carrying the live stage literal',
    // Any live literal inside an insert into the games table (column-list or select).
    re: /\binsert\s+into\s+(?:public\.)?games\b[^;]*'live'/i,
  },
  {
    name: 'supabase-js mutation object carrying the live stage literal',
    re: /\.(?:update|insert|upsert)\s*\(\s*\{[^{}]*\bstage\s*:\s*'live'/i,
  },
  {
    name: 'plpgsql := assignment of the live stage literal',
    // `:=` is unambiguously an assignment. Any identifier ending in `stage` (bare,
    // record-qualified like new./rec., or quoted) receiving the literal is flagged.
    re: /[\w."]*stage"?\s*:=\s*'live'/i,
    sqlOnly: true,
  },
  {
    name: 'plpgsql NEW-record assignment of the live stage literal',
    // In plpgsql `=` also assigns. A NEW-record write of the live literal cannot be
    // told apart reliably from a comparison inside IF/WHEN in source text, so both
    // are flagged; the DB check proves the shipped catalog has zero comparisons of
    // this shape.
    re: /\bnew\s*\.\s*"?stage"?\s*=\s*'live'/i,
    sqlOnly: true,
  },
];
