// NM-1: READ-ONLY report of site_content rows that mention a money/payment term (key, locale, terms, text).
// Uses supabase-js REST select only; it has no write path. Same matching as the strict site-copy guard.
// Usage: npm run copy:site-content            # the LOCAL stack (supabase status)
//   PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… npm run copy:site-content -- --allow-remote   # hosted (Ben/EL only)
// SQL equivalent: scripts/sql/site-content-money.sql
import { createClient } from '@supabase/supabase-js';
import { localSupabaseEnv } from './lib/local-supabase.mjs';
import { LOOPBACK } from './lib/thumbs.mjs';
import { findSiteMoneyTerms } from '../src/lib/money-claims.ts';

const args = process.argv.slice(2);
for (const a of args) if (a !== '--allow-remote' && a !== '--json') { console.error(`unknown flag: ${a}`); process.exit(2); }
const useEnv = !!(process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_SECRET_KEY);
const sb = useEnv ? { PUBLIC_SUPABASE_URL: process.env.PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY } : localSupabaseEnv();
if (!sb.PUBLIC_SUPABASE_URL || !sb.SUPABASE_SECRET_KEY) { console.error('need PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY (or none for the local stack)'); process.exit(2); }
const remote = !LOOPBACK.test(sb.PUBLIC_SUPABASE_URL);
if (remote && !args.includes('--allow-remote')) { console.error('refusing non-local Supabase; pass --allow-remote (read-only report).'); process.exit(2); }
console.log(`[site-content] ${remote ? 'REMOTE' : 'local'} ${new URL(sb.PUBLIC_SUPABASE_URL).host} (read-only)`);

const client = createClient(sb.PUBLIC_SUPABASE_URL, sb.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data, error } = await client.from('site_content').select('key, locale, value').order('key').order('locale');
if (error) { console.error(`[site-content] ${error.message}`); process.exit(1); }
const rows = [];
for (const r of data) {
  const text = JSON.stringify(r.value);
  const hits = findSiteMoneyTerms(text);
  if (hits.length) rows.push({ key: r.key, locale: r.locale, terms: [...new Set(hits.map((h) => h.split(':')[0].toLowerCase()))], text: text.slice(0, 400) });
}
if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else for (const r of rows) console.log(`${r.key} [${r.locale}]  terms: ${r.terms.join(', ')}\n    ${r.text}`);
console.log(`[site-content] ${data.length} row(s) scanned, ${rows.length} with money/payment terms`);
