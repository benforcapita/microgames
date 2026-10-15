// Local test stub only. EF-1 owns the real `validate-game` static check and is not
// on this branch. This handler exists so a pending insert can be shown to reach
// the function. It does not inspect the bundle.
Deno.serve(async (req) => {
  const body = await req.text();
  console.log(`validate-game stub ${req.method} ${body}`);
  return new Response(JSON.stringify({ ok: true, stub: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
