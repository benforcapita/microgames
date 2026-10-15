// IS-4: backfill games.input_support by running the IS-2 classifier (static-check) over each game's stored
// `<id>/index.html`. REST mode only (supabase-js: PostgREST + Storage), like capture-thumbs' REST mode.
//
// Usage: npm run backfill:input [-- --apply] [--ids a,b] [--force] [--allow-remote] [--yes]
//   default        DRY RUN: read + classify + report what would change; writes nothing
//   --apply        actually write games.input_support (--dry-run, if also given, wins)
//   scope          every game whose input_support is still 'unknown'
//   --ids          comma-separated game ids only (each must match ^[A-Za-z0-9_-]{1,32}$, else the run aborts)
//   --force        also recompute rows that already have a class
// Connection: none of PUBLIC_SUPABASE_URL / DATABASE_URL / SUPABASE_SECRET_KEY set -> the LOCAL stack from
// `supabase status`. Otherwise PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY (DATABASE_URL is ignored).
// A non-loopback target needs --allow-remote AND typing the project ref at the prompt (or --yes).
// Each update is compare-and-set on the value read at the start, so a concurrent validate-game write wins.
import readline from 'node:readline/promises';
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from './lib/local-supabase.mjs';
import { parseArgs, planRow, resolveTarget, summarize } from './lib/backfill-input.mjs';
import { analyzeGame } from '../src/lib/server/static-check.ts';

const log = (...a) => console.log('[backfill-input]', ...a);
const die = (msg, code = 2) => { console.error(`[backfill-input] ${msg}`); process.exit(code); };

const args = parseArgs(process.argv.slice(2));
if (args.error) die(args.error);
const target = resolveTarget(process.env, args);
if (target.error) die(target.error);
const sb = target.mode === 'local' ? localSupabaseEnv() : target.env;
log(`target: ${target.mode === 'remote' ? `REMOTE project ${target.ref}` : new URL(sb.PUBLIC_SUPABASE_URL).host} via REST${args.dryRun ? ' (DRY RUN, read-only; pass --apply to write)' : ' (APPLY: will write)'}`);
if (target.mode === 'remote' && target.needConfirm) {
  if (!process.stdin.isTTY) die('remote run needs confirmation: type the project ref interactively or pass --yes.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type the project ref (${target.ref}) to continue: `)).trim();
  rl.close();
  if (typed !== target.ref) die('confirmation did not match; aborting.');
}

const client = createClient(sb.PUBLIC_SUPABASE_URL, sb.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const bucket = client.storage.from('games');

async function listGames() {
  const rows = [];
  for (let from = 0; ; from += 500) {
    let q = client.from('games').select('id, slug, title, input_support').order('id').range(from, from + 499);
    if (args.ids) q = q.in('id', args.ids); // ids validated against GAME_ID_RE in parseArgs; no raw filter strings
    else if (!args.force) q = q.eq('input_support', 'unknown');
    const { data, error } = await q;
    if (error) die(`list games: ${error.message}`, 1);
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

const games = await listGames();
if (args.ids) for (const id of args.ids) if (!games.some((g) => g.id === id)) log(`not found: ${id}`);
log(`${games.length} game(s) to check`);
const results = [];
for (const g of games) {
  const { data, error } = await bucket.download(`${g.id}/index.html`);
  if (error || !data) { log(`missing ${g.id} (${g.title}): no index.html`); results.push({ action: 'missing' }); continue; }
  const report = analyzeGame(new Uint8Array(await data.arrayBuffer()));
  const plan = planRow(g.input_support, report.inputSupport?.class, args.force);
  results.push(plan);
  const sig = Object.entries(report.inputSupport?.signals ?? {}).filter(([, v]) => v).map(([k]) => k).join('+') || 'none';
  if (plan.action !== 'update') { log(`${plan.action} ${g.id} (${g.title}): ${plan.from}${plan.reason ? ` (${plan.reason})` : ''} [${sig}]`); continue; }
  if (args.dryRun) { log(`would update ${g.id} (${g.title}): ${plan.from} -> ${plan.to} [${sig}]`); continue; }
  const { data: upd, error: ue } = await client.from('games').update({ input_support: plan.to }).eq('id', g.id).eq('input_support', g.input_support).select('id');
  if (ue) die(`update ${g.id}: ${ue.message}`, 1);
  if (!upd.length) { log(`changed concurrently, left as is: ${g.id}`); plan.action = 'skip'; continue; }
  log(`updated ${g.id} (${g.title}): ${plan.from} -> ${plan.to} [${sig}]`);
}
const s = summarize(results);
log(`${args.dryRun ? 'dry run: would update' : 'updated'} ${s.update}, unchanged ${s.same}, skipped ${s.skip}, missing ${s.missing}`);
if (args.dryRun && s.update) log('nothing was written; re-run with --apply to write.');
