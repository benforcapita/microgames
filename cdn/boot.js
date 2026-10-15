/* Meshgrounds runtime — injected into every game bundle by the game CDN.
 * Runs before any game code inside a sandboxed, opaque-origin iframe and gives
 * vibe-coded games zero-code platform features:
 *  - telemetry (first frame, explicit ready, first input, crashes) for the Proving Grounds
 *  - automatic pause (requestAnimationFrame, game clock, WebAudio, media) during ads
 *  - localStorage / sessionStorage / cookie shims (blocked in opaque origins), persisted by the portal
 *  - window.Meshgrounds helper wrapping the postMessage protocol from EXCHANGE_SDK.md
 */
(function () {
  if (window.__mgBoot) return;
  window.__mgBoot = true;
  var P = window.parent;
  if (!P || P === window) return;
  var post = function (type, data) {
    try { P.postMessage(Object.assign({ type: type }, data || {}), '*'); } catch (e) {}
  };

  /* ---------- storage shims ---------- */
  function makeStorage(initial, persist) {
    var map = new Map(Object.entries(initial || {}));
    var timer;
    var flush = function () {
      if (!persist) return;
      clearTimeout(timer);
      timer = setTimeout(function () { post('__MG_STORAGE', { items: Object.fromEntries(map) }); }, 250);
    };
    var api = {
      get length() { return map.size; },
      key: function (i) { var k = Array.from(map.keys())[i]; return k === undefined ? null : k; },
      getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) { map.set(String(k), String(v)); flush(); },
      removeItem: function (k) { map.delete(String(k)); flush(); },
      clear: function () { map.clear(); flush(); },
    };
    return new Proxy(api, {
      get: function (t, p) {
        if (p in t) return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
        return typeof p === 'string' && map.has(p) ? map.get(p) : undefined;
      },
      set: function (t, p, v) { api.setItem(p, v); return true; },
      deleteProperty: function (t, p) { api.removeItem(p); return true; },
      has: function (t, p) { return p in t || map.has(p); },
      ownKeys: function () { return Array.from(map.keys()); },
      getOwnPropertyDescriptor: function (t, p) {
        return map.has(p) ? { value: map.get(p), enumerable: true, configurable: true, writable: true } : undefined;
      },
    });
  }

  var initial = {};
  var m = location.hash.match(/[#&]mgs=([^&]*)/);
  if (m) {
    try { initial = JSON.parse(decodeURIComponent(m[1])) || {}; } catch (e) {}
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
  var local = makeStorage(initial, true);
  var session = makeStorage({}, false);
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return local; } });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return session; } });
    var jar = '';
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () { return jar; },
      set: function (v) { jar = String(v).split(';')[0]; },
    });
  } catch (e) {}

  /* ---------- clock + animation-frame control ---------- */
  var nativeNow = performance.now.bind(performance);
  var rAF = window.requestAnimationFrame.bind(window);
  var cAF = window.cancelAnimationFrame.bind(window);
  var paused = false, pausedAt = 0, pausedTotal = 0, firstFrame = false;
  var held = new Map(), heldId = -1;

  performance.now = function () { return (paused ? pausedAt : nativeNow()) - pausedTotal; };
  window.requestAnimationFrame = function (cb) {
    if (paused) { var id = heldId--; held.set(id, cb); return id; }
    return rAF(function (t) {
      if (!firstFrame) { firstFrame = true; post('__MG_FIRST_FRAME', { ms: Math.round(nativeNow()) }); }
      cb(t - pausedTotal);
    });
  };
  window.cancelAnimationFrame = function (id) { id < 0 ? held.delete(id) : cAF(id); };

  /* ---------- audio tracking ---------- */
  var contexts = new Set(), media = new Set();
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = class extends Orig {
      constructor() { super(...arguments); contexts.add(this); }
    };
    window[name] = Wrapped;
  });
  var nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    media.add(this);
    if (paused) { this.__mgResume = true; return Promise.resolve(); }
    return nativePlay.call(this);
  };

  function pause() {
    if (paused) return;
    paused = true;
    pausedAt = nativeNow();
    contexts.forEach(function (c) { if (c.state === 'running') { c.__mgResume = true; c.suspend(); } });
    media.forEach(function (el) { if (!el.paused) { el.__mgResume = true; el.pause(); } });
    window.dispatchEvent(new Event('meshgrounds:pause'));
  }
  function resume() {
    if (!paused) return;
    pausedTotal += nativeNow() - pausedAt;
    paused = false;
    contexts.forEach(function (c) { if (c.__mgResume) { c.__mgResume = false; c.resume(); } });
    media.forEach(function (el) { if (el.__mgResume) { el.__mgResume = false; nativePlay.call(el).catch(function () {}); } });
    var cbs = Array.from(held.values());
    held.clear();
    cbs.forEach(function (cb) { window.requestAnimationFrame(cb); });
    window.dispatchEvent(new Event('meshgrounds:resume'));
  }

  /* ---------- telemetry ---------- */
  var inputSent = false;
  var onInput = function () {
    if (inputSent) return;
    inputSent = true;
    post('__MG_INPUT');
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) { window.addEventListener(t, onInput, { capture: true, passive: true }); });
  window.addEventListener('error', function (e) {
    if (e instanceof ErrorEvent) post('__MG_CRASH', { message: String(e.message).slice(0, 300) });
  });
  window.addEventListener('webglcontextlost', function () { post('__MG_CRASH', { message: 'webglcontextlost' }); }, true);

  /* ---------- SDK helper ---------- */
  var waiters = [];
  window.addEventListener('message', function (e) {
    if (e.source !== P || !e.data || typeof e.data !== 'object') return;
    var type = e.data.type;
    if (type === 'PAUSE') return pause();
    if (type === 'RESUME') return resume();
    waiters = waiters.filter(function (w) { return !w(type); });
  });
  var waitFor = function (types) {
    return new Promise(function (resolve) {
      waiters.push(function (type) {
        if (types.indexOf(type) === -1) return false;
        resolve(type);
        return true;
      });
    });
  };

  var readySent = false;
  window.Meshgrounds = {
    version: 1,
    // Once, when the first playable frame is showing. Games that never call this
    // still report __MG_FIRST_FRAME from the first animation frame.
    ready: function () {
      if (readySent) return;
      readySent = true;
      post('__MG_READY', { ms: Math.round(nativeNow()) });
    },
    gameOver: function (score) { post('GAME_OVER', { score: score }); },
    levelComplete: function (level, score) { post('LEVEL_COMPLETE', { level: level, score: score }); },
    submitScore: function (score) { post('SUBMIT_SCORE', { score: score }); },
    requestRewardAd: function (placement) {
      var p = waitFor(['REWARD_GRANTED', 'REWARD_DENIED']).then(function (t) { return t === 'REWARD_GRANTED'; });
      post('REQUEST_REWARD_AD', { placement: placement });
      return p;
    },
    adBreak: function () {
      var p = waitFor(['AD_BREAK_DONE']).then(function () {});
      post('REQUEST_AD_BREAK');
      return p;
    },
    onPause: function (fn) { window.addEventListener('meshgrounds:pause', fn); },
    onResume: function (fn) { window.addEventListener('meshgrounds:resume', fn); },
    get paused() { return paused; },
  };
})();
