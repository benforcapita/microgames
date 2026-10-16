#!/usr/bin/env bash
# verify-meshgrounds helper. Run from the repo root (or a worktree root).
#   vmg.sh up        isolated Supabase stack (edits supabase/config.toml, backs it up)
#   vmg.sh web       build + start portal (WEB port) and game CDN (CDN port), PIDs recorded
#   vmg.sh stop-web  stop only the portal/CDN this script started (frees the ports for smoke/e2e)
#   vmg.sh doctor    read-only health check; exit 0 = worth driving
#   vmg.sh exec -- <cmd...>   run a command with the local stack env injected (never printed)
#   vmg.sh shot <url> <png>   headless Chromium screenshot (+ .aria.txt) of a portal page
#   vmg.sh evidence <name> [file...]  copy files into the run's evidence dir and print its path
#   vmg.sh down      kill only our PIDs, stop only our stack, restore config.toml; evidence is kept
# Env: VMG_PROJECT_ID (default vmg), VMG_PORT_BASE (default 55660, uses BASE..BASE+9),
#      VMG_RUN_ID (default: timestamp, fixed at `up`), VMG_EVIDENCE_ROOT (default /workspace/verify-evidence/meshgrounds)
set -euo pipefail

# Safety: hosted credentials must never reach anything we run.
SCRUBBED=""; for v in MESHGROUNDS_DATABASE_URL MESHGROUNDS_SUPABASE_SECRET_KEY SUPABASE_ACCESS_TOKEN VERCEL_TOKEN; do [ -n "${!v:-}" ] && SCRUBBED="$SCRUBBED $v"; done
unset MESHGROUNDS_DATABASE_URL MESHGROUNDS_SUPABASE_SECRET_KEY SUPABASE_ACCESS_TOKEN VERCEL_TOKEN

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
NODE_BIN=${VMG_NODE_BIN:-/workspace/node22/bin}
export PATH="$NODE_BIN:$PATH"
PID_="${VMG_PROJECT_ID:-vmg}"
BASE=${VMG_PORT_BASE:-55660}
P_API=$BASE P_DB=$((BASE+1)) P_SHADOW=$((BASE+2)) P_POOLER=$((BASE+3)) P_STUDIO=$((BASE+4))
P_MAIL=$((BASE+5)) P_ANALYTICS=$((BASE+6)) P_INSPECT=$((BASE+7)) P_WEB=$((BASE+8)) P_CDN=$((BASE+9))
STATE=/tmp/vmg-state-$PID_
EVROOT=${VMG_EVIDENCE_ROOT:-/workspace/verify-evidence/meshgrounds}
SB=(npx -y supabase@2.120.0)
CFG=supabase/config.toml

die() { echo "[vmg] ERROR: $*" >&2; exit 1; }
run_id() { if [ -s "$STATE/run_id" ]; then cat "$STATE/run_id"; else echo "${VMG_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"; fi; }
evdir() { echo "$EVROOT/$(run_id)"; }
port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

