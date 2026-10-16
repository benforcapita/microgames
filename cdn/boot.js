/* Meshground runtime — injected into every game bundle by the game CDN.
 * Runs before any game code inside a sandboxed, opaque-origin iframe and gives
 * vibe-coded games zero-code platform features:
 *  - telemetry (first frame, explicit ready, first input, crashes) for the Proving Grounds
 *  - one thumbnail snapshot (__MG_SNAPSHOT) only when window.__MG_PREVIEW === true
 *    (set by the upload page, never by the CDN). Live plays do not capture and do not change WebGL attributes.
 *  - automatic pause (requestAnimationFrame, game clock, WebAudio, media) during ads
 *  - localStorage / sessionStorage / cookie shims (blocked in opaque origins), persisted by the portal
 *  - window.Meshground helper wrapping the postMessage protocol from EXCHANGE_SDK.md
 *    (window.Meshgrounds is kept as an alias for games written before the rebrand)
 */
(function () {
  if (window.__mgBoot) return;
  window.__mgBoot = true;
  var P = window.parent;
  if (!P || P === window) return;
  var post = function (type, data) {
    try { P.postMessage(Object.assign({ type: type }, data || {}), '*'); } catch (e) {}
  };

  /* snapshot-lib */
  var SNAP_MAX_W = 640, SNAP_MAX_H = 360, SNAP_MAX_BYTES = 150 * 1024;
  function fitSnapshotBox(width, height, maxW, maxH) {
    if (!(width > 0) || !(height > 0)) return null;
    var scale = Math.min(1, maxW / width, maxH / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
  function isBlankSample(data) {
    if (!data || data.length < 4) return true;
    var minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0, seen = false;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 16) continue;
      var r = data[i], g = data[i + 1], b = data[i + 2];
      if (!seen) { minR = maxR = r; minG = maxG = g; minB = maxB = b; seen = true; continue; }
      if (r < minR) minR = r; if (g < minG) minG = g; if (b < minB) minB = b;
      if (r > maxR) maxR = r; if (g > maxG) maxG = g; if (b > maxB) maxB = b;
    }
    if (!seen) return true;
    return (maxR - minR) < 12 && (maxG - minG) < 12 && (maxB - minB) < 12;
  }
  function dataUrlByteLength(url) {
    if (typeof url !== 'string') return Infinity;
    var comma = url.indexOf(',');
    if (comma < 0) return Infinity;
    var b64 = url.slice(comma + 1);
    var pad = b64.slice(-2) === '==' ? 2 : b64.slice(-1) === '=' ? 1 : 0;
    return Math.floor(b64.length * 3 / 4) - pad;
  }
  function isWebpUrl(url) { return typeof url === 'string' && url.indexOf('data:image/webp') === 0; }
  function glContextAttrs(type, attrs) {
    if (type !== 'webgl' && type !== 'webgl2' && type !== 'experimental-webgl') return { type: type, attrs: attrs };
    var next = {};
    if (attrs) {
      for (var key in attrs) if (Object.prototype.hasOwnProperty.call(attrs, key)) next[key] = attrs[key];
    }
    next.preserveDrawingBuffer = true;
    return { type: type, attrs: next };
  }
  function drawSnapshot(canvas, width, height, createCanvas) {
    var dest = createCanvas(width, height);
    var ctx = dest.getContext('2d');
    if (!ctx) throw new Error('2d');
    ctx.drawImage(canvas, 0, 0, width, height);
    return { canvas: dest, pixels: ctx.getImageData(0, 0, width, height).data };
  }
  function captureCanvas(canvas, createCanvas) {
    try {
      var box = fitSnapshotBox(canvas.width, canvas.height, SNAP_MAX_W, SNAP_MAX_H);
      if (!box) return { ok: false, reason: 'blank' };
      var painted = drawSnapshot(canvas, box.width, box.height, createCanvas);
      if (isBlankSample(painted.pixels)) return { ok: false, reason: 'blank' };
      var quality = 0.82;
      var dest = painted.canvas;
      var url = dest.toDataURL('image/webp', quality);
      if (!isWebpUrl(url)) url = dest.toDataURL('image/png');
      var guard = 0;
      while (dataUrlByteLength(url) > SNAP_MAX_BYTES && guard < 8) {
        guard++;
        if (isWebpUrl(url) && quality > 0.45) {
          quality = Math.round((quality - 0.15) * 100) / 100;
          url = dest.toDataURL('image/webp', quality);
          continue;
        }
        var shrunk = fitSnapshotBox(Math.max(1, Math.round(box.width * 0.75)), Math.max(1, Math.round(box.height * 0.75)), SNAP_MAX_W, SNAP_MAX_H);
        if (!shrunk) return { ok: false, reason: 'oversize' };
        box = shrunk;
        painted = drawSnapshot(canvas, box.width, box.height, createCanvas);
        if (isBlankSample(painted.pixels)) return { ok: false, reason: 'blank' };
        dest = painted.canvas;
        url = dest.toDataURL('image/webp', quality);
        if (!isWebpUrl(url)) url = dest.toDataURL('image/png');
      }
      if (!url || dataUrlByteLength(url) > SNAP_MAX_BYTES) return { ok: false, reason: 'oversize' };
      return { ok: true, dataUrl: url, type: url.slice(5, url.indexOf(';')) };
    } catch (err) {
      return { ok: false, reason: 'tainted' };
    }
  }
  function snapshotError(reason) {
    if (reason === 'tainted') return 'Could not capture this canvas because it is tainted or the WebGL buffer was cleared. Upload a PNG, JPEG, or WebP thumbnail. WebGL games need { preserveDrawingBuffer: true }.';
    if (reason === 'missing') return 'No canvas was found to capture. Upload a PNG, JPEG, or WebP thumbnail.';
    if (reason === 'oversize') return 'The preview is over 150 KB. Upload a PNG, JPEG, or WebP thumbnail.';
    return 'The captured frame is blank. Upload a PNG, JPEG, or WebP thumbnail.';
  }
  /* end-snapshot-lib */

  // Upload preview only. The CDN never sets this; a live play leaves getContext untouched.
  var capturePreview = window.__MG_PREVIEW === true;
  if (capturePreview) {
    var nativeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      var next = glContextAttrs(type, attrs);
      return nativeGetContext.call(this, type, next.attrs);
    };
  }

  var snapped = false, snapTimer = 0;
  function runSnapshot() {
    if (snapped) return;
    snapped = true;
    clearTimeout(snapTimer);
    var list = document.getElementsByTagName('canvas');
    var best = null, bestArea = 0;
    for (var i = 0; i < list.length; i++) {
      var area = list[i].width * list[i].height;
      if (area > bestArea) { best = list[i]; bestArea = area; }
    }
    if (!best) { post('__MG_SNAPSHOT', { error: snapshotError('missing') }); return; }
    var shot = captureCanvas(best, function (w, h) {
      var el = document.createElement('canvas');
      el.width = w;
      el.height = h;
      return el;
    });
    if (!shot.ok) post('__MG_SNAPSHOT', { error: snapshotError(shot.reason) });
    else post('__MG_SNAPSHOT', { dataUrl: shot.dataUrl, mime: shot.type });
  }
  function scheduleSnapshot(delay) {
    if (!capturePreview || snapped) return;
    clearTimeout(snapTimer);
    if (delay > 0) snapTimer = setTimeout(runSnapshot, delay);
    else snapTimer = setTimeout(function () { rAF(function () { runSnapshot(); }); }, 0);
  }
  // Chromium may never fire rAF in an off-screen cross-origin iframe, so the first-frame
  // trigger above can silently never run. Fall back to a timer once a canvas exists.
  if (capturePreview) {
    setTimeout(function () {
      if (!firstFrame && !readySent && document.getElementsByTagName('canvas').length) runSnapshot();
    }, 3000);
  }

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

  /* ---------- render budget ---------- */
  // Most games do renderer.setPixelRatio(devicePixelRatio). On 3x phones that is 2.25x the pixels of 2x for no
  // visible gain, and the GPU fill cost is what drops frames. Report at most 2; screens at <= 2x are untouched.
  try {
    var MAX_DPR = 2;
    var dprDesc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') || Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio');
    if (dprDesc && dprDesc.get && dprDesc.get.call(window) > MAX_DPR) {
      var nativeDpr = dprDesc.get;
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        get: function () { return Math.min(MAX_DPR, nativeDpr.call(window)); },
      });
    }
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
      if (!firstFrame) {
        firstFrame = true;
        post('__MG_FIRST_FRAME', { ms: Math.round(nativeNow()) });
        if (!readySent) scheduleSnapshot(2000);
      }
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

  // Both event names fire: meshground:* is current, meshgrounds:* is the pre-rebrand name older games listen for.
  var emit = function (name) {
    window.dispatchEvent(new Event('meshground:' + name));
    window.dispatchEvent(new Event('meshgrounds:' + name));
  };
  function pause() {
    if (paused) return;
    paused = true;
    pausedAt = nativeNow();
    contexts.forEach(function (c) { if (c.state === 'running') { c.__mgResume = true; c.suspend(); } });
    media.forEach(function (el) { if (!el.paused) { el.__mgResume = true; el.pause(); } });
    emit('pause');
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
    emit('resume');
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
  // IS-1 input support: a game declares 'mobile' | 'desktop' | 'both' with
  //   <meta name="meshground:input-support" content="both">   or   Meshground.declare({ inputSupport: 'both' })
  // (mirrors src/lib/input-support.ts; the pre-rebrand meta name meshgrounds:input-support is still read).
  // Undeclared reads as 'unknown'.
  var INPUT_SUPPORT = ['mobile', 'desktop', 'both'];
  var parseInputSupport = function (v) {
    v = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return INPUT_SUPPORT.indexOf(v) >= 0 ? v : null;
  };
  var declaredInput = null;
  var metaInput = function () {
    try {
      var m = document.querySelector('meta[name="meshground:input-support"]') || document.querySelector('meta[name="meshgrounds:input-support"]');
      return m ? parseInputSupport(m.getAttribute('content')) : null;
    } catch (e) { return null; }
  };
  window.Meshground = window.Meshgrounds = {
    version: 1,
    // Contract metadata. Unknown keys and invalid values are ignored; returns what is now in effect.
    declare: function (meta) {
      var v = meta && typeof meta === 'object' ? parseInputSupport(meta.inputSupport) : null;
      if (v && v !== declaredInput) {
        declaredInput = v;
        post('__MG_META', { inputSupport: v });
      }
      return { inputSupport: declaredInput || metaInput() || 'unknown' };
    },
    get inputSupport() { return declaredInput || metaInput() || 'unknown'; },
    // Once, when the first playable frame is showing. Games that never call this
    // still report __MG_FIRST_FRAME from the first animation frame.
    ready: function () {
      if (readySent) return;
      readySent = true;
      post('__MG_READY', { ms: Math.round(nativeNow()) });
      scheduleSnapshot(0);
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
    onPause: function (fn) { window.addEventListener('meshground:pause', fn); },
    onResume: function (fn) { window.addEventListener('meshground:resume', fn); },
    get paused() { return paused; },
  };
})();
