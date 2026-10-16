-- NM-1: READ-ONLY. Lists every site_content row whose value mentions a money/payment term (same term list as
-- SITE_MONEY_TERM in src/lib/money-claims.ts). Writes nothing. Run with any read-only role, e.g.
--   psql "$DATABASE_URL" -f scripts/sql/site-content-money.sql
with terms as (
  select '(\m(?:pay|pays|paid|paying|payments?|payouts?|paywall|revenue|earn|earns|earned|earning|earnings|moneti[sz]\w*|unmoneti[sz]\w*|money|cash|income|royalt(?:y|ies)|profits?|profitable|dollars?|usd|cents|clawback|clawed|wages?|salary|salaries|pric(?:e|es|ed|ing))\M|[$€£] ?[0-9])'::text as re
)
select c.key,
       c.locale,
       (select string_agg(distinct lower(m[1]), ', ') from regexp_matches(c.value::text, t.re, 'gi') as m) as terms,
       left(c.value::text, 400) as offending_text
from public.site_content c, terms t
where c.value::text ~* t.re
order by c.key, c.locale;
