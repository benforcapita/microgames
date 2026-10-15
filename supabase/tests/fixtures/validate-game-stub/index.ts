// Local test fixture only. Not the EF-1 function and not deployed.
// supabase/tests/serve-validate-game-stub.mjs copies this into place for
// `supabase functions serve`, then deletes the copy.
Deno.serve(async (req) => {
  const body = await req.text();
  console.log(`validate-game stub ${req.method} ${body}`);
  return new Response(JSON.stringify({ ok: true, stub: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
