/*
 * Orbit — a TV launcher where your apps are worlds.
 *
 *  Gravity     planets grow with how much you actually use them
 *  Tide        the "Now" ring reshapes itself around your habits for this hour & day
 *  Living sky  real sun / moon / stars for your time of day (and moon phase)
 *  Spells      press BACK (or MENU) on the home screen and draw a D-pad pattern to launch an app
 *  Roulette    ⏯ spins the universe and lets it pick for you
 *  Wind-down   after bedtime the sky warms, and launching asks for one breath first
 *  Drift       idle screen fades to a calm clock
 *
 * Everything stays on the box. No accounts, no network.
 * Written for old TV WebViews too: no optional chaining, no flex gap.
 */
(function () {
  'use strict';

  var NATIVE = window.OrbitNative || null;
  function $(s) { return document.querySelector(s); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ------------------------------------------------------------------ storage
  var DEFAULTS = { history: [], pins: [], hidden: [], spells: {}, bedtime: 23, lat: 51.5 };
  function loadStore() {
    try {
      var raw = NATIVE ? NATIVE.load('store') : localStorage.getItem('orbit.store');
      if (raw) {
        var s = JSON.parse(raw), out = JSON.parse(JSON.stringify(DEFAULTS));
        for (var k in s) out[k] = s[k];
        return out;
      }
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  var store = loadStore();
  var saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    var s = JSON.stringify(store);
    try { if (NATIVE) NATIVE.save('store', s); else localStorage.setItem('orbit.store', s); } catch (e) {}
  }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }

  // ------------------------------------------------------------------ apps
  var apps = [], appBy = {}, colorCache = {};
  function loadApps() {
    var list = [];
    try { list = NATIVE ? JSON.parse(NATIVE.getApps()) : mockApps(); } catch (e) { list = []; }
    list.sort(function (a, b) { return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1; });
    apps = list; appBy = {};
    list.forEach(function (a) { appBy[a.pkg] = a; a.color = colorCache[a.pkg] || null; });
  }
  function isHidden(p) { return store.hidden.indexOf(p) >= 0; }
  function isPinned(p) { return store.pins.indexOf(p) >= 0; }
  function spellFor(p) { for (var k in store.spells) if (store.spells[k] === p) return k; return null; }

  // average saturated colour of an icon → planet atmosphere
  var colorCanvas = document.createElement('canvas'); colorCanvas.width = colorCanvas.height = 16;
  var colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  function extractColor(item) {
    var img = item.img;
    if (!img || colorCache[item.pkg]) { if (colorCache[item.pkg]) applyColor(item, colorCache[item.pkg]); return; }
    var run = function () {
      try {
        var c = colorCtx; c.clearRect(0, 0, 16, 16); c.drawImage(img, 0, 0, 16, 16);
        var d = c.getImageData(0, 0, 16, 16).data, r = 0, g = 0, b = 0, w = 0;
        for (var i = 0; i < d.length; i += 4) {
          var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          var sat = mx ? (mx - mn) / mx : 0, wt = (d[i + 3] / 255) * (0.15 + sat * sat) * (mx / 255);
          r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
        }
        if (w > 0) {
          var col = 'rgb(' + Math.round(r / w) + ',' + Math.round(g / w) + ',' + Math.round(b / w) + ')';
          colorCache[item.pkg] = col; applyColor(item, col);
        }
      } catch (e) {}
    };
    if (img.complete && img.naturalWidth) run(); else img.addEventListener('load', run);
  }
  function applyColor(item, col) { if (item.el) item.el.style.setProperty('--c', col); if (appBy[item.pkg]) appBy[item.pkg].color = col; }

  // ------------------------------------------------------------------ tide (habit model)
  function isWeekend(d) { var x = d.getDay(); return x === 0 || x === 6; }
  function hourOf(d) { return d.getHours() + d.getMinutes() / 60; }
  function hourDist(a, b) { var d = Math.abs(a - b); return Math.min(d, 24 - d); }

  function tide() {
    var now = Date.now(), d = new Date(now), h = hourOf(d), we = isWeekend(d), dow = d.getDay();
    var score = {}, month = {}, last = {}, band = {}, bandDow = {};
    store.history.forEach(function (e) {
      if (!appBy[e.p]) return;
      var ed = new Date(e.t), age = (now - e.t) / 864e5;
      var dh = hourDist(hourOf(ed), h), sameType = isWeekend(ed) === we;
      var wTime = Math.exp(-(dh * dh) / (2 * 1.6 * 1.6)) * (sameType ? 1 : 0.45);
      score[e.p] = (score[e.p] || 0) + Math.pow(0.5, age / 21) * (wTime + 0.12);
      if (age <= 30) month[e.p] = (month[e.p] || 0) + 1;
      last[e.p] = Math.max(last[e.p] || 0, e.t);
      if (age <= 60 && dh <= 1.5 && sameType) {
        band[e.p] = (band[e.p] || 0) + 1;
        if (ed.getDay() === dow) bandDow[e.p] = (bandDow[e.p] || 0) + 1;
      }
    });
    return { score: score, month: month, last: last, band: band, bandDow: bandDow };
  }

  // ------------------------------------------------------------------ rings
  var ICONS = {
    roulette: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2" fill="#fff"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
    spellbook: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h13"/><path d="M12 7l1 2.2 2.4.3-1.8 1.6.5 2.4L12 12.3 9.9 13.5l.5-2.4-1.8-1.6 2.4-.3z"/></svg>',
    bedtime: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/><path d="M15 4h3l-3 3h3"/></svg>',
    unhide: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    forget: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>'
  };
  var BEDTIMES = [null, 21, 22, 23, 0, 1];
  function bedLabel(b) { return b === null ? 'Off' : (b < 10 ? '0' : '') + b + ':00'; }

  function toolItems() {
    return [
      { tool: 'roulette', label: 'Roulette', sub: 'Can’t decide? Let the universe choose', c: '#3b1450', c2: '#b04fd6' },
      { tool: 'spellbook', label: 'Spellbook', sub: Object.keys(store.spells).length + ' spells bound', c: '#141a4d', c2: '#5d6dff' },
      { tool: 'bedtime', label: 'Bedtime · ' + bedLabel(store.bedtime), sub: 'OK to change · after this the sky warms and launching asks for a breath', c: '#3d1a0c', c2: '#e2763a' },
      { tool: 'unhide', label: 'Hidden worlds · ' + store.hidden.length, sub: 'OK to bring every hidden app back into orbit', c: '#0d2d2a', c2: '#2fb39b' },
      { tool: 'forget', label: 'Forget my habits', sub: 'Clears launch history — the tide starts fresh', c: '#2a2a2a', c2: '#8a8a8a' },
      { tool: 'settings', label: 'Android settings', sub: 'System settings for this box', c: '#14212e', c2: '#4b84b8' }
    ];
  }

  var rings = [], ri = 0, T = null;
  function buildRings() {
    T = tide();
    var visible = apps.filter(function (a) { return !isHidden(a.pkg); });
    var maxMonth = 1; for (var k in T.month) maxMonth = Math.max(maxMonth, T.month[k]);
    function gravity(p) { return 0.82 + 0.5 * Math.log(1 + (T.month[p] || 0)) / Math.log(1 + maxMonth); }
    function asItem(a) { return { pkg: a.pkg, label: a.label, icon: a.icon, g: gravity(a.pkg) }; }

    var now = [];
    store.pins.forEach(function (p) { if (appBy[p] && !isHidden(p)) now.push(appBy[p]); });
    var ranked = visible.filter(function (a) { return !isPinned(a.pkg) && T.score[a.pkg]; })
      .sort(function (a, b) { return T.score[b.pkg] - T.score[a.pkg]; });
    ranked.forEach(function (a) { if (now.length < 9) now.push(a); });
    visible.forEach(function (a) { if (now.length < 7 && now.indexOf(a) < 0) now.push(a); });

    rings = [
      { name: 'Now', items: now.map(asItem) },
      { name: 'All worlds', items: visible.map(asItem) },
      { name: 'Tools', items: toolItems().map(function (t) { t.g = 0.92; return t; }) }
    ];
    rings.forEach(function (r) { r.target = 0; });
  }

  function itemId(it) { return it ? (it.pkg || ('tool:' + it.tool)) : null; }
  function rebuild(keepFocus) {
    var keep = keepFocus ? itemId(focused()) : null, keepTargets = rings.map(function (r) { return r.target; });
    buildRings();
    rings.forEach(function (r, i) { if (keepTargets[i] !== undefined && i !== ri) r.target = Math.round(keepTargets[i]); });
    var R = rings[ri], idx = 0;
    if (keep) for (var i = 0; i < R.items.length; i++) if (itemId(R.items[i]) === keep) idx = i;
    R.target = idx; pos = idx;
    renderRing(); renderRingNames(); updateLabel();
  }

  // ------------------------------------------------------------------ orbit rendering
  var orbitEl = $('#orbit'), pos = 0, spin = null, dirty = true;

  function renderRing() {
    orbitEl.innerHTML = '';
    var track = document.createElement('div'); track.className = 'track'; orbitEl.appendChild(track);
    var R = rings[ri];
    R.items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'planet' + (it.tool ? ' tool' : '') + (it.pkg && isPinned(it.pkg) ? ' pinned' : '');
      var inner = '<div class="atmo"></div><div class="body">';
      if (it.tool) inner += ICONS[it.tool];
      else inner += '<img src="' + esc(it.icon) + '" alt="">';
      inner += '</div><div class="halo"></div>';
      if (it.pkg && spellFor(it.pkg)) inner += '<div class="moon"></div>';
      el.innerHTML = inner;
      if (it.tool) { el.style.setProperty('--c', it.c); el.style.setProperty('--c2', it.c2); }
      orbitEl.appendChild(el);
      it.el = el;
      if (it.pkg) { it.img = el.querySelector('img'); extractColor(it); }
    });
    dirty = true;
  }

  function geometry() {
    var W = window.innerWidth, H = window.innerHeight;
    return { W: W, H: H, cx: W / 2, cy: H * 0.44, rx: W * 0.40, ry: H * 0.25, base: H * 0.15 };
  }

  function layout() {
    var R = rings[ri]; if (!R) return;
    var n = R.items.length, G = geometry();
    var track = orbitEl.querySelector('.track');
    if (track) {
      track.style.left = (G.cx - G.rx) + 'px'; track.style.top = (G.cy - G.ry) + 'px';
      track.style.width = (G.rx * 2) + 'px'; track.style.height = (G.ry * 2) + 'px';
    }
    if (!n) return;
    var full = n <= 13, step = full ? (2 * Math.PI / n) : (2 * Math.PI / 22);
    for (var i = 0; i < n; i++) {
      var it = R.items[i], el = it.el, k = i - pos;
      if (n > 1) { k = mod(k, n); if (k > n / 2) k -= n; } else k = 0;
      if (!full && Math.abs(k) > 9.5) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
      if (el.style.display === 'none') el.style.display = '';
      // open a little extra space either side of the focused world
      var th = Math.PI / 2 + step * (k + 0.75 * clamp(k, -1, 1));
      var x = G.cx + G.rx * Math.cos(th), y = G.cy + G.ry * Math.sin(th), depth = Math.sin(th);
      var front = (depth + 1) / 2;
      var boost = 1 + 0.32 * Math.max(0, 1 - Math.abs(k));
      var sc = (0.36 + 0.64 * Math.pow(front, 1.5)) * (it.g || 1) * boost * (full ? 1 : 0.85);
      var op = clamp(0.22 + 0.78 * front, 0, 1);
      if (!full) op *= clamp(1 - Math.max(0, Math.abs(k) - 6) / 3.5, 0, 1);
      el.style.transform = 'translate3d(' + (x - G.base / 2).toFixed(1) + 'px,' + (y - G.base / 2).toFixed(1) + 'px,0) scale(' + sc.toFixed(3) + ')';
      el.style.opacity = op.toFixed(3);
      el.style.zIndex = Math.round(front * 200);
      var f = Math.abs(k) < 0.5;
      if (f !== el._f) { el._f = f; el.classList.toggle('focus', f); }
    }
  }

  function focusIndex() { var R = rings[ri]; return R && R.items.length ? mod(Math.round(R.target), R.items.length) : -1; }
  function focused() { var i = focusIndex(); return i < 0 ? null : rings[ri].items[i]; }

  function ago(t) {
    if (!t) return '';
    var m = (Date.now() - t) / 6e4;
    if (m < 2) return 'just now';
    if (m < 60) return Math.round(m) + ' min ago';
    if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
    var d = Math.round(m / 1440); return d === 1 ? 'yesterday' : d + ' days ago';
  }
  var ARROW = { U: '↑', R: '→', D: '↓', L: '←' };
  function glyph(seq) { return seq.split('').map(function (c) { return ARROW[c]; }).join(''); }

  function updateLabel() {
    var it = focused();
    if (!it) { $('#name').textContent = rings[ri].name === 'Now' ? 'An empty sky' : ''; $('#meta').textContent = ''; return; }
    $('#name').textContent = it.label;
    if (it.tool) { $('#meta').textContent = it.sub; return; }
    var parts = [], c = T.month[it.pkg] || 0;
    if (c) parts.push('opened ' + c + (c === 1 ? ' time' : ' times') + ' this month'); else parts.push('an unexplored world');
    if (T.last[it.pkg]) parts.push('last ' + ago(T.last[it.pkg]));
    if (isPinned(it.pkg)) parts.push('pinned');
    var sp = spellFor(it.pkg);
    $('#meta').innerHTML = esc(parts.join(' · ')) + (sp ? ' · spell <span class="glyph">' + glyph(sp) + '</span>' : '');
  }

  function renderRingNames() {
    $('#rings').innerHTML = rings.map(function (r, i) { return '<div class="' + (i === ri ? 'on' : '') + '">' + esc(r.name) + '</div>'; }).join('');
  }

  function move(d) {
    var R = rings[ri]; if (!R.items.length) return;
    R.target = Math.round(R.target) + d; updateLabel();
  }

  var warping = false;
  function switchRing(d) {
    var next = clamp(ri + d, 0, rings.length - 1);
    if (next === ri || warping) return;
    warping = true;
    var dir = d > 0 ? 'down' : 'up';
    orbitEl.className = 'warp-out-' + dir;
    setTimeout(function () {
      ri = next; pos = rings[ri].target = Math.round(rings[ri].target);
      renderRing(); layout(); renderRingNames(); updateLabel();
      orbitEl.className = 'warp-in-' + dir;
      void orbitEl.offsetWidth; // flush
      orbitEl.className = '';
      warping = false;
    }, 220);
  }

  // ------------------------------------------------------------------ living sky
  var skyEl = $('#sky'), solEl = $('#sol'), lunaEl = $('#luna'), groundEl = $('#ground');
  var starAlpha = 0;
  var PALETTE = [ // altitude, top, mid, horizon, rim
    [-18, [3, 4, 13], [7, 10, 26], [14, 18, 48], [90, 110, 220]],
    [-12, [7, 11, 31], [20, 26, 58], [44, 37, 80], [120, 110, 220]],
    [-6, [20, 29, 63], [75, 52, 102], [179, 87, 106], [240, 130, 120]],
    [0, [42, 61, 110], [176, 106, 122], [245, 154, 90], [255, 170, 110]],
    [6, [43, 93, 154], [108, 154, 200], [242, 196, 141], [255, 210, 160]],
    [20, [29, 95, 168], [79, 147, 208], [169, 209, 239], [190, 225, 255]]
  ];
  function skyColors(alt) {
    if (alt <= PALETTE[0][0]) return PALETTE[0];
    for (var i = 1; i < PALETTE.length; i++) {
      if (alt <= PALETTE[i][0]) {
        var a = PALETTE[i - 1], b = PALETTE[i], t = (alt - a[0]) / (b[0] - a[0]), out = [alt];
        for (var j = 1; j < 5; j++) out.push([0, 1, 2].map(function (q) { return Math.round(lerp(a[j][q], b[j][q], t)); }));
        return out;
      }
    }
    return PALETTE[PALETTE.length - 1];
  }
  function rgb(c, a) { return a === undefined ? 'rgb(' + c.join(',') + ')' : 'rgba(' + c.join(',') + ',' + a + ')'; }

  function solar(date, lat, lon, hourShiftDeg) {
    var start = new Date(date.getFullYear(), 0, 0), day = (date - start) / 864e5;
    var decl = 23.44 * Math.sin(2 * Math.PI * (284 + day) / 365) * Math.PI / 180;
    var utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
    var H = ((utcH + lon / 15 - 12) * 15 + (hourShiftDeg || 0)); // hour angle, degrees
    H = mod(H + 180, 360) - 180;
    var phi = lat * Math.PI / 180, h = H * Math.PI / 180;
    var alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h)) * 180 / Math.PI;
    return { alt: alt, H: H };
  }
  function skyPos(s) {
    var W = window.innerWidth, H = window.innerHeight;
    return { x: W * (0.5 + s.H / 180 * 0.55), y: H * 0.78 - (s.alt / 60) * H * 0.7 };
  }

  function updateSky() {
    var d = new Date(), lon = -d.getTimezoneOffset() / 4; // timezone → rough longitude
    var sun = solar(d, store.lat, lon, 0);
    var age = mod((d.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 864e5, 29.530588);
    var moon = solar(d, store.lat, lon, -age / 29.530588 * 360);
    var c = skyColors(sun.alt);
    skyEl.style.setProperty('--s0', rgb(c[1])); skyEl.style.setProperty('--s1', rgb(c[2])); skyEl.style.setProperty('--s2', rgb(c[3]));
    skyEl.style.setProperty('--veil', clamp((sun.alt + 4) / 30, 0, 0.45).toFixed(2));
    groundEl.style.setProperty('--rim', rgb(c[4], 0.38));
    starAlpha = clamp((-sun.alt - 1) / 11, 0, 1);

    var sp = skyPos(sun), mp = skyPos(moon);
    solEl.style.transform = 'translate3d(' + sp.x + 'px,' + sp.y + 'px,0)';
    solEl.style.opacity = sun.alt > -3 ? 1 : 0;
    lunaEl.style.transform = 'translate3d(' + mp.x + 'px,' + mp.y + 'px,0)';
    lunaEl.style.opacity = moon.alt > -2 ? (0.35 + 0.65 * starAlpha).toFixed(2) : 0;
    // phase: shadow slides across. 0 = new, 0.5 = full
    var ph = age / 29.530588, shadeX = ph < 0.5 ? (-ph * 2 * 110) : ((1 - ph) * 2 * 110);
    lunaEl.style.setProperty('--shade', shadeX.toFixed(1) + '%');

    document.body.classList.toggle('winddown', windDown());
    if (!skyPlaced) { skyPlaced = true; setTimeout(function () { document.body.classList.add('sky-live'); }, 50); }
  }
  var skyPlaced = false;

  // stars
  var starCv = $('#stars'), sctx = starCv.getContext('2d'), stars = [], meteor = null, nextMeteor = Date.now() + 15000;
  function seedStars() {
    starCv.width = window.innerWidth; starCv.height = window.innerHeight; stars = [];
    var n = Math.round(starCv.width * starCv.height / 9000);
    for (var i = 0; i < n; i++) stars.push({ x: Math.random() * starCv.width, y: Math.pow(Math.random(), 1.3) * starCv.height * 0.8, r: Math.random() * 1.3 + 0.3, p: Math.random() * 6.28, s: 0.6 + Math.random() * 1.8 });
  }
  function drawStars(t) {
    sctx.clearRect(0, 0, starCv.width, starCv.height);
    if (starAlpha < 0.02) return;
    var slow = document.body.classList.contains('winddown') ? 0.4 : 1;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i], a = starAlpha * (0.55 + 0.45 * Math.sin(s.p + t / 1000 * s.s * slow));
      sctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      sctx.beginPath(); sctx.arc(s.x, s.y, s.r, 0, 6.283); sctx.fill();
    }
    var now = Date.now();
    if (!meteor && now > nextMeteor && starAlpha > 0.5) {
      meteor = { x: Math.random() * starCv.width * 0.7 + starCv.width * 0.15, y: Math.random() * starCv.height * 0.25, t0: now };
    }
    if (meteor) {
      var k = (now - meteor.t0) / 900;
      if (k > 1) { meteor = null; nextMeteor = now + 20000 + Math.random() * 40000; }
      else {
        var x = meteor.x + k * 260, y = meteor.y + k * 120, gr = sctx.createLinearGradient(x - 120, y - 55, x, y);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,' + (starAlpha * (1 - k)).toFixed(2) + ')');
        sctx.strokeStyle = gr; sctx.lineWidth = 2; sctx.beginPath(); sctx.moveTo(x - 120, y - 55); sctx.lineTo(x, y); sctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------------ clock & insight
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function partOfDay(h) { return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var TIPS = [
    'Press BACK and draw a spell with the arrows.',
    'Press ⏯ and let the universe choose.',
    'Hold OK on any world to pin it, hide it, or bind a spell.',
    'The worlds you visit most grow heavier.',
    'The Now ring follows your habits through the day.'
  ];
  var tipIx = 0, lastInsight = '';
  function insight() {
    var d = new Date(), part = partOfDay(d.getHours());
    if (windDown()) return 'It’s getting late. The stars will still be here tomorrow.';
    if (T) {
      var best = null, bc = 0;
      for (var p in T.band) if (T.band[p] > bc && appBy[p] && !isHidden(p)) { bc = T.band[p]; best = p; }
      if (best && bc >= 3) {
        var when = (T.bandDow[best] || 0) >= 2 ? DAYS[d.getDay()] : (isWeekend(d) ? 'Weekend' : 'Weekday');
        return when + ' ' + part + 's, you usually drift towards ' + appBy[best].label + '.';
      }
    }
    return TIPS[tipIx % TIPS.length];
  }
  function updateClock() {
    var d = new Date();
    $('#time').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    $('#date').textContent = DAYS[d.getDay()] + ' · ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    var s = insight(), el = $('#insight');
    if (s !== lastInsight) {
      lastInsight = s; el.classList.add('fade');
      setTimeout(function () { el.textContent = s; el.classList.remove('fade'); }, 700);
    }
  }

  // ------------------------------------------------------------------ wind-down
  function windDown() {
    var b = store.bedtime; if (b === null || b === undefined) return false;
    var h = new Date().getHours();
    return b >= 12 ? (h >= b || h < 5) : (h >= b && h < 5);
  }
  var lastBreath = 0;

  // ------------------------------------------------------------------ launching
  function launch(pkg, skipBreath) {
    var a = appBy[pkg]; if (!a) return;
    if (!skipBreath && windDown() && Date.now() - lastBreath > 30 * 60e3) { openBreath(pkg); return; }
    store.history.push({ p: pkg, t: Date.now() });
    if (store.history.length > 2000) store.history.splice(0, store.history.length - 2000);
    saveNow();
    var fl = $('#flash'); fl.style.setProperty('--c', colorCache[pkg] || '#fff');
    fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
    setTimeout(function () {
      var ok = true;
      try { if (NATIVE) ok = NATIVE.launch(pkg); else console.log('[orbit] launch', pkg); } catch (e) { ok = false; }
      setTimeout(function () { fl.classList.remove('go'); if (!NATIVE || !ok) rebuild(true); }, NATIVE ? 900 : 500);
    }, 380);
  }

  function activate() {
    var it = focused(); if (!it) return;
    if (it.pkg) { launch(it.pkg); return; }
    switch (it.tool) {
      case 'roulette': roulette(); break;
      case 'spellbook': openSpellbook(); break;
      case 'bedtime':
        var i = BEDTIMES.indexOf(store.bedtime);
        store.bedtime = BEDTIMES[(i + 1) % BEDTIMES.length]; save(); refreshTools(); updateSky(); updateClock(); break;
      case 'unhide': store.hidden = []; save(); rebuild(true); break;
      case 'forget': openConfirm('Forget your habits?', 'The tide, gravity and insights start from nothing.', function () { store.history = []; saveNow(); rebuild(true); updateClock(); }); break;
      case 'settings': if (NATIVE) NATIVE.openSettings(); break;
    }
  }
  function refreshTools() {
    var R = rings[2], fresh = toolItems();
    R.items.forEach(function (it, i) { it.label = fresh[i].label; it.sub = fresh[i].sub; });
    updateLabel();
  }

  // ------------------------------------------------------------------ modals
  var modalEl = $('#modal'), modal = null;
  function openModal(m, html) { modal = m; modalEl.innerHTML = html; modalEl.className = 'on'; document.body.classList.add('modal-open'); }
  function closeModal() { if (modal && modal.onClose) modal.onClose(); modal = null; modalEl.className = ''; modalEl.innerHTML = ''; document.body.classList.remove('modal-open'); }

  function openMenu(title, sub, options) {
    var sel = 0;
    function draw() {
      var html = '<div class="panel"><h2>' + esc(sub) + '</h2><h1>' + esc(title) + '</h1><div class="menu">' +
        options.map(function (o, i) { return '<div class="' + (i === sel ? 'on' : '') + '">' + esc(o.label) + '</div>'; }).join('') + '</div></div>';
      modalEl.innerHTML = html;
    }
    openModal({
      key: function (k) {
        if (k === 'up') sel = mod(sel - 1, options.length);
        else if (k === 'down') sel = mod(sel + 1, options.length);
        else if (k === 'ok') { var o = options[sel]; closeModal(); o.run(); return; }
        else if (k === 'back') { closeModal(); return; }
        draw();
      }
    }, '');
    draw();
  }

  function openConfirm(title, text, yes) {
    openMenu(title, 'Are you sure', [{ label: 'Yes', run: yes }, { label: 'Cancel', run: function () {} }]);
    var p = modalEl.querySelector('.panel'); if (p) p.insertAdjacentHTML('beforeend', '<p>' + esc(text) + '</p>');
  }

  function openPlanetMenu() {
    var it = focused(); if (!it || !it.pkg) { if (it && it.tool) activate(); return; }
    var p = it.pkg, sp = spellFor(p), opts = [];
    opts.push(isPinned(p)
      ? { label: 'Unpin from Now', run: function () { store.pins.splice(store.pins.indexOf(p), 1); save(); rebuild(true); } }
      : { label: 'Pin to Now', run: function () { store.pins.push(p); save(); rebuild(true); } });
    opts.push({ label: sp ? 'Re-bind spell (' + glyph(sp) + ')' : 'Bind a spell', run: function () { openSpell('bind', p); } });
    if (sp) opts.push({ label: 'Break the spell', run: function () { delete store.spells[sp]; save(); rebuild(true); } });
    opts.push({ label: 'Hide from orbit', run: function () { store.hidden.push(p); store.pins = store.pins.filter(function (x) { return x !== p; }); save(); rebuild(false); } });
    if (NATIVE) opts.push({ label: 'App info', run: function () { NATIVE.appInfo(p); } });
    opts.push({ label: 'Close', run: function () {} });
    openMenu(it.label, 'World options', opts);
  }

  function openSpellbook() {
    var keys = Object.keys(store.spells).filter(function (k) { return appBy[store.spells[k]]; });
    var body = keys.length
      ? '<div class="spellbook">' + keys.map(function (k) { return '<div><span class="glyph">' + glyph(k) + '</span>' + esc(appBy[store.spells[k]].label) + '</div>'; }).join('') + '</div>'
      : '<p>No spells yet.<br>Hold OK on any world and choose “Bind a spell”.</p>';
    openModal({ key: function (k) { if (k === 'ok' || k === 'back') closeModal(); } },
      '<div class="panel"><h2>Press BACK on the home screen, then draw</h2><h1>Spellbook</h1>' + body + '<p style="opacity:.45">OK to close</p></div>');
  }

  // spells: draw a D-pad pattern
  function openSpell(mode, pkg) {
    var seq = '', timer = null, done = false;
    var title = mode === 'cast' ? 'Cast a spell' : 'Draw a spell for ' + appBy[pkg].label;
    var sub = mode === 'cast' ? 'Draw with the arrows' : '2–4 moves · then wait';
    openModal({
      key: function (k) {
        if (done) return;
        if (k === 'back') { closeModal(); return; }
        if (k === 'ok') { resolve(); return; }
        var m = { up: 'U', down: 'D', left: 'L', right: 'R' }[k]; if (!m) return;
        seq += m; draw();
        clearTimeout(timer);
        if (seq.length >= 4) timer = setTimeout(resolve, 280);
        else if (seq.length >= 2) timer = setTimeout(resolve, 1300);
      },
      onClose: function () { clearTimeout(timer); }
    }, '<div class="panel cast"><h2>' + esc(sub) + '</h2><h1>' + esc(title) + '</h1>' +
      '<svg id="spellsvg" viewBox="-50 -50 100 100"></svg><div class="spellword"></div><p id="spellmsg" style="opacity:.55">BACK to cancel</p></div>');
    draw();

    function draw() {
      var svg = $('#spellsvg'); if (!svg) return;
      var pts = [[0, 0]], x = 0, y = 0, L = 16;
      seq.split('').forEach(function (c) { if (c === 'U') y -= L; if (c === 'D') y += L; if (c === 'L') x -= L; if (c === 'R') x += L; pts.push([x, y]); });
      var g = '';
      for (var gx = -2; gx <= 2; gx++) for (var gy = -2; gy <= 2; gy++) g += '<circle class="grid" cx="' + gx * L + '" cy="' + gy * L + '" r="0.9"/>';
      svg.innerHTML = g + '<polyline points="' + pts.map(function (p) { return p.join(','); }).join(' ') + '"/>' +
        '<circle cx="' + x + '" cy="' + y + '" r="2.6"/>';
      modalEl.querySelector('.spellword').textContent = glyph(seq);
    }
    function msg(t) { var m = $('#spellmsg'); if (m) { m.textContent = t; m.style.opacity = 1; } }
    function resolve() {
      clearTimeout(timer);
      var panel = modalEl.querySelector('.panel');
      if (mode === 'cast') {
        var target = store.spells[seq];
        if (target && appBy[target]) {
          done = true; msg('✦ ' + appBy[target].label);
          setTimeout(function () { closeModal(); launch(target); }, 550);
        } else {
          done = true; msg(seq ? 'Nothing answered.' : 'Draw first.');
          panel.classList.remove('fizzle'); void panel.offsetWidth; panel.classList.add('fizzle');
          setTimeout(closeModal, 900);
        }
      } else {
        if (seq.length < 2) { msg('At least two moves.'); seq = ''; draw(); return; }
        var prev = store.spells[seq];
        var old = spellFor(pkg); if (old) delete store.spells[old];
        store.spells[seq] = pkg; save();
        done = true;
        msg('Bound.' + (prev && prev !== pkg && appBy[prev] ? ' (It used to open ' + appBy[prev].label + '.)' : '') + ' Press BACK on the home screen, then ' + glyph(seq) + '.');
        setTimeout(function () { closeModal(); rebuild(true); }, 2200);
      }
    }
  }

  // roulette: spin the All ring and let it choose
  function roulette() {
    if (modal) closeModal();
    var candidates = apps.filter(function (a) { return !isHidden(a.pkg); });
    if (!candidates.length) return;
    var lastP = store.history.length ? store.history[store.history.length - 1].p : null;
    if (candidates.length > 2) candidates = candidates.filter(function (a) { return a.pkg !== lastP; });
    var total = 0, w = candidates.map(function (a) { var x = (T.score[a.pkg] || 0) + 0.35; total += x; return x; });
    var r = Math.random() * total, pick = candidates[0];
    for (var i = 0; i < candidates.length; i++) { r -= w[i]; if (r <= 0) { pick = candidates[i]; break; } }

    var go = function () {
      var R = rings[ri], n = R.items.length, j = 0;
      for (var q = 0; q < n; q++) if (R.items[q].pkg === pick.pkg) j = q;
      var cur = Math.round(pos), steps = mod(j - mod(cur, n), n) + n * 2;
      while (steps < 18) steps += n;
      spin = { from: pos, to: cur + steps, t0: performance.now(), dur: 3600 + Math.random() * 800, pick: pick.pkg };
    };
    if (ri !== 1) { switchRing(1 - ri); setTimeout(go, 300); } else go();
  }
  function rouletteLanded(pkg) {
    var n = 3, timer;
    function html() { return '<div class="panel chosen"><h2>The universe chose</h2><h1>' + esc(appBy[pkg].label) + '</h1><div class="count">' + n + '</div><p style="opacity:.5">OK to go now · BACK to stay</p></div>'; }
    openModal({
      key: function (k) { if (k === 'ok') { closeModal(); launch(pkg); } else if (k === 'back') closeModal(); },
      onClose: function () { clearInterval(timer); }
    }, html());
    timer = setInterval(function () {
      n--; if (n <= 0) { closeModal(); launch(pkg); return; }
      var c = modalEl.querySelector('.count'); if (c) c.textContent = n;
    }, 1000);
  }

  // wind-down: one breath before launching after bedtime
  function openBreath(pkg) {
    var d = new Date(), timer;
    openModal({
      key: function (k) { if (k === 'back') closeModal(); else if (k === 'ok') { closeModal(); lastBreath = Date.now(); launch(pkg, true); } },
      onClose: function () { clearTimeout(timer); }
    }, '<div class="panel"><div class="breath"></div><h2>It’s ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '</h2><h1>One breath first.</h1><p>' + esc(appBy[pkg].label) + ' will open by itself in a moment.<br>BACK if you’d rather call it a night.</p></div>');
    timer = setTimeout(function () { closeModal(); lastBreath = Date.now(); launch(pkg, true); }, 6000);
  }

  // ------------------------------------------------------------------ input
  var lastInput = Date.now(), okDownAt = 0, okTimer = null, okLong = false;
  function handle(k) {
    lastInput = Date.now();
    if (document.body.classList.contains('drift')) { document.body.classList.remove('drift'); return; }
    if (spin) { if (k === 'back') { spin = null; rings[ri].target = Math.round(pos); updateLabel(); } return; }
    if (modal) { modal.key(k); return; }
    switch (k) {
      case 'left': move(-1); break;
      case 'right': move(1); break;
      case 'up': switchRing(-1); break;
      case 'down': switchRing(1); break;
      case 'ok': activate(); break;
      case 'options': openPlanetMenu(); break;
      case 'back': case 'menu': openSpell('cast'); break;
      case 'playpause': roulette(); break;
    }
  }
  var KEYMAP = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 27: 'back', 8: 'back', 77: 'menu', 80: 'playpause', 32: 'playpause', 179: 'playpause', 70: 'options', 228: 'options', 93: 'menu' };
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 13 || e.keyCode === 23) { // OK / DPAD_CENTER: tap = launch, hold = options
      e.preventDefault();
      if (e.repeat || okDownAt) return;
      okDownAt = Date.now(); okLong = false;
      okTimer = setTimeout(function () { okLong = true; handle(modal ? 'ok' : 'options'); }, 600);
      return;
    }
    var k = KEYMAP[e.keyCode];
    if (k) { e.preventDefault(); handle(k); }
  });
  document.addEventListener('keyup', function (e) {
    if (e.keyCode === 13 || e.keyCode === 23) {
      e.preventDefault();
      clearTimeout(okTimer);
      if (okDownAt && !okLong) handle('ok');
      okDownAt = 0;
    }
  });
  window.addEventListener('blur', function () { clearTimeout(okTimer); okDownAt = 0; });

  // ------------------------------------------------------------------ main loop
  var lastT = performance.now(), lastStar = 0;
  function tick(t) {
    var dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
    var R = rings[ri];
    if (spin) {
      var k = clamp((t - spin.t0) / spin.dur, 0, 1), e = 1 - Math.pow(1 - k, 4);
      pos = spin.from + (spin.to - spin.from) * e; dirty = true;
      if (Math.round(pos) !== R._lastTick) { R._lastTick = Math.round(pos); R.target = Math.round(pos); updateLabel(); }
      if (k >= 1) { var p = spin.pick; R.target = spin.to; pos = spin.to; spin = null; updateLabel(); rouletteLanded(p); }
    } else if (R) {
      var d = R.target - pos;
      if (Math.abs(d) > 0.0015) { pos += d * Math.min(1, dt * 11); dirty = true; }
      else if (pos !== R.target) { pos = R.target; dirty = true; }
    }
    if (dirty) { layout(); dirty = false; }
    if (t - lastStar > 50) { lastStar = t; drawStars(t); }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ native hooks
  window.Orbit = {
    key: function (name) { handle(name); },
    resume: function () {
      clearTimeout(okTimer); okDownAt = 0;
      document.body.classList.remove('drift'); lastInput = Date.now();
      loadApps(); rebuild(true); updateClock(); updateSky();
    },
    home: function () { // HOME pressed while already home: back to the front of Now
      if (modal) closeModal(); spin = null;
      if (ri !== 0) { ri = 0; renderRing(); renderRingNames(); }
      rings[0].target = 0; pos = Math.round(pos); updateLabel();
    },
    appsChanged: function () { loadApps(); rebuild(true); }
  };

  // ------------------------------------------------------------------ mock (browser preview only)
  function mockApps() {
    var names = [['Netflix', '#e50914'], ['YouTube', '#ff0033'], ['Prime Video', '#1aa3e8'], ['Disney+', '#1b3fa8'], ['Plex', '#e5a00d'],
      ['Spotify', '#1db954'], ['BBC iPlayer', '#f54997'], ['Twitch', '#9146ff'], ['Kodi', '#17b2e7'], ['VLC', '#ff8800'],
      ['Reborn', '#7b5cff'], ['Lumen', '#f2c14e'], ['ITVX', '#a6e22e'], ['Channel 4', '#8a8dff'], ['Apple TV', '#666'],
      ['Downloader', '#f57c00'], ['Files', '#4caf50'], ['Steam Link', '#1b2838'], ['Tidal', '#222'], ['Pluto TV', '#fff200']];
    return names.map(function (n) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="' + n[1] + '"/>' +
        '<text x="50" y="66" font-family="Arial" font-weight="bold" font-size="46" text-anchor="middle" fill="#fff">' + n[0].charAt(0) + '</text></svg>';
      return { pkg: 'mock.' + n[0].toLowerCase().replace(/\W/g, ''), label: n[0], icon: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
    });
  }
  function mockHistory() {
    if (NATIVE || store.history.length) return;
    var now = Date.now(), H = [];
    for (var day = 0; day < 28; day++) {
      var base = new Date(now - day * 864e5); base.setMinutes(0, 0, 0);
      var at = function (h, p) { var d = new Date(base); d.setHours(h); if (d.getTime() < now) H.push({ p: p, t: d.getTime() + Math.random() * 3e6 }); };
      at(8, 'mock.youtube'); at(8, 'mock.bbciplayer');
      at(19, 'mock.netflix'); at(20, 'mock.reborn'); at(21, 'mock.netflix');
      if (day % 2) at(19, 'mock.plex');
      if (day % 3 === 0) at(18, 'mock.spotify');
      if (day % 7 === 0) at(22, 'mock.twitch');
    }
    H.sort(function (a, b) { return a.t - b.t; });
    store.history = H; store.pins = ['mock.lumen']; store.spells = { URD: 'mock.netflix', LLR: 'mock.youtube' };
  }

  // ------------------------------------------------------------------ preview remote (browser only)
  function previewRemote() {
    if (NATIVE) return;
    var css = document.createElement('style');
    css.textContent = '#remote{position:fixed;right:2.5vw;bottom:4vh;z-index:2000;width:23vh;font-family:inherit;user-select:none;-webkit-user-select:none}' +
      '#remote .pad{position:relative;width:23vh;height:23vh;border-radius:50%;background:rgba(20,22,40,.85);box-shadow:0 0 0 .3vh rgba(255,255,255,.12)}' +
      '#remote button{position:absolute;border:0;background:transparent;color:#f4f1ea;font-size:3vh;width:7vh;height:7vh;border-radius:50%;cursor:pointer;touch-action:manipulation}' +
      '#remote button:active{background:rgba(255,255,255,.18)}' +
      '#remote .ok{left:7.5vh;top:7.5vh;width:8vh;height:8vh;background:rgba(255,255,255,.1);font-size:2vh;letter-spacing:.2vh}' +
      '#remote .row{display:flex;justify-content:space-between;margin-top:1.4vh}' +
      '#remote .row button{position:static;width:auto;height:auto;padding:1vh 1.4vh;font-size:1.6vh;border-radius:3vh;background:rgba(20,22,40,.85);box-shadow:0 0 0 .2vh rgba(255,255,255,.12);letter-spacing:.15vh}' +
      'html,body{cursor:default}';
    document.head.appendChild(css);
    var r = document.createElement('div'); r.id = 'remote';
    r.innerHTML = '<div class="pad">' +
      '<button data-k="up" style="left:8vh;top:.5vh">▲</button>' +
      '<button data-k="down" style="left:8vh;bottom:.5vh">▼</button>' +
      '<button data-k="left" style="left:.5vh;top:8vh">◀</button>' +
      '<button data-k="right" style="right:.5vh;top:8vh">▶</button>' +
      '<button class="ok" data-k="ok">OK</button></div>' +
      '<div class="row"><button data-k="back">BACK</button><button data-k="options">HOLD OK</button><button data-k="playpause">▶❚❚</button></div>';
    document.body.appendChild(r);
    var fire = function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      e.preventDefault(); handle(b.getAttribute('data-k'));
    };
    r.addEventListener('click', fire);
    // tap a planet to bring it forward; tap the front one to launch
    orbitEl.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.planet') : null; if (!el || modal || spin) return;
      var R = rings[ri];
      for (var i = 0; i < R.items.length; i++) if (R.items[i].el === el) {
        if (i === focusIndex()) { handle('ok'); return; }
        var n = R.items.length, cur = Math.round(R.target), d = mod(i - mod(cur, n), n);
        if (d > n / 2) d -= n;
        R.target = cur + d; updateLabel(); lastInput = Date.now(); return;
      }
    });
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    previewRemote();
    loadApps(); mockHistory();
    buildRings(); renderRing(); renderRingNames(); updateLabel();
    seedStars(); updateSky(); updateClock();
    setInterval(updateClock, 15000);
    setInterval(updateSky, 30000);
    setInterval(function () { tipIx++; }, 45000);
    setInterval(function () {
      if (!modal && !spin && Date.now() - lastInput > 120000) document.body.classList.add('drift');
    }, 5000);
    window.addEventListener('resize', function () { seedStars(); updateSky(); dirty = true; });
    requestAnimationFrame(tick);
  }
  boot();
})();
