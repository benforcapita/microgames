// Local test fixture only. Not the EF-1 function and not deployed.
// supabase/tests/serve-validate-game-stub.mjs copies this into place for
// `supabase functions serve`, then deletes the copy.
// Accepts the EF-2 hook contract: JSON {gameId, reason} plus x-meshgrounds-hook.
Deno.serve(async (req) => {
  const hook = req.headers.get("x-meshgrounds-hook");
  let parsed: Record<string, unknown> = {};
  try {
    const json = JSON.parse(await req.text());
    if (json && typeof json === "object" && !Array.isArray(json)) parsed = json;
  } catch {
    parsed = {};
  }
  const gameId = parsed.gameId;
  const reason = parsed.reason;
  const ok = typeof gameId === "string" && gameId.length > 0
    && typeof reason === "string" && reason.length > 0
    && !("game_id" in parsed)
    && typeof hook === "string" && hook.length > 0;
  console.log(
    `validate-game stub ${req.method} ${JSON.stringify({
      gameId,
      reason,
      hook: typeof hook === "string" && hook.length > 0,
    })}`,
  );
  return new Response(JSON.stringify({ ok, stub: true }), {
    status: ok ? 200 : 400,
    headers: { "content-type": "application/json" },
  });
});
