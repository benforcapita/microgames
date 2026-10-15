# Site content (CM-1)

You can change homepage copy and featured games in Supabase without a deploy. Everything lives in two server-only tables and one public bucket:

| Object | Purpose |
| --- | --- |
| `public.site_content` | Copy keyed by `(key, locale)`, stored as a `value jsonb` |
| `public.featured_games` | Games pinned to the homepage hero and Featured row |
| Storage bucket `site-media` (public) | Images referenced from content, such as banner art |

Both tables have RLS on with no policies and no `anon`/`authenticated` grants. Only the server (service role) and the dashboard can read or write them. The portal caches what it reads for about **60 seconds**, so an edit appears within a minute.

## Safety rules (enforced in `src/lib/server/content-core.ts`)
- **Text only.** Values are always rendered as text and never as HTML, so `<b>` shows up literally. Control characters are stripped, and each field is capped at 600 characters.
- **Links** (`link_href`) must be a same-site path (`/games`) or an `https://` URL. Anything else, such as `javascript:` or `//host`, is dropped, and the link label goes with it.
- **Images** (`image_url`) are only accepted from the `site-media` public URL: `<SUPABASE_URL>/storage/v1/object/public/site-media/<path>`. URLs from other origins or buckets, and paths with `..`, are dropped.
- **Missing, empty or invalid** content falls back field by field: requested locale → `en` → the built-in default, which is the copy the site shipped with. If a table doesn't exist yet (`42P01` / `PGRST205`), the site still renders with the defaults.

## Keys

### `home.hero`: homepage hero copy
```json
{
  "eyebrow": "No installs · no engines · just the web",
  "title_before": "The open ground for ",
  "title_accent": "instant 3D",
  "title_after": " web games.",
  "lede": "Hundreds of tiny, strange, brilliant browser games, …"
}
```
`title_accent` is the highlighted part of the headline. Every field is optional, and any field you leave out keeps its default.

### `home.banner`: optional announcement above the hero
```json
{
  "text": "Halloween jam: ship a spooky game by Oct 31",
  "link_label": "Enter the jam",
  "link_href": "/upload",
  "image_url": "<SUPABASE_URL>/storage/v1/object/public/site-media/banners/jam.webp",
  "tone": "promo"
}
```
The banner is **hidden when `text` is empty**, and that's the default. `tone` is `info` (default), `promo` or `warning`. To remove the banner, delete the row or set `text` to `""`.

Locales: add another row with the same `key` and a different `locale` (for example `he`). Only `en` is requested today; other locales are ready for i18n.

## Featured games (`featured_games`)
| Column | Meaning |
| --- | --- |
| `game_id` | `games.id` (PK; the row is deleted if the game is deleted) |
| `position` | Sort order, lowest first. The first visible entry becomes the hero card. |
| `label` | Optional badge text, such as "Staff pick" (max 40 chars). Defaults to "Featured". |
| `starts_at` / `ends_at` | Optional window, with start inclusive and end exclusive; empty means open-ended. |
| `active` | Set it to false to hide the entry without deleting it. |

A featured game is shown only if all of these hold:
- it's active and inside its window
- it's published (`proving` or `live`), so pending, rejected and other hidden stages are skipped
- it is not broken: **≥5 plays with a crash rate above 50%** (`FEATURED_BROKEN_MIN_PLAYS` and `FEATURED_BROKEN_MAX_CRASH_RATE` in `src/lib/server/config.ts`)

With no visible featured games, the homepage keeps its current ordering: the hero shows the top live game and no Featured row appears.

## Editing in the Supabase table editor
1. Open the project's **Table Editor**, then choose `site_content` (or `featured_games`).
2. **Insert row**:
   - `key`: `home.banner`
   - `locale`: `en`
   - `value`: paste the JSON above (the editor validates JSON)
   - leave `updated_at` empty; a trigger keeps it current
3. For images, open **Storage**, then `site-media`, upload the file, and use **Get URL**. That public URL is the only kind `image_url` accepts.
4. Save. The site picks up the change within about a minute.

SQL works too:
```sql
insert into public.site_content (key, locale, value)
values ('home.banner', 'en', '{"text":"Halloween jam is open","link_label":"Enter","link_href":"/upload","tone":"promo"}')
on conflict (key, locale) do update set value = excluded.value;

insert into public.featured_games (game_id, position, label, ends_at)
values ('neon1an3', 1, 'Staff pick', now() + interval '7 days');
```
