/* Static streaming site — no build step, no dependencies.
 * Reads library.json, renders a browsable catalogue and plays video with the
 * browser's own <video> element. Watch progress and "My List" live in
 * localStorage (per browser, per device). */
(() => {
  'use strict';

  /* ---------- helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

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

  /* ---------- icons (static, trusted markup) ---------- */
  const F = 'fill="currentColor" stroke="none"';
  const ICONS = {
    play: `<path d="M7 4.5v15l13-7.5z" ${F}/>`,
    pause: `<path d="M6 4h4v16H6zM14 4h4v16h-4z" ${F}/>`,
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 13l4 4 10-10"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    vol: `<path d="M4 9v6h4l5 4V5L8 9z" ${F}/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>`,
    mute: `<path d="M4 9v6h4l5 4V5L8 9z" ${F}/><path d="M17 9.5l5 5M22 9.5l-5 5"/>`,
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    exit: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    next: `<path d="M5 5l10 7-10 7z" ${F}/><path d="M19 5v14"/>`,
    back10: '<path d="M12 5a8 8 0 1 1-8 8"/><path d="M15 2l-3 3 3 3"/><text x="12" y="16" text-anchor="middle" font-size="7.5" font-weight="700">10</text>',
    fwd10: '<path d="M12 5a8 8 0 1 0 8 8"/><path d="M9 2l3 3-3 3"/><text x="12" y="16" text-anchor="middle" font-size="7.5" font-weight="700">10</text>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const ico = (name) => { const s = h('span', { class: 'ico' }); s.innerHTML = svg(name); return s; };

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

  /* ---------- small UI pieces ---------- */
  const bgStyle = (item) => {
    const bg = item.backdrop || item.poster;
    return bg ? `background-image:url("${encodeURI(bg)}")` : '';
  };

  function toast(msg) {
    const t = h('div', { class: 'toast', text: msg });
    $('#toast').append(t);
    setTimeout(() => {
      t.classList.add('out');
      t.addEventListener('animationend', () => t.remove());
    }, 2200);
  }

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

  function lazyImg(src, extra) {
    const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async', ...extra });
    img.addEventListener('load', () => img.classList.add('ld'));
    img.addEventListener('error', () => img.remove());
    return img;
  }

  function card(item, opts = {}) {
    const kids = [h('div', { class: 'fallback' }, h('span', { text: item.title }))];
    if (item.poster) kids.push(lazyImg(item.poster));
    kids.push(h('div', { class: 'label', text: item.title }));
    if (opts.ratio) kids.push(h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(opts.ratio * 100)}%` })));
    return h('button', {
      class: 'card', title: item.title, 'aria-label': item.title,
      onclick: opts.onclick || (() => openTitle(item.id)),
    }, kids);
  }

  const stagger = (cards) => { cards.forEach((c, i) => c.style.setProperty('--i', Math.min(i, 14))); return cards; };

  function rail(title, cards) {
    const r = h('div', { class: 'rail' }, stagger(cards));
    const btn = (cls, name, dir) => h('button', {
      class: `rail-btn ${cls}`, 'aria-label': dir < 0 ? 'Scroll left' : 'Scroll right', tabindex: '-1',
      onclick: () => r.scrollBy({ left: dir * r.clientWidth * 0.85, behavior: 'smooth' }),
    }, ico(name));
    return h('section', { class: 'section' },
      h('h2', { text: title }),
      h('div', { class: 'rail-wrap' }, btn('left', 'left', -1), r, btn('right', 'right', 1)));
  }

  /* ---------- hero (auto-rotating, parallax) ---------- */
  function heroItems() {
    const feat = lib.items.filter((i) => i.featured);
    const pool = (feat.length ? feat : lib.items).slice();
    for (let i = pool.length - 1; i > 0; i--) {         // shuffle
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 5);
  }

  function heroBlock(items) {
    const bgs = items.map((it) => h('div', { class: 'hero-bg', style: bgStyle(it) }));
    const inner = h('div', { class: 'hero-inner' });
    let idx = -1, swapTimer = null;

    const dots = items.length > 1 ? items.map((it, i) => h('button', {
      class: 'dot', 'aria-label': `Show ${it.title}`, onclick: () => go(i),
    }, h('i', { onanimationend: () => go((idx + 1) % items.length) }))) : [];

    const content = (item) => {
      const target = resumeTarget(item);
      const title = h('h1', {});
      item.title.split(/\s+/).filter(Boolean).forEach((w, i) => {
        title.append(h('span', { class: 'w' }, h('span', { style: `--i:${i}`, text: w })), ' ');
      });
      return [
        h('div', { class: 'kicker', text: `Featured · ${item.type === 'show' ? 'Series' : 'Film'}` }),
        title,
        metaRow(item),
        h('p', { text: item.description || '' }),
        h('div', { class: 'row' },
          target && h('button', { class: 'btn primary', onclick: () => openPlayer(item, target.key) }, ico('play'), playLabel(item)),
          h('button', { class: 'btn', text: 'More info', onclick: () => openTitle(item.id) })),
      ];
    };

    function go(i) {
      if (i === idx) return;
      const first = idx < 0;
      idx = i;
      bgs.forEach((b, j) => b.classList.toggle('on', j === i));
      dots.forEach((d, j) => { d.classList.remove('on'); d.classList.toggle('done', j < i); });
      if (dots[i]) { void dots[i].offsetWidth; dots[i].classList.add('on'); }
      clearTimeout(swapTimer);
      const swap = () => {
        inner.classList.remove('exit', 'enter');
        inner.replaceChildren(...content(items[i]));
        void inner.offsetWidth;
        inner.classList.add('enter');
      };
      if (first || reduce) swap();
      else { inner.classList.add('exit'); swapTimer = setTimeout(swap, 320); }
    }

    const root = h('section', { class: 'hero' },
      h('div', { class: 'hero-bgs' }, bgs),
      h('div', { class: 'hero-shade' }),
      h('div', { class: 'hero-wrap' }, inner, dots.length ? h('div', { class: 'hero-dots' }, dots) : null));
    go(0);
    return root;
  }

  function emptyLibrary() {
    return h('div', { class: 'error-box' },
      h('h2', { text: 'Your library is empty' }),
      h('p', {}, 'Add titles to ', h('code', { text: 'library.json' }),
        ' (or run ', h('code', { text: 'python3 tools/add_title.py' }), ') and reload. See README.md.'));
  }

  /* ---------- views ---------- */
  function gridPage(title, items, emptyMsg) {
    return h('div', { class: 'page' },
      h('h1', { text: title }),
      items.length
        ? h('div', { class: 'grid' }, stagger(items.map((i) => card(i))))
        : h('div', { class: 'empty', text: emptyMsg }));
  }

  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });

  function matches(item, q) {
    const hay = [item.title, item.year, ...(item.genres || []), ...(item.cast || []), item.director, item.description]
      .filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // Reveal rows as they scroll into view.
  const revealer = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 })
    : null;

  function moveInk() {
    const a = $('#nav a.active');
    const ink = $('#navInk');
    if (!a) { ink.style.opacity = '0'; return; }
    ink.style.opacity = '1';
    ink.style.width = a.offsetWidth + 'px';
    ink.style.transform = `translateX(${a.offsetLeft}px)`;
  }

  function renderView(hash) {
    const same = hash === renderedHash;
    const y = same ? window.scrollY : 0;
    main.replaceChildren();

    document.querySelectorAll('#nav a').forEach((a) => {
      const v = a.dataset.view;
      a.classList.toggle('active', (v === 'home' && hash === '#/') || (v === 'movies' && hash === '#/movies') ||
        (v === 'shows' && hash === '#/shows') || (v === 'list' && hash === '#/list'));
    });
    moveInk();

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
        'Nothing here yet. Open a title and choose “My List”.'));
    } else {
      renderHome();
    }

    main.querySelectorAll('.section').forEach((s) => (revealer ? revealer.observe(s) : s.classList.add('in')));
    renderedHash = hash;
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    if (!same) {
      main.classList.remove('view-in');
      void main.offsetWidth;
      main.classList.add('view-in');
    }
  }

  function renderHome() {
    if (!lib.items.length) { main.append(emptyLibrary()); return; }
    main.append(heroBlock(heroItems()));

    const cont = continueList();
    if (cont.length) {
      main.append(rail('Continue Watching',
        cont.map((c) => card(c.item, { ratio: c.ratio, onclick: () => openPlayer(c.item, c.key) }))));
    }
    const mine = myList.map((id) => byId.get(id)).filter(Boolean);
    if (mine.length) main.append(rail('My List', mine.map((i) => card(i))));

    if (lib.items.length >= 4) {
      const hasDates = lib.items.some((i) => i.added);
      const recent = hasDates
        ? [...lib.items].sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')))
        : [...lib.items].reverse();
      main.append(rail('Recently Added', recent.slice(0, 20).map((i) => card(i))));
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
  let modalCloseTimer = null;

  const openTitle = (id) => { location.hash = '#/title/' + encodeURIComponent(id); };

  function closeModal() {
    if (location.hash.startsWith('#/title/')) location.hash = lastHash;
    else hideModal();
  }

  function hideModal() {
    if (modal.hidden || modal.classList.contains('closing')) return;
    modalItem = null;
    modal.classList.add('closing');
    modalCloseTimer = setTimeout(() => {
      modalCloseTimer = null;
      modal.hidden = true;
      modal.classList.remove('closing');
      if (el.player.hidden) document.body.classList.remove('lock');
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }, reduce ? 0 : 290);
  }

  function showModal(item) {
    const wasClosed = modal.hidden || modal.classList.contains('closing');
    if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; modal.classList.remove('closing'); }
    if (modal.hidden) lastFocus = document.activeElement;
    if (modalItem !== item) {
      modalItem = item;
      const t = resumeTarget(item);
      modalSeason = t && t.season != null ? t.season : (item.seasons && item.seasons[0] && (item.seasons[0].number ?? 1));
    }
    modalCard.classList.toggle('first', wasClosed);
    modal.hidden = false;
    document.body.classList.add('lock');
    renderModal();
    $('.m-close', modalCard).focus({ preventScroll: true });
  }

  function renderModal() {
    const item = modalItem;
    const target = resumeTarget(item);

    const facts = [];
    if (item.cast && item.cast.length) facts.push(h('div', {}, h('b', { text: 'Cast  ' }), item.cast.join(', ')));
    if (item.director) facts.push(h('div', {}, h('b', { text: 'Director  ' }), item.director));

    const epBox = h('div', { class: 'episodes' });
    const fillEpisodes = () => {
      epBox.replaceChildren();
      episodesOf(item).filter((e) => e.season === modalSeason).forEach((e, i) => {
        const r = ratioOf(e.key);
        epBox.append(h('button', { class: 'ep', style: `--i:${Math.min(i, 12)}`, onclick: () => openPlayer(item, e.key) },
          h('div', { class: 'n', text: String(e.number) }),
          h('div', { class: 'thumb' },
            e.thumb && lazyImg(e.thumb),
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
      seasonsUI = h('div', {}, h('div', { class: 'season-bar' }, h('h3', { text: 'Episodes' }), sel), epBox);
      fillEpisodes();
    }

    const setListBtn = (b) => b.replaceChildren(ico(inList(item.id) ? 'check' : 'plus'), inList(item.id) ? 'In My List' : 'My List');
    const listBtn = h('button', {
      class: 'btn',
      onclick: (e) => {
        toggleList(item.id);
        setListBtn(e.currentTarget);
        toast(inList(item.id) ? 'Added to My List' : 'Removed from My List');
      },
    });
    setListBtn(listBtn);

    modalCard.replaceChildren(
      h('div', { class: 'm-hero' },
        h('div', { class: 'm-bg', style: bgStyle(item) }),
        h('button', { class: 'm-close', 'aria-label': 'Close', onclick: closeModal }, ico('x')),
        h('div', { class: 'm-hero-content' },
          h('h2', { id: 'modalTitle', text: item.title }),
          h('div', { class: 'row' },
            target && h('button', { class: 'btn primary', onclick: () => openPlayer(item, target.key) }, ico('play'), playLabel(item)),
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
  const seek = $('#pSeek'), vol = $('#pVol'), tip = $('#pTip');
  let cur = null;           // {item, list, idx}
  let hls = null, hlsPromise = null;
  let loadToken = 0, lastSave = 0, idleTimer = null, nextTimer = null, closing = false;
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
    if (closing) return;
    const list = playablesOf(item);
    if (!list.length) return;
    const idx = Math.max(0, list.findIndex((p) => p.key === key));
    cur = { item, list, idx };
    el.player.hidden = false;
    document.body.classList.add('lock');
    history.pushState({ p: 1 }, '');
    loadEpisode(idx);
    showControls();
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
    if (!cur || closing) return;
    if (history.state && history.state.p) history.back();   // popstate handler tears down
    else teardown();
  }

  function teardown() {
    if (!cur || closing) return;
    closing = true;
    saveProgress();
    cancelNext();
    v.pause();
    el.player.classList.add('closing');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    setTimeout(() => {
      destroyHls();
      ++loadToken;
      v.removeAttribute('src');
      v.querySelectorAll('track').forEach((t) => t.remove());
      v.load();
      el.player.hidden = true;
      el.player.classList.remove('closing');
      cur = null;
      closing = false;
      if (modal.hidden) document.body.classList.remove('lock');
      route();   // refresh Continue Watching / progress bars
    }, reduce ? 0 : 330);
  }

  /* -- player controls -- */
  function togglePlay() {
    if (v.paused || v.ended) { v.play().catch(() => {}); flash('play'); }
    else { v.pause(); flash('pause'); }
  }
  function skip(sec) {
    if (!isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
    flash(sec < 0 ? 'back10' : 'fwd10');
  }
  function flash(name) {
    const c = $('#pCenter');
    c.innerHTML = svg(name);
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

  function updatePlayUI() { $('#pPlay').innerHTML = svg(v.paused ? 'play' : 'pause'); }
  function updateVolUI() {
    const muted = v.muted || v.volume === 0;
    $('#pMute').innerHTML = svg(muted ? 'mute' : 'vol');
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
    const bar = $('#pNextBar');
    bar.classList.remove('run');
    void bar.offsetWidth;
    bar.classList.add('run');
    label();
    nextTimer = setInterval(() => { n -= 1; if (n <= 0) goNext(); else label(); }, 1000);
  }
  function cancelNext() { clearInterval(nextTimer); nextTimer = null; $('#pNext').hidden = true; $('#pNextBar').classList.remove('run'); }
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
  document.addEventListener('fullscreenchange', () => {
    $('#pFull').innerHTML = svg(document.fullscreenElement ? 'exit' : 'full');
  });

  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  window.addEventListener('pointerup', () => { scrubbing = false; });
  seek.addEventListener('input', () => {
    if (isFinite(v.duration)) v.currentTime = (seek.value / 1000) * v.duration;
    setFill(seek);
  });
  seek.addEventListener('pointermove', (e) => {
    const r = seek.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    tip.textContent = fmt(f * (v.duration || 0));
    tip.style.left = f * r.width + 'px';
    tip.classList.add('on');
  });
  seek.addEventListener('pointerleave', () => tip.classList.remove('on'));
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

  /* ---------- motion layer ---------- */
  // Click ripple on buttons, cards and episode rows.
  document.addEventListener('pointerdown', (e) => {
    if (reduce) return;
    const t = e.target.closest('.btn, .icon-btn, .card, .ep, .menu button');
    if (!t) return;
    const r = t.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const s = h('span', { class: 'ripple', style: `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px` });
    t.append(s);
    s.addEventListener('animationend', () => s.remove());
  });

  // 3D tilt + glare following the mouse over cards.
  main.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || reduce) return;
    const c = e.target.closest('.card');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    c.style.setProperty('--ry', ((px - 0.5) * 16).toFixed(2) + 'deg');
    c.style.setProperty('--rx', ((0.5 - py) * 16).toFixed(2) + 'deg');
    c.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
    c.style.setProperty('--my', (py * 100).toFixed(1) + '%');
  });
  main.addEventListener('pointerout', (e) => {
    const c = e.target.closest && e.target.closest('.card');
    if (!c || c.contains(e.relatedTarget)) return;
    c.style.removeProperty('--rx');
    c.style.removeProperty('--ry');
  });

  // Soft red spotlight that trails the cursor.
  function initGlow() {
    const g = $('#glow');
    if (!finePointer || reduce) { g.remove(); return; }
    let tx = -900, ty = -900, x = tx, y = ty, running = false;
    const loop = () => {
      x += (tx - x) * 0.09;
      y += (ty - y) * 0.09;
      g.style.transform = `translate3d(${x - 300}px, ${y - 300}px, 0)`;
      if (Math.abs(tx - x) + Math.abs(ty - y) > 0.5) requestAnimationFrame(loop);
      else running = false;
    };
    window.addEventListener('pointermove', (e) => {
      if (x < -800) { x = e.clientX; y = e.clientY; }
      tx = e.clientX; ty = e.clientY;
      if (!running) { running = true; requestAnimationFrame(loop); }
    }, { passive: true });
  }

  // Scroll progress, hero parallax, auto-hiding top bar.
  let lastY = 0, scrollTick = false;
  function onScroll() {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      $('#sp').style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
      const bar = $('#topbar');
      bar.classList.toggle('solid', y > 30);
      if (y > 320 && y > lastY + 4 && el.player.hidden && modal.hidden) bar.classList.add('hide');
      else if (y < lastY - 4 || y <= 320) bar.classList.remove('hide');
      lastY = y;
      const hero = main.querySelector('.hero');
      if (hero && y < window.innerHeight * 1.3) {
        hero.style.setProperty('--py', (y * 0.28).toFixed(1) + 'px');
        hero.style.setProperty('--ho', Math.max(0, 1 - y / (window.innerHeight * 0.8)).toFixed(3));
      }
    });
  }

  function playIntro(name) {
    const intro = $('#intro');
    if (!intro) return;
    const word = $('#introWord');
    [...name.toUpperCase()].forEach((ch, i) => word.append(h('span', { style: `--i:${i}`, text: ch === ' ' ? ' ' : ch })));
    intro.classList.add('go');
    setTimeout(() => {
      intro.classList.add('done');
      setTimeout(() => intro.remove(), 1200);
    }, reduce ? 0 : 1900);
  }

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

  function initIcons() {
    $('#pBack').innerHTML = svg('back');
    $('#pBack10').innerHTML = svg('back10');
    $('#pFwd10').innerHTML = svg('fwd10');
    $('#pFull').innerHTML = svg('full');
    $('#pNextEp').innerHTML = 'Next ' + svg('next');
    updatePlayUI();
  }

  async function init() {
    initIcons();
    const saved = store.get('vol', null);
    if (saved) { v.volume = saved.v; v.muted = !!saved.m; }
    updateVolUI();
    updateSpeedUI();
    initGlow();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', moveInk);

    try {
      const res = await fetch('library.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('library.json: HTTP ' + res.status);
      lib = await res.json();
    } catch (err) {
      const intro = $('#intro');
      if (intro) intro.remove();
      showLoadError(err);
      return;
    }

    lib.items = (lib.items || []).filter((i) => i && i.id && i.title).map((i) => ({
      ...i, type: i.type || (i.seasons ? 'show' : 'movie'),
    }));
    byId = new Map(lib.items.map((i) => [String(i.id), i]));
    document.title = lib.siteName || 'Library';
    $('#brandText').textContent = lib.siteName || 'Library';

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

    playIntro(lib.siteName || 'Library');
    // Build the page behind the splash so it is ready as the curtain lifts.
    setTimeout(() => { route(); onScroll(); }, reduce ? 0 : 1500);
    document.fonts && document.fonts.ready.then(moveInk);
  }

  init();
})();
