// Game-row access for scripts/capture-thumbs.mjs, in two interchangeable flavours:
//   pgStore   direct Postgres (DATABASE_URL), e.g. the local stack
//   restStore supabase-js / PostgREST over HTTPS (PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY), for boxes
//             that can't reach 5432/6543
// Both expose the same two operations. setThumb is a compare-and-set: it only writes when games.thumb still
// holds the value read at the start, and reports whether it won.

const COLS = 'id, slug, title, thumb, created_at';
const PAGE = 1000;

export function pgStore(sql) {
  return {
    kind: 'pg',
    async list(ids) {
      return sql`
        select id, slug, title, thumb from games
        ${ids ? sql`where id in ${sql(ids)} or slug in ${sql(ids)}` : sql``}
        order by created_at`;
    },
    async setThumb(id, oldThumb, key) {
      const [row] = await sql`
        update games set thumb = ${key}
        where id = ${id} and thumb is not distinct from ${oldThumb ?? null}
        returning id`;
      return Boolean(row);
    },
    end: () => sql.end(),
  };
}

const strip = ({ id, slug, title, thumb }) => ({ id, slug, title, thumb });

export function restStore(client) {
  const table = () => client.from('games');
  const must = ({ data, error }, what) => {
    if (error) throw new Error(`PostgREST ${what} failed: ${error.message}`);
    return data ?? [];
  };
  return {
    kind: 'rest',
    async list(ids) {
      let rows = [];
      if (ids) {
        // Same match as the SQL path: id in (…) or slug in (…).
        rows = [
          ...must(await table().select(COLS).in('id', ids), 'select by id'),
          ...must(await table().select(COLS).in('slug', ids), 'select by slug'),
        ];
      } else {
        for (let from = 0; ; from += PAGE) {
          const page = must(await table().select(COLS).order('created_at').order('id').range(from, from + PAGE - 1), 'select page');
          rows.push(...page);
          if (page.length < PAGE) break;
        }
      }
      const byId = new Map();
      for (const r of rows) byId.set(r.id, r);
      return [...byId.values()]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id))
        .map(strip);
    },
    async setThumb(id, oldThumb, key) {
      let q = table().update({ thumb: key }).eq('id', id);
      q = oldThumb == null ? q.is('thumb', null) : q.eq('thumb', oldThumb);
      return must(await q.select('id'), 'conditional update').length > 0;
    },
    end: async () => {},
  };
}
