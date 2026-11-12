/* Static streaming site — no build step, no dependencies.
 * Reads library.json, renders a browsable catalogue and plays video with the
 * browser's own <video> element. Watch progress and "My List" live in
 * localStorage (per browser, per device). */
(() => {
  'use strict';

  /* ---------- helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);

  // Tiny DOM builder. Text is always set via textContent/append, never innerHTML.
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('sf:' + k); return v == null ? d : JSON.parse(v); }
      catch { return d; }
    },
    set(k, v) { try { localStorage.setItem('sf:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  };

  /* ---------- state ---------- */
  let lib = { siteName: 'Library', items: [] };
  let byId = new Map();
  let progress = store.get('progress', {});   // key -> {id, t, d, u}
  let myList = store.get('list', []);          // [item ids]
  let lastHash = '#/';
  let renderedHash = null;

  const main = $('#main');
  const modal = $('#modal');
  const modalCard = $('.modal-card', modal);

  /* ---------- library model ---------- */
  function episodesOf(item) {
    const out = [];
    for (const season of item.seasons || []) {
      const sNum = season.number ?? 1;
      (season.episodes || []).forEach((ep, i) => {
        const num = ep.number ?? i + 1;
        out.push({ ...ep, season: sNum, number: num, key: `${item.id}#${sNum}x${num}` });
      });
    }
    return out;
  }
  const playablesOf = (item) =>
    item.type === 'show' ? episodesOf(item) : item.src ? [{ ...item, key: item.id, season: null }] : [];

  const ratioOf = (key) => {
    const p = progress[key];
    return p && p.d ? p.t / p.d : 0;
  };

  function resumeTarget(item) {
    const list = playablesOf(item);
    if (!list.length) return null;
    let latest = null;
    for (const pl of list) {
      const p = progress[pl.key];
      if (p && (!latest || p.u > latest.p.u)) latest = { pl, p };
    }
    if (!latest) return list[0];
    if (ratioOf(latest.pl.key) <= 0.95) return latest.pl;
    return list[list.indexOf(latest.pl) + 1] || list[0];
  }

  function playLabel(item) {
    const t = resumeTarget(item);
    if (!t) return 'Unavailable';
    const r = ratioOf(t.key);
    const verb = r > 0.01 && r <= 0.95 ? 'Resume' : 'Play';
    return item.type === 'show' ? `${verb} S${t.season}:E${t.number}` : verb;
  }

  function continueList() {
    const seen = new Set();
    const out = [];
    const entries = Object.entries(progress).sort((a, b) => b[1].u - a[1].u);
    for (const [key, p] of entries) {
      const item = byId.get(p.id);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      if (!playablesOf(item).some((x) => x.key === key)) continue;
      const r = p.d ? p.t / p.d : 0;
      if (r >= 0.01 && r <= 0.95) out.push({ item, key, ratio: r });
    }
    return out;
  }

  const inList = (id) => myList.includes(id);
  function toggleList(id) {
    myList = inList(id) ? myList.filter((x) => x !== id) : [id, ...myList];
    store.set('list', myList);
  }

  /* ---------- UI pieces ---------- */
  function metaRow(item) {
    const bits = [];
    if (item.rating) bits.push(h('span', { class: 'tag', text: item.rating }));
    if (item.year) bits.push(h('span', { text: String(item.year) }));
    if (item.type === 'show') {
      const n = (item.seasons || []).length;
      bits.push(h('span', { text: `${n} season${n === 1 ? '' : 's'}` }));
    } else if (item.runtime) bits.push(h('span', { text: item.runtime }));
    if (item.genres && item.genres.length) bits.push(h('span', { text: item.genres.join(' · ') }));
    return h('div', { class: 'meta' }, bits);
  }

  function card(item, opts = {}) {
    const kids = [h('div', { class: 'fallback', text: item.title })];
    if (item.poster) kids.push(h('img', { src: item.poster, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }));
    kids.push(h('div', { class: 'label', text: item.title }));
    if (opts.ratio) kids.push(h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(opts.ratio * 100)}%` })));
    return h('button', {
      class: 'card', title: item.title, 'aria-label': item.title,
      onclick: opts.onclick || (() => openTitle(item.id)),
    }, kids);
  }

  function rail(title, cards) {
    const r = h('div', { class: 'rail' }, cards);
    const btn = (cls, sym, dir) => h('button', {
      class: `rail-btn ${cls}`, 'aria-label': dir < 0 ? 'Scroll left' : 'Scroll right', text: sym, tabindex: '-1',
      onclick: () => r.scrollBy({ left: dir * r.clientWidth * 0.85, behavior: 'smooth' }),
    });
    return h('section', { class: 'section' },
      h('h2', { text: title }),
      h('div', { class: 'rail-wrap' }, btn('left', '‹', -1), r, btn('right', '›', 1)));
  }

  function hero(item) {
    const bg = item.backdrop || item.poster;
    const target = resumeTarget(item);
    return h('section', { class: 'hero', style: bg ? `background-image:url("${encodeURI(bg)}")` : '' },
      h('div', { class: 'hero-inner' },
        h('h1', { text: item.title }),
        metaRow(item),
        h('p', { text: item.description || '' }),
        h('div', { class: 'row' },
          target && h('button', { class: 'btn primary', text: '▶ ' + playLabel(item), onclick: () => openPlayer(item, target.key) }),
          h('button', { class: 'btn', text: 'More info', onclick: () => openTitle(item.id) }))));
  }

  function emptyLibrary() {
    return h('div', { class: 'error-box' },
      h('h2', { text: 'Your library is empty' }),
      h('p', {}, 'Add titles to ', h('code', { text: 'library.json' }),
        ' (or run ', h('code', { text: 'python3 tools/add_title.py' }), ') and reload. See README.md.'));
  }

  /* ---------- views ---------- */
  function pickFeatured() {
    const feat = lib.items.filter((i) => i.featured);
    const pool = feat.length ? feat : lib.items;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function gridPage(title, items, emptyMsg) {
    return h('div', { class: 'page' },
      h('h1', { text: title }),
      items.length
        ? h('div', { class: 'grid' }, items.map((i) => card(i)))
        : h('div', { class: 'empty', text: emptyMsg }));
  }

  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });

  function matches(item, q) {
    const hay = [item.title, item.year, ...(item.genres || []), ...(item.cast || []), item.director, item.description]
      .filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function renderView(hash) {
    const same = hash === renderedHash;
    const y = same ? window.scrollY : 0;
    main.replaceChildren();

    document.querySelectorAll('#nav a').forEach((a) => {
      const v = a.dataset.view;
      const active = (v === 'home' && hash === '#/') || (v === 'movies' && hash === '#/movies') ||
        (v === 'shows' && hash === '#/shows') || (v === 'list' && hash === '#/list');
      a.classList.toggle('active', active);
    });

    const search = hash.match(/^#\/search\/(.*)$/);
    if (search) {
      const q = decodeURIComponent(search[1]);
      const input = $('#searchInput');
      if (input.value !== q) input.value = q;
      const res = lib.items.filter((i) => matches(i, q)).sort(byTitle);
      main.append(gridPage(`Results for “${q}”`, res, 'Nothing matches that search.'));
    } else if (hash === '#/movies') {
      main.append(gridPage('Movies', lib.items.filter((i) => i.type !== 'show').sort(byTitle), 'No movies yet.'));
    } else if (hash === '#/shows') {
      main.append(gridPage('TV Shows', lib.items.filter((i) => i.type === 'show').sort(byTitle), 'No shows yet.'));
    } else if (hash === '#/list') {
      main.append(gridPage('My List', myList.map((id) => byId.get(id)).filter(Boolean),
        'Nothing here yet. Open a title and choose “+ My List”.'));
    } else {
      renderHome();
    }
    renderedHash = hash;
    window.scrollTo(0, y);
  }

  function renderHome() {
    if (!lib.items.length) { main.append(emptyLibrary()); return; }
    main.append(hero(pickFeatured()));

    const cont = continueList();
    if (cont.length) {
      main.append(rail('Continue Watching',
        cont.map((c) => card(c.item, { ratio: c.ratio, onclick: () => openPlayer(c.item, c.key) }))));
    }
    const mine = myList.map((id) => byId.get(id)).filter(Boolean);
    if (mine.length) main.append(rail('My List', mine.map((i) => card(i))));

    if (lib.items.length >= 4) {
      const recent = [...lib.items].sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')));
      const hasDates = lib.items.some((i) => i.added);
      main.append(rail('Recently Added', (hasDates ? recent : [...lib.items].reverse()).slice(0, 20).map((i) => card(i))));
    }

    const genres = new Map();
    for (const i of lib.items) for (const g of i.genres || []) genres.set(g, [...(genres.get(g) || []), i]);
    [...genres.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)
      .forEach(([g, items]) => main.append(rail(g, items.sort(byTitle).map((i) => card(i)))));
  }

  /* ---------- details modal ---------- */
  let modalItem = null;
  let modalSeason = null;
  let lastFocus = null;

  const openTitle = (id) => { location.hash = '#/title/' + encodeURIComponent(id); };

  function closeModal() {
    if (location.hash.startsWith('#/title/')) location.hash = lastHash;
    else hideModal();
  }

  function hideModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    modalItem = null;
    if (el.player.hidden) document.body.classList.remove('lock');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }

  function showModal(item) {
    if (modal.hidden) lastFocus = document.activeElement;
    if (modalItem !== item) {
      modalItem = item;
      const t = resumeTarget(item);
      modalSeason = t && t.season != null ? t.season : (item.seasons && (item.seasons[0].number ?? 1));
    }
    modal.hidden = false;
    document.body.classList.add('lock');
    renderModal();
    $('.m-close', modalCard).focus({ preventScroll: true });
  }

  function renderModal() {
    const item = modalItem;
    const bg = item.backdrop || item.poster;
    const target = resumeTarget(item);

    const facts = [];
    if (item.cast && item.cast.length) facts.push(h('div', {}, h('b', { text: 'Cast: ' }), item.cast.join(', ')));
    if (item.director) facts.push(h('div', {}, h('b', { text: 'Director: ' }), item.director));

    const epBox = h('div', { class: 'episodes' });
    const fillEpisodes = () => {
      epBox.replaceChildren();
      episodesOf(item).filter((e) => e.season === modalSeason).forEach((e) => {
        const r = ratioOf(e.key);
        epBox.append(h('button', { class: 'ep', onclick: () => openPlayer(item, e.key) },
          h('div', { class: 'n', text: String(e.number) }),
          h('div', { class: 'thumb' },
            e.thumb && h('img', { src: e.thumb, alt: '', loading: 'lazy', onerror: (ev) => ev.target.remove() }),
            r > 0.01 && h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(Math.min(r, 1) * 100)}%` }))),
          h('div', {},
            h('div', { class: 't' }, h('b', { text: e.title || `Episode ${e.number}` }), e.runtime && h('span', { text: e.runtime })),
            h('div', { class: 'd', text: e.description || '' }))));
      });
    };

    let seasonsUI = null;
    if (item.type === 'show' && (item.seasons || []).length) {
      const sel = h('select', {
        'aria-label': 'Season',
        onchange: (e) => { modalSeason = Number(e.target.value); fillEpisodes(); },
      }, item.seasons.map((s) => {
        const n = s.number ?? 1;
        return h('option', { value: String(n), selected: n === modalSeason, text: s.title || `Season ${n}` });
      }));
      seasonsUI = h('div', {},
        h('div', { class: 'season-bar' }, h('h3', { text: 'Episodes' }), sel), epBox);
      fillEpisodes();
    }

    const listBtn = h('button', {
      class: 'btn', text: inList(item.id) ? '✓ In My List' : '+ My List',
      onclick: (e) => { toggleList(item.id); e.target.textContent = inList(item.id) ? '✓ In My List' : '+ My List'; },
    });

    modalCard.replaceChildren(
      h('div', { class: 'm-hero', style: bg ? `background-image:url("${encodeURI(bg)}")` : '' },
        h('button', { class: 'm-close', 'aria-label': 'Close', text: '✕', onclick: closeModal }),
        h('div', { class: 'm-hero-content' },
          h('h2', { id: 'modalTitle', text: item.title }),
          h('div', { class: 'row' },
            target && h('button', { class: 'btn primary', text: '▶ ' + playLabel(item), onclick: () => openPlayer(item, target.key) }),
            listBtn))),
      h('div', { class: 'm-body' },
        metaRow(item),
        h('p', { text: item.description || '' }),
        h('div', { class: 'm-facts' }, facts),
        seasonsUI));
  }

  /* ---------- player ---------- */
  const el = { player: $('#player') };
  const v = $('#video');
  const seek = $('#pSeek'), vol = $('#pVol');
  let cur = null;           // {item, list, idx}
  let hls = null, hlsPromise = null;
  let loadToken = 0, lastSave = 0, idleTimer = null, nextTimer = null;
  let scrubbing = false, tapWasIdle = false, lastPointer = 'mouse';

  const setFill = (inp) => inp.style.setProperty('--p', ((inp.value - inp.min) / (inp.max - inp.min)) * 100 + '%');

  function loadScript(urls) {
    return new Promise((resolve, reject) => {
      const [first, ...rest] = urls;
      if (!first) return reject(new Error('no source'));
      const s = document.createElement('script');
      s.src = first;
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('missing Hls')));
      s.onerror = () => { s.remove(); loadScript(rest).then(resolve, reject); };
      document.head.append(s);
    });
  }
  // Safari plays HLS natively; other browsers need hls.js (local copy first, then CDN).
  function loadHlsLib() {
    if (window.Hls) return Promise.resolve(window.Hls);
    hlsPromise = hlsPromise || loadScript(['js/hls.min.js', 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js'])
      .catch((e) => { hlsPromise = null; throw e; });
    return hlsPromise;
  }
  function destroyHls() { if (hls) { hls.destroy(); hls = null; } }

  function showError(msg) {
    const box = $('#pError');
    box.textContent = msg;
    box.hidden = false;
  }

  function attachSource(src, token) {
    destroyHls();
    const isHls = /\.m3u8(\?|#|$)/i.test(src);
    if (!isHls || v.canPlayType('application/vnd.apple.mpegurl')) { v.src = src; return; }
    loadHlsLib().then((Hls) => {
      if (token !== loadToken) return;
      if (!Hls.isSupported()) return showError('This browser cannot play HLS streams.');
      hls = new Hls({ maxBufferLength: 30 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) showError('The stream failed to load. Check the path in library.json.'); });
      hls.loadSource(src);
      hls.attachMedia(v);
    }).catch(() => showError('Could not load the HLS player library (needs js/hls.min.js or internet access).'));
  }

  function openPlayer(item, key) {
    const list = playablesOf(item);
    if (!list.length) return;
    const idx = Math.max(0, list.findIndex((p) => p.key === key));
    cur = { item, list, idx };
    el.player.hidden = false;
    document.body.classList.add('lock');
    history.pushState({ p: 1 }, '');
    loadEpisode(idx);
    showControls();
    el.player.focus?.();
  }

  function loadEpisode(idx) {
    cancelNext();
    saveProgress();          // store the episode we're leaving (no-op for first load)
    cur.idx = idx;
    const pl = cur.list[idx];
    const token = ++loadToken;

    $('#pError').hidden = true;
    $('#pTitle').textContent = cur.item.type === 'show'
      ? `${cur.item.title} — S${pl.season}:E${pl.number}${pl.title ? ' ' + pl.title : ''}`
      : cur.item.title;
    $('#pNextEp').hidden = idx >= cur.list.length - 1;

    v.querySelectorAll('track').forEach((t) => t.remove());
    (pl.subtitles || []).forEach((s) => v.append(h('track', {
      kind: 'subtitles', src: s.src, srclang: s.lang || '', label: s.label || s.lang || 'Subtitles',
    })));

    const p = progress[pl.key];
    const start = p && ratioOf(pl.key) <= 0.95 && p.t > 5 ? p.t : 0;
    v.addEventListener('loadedmetadata', () => {
      if (token !== loadToken) return;
      if (start && start < v.duration - 3) v.currentTime = start;
      applySubPref(pl);
      buildCCMenu();
    }, { once: true });

    v.playbackRate = Number(store.get('speed', 1)) || 1;
    updateSpeedUI();
    attachSource(pl.src, token);
    v.play().catch(() => {});
    updatePlayUI();
  }

  function saveProgress(finished = false) {
    lastSave = Date.now();
    if (!cur) return;
    const d = v.duration, t = v.currentTime;
    if (!isFinite(d) || d <= 0) return;
    const pl = cur.list[cur.idx];
    if (!pl) return;
    if (!finished && t < 3 && !progress[pl.key]) return;
    progress[pl.key] = { id: cur.item.id, t: finished ? d : t, d, u: Date.now() };
    store.set('progress', progress);
  }

  function closePlayer() {
    if (!cur) return;
    if (history.state && history.state.p) history.back();   // popstate handler tears down
    else teardown();
  }

  function teardown() {
    if (!cur) return;
    saveProgress();
    cancelNext();
    v.pause();
    destroyHls();
    ++loadToken;
    v.removeAttribute('src');
    v.querySelectorAll('track').forEach((t) => t.remove());
    v.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    el.player.hidden = true;
    cur = null;
    if (modal.hidden) document.body.classList.remove('lock');
    route();   // refresh Continue Watching / progress bars
  }

  /* -- player controls -- */
  function togglePlay() {
    if (v.paused || v.ended) { v.play().catch(() => {}); flash('▶'); }
    else { v.pause(); flash('❚❚'); }
  }
  function skip(sec) {
    if (!isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
    flash(sec < 0 ? '⟲' : '⟳');
  }
  function flash(sym) {
    const c = $('#pCenter');
    c.textContent = sym;
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop');
  }
  function toggleFullscreen() {
    const p = el.player;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (p.requestFullscreen) p.requestFullscreen().catch(() => {});
    else if (p.webkitRequestFullscreen) p.webkitRequestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();   // iPhone Safari
  }
  function setVolume(x) {
    v.volume = Math.max(0, Math.min(1, x));
    if (v.volume > 0) v.muted = false;
  }

  function showControls() {
    el.player.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const menuOpen = !$('#ccMenu').hidden || !$('#speedMenu').hidden;
      if (!v.paused && !menuOpen) el.player.classList.add('idle');
    }, 3000);
  }

  function updatePlayUI() { $('#pPlay').textContent = v.paused ? '▶' : '❚❚'; }
  function updateVolUI() {
    const muted = v.muted || v.volume === 0;
    $('#pMute').textContent = muted ? '🔇' : '🔊';
    vol.value = muted ? 0 : v.volume;
    setFill(vol);
  }

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  function updateSpeedUI() {
    $('#pSpeed').textContent = v.playbackRate + '×';
    $('#speedMenu').replaceChildren(...SPEEDS.map((s) => h('button', {
      class: s === v.playbackRate ? 'sel' : '', text: s === 1 ? 'Normal' : s + '×',
      onclick: () => { v.playbackRate = s; store.set('speed', s); updateSpeedUI(); closeMenus(); },
    })));
  }

  function buildCCMenu() {
    const tracks = [...v.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    $('#pCC').parentElement.hidden = tracks.length === 0;
    const anyOn = tracks.some((t) => t.mode === 'showing');
    $('#pCC').classList.toggle('on', anyOn);
    $('#ccMenu').replaceChildren(
      h('button', { class: anyOn ? '' : 'sel', text: 'Off', onclick: () => setTrack(null, tracks) }),
      ...tracks.map((t) => h('button', {
        class: t.mode === 'showing' ? 'sel' : '', text: t.label || t.language || 'Track',
        onclick: () => setTrack(t, tracks),
      })));
  }
  function setTrack(track, tracks) {
    tracks.forEach((t) => { t.mode = t === track ? 'showing' : 'disabled'; });
    store.set('sub', track ? (track.language || track.label) : 'off');
    buildCCMenu();
    closeMenus();
  }
  function applySubPref(pl) {
    const tracks = [...v.textTracks];
    if (!tracks.length) return;
    const pref = store.get('sub', null);
    let pick = null;
    if (pref && pref !== 'off') pick = tracks.find((t) => t.language === pref || t.label === pref) || null;
    else if (pref === null) pick = tracks[(pl.subtitles || []).findIndex((s) => s.default)] || null;
    tracks.forEach((t) => { t.mode = t === pick ? 'showing' : 'disabled'; });
  }
  function cycleCaptions() {
    const tracks = [...v.textTracks];
    if (!tracks.length) return;
    const i = tracks.findIndex((t) => t.mode === 'showing');
    setTrack(i + 1 < tracks.length ? tracks[i + 1] : null, tracks);
  }

  function closeMenus() { $('#ccMenu').hidden = true; $('#speedMenu').hidden = true; }
  function toggleMenu(menu) { const open = menu.hidden; closeMenus(); menu.hidden = !open; }

  /* -- next episode -- */
  function startNextCountdown() {
    let n = 8;
    const nxt = cur.list[cur.idx + 1];
    const label = () => { $('#pNextText').textContent = `Next: S${nxt.season}:E${nxt.number}${nxt.title ? ' ' + nxt.title : ''} — in ${n}s`; };
    $('#pNext').hidden = false;
    label();
    nextTimer = setInterval(() => { n -= 1; if (n <= 0) goNext(); else label(); }, 1000);
  }
  function cancelNext() { clearInterval(nextTimer); nextTimer = null; $('#pNext').hidden = true; }
  function goNext() { if (cur && cur.idx < cur.list.length - 1) loadEpisode(cur.idx + 1); }

  /* -- wiring -- */
  v.addEventListener('timeupdate', () => {
    const d = v.duration, t = v.currentTime;
    if (isFinite(d) && d > 0 && !scrubbing) { seek.value = (t / d) * 1000; setFill(seek); }
    $('#pTime').textContent = `${fmt(t)} / ${fmt(d)}`;
    if (Date.now() - lastSave > 5000) saveProgress();
  });
  v.addEventListener('play', () => { updatePlayUI(); showControls(); });
  v.addEventListener('pause', () => { updatePlayUI(); saveProgress(); showControls(); });
  v.addEventListener('volumechange', () => { updateVolUI(); store.set('vol', { v: v.volume, m: v.muted }); });
  v.addEventListener('error', () => showError('Can’t play this file. Browsers play MP4 (H.264 + AAC), WebM or HLS (.m3u8). Check the path in library.json.'));
  v.addEventListener('ended', () => {
    saveProgress(true);
    if (cur && cur.idx < cur.list.length - 1) startNextCountdown(); else showControls();
  });

  v.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; tapWasIdle = el.player.classList.contains('idle'); });
  v.addEventListener('click', () => { if (lastPointer === 'touch' && tapWasIdle) return; togglePlay(); });
  v.addEventListener('dblclick', toggleFullscreen);
  el.player.addEventListener('pointermove', showControls);
  el.player.addEventListener('pointerdown', showControls);

  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  window.addEventListener('pointerup', () => { scrubbing = false; });
  seek.addEventListener('input', () => {
    if (isFinite(v.duration)) v.currentTime = (seek.value / 1000) * v.duration;
    setFill(seek);
  });
  vol.addEventListener('input', () => setVolume(Number(vol.value)));

  $('#pBack').addEventListener('click', closePlayer);
  $('#pPlay').addEventListener('click', togglePlay);
  $('#pBack10').addEventListener('click', () => skip(-10));
  $('#pFwd10').addEventListener('click', () => skip(10));
  $('#pMute').addEventListener('click', () => { v.muted = !v.muted; });
  $('#pFull').addEventListener('click', toggleFullscreen);
  $('#pNextEp').addEventListener('click', goNext);
  $('#pNextNow').addEventListener('click', goNext);
  $('#pNextCancel').addEventListener('click', cancelNext);
  $('#pCC').addEventListener('click', () => toggleMenu($('#ccMenu')));
  $('#pSpeed').addEventListener('click', () => toggleMenu($('#speedMenu')));
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenus(); });

  window.addEventListener('popstate', () => { if (cur && !el.player.hidden) teardown(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
  window.addEventListener('pagehide', () => saveProgress());

  document.addEventListener('keydown', (e) => {
    if (el.player.hidden) {
      if (e.key === 'Escape' && !modal.hidden) closeModal();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    showControls();
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); skip(-5); break;
      case 'ArrowRight': e.preventDefault(); skip(5); break;
      case 'j': skip(-10); break;
      case 'l': skip(10); break;
      case 'ArrowUp': e.preventDefault(); setVolume(v.volume + 0.05); break;
      case 'ArrowDown': e.preventDefault(); setVolume(v.volume - 0.05); break;
      case 'm': v.muted = !v.muted; break;
      case 'f': toggleFullscreen(); break;
      case 'c': cycleCaptions(); break;
      case 'n': goNext(); break;
      case 'Escape': if (!document.fullscreenElement && !document.webkitFullscreenElement) closePlayer(); break;
      default:
        if (/^[0-9]$/.test(e.key) && isFinite(v.duration)) v.currentTime = (Number(e.key) / 10) * v.duration;
    }
  });
  // Stop Space on a focused button from clicking it a second time.
  document.addEventListener('keyup', (e) => { if (!el.player.hidden && e.key === ' ') e.preventDefault(); });

  /* ---------- routing + boot ---------- */
  function route() {
    const hash = location.hash || '#/';
    const m = hash.match(/^#\/title\/(.+)$/);
    if (m) {
      const item = byId.get(decodeURIComponent(m[1]));
      if (!item) { location.replace('#/'); return; }
      if (!main.firstChild) { lastHash = '#/'; renderView('#/'); }
      showModal(item);
      return;
    }
    hideModal();
    lastHash = hash;
    renderView(hash);
  }

  function showLoadError(err) {
    const local = location.protocol === 'file:';
    main.replaceChildren(h('div', { class: 'error-box' },
      h('h2', { text: 'Couldn’t load library.json' }),
      h('p', { text: local
        ? 'Browsers block file loading when you open index.html directly from disk. Run a tiny local server instead:'
        : String(err && err.message ? err.message : err) }),
      local && h('p', {}, h('code', { text: 'python3 tools/serve.py' }), ' then open http://localhost:8000')));
  }

  async function init() {
    const saved = store.get('vol', null);
    if (saved) { v.volume = saved.v; v.muted = !!saved.m; }
    updateVolUI();
    updateSpeedUI();
    window.addEventListener('scroll', () => $('#topbar').classList.toggle('solid', window.scrollY > 30), { passive: true });

    try {
      const res = await fetch('library.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('library.json: HTTP ' + res.status);
      lib = await res.json();
    } catch (err) { showLoadError(err); return; }

    lib.items = (lib.items || []).filter((i) => i && i.id && i.title).map((i) => ({
      ...i, type: i.type || (i.seasons ? 'show' : 'movie'),
    }));
    byId = new Map(lib.items.map((i) => [String(i.id), i]));
    document.title = lib.siteName || 'Library';
    $('#brand').textContent = lib.siteName || 'Library';

    let t;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        const q = e.target.value.trim();
        const target = q ? '#/search/' + encodeURIComponent(q) : '#/';
        history.replaceState(null, '', target);
        lastHash = target;
        renderView(target);
      }, 150);
    });
    $('#searchForm').addEventListener('submit', (e) => e.preventDefault());
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();
