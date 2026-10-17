// AS-5 fixture: proves the game can load its own .js/.css/.png/.wasm, and cannot read another game's assets.
window.__as5 = (async () => {
  const r = { js: true };
  r.css = getComputedStyle(document.body).backgroundColor === 'rgb(1, 2, 3)';
  const img = document.getElementById('sprite');
  r.png = await new Promise((ok) => (img.complete ? ok(img.naturalWidth === 1) : (img.onload = () => ok(true), img.onerror = () => ok(false))));
  try {
    const { instance } = await WebAssembly.instantiateStreaming(fetch('add.wasm'));
    r.wasm = instance.exports.add(2, 3) === 5;
  } catch (e) { r.wasm = false; r.wasmError = String(e); }
  const other = new URL(location.href.replace(/\/g\/[^/]+\//, '/g/othergm1/')).href.replace(/[^/]+$/, 'secret.js');
  try { await fetch(other); r.otherFetch = 'loaded'; } catch { r.otherFetch = 'blocked'; }
  r.otherScript = await new Promise((ok) => {
    const s = document.createElement('script');
    s.src = other; s.onload = () => ok('loaded'); s.onerror = () => ok('blocked');
    document.head.appendChild(s);
  });
  return r;
})();
