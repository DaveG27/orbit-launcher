/*
 * Orbit — a TV launcher where your apps are worlds.
 *
 *  Gravity       planets grow with how much you actually use them
 *  Tide          the "Now" ring reshapes itself around your habits for this hour & day
 *  Living sky    real sun / moon / stars for your time of day, plus real sky events
 *  Spells        press BACK (or MENU) on the home screen and draw a D-pad pattern to launch
 *  Roulette      PLAY/PAUSE spins the universe and lets it pick for you
 *  Wind-down     after bedtime the sky warms, and launching asks for one breath first
 *  Drift         idle screen fades to a calm clock
 *  Beam          your phone becomes the keyboard: links, APKs, Downloader codes, notes
 *  Eclipse       a sleep timer for any app: Orbit returns and pauses what's playing
 *  Live worlds   favourite channels as planets, with what's on now; open straight in Reborn
 *  Asteroid belt apps you never use drift out, with their size, ready to remove
 *  Sonic orbit   optional chimes and an ambient bed that follows the time of day
 *
 * Everything stays on the box. Written for old TV WebViews too: ES5 only.
 */
(function () {
  'use strict';

  var NATIVE = window.OrbitNative || null;
  var REBORN = 'app.reborn.iptv';
  var DAY = 864e5;
  function $(s) { return document.querySelector(s); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtSize(b) { if (!b) return ''; if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'; return Math.max(1, Math.round(b / 1e6)) + ' MB'; }

  // ------------------------------------------------------------------ storage
  var DEFAULTS = { history: [], pins: [], hidden: [], keep: [], spells: {}, bedtime: 23, lat: 51.5, sound: 0, since: 0 };
  function loadStore() {
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      var raw = NATIVE ? NATIVE.load('store') : localStorage.getItem('orbit.store');
      if (raw) { var s = JSON.parse(raw); for (var k in s) out[k] = s[k]; }
    } catch (e) {}
    return out;
  }
  var store = loadStore();
  var saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    var s = JSON.stringify(store);
    try { if (NATIVE) NATIVE.save('store', s); else localStorage.setItem('orbit.store', s); } catch (e) {}
  }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  if (!store.since) { store.since = Date.now(); save(); }

  // ------------------------------------------------------------------ worlds (apps + live channels)
  var apps = [], appBy = {}, live = { signedIn: false, channels: [], reborn: false }, liveBy = {}, colorCache = {}, hasUsage = false;
  function world(key) { return key && key.indexOf('live:') === 0 ? liveBy[key] : appBy[key]; }

  function letterIcon(label, color) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="' + color + '"/>' +
      '<text x="50" y="66" font-family="Arial" font-weight="bold" font-size="46" text-anchor="middle" fill="#fff">' + esc(label.charAt(0)) + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function loadApps() {
    var list = [];
    try { list = NATIVE ? JSON.parse(NATIVE.getApps()) : mockApps(); } catch (e) { list = []; }
    try { hasUsage = NATIVE ? !!NATIVE.hasUsageAccess() : true; } catch (e) { hasUsage = false; }
    list.sort(function (a, b) { return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1; });
    apps = list; appBy = {};
    list.forEach(function (a) { a.key = a.pkg; a.kind = 'app'; appBy[a.pkg] = a; });
  }
  function loadLive() {
    try { live = NATIVE ? JSON.parse(NATIVE.liveState()) : mockLive(); } catch (e) { live = { signedIn: false, channels: [] }; }
    liveBy = {};
    var hues = ['#2b6cb0', '#c53030', '#2f855a', '#6b46c1', '#b7791f', '#2c7a7b'];
    (live.channels || []).forEach(function (c, i) {
      var icon = c.icon ? (NATIVE ? 'https://orbit.local/img?u=' + encodeURIComponent(c.icon) : c.icon) : letterIcon(c.name, hues[i % hues.length]);
      liveBy['live:' + c.id] = { key: 'live:' + c.id, id: c.id, label: c.name, icon: icon, kind: 'live' };
    });
  }
  function isHidden(k) { return store.hidden.indexOf(k) >= 0; }
  function isPinned(k) { return store.pins.indexOf(k) >= 0; }
  function spellFor(k) { for (var s in store.spells) if (store.spells[s] === k) return s; return null; }

  // average saturated colour of an icon → planet atmosphere + its note in Sonic orbit
  var colorCanvas = document.createElement('canvas'); colorCanvas.width = colorCanvas.height = 16;
  var colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  function extractColor(item) {
    var img = item.img;
    if (colorCache[item.key]) { applyColor(item, colorCache[item.key]); return; }
    if (!img) return;
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
          var col = [Math.round(r / w), Math.round(g / w), Math.round(b / w)];
          colorCache[item.key] = col; applyColor(item, col);
        }
      } catch (e) {}
    };
    if (img.complete && img.naturalWidth) run(); else img.addEventListener('load', run);
  }
  function applyColor(item, col) { if (item.el && !item.tool) item.el.style.setProperty('--c', 'rgb(' + col.join(',') + ')'); }
  function hueOf(key) {
    var c = colorCache[key]; if (!c) { var h = 0; for (var i = 0; i < (key || '').length; i++) h = (h * 31 + key.charCodeAt(i)) % 360; return h; }
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    var h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return mod(h * 60, 360);
  }

  // ------------------------------------------------------------------ tide (habit model)
  function isWeekend(d) { var x = d.getDay(); return x === 0 || x === 6; }
  function hourOf(d) { return d.getHours() + d.getMinutes() / 60; }
  function hourDist(a, b) { var d = Math.abs(a - b); return Math.min(d, 24 - d); }

  function tide() {
    var now = Date.now(), d = new Date(now), h = hourOf(d), we = isWeekend(d), dow = d.getDay();
    var score = {}, month = {}, last = {}, band = {}, bandDow = {};
    store.history.forEach(function (e) {
      var ed = new Date(e.t), age = (now - e.t) / DAY;
      last[e.p] = Math.max(last[e.p] || 0, e.t);
      if (!world(e.p)) return;
      var dh = hourDist(hourOf(ed), h), sameType = isWeekend(ed) === we;
      var wTime = Math.exp(-(dh * dh) / (2 * 1.6 * 1.6)) * (sameType ? 1 : 0.45);
      score[e.p] = (score[e.p] || 0) + Math.pow(0.5, age / 21) * (wTime + 0.12);
      if (age <= 30) month[e.p] = (month[e.p] || 0) + 1;
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
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
    forget: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    beam: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/><path d="M2 8c1.5-1.5 1.5-4.5 0-6M22 8c-1.5-1.5-1.5-4.5 0-6" transform="translate(0 4)"/></svg>',
    eclipse: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><circle cx="15" cy="10" r="8" fill="#0a0c20" stroke="none"/><path d="M12 2v1M12 21v1M2 12h1M21 12h1" stroke-linecap="round"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    live: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 2l4 4 4-4"/><circle cx="12" cy="12.5" r="2" fill="#fff"/></svg>',
    doorbell: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="3"/><circle cx="12" cy="8" r="2"/><circle cx="12" cy="15.5" r="2.6"/><path d="M3 9c-1 2-1 4 0 6M21 9c1 2 1 4 0 6"/></svg>',
    update: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>',
    belt: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="14" r="2.5"/><circle cx="13" cy="9" r="3.5"/><circle cx="19" cy="15" r="1.8"/><path d="M2 19c6-2 14-2 20 0"/></svg>'
  };
  var BEDTIMES = [null, 21, 22, 23, 0, 1];
  var ECLIPSE_STEPS = [0, 15, 30, 45, 60, 90, 120];
  var SOUND_LABELS = ['Off', 'Chimes', 'Chimes + ambience'];
  function bedLabel(b) { return b === null ? 'Off' : pad(b) + ':00'; }

  var eclipseAt = 0, ecStep = 0;
  function eclipseLabel() { return eclipseAt > Date.now() ? 'at ' + hhmm(eclipseAt) : 'off'; }

  // ------------------------------------------------------------------ doorbell test
  function bellState() {
    try { if (NATIVE && NATIVE.doorbellState) return JSON.parse(NATIVE.doorbellState()); } catch (e) {}
    return { on: false, status: 'off', count: 0, log: [], ip: '' };
  }
  function bellItem() {
    var b = bellState();
    if (!b.service) return { tool: 'doorbell', label: 'Doorbell pop-up · off', sub: 'OK to switch on · when the Tapo doorbell rings, Orbit shows it over whatever’s playing', c: '#2b2208', c2: '#e6b422' };
    var sub = !b.tapo ? 'Install the Tapo app on this box so Orbit can show who’s there' :
      !b.popup ? 'Paused · OK to turn pop-ups back on' :
      'Rings show “' + b.name + '” for ' + b.secs + 's, then back to what you were watching · OK for options';
    return { tool: 'doorbell', label: 'Doorbell pop-up · ' + (b.popup ? 'on' : 'paused'), sub: sub, c: '#2b2208', c2: '#e6b422' };
  }
  function openBell() {
    var b = bellState();
    if (!b.service) {
      openMenu('Switch on the doorbell pop-up', 'Doorbell', [
        { label: 'Open Accessibility settings', run: function () { if (NATIVE && NATIVE.bellSettings) NATIVE.bellSettings(); } },
        { label: 'Not now', run: function () {} }
      ], '<p>In the settings that open, choose <b>Orbit doorbell</b> and turn it on. That lets Orbit notice the ring whatever app you’re in, open your doorbell in Tapo, and bring you back afterwards. Then press BACK to return here.</p>' +
        (b.tapo ? '' : '<p style="opacity:.7">You’ll also need the Tapo app installed on this box, signed in.</p>'));
      return;
    }
    var last = (b.log || []).slice(0, 3).map(function (e) { return hhmm(e.at) + ' from ' + esc(e.ip); }).join(' · ');
    openMenu('Doorbell pop-up', b.popup ? 'On' : 'Paused', [
      { label: 'Test it now', run: function () { toast('Opening the doorbell — back in ' + b.secs + 's'); if (NATIVE && NATIVE.bellTest) NATIVE.bellTest(); } },
      { label: 'Show it for ' + b.secs + 's → change', run: function () {
        var opts = [10, 20, 30, 45, 60, 90].map(function (n) { return { label: n + ' seconds' + (n === b.secs ? ' ✓' : ''), run: function () { NATIVE.bellSecs(n); refreshTools(); toast('Doorbell shows for ' + n + 's'); } }; });
        openMenu('How long on screen?', 'Doorbell', opts);
      } },
      { label: b.popup ? 'Pause pop-ups' : 'Turn pop-ups back on', run: function () { NATIVE.bellPopup(!b.popup); refreshTools(); toast(b.popup ? 'Doorbell pop-ups paused' : 'Doorbell pop-ups on'); } },
      { label: 'Accessibility settings', run: function () { NATIVE.bellSettings(); } },
      { label: 'Close', run: function () {} }
    ], '<p>Looks for the tile called <b>“' + esc(b.name) + '”</b> in Tapo' + (b.bellIp ? ' · doorbell at ' + esc(b.bellIp) : '') + '.</p>' +
      (last ? '<p style="opacity:.6">Last rings: ' + last + '</p>' : '<p style="opacity:.6">No rings heard yet.</p>') +
      (b.tapo ? '' : '<p style="color:#ffb3b3">Tapo isn’t installed on this box.</p>'));
  }

  function toolItems() {
    return [
      { tool: 'beam', label: 'Beam from your phone', sub: 'Scan once — send links, APKs, Downloader codes and notes to the TV', c: '#122046', c2: '#4f7bff' },
      { tool: 'roulette', label: 'Roulette', sub: 'Can’t decide? Let the universe choose', c: '#3b1450', c2: '#b04fd6' },
      { tool: 'eclipse', label: 'Eclipse · ' + eclipseLabel(), sub: 'OK to set a sleep timer · when it ends Orbit returns and pauses what’s playing', c: '#0d0f24', c2: '#e9b84a' },
      { tool: 'spellbook', label: 'Spellbook', sub: Object.keys(store.spells).length + ' spells bound', c: '#141a4d', c2: '#5d6dff' },
      { tool: 'bedtime', label: 'Bedtime · ' + bedLabel(store.bedtime), sub: 'OK to change · after this the sky warms and launching asks for a breath', c: '#3d1a0c', c2: '#e2763a' },
      { tool: 'sound', label: 'Sonic orbit · ' + SOUND_LABELS[store.sound || 0], sub: 'OK to change · every world has its own note', c: '#0f2b33', c2: '#36b5c9' },
      bellItem(),
      { tool: 'update', label: 'Update Orbit' + (NATIVE && NATIVE.version ? ' · v' + NATIVE.version() : ''), sub: 'OK to check for a newer build and install it', c: '#0f2a1a', c2: '#3fbf6f' },
      { tool: 'unhide', label: 'Hidden worlds · ' + store.hidden.length, sub: 'OK to bring every hidden app back into orbit', c: '#0d2d2a', c2: '#2fb39b' },
      { tool: 'forget', label: 'Forget my habits', sub: 'Clears launch history — the tide starts fresh', c: '#2a2a2a', c2: '#8a8a8a' },
      { tool: 'settings', label: 'Android settings', sub: 'System settings for this box', c: '#14212e', c2: '#4b84b8' }
    ].map(function (t) { t.key = 'tool:' + t.tool; t.kind = 'tool'; t.g = 0.92; return t; });
  }

  // Asteroid belt: apps not used for 60+ days, biggest first
  function beltItems() {
    var now = Date.now(), learnLeft = Math.ceil(21 - (now - store.since) / DAY);
    if (!hasUsage && learnLeft > 0) {
      return { total: 0, items: [{ tool: 'beltinfo', key: 'tool:beltinfo', kind: 'tool', g: 0.95, c: '#1c1c22', c2: '#77777f', icon: 'belt',
        label: 'The belt is still forming', sub: 'Apps you don’t use drift out here · ready in ' + learnLeft + (learnLeft === 1 ? ' day' : ' days') + ' · OK to skip the wait' }] };
    }
    var out = [], total = 0, maxSize = 1;
    apps.forEach(function (a) {
      if (a.system || isHidden(a.pkg) || store.keep.indexOf(a.pkg) >= 0) return;
      var last = Math.max(a.lastUsed > 0 ? a.lastUsed : 0, T.last[a.pkg] || 0);
      var ref = last || Math.max(a.installed || 0, hasUsage ? 0 : store.since);
      var idle = Math.floor((now - ref) / DAY);
      if (idle < 60) return;
      out.push({ key: a.pkg, pkg: a.pkg, kind: 'rock', label: a.label, icon: a.icon, size: a.size || 0, idle: idle, never: !last });
      total += a.size || 0; maxSize = Math.max(maxSize, a.size || 0);
    });
    out.sort(function (a, b) { return b.size - a.size; });
    out.forEach(function (r) { r.g = 0.68 + 0.5 * Math.log(1 + r.size) / Math.log(1 + maxSize); });
    if (!out.length) out.push({ tool: 'beltinfo', key: 'tool:beltinfo', kind: 'tool', g: 0.95, c: '#1c1c22', c2: '#77777f', icon: 'belt',
      label: 'The belt is clear', sub: 'Every app has been used in the last 60 days' });
    return { total: total, items: out };
  }

  var rings = [], ri = 0, T = null;
  function ringIx(id) { for (var i = 0; i < rings.length; i++) if (rings[i].id === id) return i; return 0; }
  function buildRings() {
    T = tide();
    var visible = apps.filter(function (a) { return !isHidden(a.pkg); });
    var liveWorlds = []; for (var k in liveBy) liveWorlds.push(liveBy[k]);
    var maxMonth = 1; for (var m in T.month) maxMonth = Math.max(maxMonth, T.month[m]);
    function gravity(key) { return 0.82 + 0.5 * Math.log(1 + (T.month[key] || 0)) / Math.log(1 + maxMonth); }
    function asItem(w) { return { key: w.key, pkg: w.pkg, liveId: w.id, kind: w.kind, label: w.label, icon: w.icon, g: gravity(w.key) }; }

    var now = [];
    store.pins.forEach(function (p) { var w = world(p); if (w && !isHidden(p)) now.push(w); });
    visible.concat(liveWorlds).filter(function (w) { return !isPinned(w.key) && T.score[w.key]; })
      .sort(function (a, b) { return T.score[b.key] - T.score[a.key]; })
      .forEach(function (w) { if (now.length < 9) now.push(w); });
    visible.forEach(function (a) { if (now.length < 7 && now.indexOf(a) < 0) now.push(a); });

    var liveItems = liveWorlds.length ? liveWorlds.map(asItem) : [{
      tool: 'livesetup', key: 'tool:livesetup', kind: 'tool', g: 0.95, c: '#2a0f22', c2: '#e0457b', icon: 'live',
      label: 'Bring your channels into orbit', sub: 'OK, then sign in and pick channels from your phone'
    }];
    var belt = beltItems();

    rings = [
      { id: 'now', name: 'Now', items: now.map(asItem) },
      { id: 'live', name: 'Live', items: liveItems },
      { id: 'all', name: 'All worlds', items: visible.map(asItem) },
      { id: 'belt', name: 'Asteroid belt' + (belt.total ? ' · ' + fmtSize(belt.total) : ''), items: belt.items },
      { id: 'tools', name: 'Tools', items: toolItems() }
    ];
    rings.forEach(function (r) { r.target = 0; });
  }

  function rebuild(keepFocus) {
    var keep = keepFocus && focused() ? focused().key : null;
    var keepTargets = {}; rings.forEach(function (r) { keepTargets[r.id] = r.target; });
    var curId = rings[ri] ? rings[ri].id : 'now';
    buildRings();
    ri = ringIx(curId);
    rings.forEach(function (r, i) { if (keepTargets[r.id] !== undefined && i !== ri) r.target = Math.round(keepTargets[r.id]); });
    var R = rings[ri], idx = 0;
    if (keep) for (var i = 0; i < R.items.length; i++) if (R.items[i].key === keep) idx = i;
    R.target = idx; pos = idx;
    renderRing(); renderRingNames(); updateLabel(true);
  }

  // ------------------------------------------------------------------ orbit rendering
  var orbitEl = $('#orbit'), pos = 0, spin = null, dirty = true;

  function renderRing() {
    orbitEl.innerHTML = '';
    var track = document.createElement('div'); track.className = 'track'; orbitEl.appendChild(track);
    rings[ri].items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'planet ' + it.kind + (isPinned(it.key) ? ' pinned' : '');
      var inner = '<div class="atmo"></div><div class="body">';
      if (it.kind === 'tool') inner += ICONS[it.icon || it.tool] || '';
      else inner += '<img src="' + esc(it.icon) + '" alt="">';
      inner += '</div><div class="halo"></div>';
      if (it.kind === 'live') inner += '<div class="badge">LIVE</div>';
      if (spellFor(it.key)) inner += '<div class="moon"></div>';
      el.innerHTML = inner;
      if (it.kind === 'tool') { el.style.setProperty('--c', it.c); el.style.setProperty('--c2', it.c2); }
      orbitEl.appendChild(el);
      it.el = el;
      if (it.kind !== 'tool') {
        it.img = el.querySelector('img');
        it.img.onerror = function () { it.img.src = letterIcon(it.label, '#3a3f66'); };
        extractColor(it);
      }
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

  // ------------------------------------------------------------------ live guide
  var epg = {}; // id -> [{title,start,end}]
  function b64(s) { try { return decodeURIComponent(escape(atob(s))); } catch (e) { try { return atob(s); } catch (e2) { return s; } } }
  function nowNext(id) {
    var list = epg[id]; if (!list || !list.length) return null;
    var now = Date.now(), cur = null, next = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].start <= now && list[i].end > now) { cur = list[i]; next = list[i + 1] || null; break; }
      if (list[i].start > now && !next) next = list[i];
    }
    return cur || next ? { cur: cur, next: next } : null;
  }
  function epgLine(id) {
    var nn = nowNext(id); if (!nn) return '';
    var s = '';
    if (nn.cur) s = 'Now: ' + nn.cur.title + ' · until ' + hhmm(nn.cur.end);
    if (nn.next) s += (s ? ' — ' : '') + 'Next: ' + nn.next.title + (nn.cur ? '' : ' at ' + hhmm(nn.next.start));
    return s;
  }
  function refreshEpg() {
    if (!live.signedIn || !live.channels || !live.channels.length) return;
    var ids = live.channels.map(function (c) { return c.id; }).join(',');
    if (NATIVE) { try { NATIVE.liveEpg(ids); } catch (e) {} } else window.Orbit.liveEpg(mockEpg());
  }

  function updateLabel(silent) {
    var it = focused();
    if (!silent && it) Sound.focus(it.key);
    if (!it) { $('#name').textContent = ''; $('#meta').textContent = ''; return; }
    $('#name').textContent = it.label;
    if (it.kind === 'tool') { $('#meta').textContent = it.sub; return; }
    var parts = [], sp = spellFor(it.key);
    if (it.kind === 'rock') {
      parts.push((it.never ? 'not opened in ' : 'unused for ') + it.idle + ' days');
      if (it.size) parts.push(fmtSize(it.size));
      parts.push('OK for options');
    } else if (it.kind === 'live') {
      var line = epgLine(it.liveId);
      parts.push(line || 'No guide for this channel');
    } else {
      if (it.pkg === REBORN && live.channels && live.channels.length) {
        var first = live.channels[0], nn = nowNext(first.id);
        if (nn && nn.cur) parts.push('on ' + first.name + ': ' + nn.cur.title);
      }
      var c = T.month[it.key] || 0;
      if (c) parts.push('opened ' + c + (c === 1 ? ' time' : ' times') + ' this month'); else if (!parts.length) parts.push('an unexplored world');
      if (T.last[it.key]) parts.push('last ' + ago(T.last[it.key]));
    }
    if (isPinned(it.key)) parts.push('pinned');
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
  function switchRing(d, then) {
    var next = clamp(ri + d, 0, rings.length - 1);
    if (next === ri || warping) { if (then) then(); return; }
    warping = true;
    Sound.whoosh(d);
    var dir = d > 0 ? 'down' : 'up';
    orbitEl.className = 'warp-out-' + dir;
    setTimeout(function () {
      ri = next; pos = rings[ri].target = Math.round(rings[ri].target);
      renderRing(); layout(); renderRingNames(); updateLabel(true);
      orbitEl.className = 'warp-in-' + dir;
      void orbitEl.offsetWidth;
      orbitEl.className = '';
      warping = false;
      if (rings[ri].id === 'live') refreshEpg();
      if (then) then();
    }, 220);
  }
  function goRing(id, then) { switchRing(ringIx(id) - ri, then); }

  // ------------------------------------------------------------------ living sky
  var skyEl = $('#sky'), solEl = $('#sol'), lunaEl = $('#luna'), groundEl = $('#ground');
  var starAlpha = 0, skyFlags = {};
  var PALETTE = [
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
    var start = new Date(date.getFullYear(), 0, 0), day = (date - start) / DAY;
    var decl = 23.44 * Math.sin(2 * Math.PI * (284 + day) / 365) * Math.PI / 180;
    var utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
    var H = mod((utcH + lon / 15 - 12) * 15 + (hourShiftDeg || 0) + 180, 360) - 180;
    var phi = lat * Math.PI / 180, h = H * Math.PI / 180;
    var alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h)) * 180 / Math.PI;
    return { alt: alt, H: H };
  }
  function skyPos(s) {
    var W = window.innerWidth, H = window.innerHeight;
    return { x: W * (0.5 + s.H / 180 * 0.55), y: H * 0.78 - (s.alt / 60) * H * 0.7 };
  }
  function moonAge(d) { return mod((d.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / DAY, 29.530588); }

  function updateSky() {
    var d = new Date(), lon = -d.getTimezoneOffset() / 4;
    var sun = solar(d, store.lat, lon, 0), age = moonAge(d);
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
    var ph = age / 29.530588, shadeX = ph < 0.5 ? (-ph * 2 * 110) : ((1 - ph) * 2 * 110);
    lunaEl.style.setProperty('--shade', shadeX.toFixed(1) + '%');

    skyFlags = skyEvents(d).flags;
    solEl.classList.toggle('eclipsed', !!skyFlags.sunEclipse);
    lunaEl.classList.toggle('blood', !!skyFlags.moonEclipse);
    document.body.classList.toggle('winddown', windDown());
    if (!skyPlaced) { skyPlaced = true; setTimeout(function () { document.body.classList.add('sky-live'); }, 50); }
  }
  var skyPlaced = false;

  // real sky events (northern-hemisphere wording; dates from NASA / EclipseWise tables)
  var SHOWERS = [[0, 3, 'Quadrantids'], [3, 22, 'Lyrids'], [4, 6, 'Eta Aquariids'], [7, 12, 'Perseids'], [9, 21, 'Orionids'], [10, 17, 'Leonids'], [11, 14, 'Geminids'], [11, 22, 'Ursids']];
  var MOON_NAMES = ['Wolf', 'Snow', 'Worm', 'Pink', 'Flower', 'Strawberry', 'Buck', 'Sturgeon', 'Harvest', 'Hunter’s', 'Beaver', 'Cold'];
  var ECLIPSES = [
    ['2027-02-06', 'sun', 'annular solar eclipse', ' over South America and Africa'],
    ['2027-02-20', 'moon', 'penumbral lunar eclipse', ''],
    ['2027-07-18', 'moon', 'penumbral lunar eclipse', ''],
    ['2027-08-02', 'sun', 'total solar eclipse', ' over southern Spain, North Africa and Egypt'],
    ['2027-08-17', 'moon', 'penumbral lunar eclipse', ''],
    ['2028-01-12', 'moon', 'partial lunar eclipse', ', visible from Europe, Africa and the Americas'],
    ['2028-01-26', 'sun', 'annular solar eclipse', ' over South America, Portugal and Spain'],
    ['2028-07-22', 'sun', 'total solar eclipse', ' over Australia and New Zealand']
  ];
  var SEASONS = [[2, 20, 'The spring equinox — day and night in balance.'], [5, 21, 'The summer solstice — the longest day of the year.'],
    [8, 22, 'The autumn equinox — day and night in balance.'], [11, 21, 'The winter solstice — the longest night of the year.']];
  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function daysUntil(d, y, m, day) { return Math.round((new Date(y, m, day).getTime() - dayStart(d)) / DAY); }

  function skyEvents(d) {
    var texts = [], flags = {}, y = d.getFullYear(), age = moonAge(d);
    ECLIPSES.forEach(function (e) {
      var p = e[0].split('-'), n = daysUntil(d, +p[0], +p[1] - 1, +p[2]);
      if (n === 0) {
        texts.push('Today: a ' + e[2] + e[3] + '.');
        if (e[1] === 'sun') flags.sunEclipse = true; else flags.moonEclipse = true;
      } else if (n > 0 && n <= 7 && e[2].indexOf('penumbral') < 0) {
        texts.push((n === 1 ? 'Tomorrow' : 'In ' + n + ' days') + ': a ' + e[2] + e[3] + '.');
      }
    });
    SHOWERS.forEach(function (s) {
      var n = daysUntil(d, y, s[0], s[1]);
      if (Math.abs(n) <= 1) {
        flags.meteors = true;
        texts.push(n === 0 ? 'The ' + s[2] + ' peak tonight — keep an eye on the sky.' : n === 1 ? 'The ' + s[2] + ' meteor shower peaks tomorrow night.' : 'The ' + s[2] + ' are still falling tonight.');
      }
    });
    if (Math.abs(age - 14.765) < 1) texts.push('Full ' + MOON_NAMES[d.getMonth()] + ' Moon tonight.');
    else if (age < 1 || age > 28.5) { flags.newMoon = true; texts.push('New moon — the darkest skies of the month.'); }
    SEASONS.forEach(function (s) { if (daysUntil(d, y, s[0], s[1]) === 0) texts.push(s[2]); });
    return { texts: texts, flags: flags };
  }

  // stars + meteors
  var starCv = $('#stars'), sctx = starCv.getContext('2d'), stars = [], meteor = null, nextMeteor = Date.now() + 15000;
  function seedStars() {
    starCv.width = window.innerWidth; starCv.height = window.innerHeight; stars = [];
    var n = Math.round(starCv.width * starCv.height / 9000);
    for (var i = 0; i < n; i++) stars.push({ x: Math.random() * starCv.width, y: Math.pow(Math.random(), 1.3) * starCv.height * 0.8, r: Math.random() * 1.3 + 0.3, p: Math.random() * 6.28, s: 0.6 + Math.random() * 1.8 });
  }
  function drawStars(t) {
    sctx.clearRect(0, 0, starCv.width, starCv.height);
    if (starAlpha < 0.02) return;
    var slow = document.body.classList.contains('winddown') ? 0.4 : 1, boost = skyFlags.newMoon ? 1.15 : 1;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i], a = Math.min(1, starAlpha * boost * (0.55 + 0.45 * Math.sin(s.p + t / 1000 * s.s * slow)));
      sctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      sctx.beginPath(); sctx.arc(s.x, s.y, s.r, 0, 6.283); sctx.fill();
    }
    var now = Date.now();
    if (!meteor && now > nextMeteor && starAlpha > 0.5) {
      meteor = { x: Math.random() * starCv.width * 0.7 + starCv.width * 0.15, y: Math.random() * starCv.height * 0.25, t0: now, len: 0.7 + Math.random() * 0.8 };
    }
    if (meteor) {
      var k = (now - meteor.t0) / 900;
      if (k > 1) { meteor = null; nextMeteor = now + (skyFlags.meteors ? 2500 + Math.random() * 6000 : 20000 + Math.random() * 40000); }
      else {
        var L = meteor.len, x = meteor.x + k * 260 * L, y = meteor.y + k * 120 * L, gr = sctx.createLinearGradient(x - 120 * L, y - 55 * L, x, y);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,' + (starAlpha * (1 - k)).toFixed(2) + ')');
        sctx.strokeStyle = gr; sctx.lineWidth = 2; sctx.beginPath(); sctx.moveTo(x - 120 * L, y - 55 * L); sctx.lineTo(x, y); sctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------------ clock & insight
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function partOfDay(h) { return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night'; }
  var TIPS = [
    'Press BACK and draw a spell with the arrows.',
    'Press PLAY and let the universe choose.',
    'Hold OK on any world to pin it, hide it, or bind a spell.',
    'The worlds you visit most grow heavier.',
    'Tools → Beam turns your phone into a keyboard.',
    'Tools → Eclipse is a sleep timer for any app.'
  ];
  var tipIx = 0, insightIx = 0, lastInsight = '';
  function insights() {
    var d = new Date(), part = partOfDay(d.getHours()), list = [];
    if (windDown()) list.push('It’s getting late. The stars will still be here tomorrow.');
    list = list.concat(skyEvents(d).texts);
    var habit = null;
    if (T) {
      var best = null, bc = 0;
      for (var p in T.band) if (T.band[p] > bc && world(p) && !isHidden(p)) { bc = T.band[p]; best = p; }
      if (best && bc >= 3) {
        var when = (T.bandDow[best] || 0) >= 2 ? DAYS[d.getDay()] : (isWeekend(d) ? 'Weekend' : 'Weekday');
        habit = when + ' ' + part + 's, you usually drift towards ' + world(best).label + '.';
      }
    }
    list.push(habit || TIPS[tipIx % TIPS.length]);
    return list;
  }
  function updateClock() {
    var d = new Date();
    $('#time').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var date = DAYS[d.getDay()] + ' · ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (eclipseAt > Date.now()) date += ' · eclipse ' + hhmm(eclipseAt);
    $('#date').textContent = date;
    var list = insights(), s = list[insightIx % list.length], el = $('#insight');
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

  // ------------------------------------------------------------------ Sonic orbit
  var Sound = (function () {
    var ctx = null, amb = null, lastKey = null;
    var PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
    function ac() {
      if (!ctx) {
        var C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
        try { ctx = new C(); } catch (e) { return null; }
      }
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      return ctx;
    }
    function tone(f, t0, dur, vol, type) {
      var c = ac(); if (!c) return;
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.05);
    }
    function note(key) { return 261.63 * Math.pow(2, PENTA[Math.floor(hueOf(key) / 36) % 10] / 12); }
    function chord() {
      var h = new Date().getHours();
      if (h >= 5 && h < 12) return [65.41, 98.0, 130.81, 164.81];   // morning: open C
      if (h >= 12 && h < 18) return [73.42, 110.0, 146.83, 185.0];  // day: D
      if (h >= 18 && h < 22) return [58.27, 87.31, 116.54, 146.83]; // evening: warm Bb
      return [55.0, 82.41, 110.0, 130.81];                          // night: low A minor
    }
    return {
      unlock: function () { if (store.sound > 0) ac(); if (store.sound === 2) this.ambience(true); },
      focus: function (key) {
        if (key === lastKey) return; lastKey = key;
        if (store.sound < 1) return; var c = ac(); if (!c) return;
        var t = c.currentTime, f = note(key);
        tone(f, t, 1.1, 0.05, 'sine'); tone(f * 2, t, 0.5, 0.012, 'triangle');
      },
      whoosh: function (d) {
        if (store.sound < 1) return; var c = ac(); if (!c) return;
        var t = c.currentTime, o = c.createOscillator(), g = c.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(d > 0 ? 520 : 160, t); o.frequency.exponentialRampToValueAtTime(d > 0 ? 160 : 520, t + 0.3);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.025, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.4);
      },
      launch: function (key) {
        if (store.sound < 1) return; var c = ac(); if (!c) return;
        var t = c.currentTime, f = note(key);
        tone(f, t, 0.6, 0.05); tone(f * 1.25, t + 0.08, 0.6, 0.045); tone(f * 1.5, t + 0.16, 0.9, 0.04);
      },
      ambience: function (on) {
        var c = on ? ac() : ctx;
        if (on && store.sound === 2 && c && !amb) {
          var master = c.createGain(), lp = c.createBiquadFilter(), lfo = c.createOscillator(), lfoG = c.createGain(), oscs = [];
          lp.type = 'lowpass'; lp.frequency.value = 700;
          master.gain.setValueAtTime(0.0001, c.currentTime); master.gain.exponentialRampToValueAtTime(0.03, c.currentTime + 4);
          lfo.frequency.value = 0.05; lfoG.gain.value = 0.01; lfo.connect(lfoG); lfoG.connect(master.gain); lfo.start();
          chord().forEach(function (f, i) {
            var o = c.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f; o.detune.value = (i - 1.5) * 4;
            o.connect(lp); o.start(); oscs.push(o);
          });
          lp.connect(master); master.connect(c.destination);
          amb = { master: master, oscs: oscs.concat([lfo]) };
        } else if (!on && amb && c) {
          var a = amb; amb = null;
          try { a.master.gain.cancelScheduledValues(c.currentTime); a.master.gain.setValueAtTime(a.master.gain.value || 0.03, c.currentTime); a.master.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.2); } catch (e) {}
          setTimeout(function () { a.oscs.forEach(function (o) { try { o.stop(); } catch (e) {} }); }, 1400);
        }
      }
    };
  })();

  // ------------------------------------------------------------------ launching
  function launch(key, skipBreath) {
    var w = world(key); if (!w) return;
    if (!skipBreath && windDown() && Date.now() - lastBreath > 30 * 60e3) { openBreath(key); return; }
    store.history.push({ p: key, t: Date.now() });
    if (store.history.length > 2000) store.history.splice(0, store.history.length - 2000);
    saveNow();
    Sound.launch(key); Sound.ambience(false);
    var fl = $('#flash'), col = colorCache[key];
    fl.style.setProperty('--c', col ? 'rgb(' + col.join(',') + ')' : '#fff');
    fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
    setTimeout(function () {
      var ok = true;
      try {
        if (!NATIVE) console.log('[orbit] launch', key);
        else if (w.kind === 'live') ok = NATIVE.playLive(w.id);
        else ok = NATIVE.launch(w.pkg);
      } catch (e) { ok = false; }
      setTimeout(function () { fl.classList.remove('go'); if (!NATIVE || !ok) { rebuild(true); Sound.ambience(true); } }, NATIVE ? 900 : 500);
    }, 380);
  }

  function activate() {
    var it = focused(); if (!it) return;
    if (it.kind === 'app' || it.kind === 'live') { launch(it.key); return; }
    if (it.kind === 'rock') { openPlanetMenu(); return; }
    switch (it.tool) {
      case 'beam': case 'livesetup': openBeam(it.tool === 'livesetup'); break;
      case 'roulette': roulette(); break;
      case 'spellbook': openSpellbook(); break;
      case 'eclipse':
        ecStep = eclipseAt > Date.now() ? (ecStep + 1) % ECLIPSE_STEPS.length : 1;
        setEclipse(ECLIPSE_STEPS[ecStep]); break;
      case 'bedtime':
        store.bedtime = BEDTIMES[(BEDTIMES.indexOf(store.bedtime) + 1) % BEDTIMES.length]; save(); refreshTools(); updateSky(); updateClock(); break;
      case 'sound':
        store.sound = ((store.sound || 0) + 1) % 3; save(); refreshTools();
        if (store.sound === 2) Sound.ambience(true); else Sound.ambience(false);
        if (store.sound === 1) Sound.launch('tool:sound');
        break;
      case 'unhide': store.hidden = []; save(); rebuild(true); break;
      case 'forget': openConfirm('Forget your habits?', 'The tide, gravity and insights start from nothing.', function () { store.history = []; saveNow(); rebuild(true); updateClock(); }); break;
      case 'settings': if (NATIVE) NATIVE.openSettings(); break;
      case 'beltinfo': openBeltInfo(); break;
      case 'doorbell': openBell(); break;
      case 'update': if (NATIVE && NATIVE.checkUpdate) { toast('Checking for a newer Orbit…'); NATIVE.checkUpdate(); } break;
    }
  }
  function refreshTools() {
    var R = rings[ringIx('tools')], fresh = toolItems();
    R.items.forEach(function (it, i) { it.label = fresh[i].label; it.sub = fresh[i].sub; });
    updateLabel(true);
  }

  // ------------------------------------------------------------------ eclipse
  function setEclipse(minutes) {
    if (NATIVE) { try { eclipseAt = NATIVE.setEclipse(minutes) || 0; } catch (e) { eclipseAt = 0; } }
    else eclipseAt = minutes ? Date.now() + minutes * 60e3 : 0;
    if (!minutes) ecStep = 0;
    refreshTools(); updateClock();
    toast(minutes ? 'Eclipse at ' + hhmm(eclipseAt) + ' — Orbit will come back and pause what’s playing' : 'Eclipse cancelled');
  }
  function eclipseArrived() {
    eclipseAt = 0; ecStep = 0;
    if (modal) closeModal(); spin = null;
    if (rings.length) refreshTools(); updateClock();
    openModal({ key: function (k) { if (k === 'ok' || k === 'back') closeModal(); } },
      '<div class="panel eclipse-panel"><div class="eclipse-art"><div class="e-sun"></div><div class="e-moon"></div></div>' +
      '<h2>' + hhmm(Date.now()) + '</h2><h1>The eclipse is here.</h1><p>Whatever was playing has been paused. Time to rest.</p><p style="opacity:.45">OK to close</p></div>');
  }

  // ------------------------------------------------------------------ toast / progress
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast'); el.textContent = msg; el.className = 'on';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.className = ''; }, 4200);
  }
  function progress(label, pct) {
    var el = $('#progress');
    if (label === null) { el.className = ''; return; }
    el.className = 'on';
    el.innerHTML = '<span>' + esc(label) + (pct >= 0 ? ' ' + pct + '%' : '…') + '</span><i style="width:' + (pct >= 0 ? pct : 30) + '%"></i>';
  }

  // ------------------------------------------------------------------ modals
  var modalEl = $('#modal'), modal = null;
  function openModal(m, html) { modal = m; modalEl.innerHTML = html; modalEl.className = 'on'; document.body.classList.add('modal-open'); }
  function closeModal() { if (modal && modal.onClose) modal.onClose(); modal = null; modalEl.className = ''; modalEl.innerHTML = ''; document.body.classList.remove('modal-open'); }

  function openMenu(title, sub, options, extra) {
    var sel = 0;
    function draw() {
      modalEl.innerHTML = '<div class="panel"><h2>' + esc(sub) + '</h2><h1>' + esc(title) + '</h1><div class="menu">' +
        options.map(function (o, i) { return '<div class="' + (i === sel ? 'on' : '') + '">' + esc(o.label) + '</div>'; }).join('') + '</div>' + (extra || '') + '</div>';
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
    openMenu(title, 'Are you sure', [{ label: 'Yes', run: yes }, { label: 'Cancel', run: function () {} }], '<p>' + esc(text) + '</p>');
  }

  function spellOpts(it) {
    var sp = spellFor(it.key), o = [];
    o.push({ label: sp ? 'Re-bind spell (' + glyph(sp) + ')' : 'Bind a spell', run: function () { openSpell('bind', it.key); } });
    if (sp) o.push({ label: 'Break the spell', run: function () { delete store.spells[sp]; save(); rebuild(true); } });
    return o;
  }
  function pinOpt(it) {
    return isPinned(it.key)
      ? { label: 'Unpin from Now', run: function () { store.pins.splice(store.pins.indexOf(it.key), 1); save(); rebuild(true); } }
      : { label: 'Pin to Now', run: function () { store.pins.push(it.key); save(); rebuild(true); } };
  }

  function openPlanetMenu() {
    var it = focused(); if (!it) return;
    if (it.kind === 'tool') { activate(); return; }
    var opts = [];
    if (it.kind === 'rock') {
      opts.push({ label: 'Uninstall' + (it.size ? ' · frees ' + fmtSize(it.size) : ''), run: function () { if (NATIVE) NATIVE.uninstall(it.pkg); else toast('(preview) would uninstall ' + it.label); } });
      opts.push({ label: 'Open it', run: function () { launch(it.key); } });
      opts.push({ label: 'Keep in orbit', run: function () { store.keep.push(it.pkg); save(); rebuild(false); toast(it.label + ' will stay out of the belt'); } });
    } else if (it.kind === 'live') {
      opts.push(pinOpt(it));
      opts = opts.concat(spellOpts(it));
      opts.push({ label: 'Remove from Live', run: function () { if (NATIVE) NATIVE.liveRemove(it.liveId); else live.channels = live.channels.filter(function (c) { return c.id !== it.liveId; }); loadLive(); rebuild(false); } });
    } else {
      opts.push(pinOpt(it));
      opts = opts.concat(spellOpts(it));
      opts.push({ label: 'Hide from orbit', run: function () { store.hidden.push(it.key); store.pins = store.pins.filter(function (x) { return x !== it.key; }); save(); rebuild(false); } });
      if (NATIVE) opts.push({ label: 'App info', run: function () { NATIVE.appInfo(it.pkg); } });
    }
    opts.push({ label: 'Close', run: function () {} });
    openMenu(it.label, it.kind === 'rock' ? 'Drifting in the belt' : it.kind === 'live' ? 'Live world' : 'World options', opts);
  }

  function openSpellbook() {
    var keys = Object.keys(store.spells).filter(function (k) { return world(store.spells[k]); });
    var body = keys.length
      ? '<div class="spellbook">' + keys.map(function (k) { return '<div><span class="glyph">' + glyph(k) + '</span>' + esc(world(store.spells[k]).label) + '</div>'; }).join('') + '</div>'
      : '<p>No spells yet.<br>Hold OK on any world and choose “Bind a spell”.</p>';
    openModal({ key: function (k) { if (k === 'ok' || k === 'back') closeModal(); } },
      '<div class="panel"><h2>Press BACK on the home screen, then draw</h2><h1>Spellbook</h1>' + body + '<p style="opacity:.45">OK to close</p></div>');
  }

  function openBeltInfo() {
    openModal({ key: function (k) { if (k === 'ok' || k === 'back') closeModal(); } },
      '<div class="panel" style="max-width:62vw"><h2>Asteroid belt</h2><h1>How the belt forms</h1>' +
      '<p>Apps you haven’t opened for 60 days drift out here, biggest first, ready to remove.</p>' +
      '<p>Orbit learns from what you open through it, so the belt appears after three weeks. To use the box’s own records straight away, connect from a computer and run:</p>' +
      '<p class="code">adb shell appops set com.orbit.launcher GET_USAGE_STATS allow</p><p style="opacity:.45">OK to close</p></div>');
  }

  // Beam: QR code for the phone
  function openBeam(forLive) {
    var info = { url: null, short: null };
    try { info = NATIVE ? JSON.parse(NATIVE.beamInfo()) : { url: 'http://192.168.1.23:8790/?t=demo', short: 'http://192.168.1.23:8790' }; } catch (e) {}
    var body;
    if (!info.url) body = '<p>This box isn’t on a network right now, so your phone can’t reach it.</p>';
    else {
      var qr = NATIVE ? '<img class="qr" src="https://orbit.local/beam-qr.png?' + Date.now() + '" alt="">' : '<div class="qr qr-demo">QR code<br>appears here<br>on the TV</div>';
      body = '<div class="beam-wrap">' + qr + '<div class="beam-text">' +
        '<p>Scan with your phone’s camera. Your phone must be on the same Wi-Fi.</p>' +
        (forLive ? '<p>Then sign in under <b>Live worlds</b> and add your channels.</p>'
          : '<p>Send a <b>link</b> to open it, an <b>APK link</b> to install it, a <b>Downloader code</b> like 12345, or a <b>note</b>. You can also set an Eclipse timer and choose your Live channels.</p>') +
        '<p class="code">' + esc(info.url) + '</p></div></div>';
    }
    openModal({ key: function (k) { if (k === 'ok' || k === 'back') closeModal(); } },
      '<div class="panel" style="max-width:76vw"><h2>Your phone is the keyboard</h2><h1>Beam</h1>' + body + '<p style="opacity:.45">OK to close</p></div>');
  }

  function beamNote(text) {
    if (modal) closeModal();
    document.body.classList.remove('drift');
    openModal({ key: function (k) { if (k === 'ok' || k === 'back') closeModal(); } },
      '<div class="panel" style="max-width:70vw"><h2>Beamed from your phone</h2><div class="note">' + esc(text).replace(/\n/g, '<br>') + '</div><p style="opacity:.45">OK to close</p></div>');
  }

  // spells: draw a D-pad pattern
  function openSpell(mode, key) {
    var seq = '', timer = null, done = false;
    var title = mode === 'cast' ? 'Cast a spell' : 'Draw a spell for ' + world(key).label;
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
      svg.innerHTML = g + '<polyline points="' + pts.map(function (p) { return p.join(','); }).join(' ') + '"/>' + '<circle cx="' + x + '" cy="' + y + '" r="2.6"/>';
      modalEl.querySelector('.spellword').textContent = glyph(seq);
    }
    function msg(t) { var m = $('#spellmsg'); if (m) { m.textContent = t; m.style.opacity = 1; } }
    function resolve() {
      clearTimeout(timer);
      var panel = modalEl.querySelector('.panel');
      if (mode === 'cast') {
        var target = store.spells[seq];
        if (target && world(target)) {
          done = true; msg('✦ ' + world(target).label);
          setTimeout(function () { closeModal(); launch(target); }, 550);
        } else {
          done = true; msg(seq ? 'Nothing answered.' : 'Draw first.');
          panel.classList.remove('fizzle'); void panel.offsetWidth; panel.classList.add('fizzle');
          setTimeout(closeModal, 900);
        }
      } else {
        if (seq.length < 2) { msg('At least two moves.'); seq = ''; draw(); return; }
        var prev = store.spells[seq], old = spellFor(key);
        if (old) delete store.spells[old];
        store.spells[seq] = key; save();
        done = true;
        msg('Bound.' + (prev && prev !== key && world(prev) ? ' (It used to open ' + world(prev).label + '.)' : '') + ' Press BACK on the home screen, then ' + glyph(seq) + '.');
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
    goRing('all', function () {
      var R = rings[ri], n = R.items.length, j = 0;
      for (var q = 0; q < n; q++) if (R.items[q].key === pick.pkg) j = q;
      var cur = Math.round(pos), steps = mod(j - mod(cur, n), n) + n * 2;
      while (steps < 18) steps += n;
      spin = { from: pos, to: cur + steps, t0: performance.now(), dur: 3600 + Math.random() * 800, pick: pick.pkg };
    });
  }
  function rouletteLanded(key) {
    var n = 3, timer;
    openModal({
      key: function (k) { if (k === 'ok') { closeModal(); launch(key); } else if (k === 'back') closeModal(); },
      onClose: function () { clearInterval(timer); }
    }, '<div class="panel chosen"><h2>The universe chose</h2><h1>' + esc(world(key).label) + '</h1><div class="count">' + n + '</div><p style="opacity:.5">OK to go now · BACK to stay</p></div>');
    timer = setInterval(function () {
      n--; if (n <= 0) { closeModal(); launch(key); return; }
      var c = modalEl.querySelector('.count'); if (c) c.textContent = n;
    }, 1000);
  }

  // wind-down: one breath before launching after bedtime
  function openBreath(key) {
    var d = new Date(), timer;
    openModal({
      key: function (k) { if (k === 'back') closeModal(); else if (k === 'ok') { closeModal(); lastBreath = Date.now(); launch(key, true); } },
      onClose: function () { clearTimeout(timer); }
    }, '<div class="panel"><div class="breath"></div><h2>It’s ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '</h2><h1>One breath first.</h1><p>' + esc(world(key).label) + ' will open by itself in a moment.<br>BACK if you’d rather call it a night.</p></div>');
    timer = setTimeout(function () { closeModal(); lastBreath = Date.now(); launch(key, true); }, 6000);
  }

  // ------------------------------------------------------------------ input
  var lastInput = Date.now(), okDownAt = 0, okTimer = null, okLong = false, unlocked = false;
  function handle(k) {
    lastInput = Date.now();
    if (!unlocked) { unlocked = true; Sound.unlock(); }
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
    if (e.keyCode === 13 || e.keyCode === 23) {
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
      if (k >= 1) { var p = spin.pick; R.target = spin.to; pos = spin.to; spin = null; updateLabel(true); rouletteLanded(p); }
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
      try { eclipseAt = NATIVE ? NATIVE.getEclipse() || 0 : eclipseAt; } catch (e) {}
      loadApps(); loadLive(); rebuild(true); updateClock(); updateSky(); refreshEpg();
      Sound.ambience(true);
    },
    pause: function () { Sound.ambience(false); },
    home: function () {
      if (modal) closeModal(); spin = null;
      if (ri !== 0) { ri = 0; renderRing(); renderRingNames(); }
      rings[0].target = 0; pos = Math.round(pos); updateLabel();
    },
    appsChanged: function () { loadApps(); rebuild(true); },
    liveChanged: function () { loadLive(); rebuild(true); refreshEpg(); },
    liveEpg: function (map) {
      for (var id in map) {
        var l = (map[id] && map[id].epg_listings) || [];
        epg[id] = l.map(function (x) {
          var s = +x.start_timestamp * 1000 || Date.parse(String(x.start).replace(' ', 'T')),
            e = +x.stop_timestamp * 1000 || Date.parse(String(x.end).replace(' ', 'T'));
          return { title: b64(x.title || ''), start: s, end: e };
        }).filter(function (x) { return x.end > Date.now() - 6e4; }).sort(function (a, b) { return a.start - b.start; });
      }
      updateLabel(true);
    },
    beamNote: beamNote,
    toast: toast,
    progress: progress,
    eclipseArrived: eclipseArrived,
    updateInfo: function (o) {
      if (o.error) toast(o.error);
      else if (o.newer) toast('A newer Orbit is here — downloading it now');
      else toast('Orbit is up to date (v' + o.current + ')');
    },
    doorbellHeard: function (e) { if (rings.length) refreshTools(); },
    doorbellStatus: function (st) { if (rings.length) refreshTools(); },
    eclipseChanged: function (at) { eclipseAt = at || 0; if (!at) ecStep = 0; if (rings.length) refreshTools(); updateClock(); toast(at ? 'Eclipse set from your phone — ' + hhmm(at) : 'Eclipse cancelled from your phone'); }
  };

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
    r.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      e.preventDefault(); handle(b.getAttribute('data-k'));
    });
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

  // ------------------------------------------------------------------ mock data (browser preview only)
  function mockApps() {
    var now = Date.now();
    var names = [['Netflix', '#e50914'], ['YouTube', '#ff0033'], ['Prime Video', '#1aa3e8'], ['Disney+', '#1b3fa8'], ['Plex', '#e5a00d'],
      ['Spotify', '#1db954'], ['BBC iPlayer', '#f54997'], ['Twitch', '#9146ff'], ['Kodi', '#17b2e7'], ['VLC', '#ff8800'],
      ['Reborn', '#7b5cff'], ['Lumen', '#f2c14e'], ['ITVX', '#a6e22e'], ['Channel 4', '#8a8dff'], ['Apple TV', '#666'],
      ['Downloader', '#f57c00'], ['Files', '#4caf50'], ['Steam Link', '#1b2838'], ['Tidal', '#222'], ['Pluto TV', '#c9b800']];
    var stale = { 'Steam Link': [140, 92e6], 'Tidal': [75, 61e6], 'Pluto TV': [210, 48e6], 'Apple TV': [99, 158e6] };
    return names.map(function (n) {
      var pkg = n[0] === 'Reborn' ? REBORN : 'mock.' + n[0].toLowerCase().replace(/\W/g, '');
      var s = stale[n[0]];
      return { pkg: pkg, label: n[0], icon: letterIcon(n[0], n[1]), system: n[0] === 'Files', size: s ? s[1] : 40e6,
        installed: now - 400 * DAY, lastUsed: s ? now - s[0] * DAY : now - 3 * DAY };
    });
  }
  var mockChannels = [{ id: '101', name: 'Sky Sports Main Event' }, { id: '102', name: 'BBC One' }, { id: '103', name: 'Sky Cinema Premiere' },
    { id: '104', name: 'TNT Sports 1' }, { id: '105', name: 'Discovery' }, { id: '106', name: 'Sky News' }];
  function mockLive() { return { signedIn: true, channels: mockChannels, reborn: true }; }
  function mockEpg() {
    var titles = { '101': ['Monday Night Football', 'The Debate'], '102': ['BBC News at Ten', 'Newsnight'], '103': ['Dune: Part Two', 'Oppenheimer'],
      '104': ['UEFA Champions League Highlights', 'Boxing: Fight Night'], '105': ['Gold Rush', 'Deadliest Catch'], '106': ['The News Hour', 'The World Tonight'] };
    var out = {}, now = Date.now(), h = new Date(now); h.setMinutes(0, 0, 0);
    for (var id in titles) {
      var s1 = h.getTime(), e1 = s1 + (id === '103' ? 150 : 60) * 6e4;
      out[id] = { epg_listings: [
        { title: btoa(titles[id][0]), start_timestamp: String(s1 / 1000), stop_timestamp: String(e1 / 1000) },
        { title: btoa(titles[id][1]), start_timestamp: String(e1 / 1000), stop_timestamp: String(e1 / 1000 + 3600) }] };
    }
    return out;
  }
  function mockHistory() {
    if (NATIVE || store.history.length) return;
    var now = Date.now(), H = [];
    for (var day = 0; day < 28; day++) {
      var base = new Date(now - day * DAY); base.setMinutes(0, 0, 0);
      var at = function (h, p) { var d = new Date(base); d.setHours(h); if (d.getTime() < now) H.push({ p: p, t: d.getTime() + Math.random() * 3e6 }); };
      at(8, 'mock.youtube'); at(8, 'mock.bbciplayer');
      at(19, 'mock.netflix'); at(20, REBORN); at(21, 'mock.netflix');
      if (day % 2) at(19, 'mock.plex');
      if (day % 3 === 0) at(18, 'mock.spotify');
      if (day % 2 === 0) at(20, 'live:101');
      if (day % 7 === 0) at(22, 'mock.twitch');
    }
    H.sort(function (a, b) { return a.t - b.t; });
    store.history = H; store.pins = ['mock.lumen']; store.spells = { URD: 'mock.netflix', LLR: 'mock.youtube', UUR: 'live:101' };
    store.since = now - 60 * DAY;
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    previewRemote();
    loadApps(); loadLive(); mockHistory();
    try { eclipseAt = NATIVE ? NATIVE.getEclipse() || 0 : 0; } catch (e) {}
    buildRings(); renderRing(); renderRingNames(); updateLabel(true);
    seedStars(); updateSky(); updateClock(); refreshEpg();
    setInterval(updateClock, 15000);
    setInterval(updateSky, 30000);
    setInterval(function () { insightIx++; updateClock(); }, 20000);
    setInterval(function () { tipIx++; }, 60000);
    setInterval(refreshEpg, 5 * 60000);
    setInterval(function () {
      if (!modal && !spin && Date.now() - lastInput > 120000) document.body.classList.add('drift');
    }, 5000);
    window.addEventListener('resize', function () { seedStars(); updateSky(); dirty = true; });
    requestAnimationFrame(tick);
  }
  boot();
})();