# Loopback env from `supabase status` of OUR project. Refuses non-127.0.0.1. Prints nothing.
load_env() {
  local js; js=$("${SB[@]}" status -o json 2>/dev/null) || die "stack '$PID_' not running (vmg.sh up)"
  js=${js#*\{}; js="{${js%\}*}}"
  eval "$(node -e '
    const s = JSON.parse(process.argv[1]); const P = process.argv[2];
    const ok = (u) => new RegExp("^(http|postgresql)://([^@/]*@)?127\\.0\\.0\\.1:").test(u ?? "");
    if (!ok(s.API_URL) || !ok(s.DB_URL)) { console.log("die \"non-loopback stack refused\""); process.exit(); }
    if (!s.API_URL.endsWith(":"+P)) { console.log("die \"status is not project on port "+P+" (config.toml not ours?)\""); process.exit(); }
    const q = (v) => "\x27" + String(v ?? "").replace(/\x27/g, "") + "\x27";
    const m = { PUBLIC_SUPABASE_URL: s.API_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY: s.PUBLISHABLE_KEY ?? s.ANON_KEY,
      SUPABASE_SECRET_KEY: s.SECRET_KEY ?? s.SERVICE_ROLE_KEY, DATABASE_URL: s.DB_URL, MAILPIT_URL: s.MAILPIT_URL ?? s.INBUCKET_URL };
    for (const [k, v] of Object.entries(m)) console.log("export " + k + "=" + q(v));
  ' "$js" "$P_API")"
  local WEB=http://127.0.0.1:$P_WEB CDN=http://127.0.0.1:$P_CDN
  export HOST=127.0.0.1 PORT=$P_WEB SITE_URL=$WEB MG_CDN_PORT=$P_CDN MG_CDN_ORIGIN=$CDN
  export MG_WEB_ORIGINS="$WEB http://localhost:$P_WEB"
  export SMOKE_WEB_PORT=$P_WEB SMOKE_CDN_PORT=$P_CDN E2E_WEB_PORT=$P_WEB E2E_CDN_PORT=$P_CDN
  export CDN_PREVIEW_SECRET=${CDN_PREVIEW_SECRET:-$(head -c 24 /dev/urandom | base64)}
  export NODE_OPTIONS="${NODE_OPTIONS:-} --experimental-strip-types --disable-warning=ExperimentalWarning"
  case "$DATABASE_URL" in postgresql://*@127.0.0.1:$P_DB/*) ;; *) die "DATABASE_URL not 127.0.0.1:$P_DB";; esac
}

# Safeguard for docs/pr-assets (e2e specs rewrite committed screenshots). `up` snapshots every tracked file's
# current working-tree bytes (pre-existing edits included) + sha256; `down` restores only files whose bytes
# changed during the run, back to that snapshot. Never `git checkout`, so edits made before `up` survive.
ASSETS=docs/pr-assets
snapshot_assets() {
  local snap="$STATE/pr-assets" f; rm -rf "$snap"; mkdir -p "$snap"; : > "$STATE/pr-assets.sha256"
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || { printf 'MISSING  %s\n' "$f" >> "$STATE/pr-assets.sha256"; continue; }
    mkdir -p "$snap/$(dirname "$f")"; cp -p "$f" "$snap/$f"; sha256sum "$f" >> "$STATE/pr-assets.sha256"
  done < <(git ls-files -z -- "$ASSETS")
  echo "[vmg] $ASSETS: snapshot of $(wc -l < "$STATE/pr-assets.sha256") tracked files"
}
restore_assets() {
  local d=$1 man="$STATE/pr-assets.sha256" n=0 sum f
  [ -f "$man" ] || { echo "[vmg] $ASSETS: no snapshot from up; leaving files as they are"; return 0; }
  while read -r sum f; do
    if [ "$sum" = MISSING ]; then
      [ -e "$f" ] && echo "[vmg] warning: $f was missing before up and exists now; left in place"; continue
    fi
    [ -f "$f" ] && [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$sum" ] && continue
    mkdir -p "$d/e2e-pr-assets"; [ -f "$f" ] && cp "$f" "$d/e2e-pr-assets/"
    cp -p "$STATE/pr-assets/$f" "$f"; n=$((n+1)); echo "[vmg] $ASSETS: restored $f to its pre-up state"
  done < "$man"
  echo "[vmg] $ASSETS: $n file(s) changed during the run restored (run copies kept in evidence); pre-up edits untouched"
}

cmd_up() {
  mkdir -p "$STATE"
  [ -f "$STATE/config.toml.orig" ] && die "state exists ($STATE); run vmg.sh down first"
  for p in $(seq "$BASE" $((BASE+9))); do port_busy "$p" && die "port $p already in use (someone else's run?)"; done
  docker ps --format '{{.Names}}' | grep -q "_${PID_}\$" && die "containers for project '$PID_' already running"
  local rid; rid=$(run_id); echo "$rid" > "$STATE/run_id"; mkdir -p "$(evdir)"
  cp "$CFG" "$STATE/config.toml.orig"
  snapshot_assets
  sed -i -E \
    -e "s/^project_id = .*/project_id = \"$PID_\"/" \
    -e "/^\[api\]/,/^\[/ s/^port = .*/port = $P_API/" \
    -e "/^\[db\]/,/^\[/ { s/^port = .*/port = $P_DB/; s/^shadow_port = .*/shadow_port = $P_SHADOW/ }" \
    -e "/^\[db.pooler\]/,/^\[/ s/^port = .*/port = $P_POOLER/" \
    -e "/^\[studio\]/,/^\[/ s/^port = .*/port = $P_STUDIO/" \
    -e "/^\[local_smtp\]/,/^\[/ s/^port = .*/port = $P_MAIL/" \
    -e "/^\[analytics\]/,/^\[/ s/^port = .*/port = $P_ANALYTICS/" \
    -e "s/^inspector_port = .*/inspector_port = $P_INSPECT/" \
    -e "s#^site_url = .*#site_url = \"http://127.0.0.1:$P_WEB\"#" \
    -e "s#^additional_redirect_urls = .*#additional_redirect_urls = [\"http://127.0.0.1:$P_WEB/auth/callback\", \"http://localhost:$P_WEB/auth/callback\"]#" \
    "$CFG"
  grep -q "project_id = \"$PID_\"" "$CFG" || die "config edit failed"
  echo "[vmg] config.toml -> project_id=$PID_ ports $BASE-$((BASE+9)) (original backed up in $STATE)"
  "${SB[@]}" start -x vector,logflare,edge-runtime,imgproxy,realtime 2>&1 | grep -viE 'key|secret|jwt|token' | tee "$STATE/supabase-start.log"
  load_env
  # Ready = migrations applied and seed data loaded, not just "API answers".
  node scripts/seed.mjs --force >"$STATE/seed.log" 2>&1 || { tail -20 "$STATE/seed.log"; die "seed failed"; }
  echo "[vmg] stack up and seeded. evidence dir: $(evdir)"
}

cmd_web() {
  load_env
  for p in "$P_WEB" "$P_CDN"; do port_busy "$p" && die "port $p busy"; done
  [ "${VMG_SKIP_BUILD:-0}" = 1 ] && [ -f dist/server/entry.mjs ] || npx astro build >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; die "build failed"; }
  setsid node scripts/game-cdn.mjs >"$STATE/cdn.log" 2>&1 & echo $! >"$STATE/cdn.pid"
  setsid node dist/server/entry.mjs >"$STATE/web.log" 2>&1 & echo $! >"$STATE/web.pid"
  for i in $(seq 60); do
    curl -fs -o /dev/null "http://127.0.0.1:$P_WEB/login" && curl -fs -o /dev/null "http://127.0.0.1:$P_CDN/g/stk7wr01/index.html" && { echo "[vmg] web ready http://127.0.0.1:$P_WEB  cdn http://127.0.0.1:$P_CDN (pids $(cat "$STATE/web.pid") $(cat "$STATE/cdn.pid"))"; return; }
    sleep 1
  done
  tail -20 "$STATE/web.log" "$STATE/cdn.log"; die "web/cdn not ready"
}

cmd_doctor() {
  local bad=0
  ok() { echo "OK   $*"; }
  no() { echo "FAIL $*"; bad=1; }
  for v in MESHGROUNDS_DATABASE_URL MESHGROUNDS_SUPABASE_SECRET_KEY SUPABASE_ACCESS_TOKEN VERCEL_TOKEN; do [ -z "${!v:-}" ] && ok "$v unset in this process" || no "$v set"; done
  [ -n "$SCRUBBED" ] && echo "INFO scrubbed from caller env:$SCRUBBED (unset them in your shell too before running anything outside vmg.sh)"
  grep -q "^project_id = \"$PID_\"" "$CFG" && ok "config.toml project_id=$PID_" || no "config.toml project_id is not $PID_"
  [ -f "$STATE/config.toml.orig" ] && ok "original config.toml backed up" || no "no backup in $STATE (not started by vmg.sh up)"
  local n; n=$(docker ps --filter "name=_${PID_}\$" --format '{{.Names}}' | wc -l)
  [ "$n" -ge 5 ] && ok "$n containers for project $PID_" || no "only $n containers for $PID_"
  if (load_env) >/dev/null 2>&1; then
    load_env; ok "status loopback: $PUBLIC_SUPABASE_URL db 127.0.0.1:$P_DB"
    curl -fsS -o /dev/null "$PUBLIC_SUPABASE_URL/auth/v1/health" -H "apikey: $PUBLIC_SUPABASE_PUBLISHABLE_KEY" && ok "auth health" || no "auth health"
    curl -fsS -o /dev/null "$MAILPIT_URL/api/v1/messages" && ok "mailpit $MAILPIT_URL" || no "mailpit"
    local out; out=$(node -e '
      const pg = (await import(process.cwd()+"/node_modules/postgres/src/index.js")).default;
      const sql = pg(process.env.DATABASE_URL, { max: 1, connect_timeout: 3 });
      const [g] = await sql`select count(*)::int n, count(*) filter (where stage=${"live"})::int live from public.games`;
      const [m] = await sql`select count(*)::int n from supabase_migrations.schema_migrations`;
      console.log(`games=${g.n} live=${g.live} migrations=${m.n}`); await sql.end();' --input-type=module 2>&1) && ok "db $out" || no "db query: $out"
    local want; want=$(ls supabase/migrations/*.sql | wc -l)
    [[ "$out" == *"migrations=$want"* ]] && ok "all $want migrations applied" || no "expected migrations=$want"
  else no "supabase status for $PID_ (stack down or not loopback)"; fi
  for s in web cdn; do
    local f="$STATE/$s.pid" port; [ $s = web ] && port=$P_WEB || port=$P_CDN
    if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
      ss -ltnpH "( sport = :$port )" | grep -q "pid=$(cat "$f")," && ok "$s pid $(cat "$f") owns :$port" || no "$s :$port not owned by our pid"
    else echo "INFO $s not running (only needed for browser/curl drives; smoke/e2e start their own)"; fi
  done
  echo "INFO rev $(git rev-parse --short HEAD)  evidence $(evdir)"
  return $bad
}

cmd_exec() { [ "${1:-}" = -- ] && shift; load_env; exec "$@"; }

cmd_shot() {
  local url=$1 png=$2
  node --input-type=module -e '
    const { chromium } = await import(process.cwd()+"/node_modules/@playwright/test/index.mjs");
    const b = await chromium.launch({ args: ["--disable-site-isolation-trials"] });
    const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
    const r = await p.goto(process.argv[1], { waitUntil: "networkidle" });
    await p.screenshot({ path: process.argv[2] });
    (await import("node:fs")).writeFileSync(process.argv[2].replace(/\.png$/, ".aria.txt"), await p.locator("body").ariaSnapshot());
    console.log(`[vmg] ${r.status()} ${p.url()} -> ${process.argv[2]}`); await b.close();' "$url" "$png"
}

cmd_evidence() {
  local name=$1; shift; local d; d="$(evdir)/$name"; mkdir -p "$d"
  for f in "$@"; do cp -r "$f" "$d/"; done
  echo "$d"
}

stop_web() {
  for s in web cdn; do
    local f="$STATE/$s.pid"
    if [ -f "$f" ]; then local p; p=$(cat "$f")
      kill -0 "$p" 2>/dev/null && { kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p"; echo "[vmg] stopped $s (pgid $p)"; }
      rm -f "$f"
    fi
  done
}
cmd_stop-web() { stop_web; }
cmd_down() {
  stop_web
  grep -q "^project_id = \"$PID_\"" "$CFG" 2>/dev/null || [ -f "$STATE/config.toml.orig" ] || echo "[vmg] warning: config.toml is not ours and no backup; stopping by --project-id only"
  "${SB[@]}" stop --project-id "$PID_" --no-backup 2>&1 | grep -viE 'key|secret' || true
  if [ -f "$STATE/config.toml.orig" ]; then cp "$STATE/config.toml.orig" "$CFG"; echo "[vmg] config.toml restored"; fi
  git diff --quiet -- "$CFG" && echo "[vmg] config.toml clean vs HEAD" || echo "[vmg] warning: config.toml differs from HEAD"
  local d; d=$(evdir)
  # e2e specs rewrite committed screenshots: restore only what this run changed, from the up snapshot.
  restore_assets "$d"
  [ -d "$STATE" ] && cp "$STATE"/*.log "$d/" 2>/dev/null || true
  rm -rf "$STATE"
  docker ps --format '{{.Names}}' | grep "_${PID_}\$" && echo "[vmg] warning: containers remain" || echo "[vmg] no $PID_ containers left"
  [ -d "$d" ] && echo "[vmg] evidence kept: $d ($(find "$d" -type f | wc -l) files)" || echo "[vmg] no evidence dir"
}

c=${1:-}; shift || true
case "$c" in up|web|stop-web|doctor|exec|shot|evidence|down) "cmd_$c" "$@";; *) sed -n 2,14p "$0"; exit 2;; esac
