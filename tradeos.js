(() => {
  'use strict';

  /* Dasverra Trade OS (early access)
     - RFQ basket (kept in this browser only until the buyer form is submitted)
     - Catalogue search and filters
     - Register-form prefill from the basket or from a Trade Board listing
     - Trade Board and Track-a-trade, both read from the Google Apps Script endpoint (GET);
       Track also draws a shipment (route, dates, progress) when the trade desk shares one
     Nothing here sends data anywhere except the register form (app.js) and the two read-only lookups. */

  const CONF = Object.assign({ formEndpoint: '', whatsapp: '918013906621', email: 'aseem.das@dasverra.org' }, window.DVCONF || {});
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function icon(id) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  /* One polite live region for announcements. */
  const live = el('div', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  function say(message) {
    live.textContent = '';
    setTimeout(() => { live.textContent = message; }, 30);
  }

  /* ---------- Storage that never throws ---------- */
  const memory = {};
  const store = {
    get(key) {
      try {
        const v = window.localStorage.getItem(key);
        if (v !== null) return v;
      } catch (err) { /* blocked: fall through to memory */ }
      return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
    },
    set(key, value) {
      memory[key] = value;
      try { window.localStorage.setItem(key, value); } catch (err) { /* memory copy still works for this visit */ }
    },
    del(key) {
      delete memory[key];
      try { window.localStorage.removeItem(key); } catch (err) { /* ignore */ }
    }
  };

  /* =====================================================================
     RFQ basket
     ===================================================================== */
  const KEY = 'dv_rfq_v1';
  const MAX_ITEMS = 40;

  function clip(it) {
    return {
      id: String(it.id).slice(0, 120),
      name: String(it.name).slice(0, 120),
      spec: String(it.spec || '').slice(0, 200),
      chip: String(it.chip || '').slice(0, 80),
      group: String(it.group || '').slice(0, 40)
    };
  }
  function loadBasket() {
    const raw = store.get(KEY);
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      const list = data && Array.isArray(data.items) ? data.items : [];
      const seen = {};
      const out = [];
      list.forEach(it => {
        if (!it || typeof it.id !== 'string' || typeof it.name !== 'string' || seen[it.id]) return;
        seen[it.id] = true;
        out.push(clip(it));
      });
      return out.slice(0, MAX_ITEMS);
    } catch (err) {
      return [];
    }
  }
  let basket = loadBasket();

  const has = id => basket.some(i => i.id === id);
  function persist() {
    store.set(KEY, JSON.stringify({ v: 1, items: basket }));
    syncBasket();
  }
  function addItem(item) {
    if (has(item.id)) return true;
    if (basket.length >= MAX_ITEMS) return false;
    basket.push(clip(item));
    persist();
    return true;
  }
  function removeItem(id) {
    basket = basket.filter(i => i.id !== id);
    persist();
  }
  function clearBasket() {
    basket = [];
    persist();
  }

  const tray = $('#rfq');
  const scrim = $('#rfq-scrim');
  const fab = $('#rfq-fab');
  const trayList = $('#rfq-list');
  const trayEmpty = $('#rfq-empty');
  const trayFoot = $('.rfq-foot', tray || document);
  let trayOpener = null;

  function syncBasket() {
    const n = basket.length;
    $$('[data-rfq-count]').forEach(node => { node.textContent = String(n); node.dataset.n = String(n); });
    $$('[data-rfq-link]').forEach(a => {
      a.setAttribute('aria-label', 'My RFQ, ' + n + (n === 1 ? ' product' : ' products'));
    });
    $$('.p-card').forEach(card => {
      const on = has(card.dataset.id);
      card.classList.toggle('in-rfq', on);
      const btn = $('[data-rfq-add]', card);
      if (!btn) return;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const label = $('[data-text]', btn);
      if (label) label.textContent = on ? 'Added' : 'Add to RFQ';
    });
    if (fab) fab.hidden = n === 0 || !tray;
    if (trayList) {
      trayList.textContent = '';
      basket.forEach(it => {
        const li = el('li', 'rfq-item');
        const text = el('div', 'rfq-item-text');
        text.appendChild(el('b', '', it.name));
        if (it.spec) text.appendChild(el('span', '', it.spec));
        const rm = el('button', 'rfq-remove');
        rm.type = 'button';
        rm.dataset.id = it.id;
        rm.setAttribute('aria-label', 'Remove ' + it.name + ' from RFQ');
        rm.appendChild(icon('i-close'));
        li.appendChild(text);
        li.appendChild(rm);
        trayList.appendChild(li);
      });
      trayList.hidden = n === 0;
      if (trayEmpty) trayEmpty.hidden = n !== 0;
      if (trayFoot) trayFoot.hidden = n === 0;
    }
  }

  /* Tray (dialog) */
  const INERT_SELECTORS = ['.os-bar', '.site-header', 'main', '.site-footer'];
  function setInert(on) {
    INERT_SELECTORS.forEach(sel => {
      const node = $(sel);
      if (!node) return;
      if (on) node.setAttribute('inert', ''); else node.removeAttribute('inert');
    });
  }
  function trayIsOpen() { return !!tray && !tray.hidden; }
  function openTray() {
    if (!tray || trayIsOpen()) return;
    trayOpener = document.activeElement;
    tray.hidden = false;
    scrim.hidden = false;
    document.documentElement.classList.add('rfq-open');
    if (fab) fab.setAttribute('aria-expanded', 'true');
    setInert(true);
    const first = $('.rfq-remove, #rfq-go, [data-rfq-close]', tray);
    (first || tray).focus({ preventScroll: true });
  }
  function closeTray(restoreFocus) {
    if (!trayIsOpen()) return;
    tray.hidden = true;
    scrim.hidden = true;
    document.documentElement.classList.remove('rfq-open');
    if (fab) fab.setAttribute('aria-expanded', 'false');
    setInert(false);
    if (location.hash === '#rfq' && window.history && history.replaceState) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (restoreFocus !== false) {
      const usable = trayOpener && trayOpener !== document.body && document.contains(trayOpener) && !trayOpener.hidden;
      const back = usable ? trayOpener : (fab && !fab.hidden ? fab : null);
      if (back) back.focus({ preventScroll: true });
    }
    trayOpener = null;
  }

  if (tray) {
    // Move out of <main> so the rest of the page can be made inert while the tray is open.
    document.body.appendChild(scrim);
    document.body.appendChild(tray);
    if (fab) document.body.appendChild(fab);

    if (fab) fab.addEventListener('click', () => (trayIsOpen() ? closeTray() : openTray()));
    scrim.addEventListener('click', () => closeTray());
    $$('[data-rfq-close]', tray).forEach(b => b.addEventListener('click', () => closeTray()));
    $('#rfq-clear', tray).addEventListener('click', () => {
      clearBasket();
      say('RFQ cleared.');
      tray.focus({ preventScroll: true });
    });
    trayList.addEventListener('click', e => {
      const btn = e.target.closest('.rfq-remove');
      if (!btn) return;
      const name = (btn.getAttribute('aria-label') || '').replace(/^Remove | from RFQ$/g, '');
      removeItem(btn.dataset.id);
      say('Removed ' + name + '. ' + basket.length + (basket.length === 1 ? ' product' : ' products') + ' in your RFQ.');
      const next = $('.rfq-remove', trayList);
      (next || tray).focus({ preventScroll: true });
    });
    tray.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeTray(); return; }
      if (e.key !== 'Tab') return;
      const nodes = $$('button:not([disabled]), a[href]', tray).filter(n => !n.hidden && n.offsetParent !== null);
      if (!nodes.length) { e.preventDefault(); tray.focus(); return; }
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === firstNode || document.activeElement === tray)) { e.preventDefault(); lastNode.focus(); }
      else if (!e.shiftKey && document.activeElement === lastNode) { e.preventDefault(); firstNode.focus(); }
    });
    // Every "My RFQ" link on the catalogue page opens the tray instead of reloading the page.
    $$('a[href$="#rfq"]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); openTray(); }));
    window.addEventListener('hashchange', () => { if (location.hash === '#rfq') openTray(); });
    if (location.hash === '#rfq') openTray();
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-rfq-add]');
    if (!btn) return;
    const card = btn.closest('.p-card');
    if (!card) return;
    const id = card.dataset.id;
    if (has(id)) {
      removeItem(id);
      say('Removed ' + card.dataset.name + ' from your RFQ.');
      return;
    }
    const ok = addItem({ id: id, name: card.dataset.name, spec: card.dataset.spec, chip: card.dataset.chip, group: card.dataset.group });
    if (ok) {
      say('Added ' + card.dataset.name + ' to your RFQ. ' + basket.length + (basket.length === 1 ? ' product' : ' products') + ' in total.');
    } else {
      const label = $('[data-text]', btn);
      if (label) {
        label.textContent = 'RFQ is full';
        setTimeout(syncBasket, 1800);
      }
      say('Your RFQ already holds ' + MAX_ITEMS + ' products. Send it first, then start another.');
    }
  });

  window.addEventListener('storage', e => {
    if (e.key !== KEY) return;
    basket = loadBasket();
    syncBasket();
  });

  /* =====================================================================
     Catalogue: search and filters
     ===================================================================== */
  function initCatalogue() {
    const search = $('#cat-q');
    if (!search) return;
    const cards = $$('.p-card');
    const groups = $$('.cat-group');
    const filters = $$('.cat-filters button[data-group]');
    const count = $('#cat-count');
    const empty = $('#cat-empty');
    const emptyText = $('#cat-empty-text');
    const emptyCta = $('#cat-empty-cta');
    const reset = $('#cat-reset');
    const total = cards.length;
    let group = 'all';

    function apply() {
      const raw = search.value.trim();
      const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      cards.forEach(card => {
        const inGroup = group === 'all' || card.dataset.group === group;
        const hay = card.dataset.search || '';
        const on = inGroup && terms.every(t => hay.indexOf(t) !== -1);
        card.hidden = !on;
        if (on) shown += 1;
      });
      groups.forEach(g => { g.hidden = !$('.p-card:not([hidden])', g); });
      count.textContent = shown === total ? 'Showing all ' + total + ' products' : 'Showing ' + shown + ' of ' + total + ' products';
      empty.hidden = shown > 0;
      if (shown === 0) {
        emptyText.textContent = raw
          ? 'Nothing in the catalogue matches "' + raw.slice(0, 60) + '". We work around the requirement, not a fixed list, so tell us what you need.'
          : 'Nothing in this category yet. We work around the requirement, not a fixed list, so tell us what you need.';
        emptyCta.href = 'register.html' + (raw ? '?q=' + encodeURIComponent(raw.slice(0, 120)) : '') + '#buyer';
      }
    }
    function setGroup(key) {
      group = filters.some(b => b.dataset.group === key) ? key : 'all';
      filters.forEach(b => b.setAttribute('aria-pressed', b.dataset.group === group ? 'true' : 'false'));
    }

    let timer = null;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 80); });
    search.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    filters.forEach(b => b.addEventListener('click', () => { setGroup(b.dataset.group); apply(); }));
    reset.addEventListener('click', () => { search.value = ''; setGroup('all'); apply(); search.focus(); });

    const params = new URLSearchParams(location.search);
    if (params.get('q')) search.value = params.get('q').slice(0, 80);
    if (params.get('g')) setGroup(params.get('g'));
    apply();
  }

  /* =====================================================================
     Register form prefill (from the RFQ basket, a Board listing or a search)
     ===================================================================== */
  const prefill = { rfq: false };

  function fillIfEmpty(control, value) {
    if (!control || control.value.trim()) return false;
    control.value = value;
    return true;
  }
  function tickChip(formKey, fieldName, label) {
    if (!label) return false;
    const group = $('#panel-' + formKey + ' [data-name="' + fieldName + '"] .chips');
    if (!group) return false;
    let done = false;
    $$('.chip', group).forEach(chip => {
      const lab = $('label', chip);
      const input = $('input', chip);
      if (lab && input && lab.textContent.trim() === label) { input.checked = true; done = true; }
    });
    return done;
  }
  function addNote(formKey, html) {
    const intro = $('#panel-' + formKey + ' .form-intro');
    if (!intro) return;
    const note = el('div', 'prefill-note');
    note.setAttribute('role', 'status');
    note.appendChild(icon('i-list'));
    const p = el('p');
    html(p);
    note.appendChild(p);
    intro.appendChild(note);
  }
  function rfqText(items) {
    const head = 'Requested from the Dasverra catalogue:\n';
    const tail = '\nGrade, quantity and packing for each product:\n';
    let out = head;
    let used = 0;
    for (let i = 0; i < items.length; i += 1) {
      const line = '- ' + items[i].name + (items[i].spec ? ' (' + items[i].spec + ')' : '') + '\n';
      if (out.length + line.length + tail.length > 2700) break;
      out += line;
      used += 1;
    }
    if (used < items.length) out += '- and ' + (items.length - used) + ' more\n';
    return out + tail;
  }
  function initPrefill() {
    const buyer = $('#form-buyer');
    if (!buyer) return;
    const params = new URLSearchParams(location.search);

    if (params.get('rfq') === '1' && basket.length) {
      let ticked = 0;
      basket.forEach(it => { if (tickChip('buyer', 'products', it.chip)) ticked += 1; });
      const wrote = fillIfEmpty($('#buyer-requirement'), rfqText(basket));
      if (wrote || ticked) {
        prefill.rfq = true;
        addNote('buyer', p => {
          p.appendChild(el('b', '', basket.length + (basket.length === 1 ? ' product' : ' products') + ' added from your RFQ. '));
          p.appendChild(document.createTextNode('Add the grade, quantity and destination below. '));
          const a = el('a', 'text-link', 'Change your RFQ');
          a.href = 'catalogue.html#rfq';
          p.appendChild(a);
        });
      }
    }

    const board = params.get('board');
    if (board && /^[A-Za-z0-9-]{1,24}$/.test(board)) {
      const type = params.get('t') === 'supply' ? 'supply' : 'demand';
      const product = (params.get('p') || '').slice(0, 120);
      const category = (params.get('c') || '').slice(0, 60);
      const role = type === 'demand' ? 'supplier' : 'buyer'; // a buyer's demand is answered by a supplier, and vice versa
      const target = role === 'supplier' ? $('#supplier-products') : $('#buyer-requirement');
      const intro = type === 'demand'
        ? 'Trade Board ' + board + ': buyer requirement for ' + (product || 'this product') + '.\nOur grades, specification and quantity available:\n'
        : 'Trade Board ' + board + ': supply offer for ' + (product || 'this product') + '.\nOur required grade, quantity, packing and destination:\n';
      const wrote = fillIfEmpty(target, intro);
      fillIfEmpty($('#' + role + '-message'), 'Responding to Trade Board listing ' + board);
      tickChip(role, role === 'supplier' ? 'categories' : 'products', category);
      if (wrote) {
        addNote(role, p => {
          p.appendChild(el('b', '', 'Responding to Trade Board listing ' + board + '. '));
          p.appendChild(document.createTextNode('We have started the form for you. Check it and add your details.'));
        });
      }
    }

    const q = params.get('q');
    if (q) fillIfEmpty($('#buyer-requirement'), 'Looking for: ' + q.slice(0, 160) + '\n');
  }

  document.addEventListener('dv:submitted', e => {
    const d = e.detail || {};
    if (d.sent && d.role === 'buyer' && prefill.rfq) {
      clearBasket();
      prefill.rfq = false;
    }
  });

  /* =====================================================================
     Read-only API (GET), with a JSONP fallback for restrictive networks
     ===================================================================== */
  function apiUrl(params) {
    const base = CONF.formEndpoint;
    if (!base) return '';
    const qs = Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    return base + (base.indexOf('?') === -1 ? '?' : '&') + qs;
  }
  function viaFetch(url, ms) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no-fetch'));
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(res => {
        if (!res.ok) throw new Error('http-' + res.status);
        return res.json();
      })
      .then(data => { if (timer) clearTimeout(timer); return data; }, err => { if (timer) clearTimeout(timer); throw err; });
  }
  function viaJsonp(url, ms) {
    return new Promise((resolve, reject) => {
      const name = 'dvcb_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      const script = document.createElement('script');
      let done = false;
      function finish(fn, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete window[name]; } catch (err) { window[name] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
        fn(value);
      }
      const timer = setTimeout(() => finish(reject, new Error('timeout')), ms);
      window[name] = data => finish(resolve, data);
      script.onerror = () => finish(reject, new Error('script'));
      script.async = true;
      script.src = url + '&callback=' + name;
      document.head.appendChild(script);
    });
  }
  function api(params) {
    const url = apiUrl(params);
    if (!url) return Promise.reject(new Error('no-endpoint'));
    return viaFetch(url, 9000).catch(() => viaJsonp(url, 9000));
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(value) {
    if (!value) return '';
    const s = String(value);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s.slice(0, 40);
    const mon = Number(m[2]);
    if (mon < 1 || mon > 12) return s.slice(0, 40);
    return Number(m[3]) + ' ' + MONTHS[mon - 1] + ' ' + m[1];
  }

  /* =====================================================================
     Trade Board
     ===================================================================== */
  function initBoard() {
    const grid = $('#board-grid');
    if (!grid) return;
    const state = $('#board-state');
    const empty = $('#board-empty');
    const emptyTitle = $('#board-empty-title');
    const emptyText = $('#board-empty-text');
    const count = $('#board-count');
    const seg = $$('.seg button[data-type]');
    const catSel = $('#board-cat');
    const tools = $('.board-tools');
    let items = [];
    let type = 'all';

    function showState(kind, message) {
      state.hidden = false;
      state.textContent = '';
      if (kind === 'loading') {
        state.appendChild(el('span', 'spinner'));
        state.lastChild.setAttribute('aria-hidden', 'true');
        state.appendChild(el('span', '', message));
      } else {
        state.appendChild(el('span', '', message));
        const retry = el('button', 'btn small dark', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', load);
        state.appendChild(retry);
      }
    }

    function fact(label, value, wide) {
      const wrap = el('div', wide ? 'wide' : '');
      wrap.appendChild(el('dt', '', label));
      wrap.appendChild(el('dd', '', value));
      return wrap;
    }
    function respondHref(item) {
      const t = item.type === 'supply' ? 'supply' : 'demand';
      const p = new URLSearchParams({ board: item.id, t: t, p: item.product || '', c: item.category || '' });
      return 'register.html?' + p.toString() + '#' + (t === 'demand' ? 'supplier' : 'buyer');
    }
    function card(item) {
      const supply = item.type === 'supply';
      const a = el('article', 'b-card ' + (supply ? 'supply' : 'demand'));
      const top = el('div', 'b-top');
      top.appendChild(el('span', 'b-type', supply ? 'Supplier offers' : 'Buyer wants'));
      top.appendChild(el('span', 'b-id', item.id));
      a.appendChild(top);
      a.appendChild(el('h3', '', item.product));
      const dl = el('dl', 'b-facts');
      if (item.qty) dl.appendChild(fact('Quantity', item.qty));
      if (item.spec) dl.appendChild(fact('Specification', item.spec, true));
      if (item.region) dl.appendChild(fact(supply ? 'Origin' : 'Destination', item.region));
      if (item.terms) dl.appendChild(fact('Terms', item.terms, true));
      if (item.category) dl.appendChild(fact('Category', item.category));
      a.appendChild(dl);
      if (item.note) a.appendChild(el('p', 'b-note', item.note));
      const foot = el('div', 'b-foot');
      const dates = [];
      if (item.posted) dates.push('Posted ' + fmtDate(item.posted));
      if (item.until) dates.push('Open until ' + fmtDate(item.until));
      foot.appendChild(el('span', 'b-date', dates.join(' · ')));
      const cta = el('a', 'btn small solid');
      cta.href = respondHref(item);
      cta.appendChild(document.createTextNode(supply ? 'I am interested' : 'I can supply this'));
      cta.appendChild(icon('i-arrow'));
      cta.setAttribute('aria-label', (supply ? 'I am interested in ' : 'I can supply ') + item.product + ' (' + item.id + ')');
      foot.appendChild(cta);
      a.appendChild(foot);
      return a;
    }

    function render() {
      const cat = catSel.value;
      const list = items.filter(i => (type === 'all' || i.type === type) && (!cat || i.category === cat));
      grid.textContent = '';
      list.forEach(i => grid.appendChild(card(i)));
      empty.hidden = list.length > 0;
      if (!list.length) {
        if (!items.length) {
          emptyTitle.textContent = 'No open listings right now.';
          emptyText.textContent = 'Listings appear here as our trade desk takes on live requirements and supply. Be the first to post.';
        } else {
          emptyTitle.textContent = 'Nothing matches these filters.';
          emptyText.textContent = 'Try another category or type, or post your own requirement.';
        }
      }
      count.textContent = !items.length ? '' : (list.length === items.length
        ? items.length + (items.length === 1 ? ' open listing' : ' open listings')
        : list.length + ' of ' + items.length + ' listings');
    }
    function fillCategories() {
      const cats = Array.from(new Set(items.map(i => i.category).filter(Boolean))).sort();
      const keep = catSel.value;
      catSel.textContent = '';
      const all = el('option', '', 'All categories');
      all.value = '';
      catSel.appendChild(all);
      cats.forEach(c => { const o = el('option', '', c); o.value = c; catSel.appendChild(o); });
      catSel.value = cats.indexOf(keep) === -1 ? '' : keep;
    }

    function sanitise(raw) {
      const s = v => (v === undefined || v === null ? '' : String(v).slice(0, 400));
      return {
        id: s(raw.id).slice(0, 24),
        type: raw.type === 'supply' ? 'supply' : 'demand',
        product: s(raw.product).slice(0, 140),
        category: s(raw.category).slice(0, 60),
        qty: s(raw.qty).slice(0, 80),
        spec: s(raw.spec),
        region: s(raw.region).slice(0, 120),
        terms: s(raw.terms).slice(0, 160),
        posted: s(raw.posted).slice(0, 10),
        until: s(raw.until).slice(0, 10),
        note: s(raw.note)
      };
    }

    function load() {
      grid.textContent = '';
      empty.hidden = true;
      count.textContent = '';
      tools.hidden = true;
      showState('loading', 'Loading listings…');
      api({ action: 'board' }).then(data => {
        if (!data || data.ok !== true || !Array.isArray(data.items)) throw new Error('bad-response');
        items = data.items.map(sanitise).filter(i => i.id && i.product);
        state.hidden = true;
        fillCategories();
        tools.hidden = items.length === 0; // filters mean nothing on an empty board
        render();
      }).catch(err => {
        const noEndpoint = err && err.message === 'no-endpoint';
        showState('error', noEndpoint
          ? 'The Trade Board is not switched on yet. Write to ' + CONF.email + ' and we will share what is open.'
          : 'We could not load the Trade Board right now. Check your connection and try again, or write to ' + CONF.email + '.');
      });
    }

    seg.forEach(b => b.addEventListener('click', () => {
      type = b.dataset.type;
      seg.forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      render();
    }));
    catSel.addEventListener('change', render);
    load();
  }

  /* =====================================================================
     Track a trade
     ===================================================================== */
  function initTrack() {
    const form = $('#track-form');
    if (!form) return;
    const input = $('#track-ref');
    const msg = $('#track-msg');
    const out = $('#track-result');
    const submit = $('button[type="submit"]', form);
    const submitLabel = $('[data-text]', submit);
    const REF = /^DV-[BSFPT]-\d{6}-[A-Z0-9]{4}$/;
    let stages = { application: [], trade: [] };
    try { stages = JSON.parse($('#dv-stages').textContent); } catch (err) { /* the side list still renders from HTML */ }

    function normalise(v) {
      return String(v || '').toUpperCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, '').slice(0, 24);
    }
    function problem(text) {
      msg.textContent = text;
      msg.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    }
    function clearProblem() {
      msg.hidden = true;
      msg.textContent = '';
      input.removeAttribute('aria-invalid');
    }
    function contactLinks(ref) {
      const wrap = el('p', 'trk-help');
      wrap.appendChild(document.createTextNode('Questions about this reference? '));
      const wa = el('a', 'text-link', 'Message us on WhatsApp');
      wa.href = 'https://wa.me/' + CONF.whatsapp + '?text=' + encodeURIComponent('Hello Dasverra, a question about reference ' + ref);
      wa.target = '_blank';
      wa.rel = 'noopener';
      wrap.appendChild(wa);
      wrap.appendChild(document.createTextNode(' or write to '));
      const mail = el('a', 'text-link', CONF.email);
      mail.href = 'mailto:' + CONF.email + '?subject=' + encodeURIComponent('Reference ' + ref);
      wrap.appendChild(mail);
      wrap.appendChild(document.createTextNode('.'));
      return wrap;
    }
    function show(node) {
      out.textContent = '';
      out.appendChild(node);
      out.hidden = false;
      out.focus({ preventScroll: true });
      out.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function notFound(ref) {
      const box = el('div', 'trk-miss');
      box.appendChild(el('h2', '', 'We could not find that reference'));
      box.appendChild(el('p', '', 'Check each character of ' + ref + '. If it is right, it may not be on the tracker yet.'));
      box.appendChild(contactLinks(ref));
      show(box);
    }
    /* A shipment the trade desk has chosen to share. Everything comes from the endpoint as plain text and is drawn with
       textContent only. The endpoint never sends the forwarder, costs, booking or BL numbers, so there is nothing to hide here. */
    const MODES = { sea: 'Sea freight', air: 'Air freight', road: 'Road freight', rail: 'Rail freight' };
    function shipmentBlock(raw, index, count) {
      if (!raw || typeof raw !== 'object') return null;
      const str = (v, n) => (v === undefined || v === null ? '' : String(v).slice(0, n || 200));
      const total = Math.max(1, Math.min(12, Number(raw.total) || 0));
      const step = Math.max(0, Math.min(total, Number(raw.step) || 0));
      if (!step) return null;
      const title = count > 1 ? 'Shipment ' + (index + 1) + ' of ' + count : 'Shipment';
      const sec = el('section', 'trk-ship');
      sec.setAttribute('aria-label', title);
      sec.appendChild(el('h3', '', title));

      const from = str(raw.from, 80);
      const to = str(raw.to, 80);
      const mode = MODES[str(raw.mode, 16).toLowerCase()] || '';
      if (from || to || mode) {
        const route = el('p', 'ship-route');
        if (from || to) {
          route.appendChild(el('span', '', from || 'Origin to be confirmed'));
          route.appendChild(icon('i-arrow'));
          route.appendChild(el('span', '', to || 'Destination to be confirmed'));
        }
        if (mode) route.appendChild(el('em', '', mode));
        sec.appendChild(route);
      }

      const label = str(raw.label, 60);
      const line = el('p', 'trk-stage');
      line.appendChild(el('span', 'trk-count', 'Stage ' + step + ' of ' + total));
      line.appendChild(el('b', '', label));
      sec.appendChild(line);
      const bar = el('div', 'ship-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', 'Shipment progress: stage ' + step + ' of ' + total + (label ? ', ' + label : ''));
      for (let i = 1; i <= total; i++) bar.appendChild(el('span', i < step ? 'done' : (i === step ? 'current' : '')));
      sec.appendChild(bar);
      const list = stages.shipment || [];
      if (list[step - 1] && list[step - 1].desc) sec.appendChild(el('p', 'ship-desc', list[step - 1].desc));

      const meta = el('dl', 'trk-meta');
      const add = (k, v) => { if (!v) return; const w = el('div'); w.appendChild(el('dt', '', k)); w.appendChild(el('dd', '', v)); meta.appendChild(w); };
      add('Departure', fmtDate(raw.etd));
      add('Expected arrival', fmtDate(raw.eta));
      add('Vessel and voyage', str(raw.vessel, 80));
      add('Container or air waybill', str(raw.container, 160));
      add('Last updated', fmtDate(raw.updated));
      if (meta.childNodes.length) sec.appendChild(meta);

      if (Array.isArray(raw.docs) && raw.docs.length) {
        const wrap = el('div', 'ship-docwrap');
        wrap.appendChild(el('b', '', 'Documents'));
        const ul = el('ul', 'ship-docs');
        raw.docs.slice(0, 12).forEach(doc => {
          if (!doc) return;
          const status = str(doc.status, 12);
          const ready = status === 'Ready' || status === 'Sent';
          const li = el('li', ready ? 'ok' : 'wait');
          li.appendChild(el('b', '', str(doc.name, 40)));
          li.appendChild(el('span', '', status));
          ul.appendChild(li);
        });
        wrap.appendChild(ul);
        wrap.appendChild(el('p', 'ship-fine', 'This shows whether each document is ready. The documents themselves are shared with you directly.'));
        sec.appendChild(wrap);
      }
      if (raw.note) {
        const note = el('div', 'trk-note');
        note.appendChild(el('b', '', 'Note on this shipment'));
        note.appendChild(el('p', '', str(raw.note, 300)));
        sec.appendChild(note);
      }
      return sec;
    }

    function result(d) {
      const box = el('div', 'trk-card');
      const head = el('div', 'trk-head');
      const row = el('div', 'ref-row');
      row.appendChild(el('span', 'eyebrow', 'Reference'));
      row.appendChild(el('span', 'ref', d.ref));
      head.appendChild(row);
      head.appendChild(el('h2', '', d.title || (d.track === 'trade' ? 'Your trade' : 'Your application')));
      box.appendChild(head);

      const step = Number(d.step) || 0;
      const total = Number(d.total) || 0;
      const stage = el('p', 'trk-stage');
      stage.appendChild(el('span', 'trk-count', total ? 'Stage ' + step + ' of ' + total : 'Current stage'));
      stage.appendChild(el('b', '', d.label || ''));
      box.appendChild(stage);

      const list = stages[d.track] || [];
      if (list.length) {
        const ol = el('ol', 'trk-steps');
        list.forEach((s, i) => {
          const li = el('li', i + 1 < step ? 'done' : (i + 1 === step ? 'current' : ''));
          if (i + 1 === step) li.setAttribute('aria-current', 'step');
          const dot = el('span', 'dot');
          dot.setAttribute('aria-hidden', 'true');
          if (i + 1 < step) dot.appendChild(icon('i-check'));
          else dot.textContent = String(i + 1);
          li.appendChild(dot);
          const text = el('div');
          text.appendChild(el('b', '', s.label));
          if (i + 1 === step) text.appendChild(el('span', '', s.desc));
          li.appendChild(text);
          ol.appendChild(li);
        });
        box.appendChild(ol);
      }

      const meta = el('dl', 'trk-meta');
      if (d.updated) { const w = el('div'); w.appendChild(el('dt', '', 'Last updated')); w.appendChild(el('dd', '', fmtDate(d.updated))); meta.appendChild(w); }
      if (d.eta) { const w = el('div'); w.appendChild(el('dt', '', 'Expected')); w.appendChild(el('dd', '', fmtDate(d.eta))); meta.appendChild(w); }
      if (meta.childNodes.length) box.appendChild(meta);
      if (d.note) {
        const note = el('div', 'trk-note');
        note.appendChild(el('b', '', 'Note from the trade desk'));
        note.appendChild(el('p', '', String(d.note).slice(0, 600)));
        box.appendChild(note);
      }
      if (Array.isArray(d.shipments)) {
        const ships = d.shipments.slice(0, 10);
        ships.forEach((raw, i) => { const block = shipmentBlock(raw, i, ships.length); if (block) box.appendChild(block); });
      }
      box.appendChild(contactLinks(d.ref));
      show(box);
    }

    function setBusy(on) {
      submit.disabled = on;
      submitLabel.textContent = on ? 'Checking…' : 'Check status';
    }

    function lookup(ref) {
      setBusy(true);
      api({ action: 'track', ref: ref }).then(d => {
        if (!d || typeof d !== 'object') throw new Error('bad-response');
        if (d.ok === false) {
          if (d.error === 'busy') problem('Many lookups at once. Please wait a minute and try again.');
          else problem('We could not check that right now. Please try again in a moment.');
          return;
        }
        if (!d.found) { notFound(ref); return; }
        d.ref = ref;
        result(d);
      }).catch(err => {
        if (err && err.message === 'no-endpoint') problem('Tracking is not switched on yet. Write to ' + CONF.email + ' and we will update you.');
        else problem('We could not reach the tracker. Check your connection and try again.');
      }).then(() => setBusy(false), () => setBusy(false));
    }

    form.addEventListener('submit', e => {
      e.preventDefault();
      if (submit.disabled) return;
      const ref = normalise(input.value);
      input.value = ref;
      clearProblem();
      out.hidden = true;
      if (!REF.test(ref)) {
        problem(ref ? 'That does not look like a Dasverra reference. It looks like DV-B-261010-2FH3.' : 'Enter the reference we gave you.');
        input.focus();
        return;
      }
      try {
        if (window.history && history.replaceState) history.replaceState(null, '', location.pathname + '?ref=' + encodeURIComponent(ref));
      } catch (err) { /* not important */ }
      lookup(ref);
    });
    input.addEventListener('input', () => { if (!msg.hidden) clearProblem(); });

    // Side list: switch between the application and trade stages.
    const tabs = $$('.trk-tabs button[data-track]');
    const lists = $$('[data-track-list]');
    tabs.forEach(b => b.addEventListener('click', () => {
      tabs.forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      lists.forEach(l => { l.hidden = l.dataset.trackList !== b.dataset.track; });
    }));

    const fromUrl = normalise(new URLSearchParams(location.search).get('ref'));
    if (fromUrl) {
      input.value = fromUrl;
      if (REF.test(fromUrl)) lookup(fromUrl);
      else problem('That does not look like a Dasverra reference. It looks like DV-B-261010-2FH3.');
    }
  }

  /* ---------- Go ---------- */
  syncBasket();
  initCatalogue();
  initPrefill();
  initBoard();
  initTrack();
})();
