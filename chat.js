(() => {
  'use strict';

  /* Dasverra chat (early access)
     A small chat window on every page. It talks to the same Google Apps Script web app as the forms, with plain GET calls
     (chat-api.js). Nothing is sent until the visitor opens the window, and nothing is sent about the page except its file name.
       - Online: the visitor leaves a name, a way to reach them and a first message, then talks to the trade desk in real time.
       - Offline: a short enquiry form. It lands in the Enquiries tab and an email is sent to the trade desk.
       - If the script has no chat (or cannot be reached): WhatsApp and email, the two ways that always work.
     The conversation is kept in this browser only through a private token; the Sheet keeps just a hash of it.
     Messages are drawn with textContent, never as HTML. */

  const API = window.DVChatAPI;
  if (!API || window.DVChat) return;

  const CONF = Object.assign({ whatsapp: '918013906621', email: 'aseem.das@dasverra.org' }, window.DVCONF || {});
  const STORE_KEY = 'dv_chat_v1';
  const BASKET_KEY = 'dv_rfq_v1';
  const MAX_MESSAGE = 500;       // characters in one message (the script cuts at the same number)
  const URL_BUDGET = 1100;       // encoded characters of message text allowed in one call; longer messages go as several
  const KEEP_DAYS = 14;          // a saved chat is forgotten after this long without use
  const BACKGROUND_MS = 30 * 60 * 1000; // after this long without activity the window stops asking for replies on its own
  const SMALL = window.matchMedia ? window.matchMedia('(max-width: 560px)') : { matches: false, addEventListener() {} };
  const TOUCH = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const $ = (sel, root = document) => root.querySelector(sel);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Tells the rest of the page that something happened (nothing in the site listens; a test page or analytics may).
  function emit(type, detail) {
    try { document.dispatchEvent(new CustomEvent('dv:chat', { detail: Object.assign({ type }, detail || {}) })); } catch (err) { /* no events here */ }
  }

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

  /* ---------- Validation (the script checks the same things again) ---------- */
  const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(s || ''));
  const isPhone = s => /^\+?[0-9][0-9 ().\-]{5,24}$/.test(String(s || '')) && String(s).replace(/\D/g, '').length >= 7;

  /* ---------- State ---------- */
  const state = {
    open: false,
    view: 'idle',          // idle | boot | start | enquiry | sending | sent | thread | contact
    online: false,
    chat: null,            // { id, t, name, contact, at }
    msgs: [],              // messages from the script: { n, f: v|s|x, t, ts }
    pending: [],           // messages typed but not stored yet: { mid, text, failed }
    loaded: false,         // the script has answered at least once for the chat shown
    lastN: 0,              // highest message number received
    seenN: 0,              // highest message number the visitor has looked at
    status: 'Open',
    unread: 0,
    draft: { name: '', contact: '', country: '', message: '', company: '', product: '', quantity: '' },
    includeBasket: true,
    shownAt: 0,
    lastActivity: Date.now(),
    contactReason: '',
    enquiry: null          // { data, tries } while an enquiry is being delivered
  };
  let pollTimer = null;
  let pollBusy = false;
  let sendChain = Promise.resolve();
  let opener = null;

  /* ---------- Page context ---------- */
  function pageName() {
    const last = (location.pathname || '/').split('/').pop();
    return (last || 'index.html').slice(0, 100);
  }
  function basketItems() {
    try {
      const data = JSON.parse(store.get(BASKET_KEY) || 'null');
      const list = data && Array.isArray(data.items) ? data.items : [];
      return list.filter(it => it && typeof it.name === 'string').map(it => String(it.name).slice(0, 80));
    } catch (err) {
      return [];
    }
  }
  function basketText() {
    const items = basketItems();
    if (!items.length) return '';
    const head = items.length + (items.length === 1 ? ' product: ' : ' products: ');
    return (head + items.join('; ')).slice(0, 300);
  }
  function whatsappLink(text) {
    return 'https://wa.me/' + CONF.whatsapp + '?text=' + encodeURIComponent(text.length > 1500 ? text.slice(0, 1499) + '…' : text);
  }
  function mailLink(subject, body) {
    return 'mailto:' + CONF.email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body || '');
  }

  /* ---------- Saved chat ---------- */
  function loadSaved() {
    try {
      const o = JSON.parse(store.get(STORE_KEY) || 'null');
      if (!o || typeof o.id !== 'string' || typeof o.t !== 'string' || !/^DV-C-\d{6}-[A-Z0-9]{4}$/.test(o.id)) return null;
      if (!o.at || Date.now() - o.at > KEEP_DAYS * 86400000) return null;
      return { id: o.id, t: o.t, name: String(o.name || ''), contact: String(o.contact || ''), at: Number(o.at), seen: Number(o.seen) || 0 };
    } catch (err) {
      return null;
    }
  }
  function saveChat() {
    if (!state.chat) return;
    store.set(STORE_KEY, JSON.stringify({
      id: state.chat.id, t: state.chat.t, name: state.chat.name, contact: state.chat.contact, at: state.chat.at, seen: state.seenN
    }));
  }
  function forgetChat() {
    store.del(STORE_KEY);
    state.chat = null;
    state.msgs = [];
    state.pending = [];
    state.loaded = false;
    state.lastN = 0;
    state.seenN = 0;
    state.unread = 0;
    state.status = 'Open';
    clearTimeout(pollTimer);
    syncBadge();
  }
  function touch() {
    state.lastActivity = Date.now();
    if (state.chat) { state.chat.at = Date.now(); saveChat(); }
  }

  /* ---------- The shell: launcher and window ---------- */
  const root = el('div', 'dvc');
  const launch = el('button', 'dvc-launch');
  launch.type = 'button';
  launch.setAttribute('aria-haspopup', 'dialog');
  launch.setAttribute('aria-controls', 'dvc-panel');
  launch.setAttribute('aria-expanded', 'false');
  const launchIcon = icon('i-chat');
  launch.appendChild(launchIcon);
  const launchText = el('span', 'dvc-launch-text', 'Chat with sales');
  launch.appendChild(launchText);
  const badge = el('span', 'dvc-badge');
  badge.setAttribute('aria-hidden', 'true');
  badge.hidden = true;
  launch.appendChild(badge);

  const panel = el('div', 'dvc-panel');
  panel.id = 'dvc-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Chat with Dasverra sales');
  panel.setAttribute('aria-modal', 'false');
  panel.tabIndex = -1;
  panel.hidden = true;

  const head = el('header', 'dvc-head');
  const headText = el('div', 'dvc-head-text');
  headText.appendChild(el('b', 'dvc-title', 'Dasverra sales'));
  const sub = el('span', 'dvc-sub');
  const dot = el('i', 'dvc-dot');
  dot.setAttribute('aria-hidden', 'true');
  const subText = el('span', 'dvc-sub-text', '');
  sub.appendChild(dot);
  sub.appendChild(subText);
  headText.appendChild(sub);
  const closeBtn = el('button', 'dvc-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close chat');
  closeBtn.appendChild(icon('i-close'));
  head.appendChild(headText);
  head.appendChild(closeBtn);

  const body = el('div', 'dvc-body');
  const live = el('div', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(live);
  root.appendChild(launch);
  root.appendChild(panel);

  function say(message) {
    live.textContent = '';
    setTimeout(() => { live.textContent = message; }, 30);
  }

  function setHeader() {
    const on = state.view === 'thread' || state.view === 'start' ? state.online : false;
    dot.className = 'dvc-dot' + (on ? ' on' : '');
    if (state.view === 'thread' && !state.loaded) subText.textContent = 'Connecting…';
    else if (state.view === 'thread' || state.view === 'start') subText.textContent = state.online ? 'Online now' : 'Offline right now';
    else if (state.view === 'enquiry' || state.view === 'sending' || state.view === 'sent') subText.textContent = 'Send an enquiry';
    else if (state.view === 'boot') subText.textContent = 'Connecting…';
    else subText.textContent = 'WhatsApp and email';
  }

  /* The button's name is its visible text ("Chat with sales", or "Close chat" while the window is open on a wide screen);
     with unread replies it says so as well. */
  function syncBadge() {
    const n = state.open ? 0 : state.unread;
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? '9+' : String(n);
    if (n) launch.setAttribute('aria-label', 'Chat with sales, ' + n + (n === 1 ? ' new message' : ' new messages'));
    else launch.removeAttribute('aria-label');
    launchText.textContent = state.open ? 'Close chat' : 'Chat with sales';
    launchIcon.firstChild.setAttribute('href', state.open ? '#i-close' : '#i-chat');
  }

  /* ---------- Opening and closing ---------- */
  const INERT = ['.skip', '.os-bar', '.site-header', 'main', '.site-footer', '.rfq-fab'];
  function setInert(on) {
    INERT.forEach(sel => {
      const node = $(sel);
      if (!node) return;
      if (on) node.setAttribute('inert', ''); else node.removeAttribute('inert');
    });
  }
  function fitViewport() {
    const vv = window.visualViewport;
    if (!state.open || !SMALL.matches || !vv) { panel.style.removeProperty('height'); panel.style.removeProperty('top'); return; }
    panel.style.height = Math.round(vv.height) + 'px';
    panel.style.top = Math.round(vv.offsetTop) + 'px';
  }
  function open() {
    if (state.open) return;
    state.open = true;
    opener = document.activeElement;
    panel.hidden = false;
    root.classList.add('open');
    launch.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('dvc-open');
    if (SMALL.matches) { setInert(true); panel.setAttribute('aria-modal', 'true'); }
    fitViewport();
    touch();
    syncBadge();
    if (state.view === 'idle') boot(); else render(true);
    if (state.view === 'thread') { markSeen(); poll(); }
  }
  function close() {
    if (!state.open) return;
    state.open = false;
    panel.hidden = true;
    root.classList.remove('open');
    launch.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('dvc-open');
    setInert(false);
    panel.setAttribute('aria-modal', 'false');
    fitViewport();
    syncBadge();
    const back = opener && opener !== document.body && document.contains(opener) && !opener.hidden ? opener : launch;
    back.focus({ preventScroll: true });
    scheduleBackgroundPoll();
  }
  launch.addEventListener('click', () => { if (state.open) close(); else open(); });
  closeBtn.addEventListener('click', close);
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  document.addEventListener('click', e => {
    const t = e.target.closest ? e.target.closest('[data-open-chat]') : null;
    if (t) { e.preventDefault(); open(); }
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  if (SMALL.addEventListener) SMALL.addEventListener('change', () => { if (state.open) { setInert(SMALL.matches); fitViewport(); } });

  /* ---------- Starting up ---------- */
  function boot() {
    const saved = loadSaved();
    if (saved) {
      state.chat = saved;
      state.seenN = saved.seen || 0;
      state.view = 'thread';
      state.online = false;
      render(true);
      poll(true);
      return;
    }
    state.view = 'boot';
    render(true);
    API.call({ action: 'chat_status' }, 9000).then(res => {
      if (!res || res.ok !== true || res.chat !== true) throw new Error('not-json');
      state.online = !!(res.enabled && res.online);
      state.view = res.enabled && res.online ? 'start' : 'enquiry';
      state.contactReason = '';
      if (!res.enabled) state.chatOff = true;
      render(true);
    }).catch(err => {
      state.contactReason = API.failure(err);
      state.view = 'contact';
      render(true);
    });
  }

  /* ---------- Rendering ---------- */
  function render(focus) {
    setHeader();
    body.textContent = '';
    body.className = 'dvc-body dvc-view-' + state.view;
    switch (state.view) {
      case 'boot': renderBoot(); break;
      case 'start': renderStart(focus); break;
      case 'enquiry': renderEnquiry(focus); break;
      case 'sending': renderSending(); break;
      case 'sent': renderSent(); break;
      case 'thread': renderThread(focus); break;
      default: renderContact(); break;
    }
  }

  function renderBoot() {
    const box = el('div', 'dvc-center');
    box.appendChild(el('span', 'dvc-spinner'));
    box.appendChild(el('p', '', 'Connecting to our trade desk…'));
    body.appendChild(box);
  }

  /* A labelled field. kind: input | textarea. Returns { wrap, control, error }. */
  function field(id, label, kind, attrs, hint) {
    const wrap = el('div', 'field dvc-field');
    const lab = el('label', '', label);
    lab.setAttribute('for', id);
    const control = el(kind === 'textarea' ? 'textarea' : 'input');
    control.id = id;
    if (kind !== 'textarea') control.type = (attrs && attrs.type) || 'text';
    Object.keys(attrs || {}).forEach(k => { if (k !== 'type') control.setAttribute(k, attrs[k]); });
    wrap.appendChild(lab);
    wrap.appendChild(control);
    if (hint) {
      const h = el('span', 'dvc-hint', hint);
      h.id = id + '-hint';
      control.setAttribute('aria-describedby', h.id);
      wrap.appendChild(h);
    }
    const error = el('span', 'err-msg', '');
    error.id = id + '-err';
    error.hidden = true;
    wrap.appendChild(error);
    return { wrap, control, error };
  }
  function showErr(f, message) {
    f.error.textContent = message;
    f.error.hidden = false;
    f.control.setAttribute('aria-invalid', 'true');
    const prev = f.control.getAttribute('aria-describedby') || '';
    if (prev.indexOf(f.error.id) === -1) f.control.setAttribute('aria-describedby', (prev + ' ' + f.error.id).trim());
  }
  function clearErr(f) {
    f.error.textContent = '';
    f.error.hidden = true;
    f.control.removeAttribute('aria-invalid');
  }
  function checkbox(id, labelNode) {
    const wrap = el('div', 'dvc-check');
    const box = el('input');
    box.type = 'checkbox';
    box.id = id;
    const lab = el('label');
    lab.setAttribute('for', id);
    lab.appendChild(labelNode);
    const error = el('span', 'err-msg', '');
    error.hidden = true;
    wrap.appendChild(box);
    wrap.appendChild(lab);
    wrap.appendChild(error);
    return { wrap, box, error };
  }
  function consentLabel() {
    const span = el('span');
    span.appendChild(document.createTextNode('I agree that Dasverra may store this conversation and my contact details to reply to me. '));
    const a = el('a', '', 'Privacy Policy');
    a.href = 'privacy-policy.html';
    a.target = '_blank';
    a.rel = 'noopener';
    span.appendChild(a);
    span.appendChild(document.createTextNode('.'));
    return span;
  }
  function honeypot() {
    const wrap = el('div', 'dvc-hp');
    wrap.setAttribute('aria-hidden', 'true');
    const input = el('input');
    input.type = 'text';
    input.name = 'hp';
    input.tabIndex = -1;
    input.autocomplete = 'off';
    wrap.appendChild(input);
    return { wrap, input };
  }
  function keepDraft(map) {
    Object.keys(map).forEach(k => { state.draft[k] = map[k].control.value; });
  }

  /* ----- register shortcut: the four ways to join, one tap each. The forms live on register.html; the page opens the right tab from the #role in the link.
     Nothing about the visitor travels in the link. The window closes first, so the form is not hidden behind it. ----- */
  const REG_ROLES = [['buyer', 'Buyer'], ['supplier', 'Supplier'], ['forwarder', 'Forwarder'], ['partner', 'Partner']];
  function registerStrip(lead) {
    const wrap = el('div', 'dvc-reg');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Register with Dasverra');
    wrap.appendChild(el('span', 'dvc-reg-t', lead || 'New to Dasverra? Register as:'));
    const row = el('span', 'dvc-reg-row');
    REG_ROLES.forEach(r => {
      const a = el('a', 'dvc-reg-a', r[1]);
      a.href = 'register.html#' + r[0];
      a.addEventListener('click', () => { close(); });
      row.appendChild(a);
    });
    wrap.appendChild(row);
    return wrap;
  }

  /* ----- start a chat ----- */
  function renderStart(focus) {
    state.shownAt = Date.now();
    const form = el('form', 'dvc-form');
    form.noValidate = true;
    form.appendChild(el('p', 'dvc-intro', 'Ask about a product, a price or a shipment. Our trade desk is online and answers here.'));
    form.appendChild(registerStrip());
    const f = {
      name: field('dvc-name', 'Your name', 'input', { autocomplete: 'name', maxlength: '60', required: '' }),
      contact: field('dvc-contact', 'Email or WhatsApp number', 'input', { autocomplete: 'email', maxlength: '80', required: '', inputmode: 'email' }, 'So we can reach you if you leave the page.'),
      message: field('dvc-message', 'Your message', 'textarea', { rows: '3', maxlength: String(MAX_MESSAGE), required: '', placeholder: 'What do you need? Product, quantity, destination…' })
    };
    f.name.control.value = state.draft.name;
    f.contact.control.value = state.draft.contact;
    f.message.control.value = state.draft.message;
    [f.name, f.contact, f.message].forEach(x => form.appendChild(x.wrap));
    let basketBox = null;
    const bt = basketText();
    if (bt) {
      const n = basketItems().length;
      basketBox = checkbox('dvc-basket', el('span', '', 'Include my RFQ list (' + n + (n === 1 ? ' product' : ' products') + ')'));
      basketBox.box.checked = state.includeBasket;
      form.appendChild(basketBox.wrap);
    }
    const consent = checkbox('dvc-consent', consentLabel());
    form.appendChild(consent.wrap);
    const hp = honeypot();
    form.appendChild(hp.wrap);
    const status = el('p', 'dvc-status', '');
    status.hidden = true;
    status.setAttribute('role', 'alert');
    form.appendChild(status);
    const go = el('button', 'btn solid dvc-go');
    go.type = 'submit';
    go.appendChild(el('span', '', 'Start chat'));
    form.appendChild(go);
    const alt = el('button', 'btn text dvc-alt', 'Prefer to send an enquiry instead?');
    alt.type = 'button';
    alt.addEventListener('click', () => { keepDraft(f); state.view = 'enquiry'; render(true); });
    form.appendChild(alt);

    form.addEventListener('input', e => {
      const x = [f.name, f.contact, f.message].find(y => y.control === e.target);
      if (x && !x.error.hidden) clearErr(x);
      if (e.target === consent.box) consent.error.hidden = true;
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (go.disabled) return;
      keepDraft(f);
      state.includeBasket = basketBox ? basketBox.box.checked : false;
      let bad = null;
      const name = f.name.control.value.trim();
      const contact = f.contact.control.value.trim();
      const message = f.message.control.value.trim();
      [f.name, f.contact, f.message].forEach(clearErr);
      if (name.length < 2) { showErr(f.name, 'Please enter your name.'); bad = bad || f.name; }
      if (!isEmail(contact) && !isPhone(contact)) { showErr(f.contact, 'Enter a valid email address or a phone number with country code.'); bad = bad || f.contact; }
      if (!message) { showErr(f.message, 'Please write your message.'); bad = bad || f.message; }
      if (!consent.box.checked) {
        consent.error.textContent = 'Please tick this box to continue.';
        consent.error.hidden = false;
        bad = bad || { control: consent.box };
      }
      if (bad) { bad.control.focus(); return; }
      status.hidden = true;
      go.disabled = true;
      go.firstChild.textContent = 'Starting…';
      startChat({
        name, contact, country: '', message,
        basket: basketBox && basketBox.box.checked ? bt : '', hp: hp.input.value
      }).then(res => {
        if (res === true) return;
        go.disabled = false;
        go.firstChild.textContent = 'Start chat';
        status.textContent = res;
        status.hidden = false;
      });
    });
    body.appendChild(form);
    if (focus) f.name.control.focus({ preventScroll: true });
  }

  /* Starts a chat. Resolves true when the thread is showing, or a sentence to show the visitor. The message is cut into
     parts when it is too long for one call; the first part starts the chat, the rest follow as ordinary messages. */
  function startChat(d) {
    const room = Math.max(300, URL_BUDGET - 250 - API.encLen(d.name) - API.encLen(d.contact) - API.encLen(d.basket) - API.encLen(d.country));
    const parts = API.splitMessage(d.message, MAX_MESSAGE, room);
    const first = parts.shift();
    return API.call({
      action: 'chat_start', n: d.name, c: d.contact, co: d.country, pg: pageName(), b: d.basket, m: first, cs: '1',
      mid: API.uid('s'), el: Math.round((Date.now() - state.shownAt) / 1000), hp: d.hp
    }, 12000).then(res => {
      if (!res || res.ok !== true) {
        const e = res && res.error;
        if (e === 'off' || e === 'busy') {
          state.view = 'enquiry';
          state.chatNote = e === 'busy' ? 'Our chat is very busy right now.' : '';
          render(true);
          return true;
        }
        if (e === 'contact') return 'Enter a valid email address or a phone number with country code.';
        if (e === 'consent') return 'Please tick the box to continue.';
        if (e === 'invalid') return 'Please check your name and message.';
        return 'We could not start the chat just now. Please try again, or use WhatsApp.';
      }
      state.chat = { id: res.id, t: res.t, name: d.name, contact: d.contact, at: Date.now() };
      state.msgs = [];
      state.pending = [];
      state.loaded = true;
      state.lastN = 0;
      state.seenN = 0;
      state.status = 'Open';
      applyServer(res.messages || []);
      state.online = !!res.online;
      state.view = 'thread';
      saveChat();
      render(true);
      parts.forEach(p => queueSend(p));
      markSeen();
      scheduleNextPoll();
      emit('chat-started', { id: res.id });
      return true;
    }).catch(err => {
      const kind = API.failure(err);
      if (kind === 'unsupported' || kind === 'offline') { state.contactReason = kind; state.view = 'contact'; render(true); return true; }
      return 'That took too long. Please try again, or use WhatsApp.';
    });
  }

  /* ----- the thread ----- */
  let thread = null;
  let composer = null;
  let banner = null;

  function dayLabel(ts) {
    const d = new Date(ts * 1000);
    const today = new Date();
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return 'Today';
    const y = new Date(today.getTime() - 86400000);
    if (same(d, y)) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function timeLabel(ts) {
    try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (err) { return ''; }
  }

  function renderThread(focus) {
    const wrap = el('div', 'dvc-threadwrap');
    banner = el('div', 'dvc-banner');
    banner.setAttribute('role', 'status');
    wrap.appendChild(banner);
    thread = el('div', 'dvc-thread');
    thread.setAttribute('role', 'log');
    thread.setAttribute('aria-label', 'Conversation');
    thread.setAttribute('aria-live', 'polite');
    thread.tabIndex = 0;
    wrap.appendChild(thread);

    composer = el('form', 'dvc-compose');
    const lab = el('label', 'sr-only', 'Your message');
    lab.setAttribute('for', 'dvc-text');
    const ta = el('textarea');
    ta.id = 'dvc-text';
    ta.rows = 1;
    ta.maxLength = MAX_MESSAGE * 3;
    ta.placeholder = 'Type your message';
    ta.setAttribute('enterkeyhint', 'send');
    const send = el('button', 'dvc-send');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Send message');
    send.appendChild(icon('i-arrow'));
    composer.appendChild(lab);
    composer.appendChild(ta);
    composer.appendChild(send);
    wrap.appendChild(composer);
    body.appendChild(wrap);

    function grow() {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !TOUCH.matches) {
        e.preventDefault();
        composer.requestSubmit ? composer.requestSubmit() : composer.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    composer.addEventListener('submit', e => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      grow();
      sendText(text);
      ta.focus({ preventScroll: true });
    });
    drawThread(true);
    drawBanner();
    if (focus) ta.focus({ preventScroll: true });
  }

  function drawBanner() {
    if (!banner) return;
    banner.textContent = '';
    banner.hidden = true;
    if (state.status === 'Closed') {
      banner.hidden = false;
      banner.appendChild(document.createTextNode('This chat was closed by our team. Write a message to reopen it, or '));
      const b = el('button', 'dvc-link', 'start a new chat');
      b.type = 'button';
      b.addEventListener('click', () => { forgetChat(); state.view = 'boot'; boot(); });
      banner.appendChild(b);
      banner.appendChild(document.createTextNode('.'));
    } else if (state.loaded && !state.online) {
      banner.hidden = false;
      const c = state.chat && state.chat.contact ? ' at ' + state.chat.contact : '';
      banner.textContent = 'Our trade desk is offline right now. Your messages are saved, and we will reply here or' + (c || ' to the contact you left') + '.';
    }
  }

  function drawThread(forceBottom) {
    if (!thread) return;
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
    thread.textContent = '';
    const note = el('p', 'dvc-fine', 'This chat is saved in this browser, so you can come back to it. Only you and our sales team can read it.');
    thread.appendChild(note);
    if (!state.loaded && !state.msgs.length) thread.appendChild(el('p', 'dvc-fine', 'Loading your conversation…'));
    let lastDay = '';
    state.msgs.forEach(m => {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { thread.appendChild(el('p', 'dvc-day', day)); lastDay = day; }
      if (m.f === 'x') { thread.appendChild(el('p', 'dvc-system', m.t)); return; }
      const row = el('div', 'dvc-msg ' + (m.f === 'v' ? 'me' : 'them'));
      row.appendChild(el('p', 'dvc-text', m.t));
      const meta = el('span', 'dvc-time', (m.f === 's' ? 'Dasverra sales · ' : '') + timeLabel(m.ts));
      row.appendChild(meta);
      thread.appendChild(row);
    });
    state.pending.forEach(p => {
      const row = el('div', 'dvc-msg me pending' + (p.failed ? ' failed' : ''));
      row.appendChild(el('p', 'dvc-text', p.text));
      if (p.failed) {
        const meta = el('span', 'dvc-time');
        meta.appendChild(document.createTextNode((p.reason || 'Not sent') + ' · '));
        const retry = el('button', 'dvc-link', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', () => retryPending(p.mid));
        meta.appendChild(retry);
        row.appendChild(meta);
      } else {
        row.appendChild(el('span', 'dvc-time', 'Sending…'));
      }
      thread.appendChild(row);
    });
    if (forceBottom || near) thread.scrollTop = thread.scrollHeight;
  }

  /* Takes messages from the script into the thread (each number once). Returns how many came from the team. */
  function applyServer(list) {
    let fromTeam = 0;
    list.forEach(m => {
      if (!m || typeof m.n !== 'number' || state.msgs.some(x => x.n === m.n)) return;
      state.msgs.push({ n: m.n, f: m.f, t: String(m.t), ts: Number(m.ts) || 0 });
      if (m.f === 's') fromTeam++;
      if (m.f === 'v') { // the stored copy of a message still shown as "Sending…"
        const i = state.pending.findIndex(p => !p.failed && p.text === String(m.t));
        if (i > -1) state.pending.splice(i, 1);
      }
    });
    state.msgs.sort((a, b) => a.n - b.n);
    state.lastN = state.msgs.length ? state.msgs[state.msgs.length - 1].n : 0;
    return fromTeam;
  }
  function markSeen() {
    if (!state.open || state.view !== 'thread') return;
    state.seenN = state.lastN;
    state.unread = 0;
    syncBadge();
    saveChat();
  }

  /* ----- sending ----- */
  /* A long message goes as several, each short enough for one call (by encoded length) and within the script's limit of
     MAX_MESSAGE characters. Nothing is dropped. */
  function sendText(text) {
    API.splitMessage(text.slice(0, MAX_MESSAGE * 3), MAX_MESSAGE, URL_BUDGET).forEach(part => queueSend(part));
  }
  function enqueue(entry) {
    sendChain = sendChain.then(() => deliver(entry)).catch(() => {
      entry.failed = true;
      entry.reason = 'Not sent';
      if (state.view === 'thread') drawThread(true);
    });
  }
  function queueSend(text) {
    const entry = { mid: API.uid('m'), text, failed: false, reason: '' };
    state.pending.push(entry);
    touch();
    if (state.view === 'thread') { drawThread(true); }
    enqueue(entry);
  }
  function retryPending(mid) {
    const entry = state.pending.find(p => p.mid === mid);
    if (!entry) return;
    entry.failed = false;
    entry.reason = '';
    drawThread(true);
    enqueue(entry);
  }
  function deliver(entry) {
    if (!state.chat) return Promise.resolve();
    return API.call({ action: 'chat_send', id: state.chat.id, t: state.chat.t, m: entry.text, mid: entry.mid, after: state.lastN }, 12000).then(res => {
      if (res && res.ok === true) {
        const i = state.pending.indexOf(entry);
        if (i > -1) state.pending.splice(i, 1);
        state.loaded = true;
        const fromTeam = applyServer(res.messages || []);
        state.online = !!res.online;
        state.status = res.st || 'Open';
        touch();
        if (state.view === 'thread') { drawThread(true); drawBanner(); setHeader(); }
        if (fromTeam && state.open) markSeen();
        return;
      }
      const e = res && res.error;
      if (e === 'denied') { gone(); return; }
      entry.failed = true;
      entry.reason = e === 'slow' ? 'You are sending very fast. Wait a moment' : e === 'limit' ? 'This chat is full. Please send an enquiry' : e === 'off' ? 'Chat is switched off' : 'Not sent';
      if (state.view === 'thread') drawThread(true);
    }).catch(() => {
      entry.failed = true;
      entry.reason = 'Not sent';
      if (state.view === 'thread') drawThread(true);
    });
  }
  /* The script no longer knows this chat (it was cleared, or the saved token is old). */
  function gone() {
    forgetChat();
    state.draft.message = '';
    state.view = 'boot';
    boot();
    say('Your earlier chat is no longer available. You can start a new one.');
  }

  /* ----- asking for replies ----- */
  function activeEnough() { return Date.now() - state.lastActivity < BACKGROUND_MS; }
  function nextDelay() {
    if (!state.open) return 20000;
    const idle = Date.now() - state.lastActivity;
    return idle < 120000 ? 3000 : (idle < 600000 ? 6000 : 12000);
  }
  function scheduleNextPoll() {
    clearTimeout(pollTimer);
    if (!state.chat || document.hidden) return;
    if (!state.open && !activeEnough()) return;
    pollTimer = setTimeout(() => poll(), nextDelay());
  }
  function scheduleBackgroundPoll() { scheduleNextPoll(); }
  function poll(first) {
    clearTimeout(pollTimer);
    if (!state.chat || pollBusy) { scheduleNextPoll(); return; }
    pollBusy = true;
    API.call({ action: 'chat_poll', id: state.chat.id, t: state.chat.t, after: state.lastN }, 10000).then(res => {
      pollBusy = false;
      if (!res || res.ok !== true) {
        if (res && res.error === 'denied') { gone(); return; }
        if (res && res.error === 'off') { state.online = false; }
        scheduleNextPoll();
        return;
      }
      const wasOnline = state.online;
      const wasLoaded = state.loaded;
      state.loaded = true;
      state.online = !!res.online;
      const before = state.msgs.length;
      const fromTeam = applyServer(res.messages || []);
      const statusChanged = state.status !== (res.st || 'Open');
      state.status = res.st || 'Open';
      if (state.msgs.length !== before) touch();
      if (state.view === 'thread') {
        if (state.msgs.length !== before || !wasLoaded) drawThread(!wasLoaded);
        if (statusChanged || wasOnline !== state.online || first) { drawBanner(); setHeader(); }
      }
      if (fromTeam) {
        if (state.open && state.view === 'thread' && !document.hidden) { markSeen(); say('New message from Dasverra sales.'); }
        else { state.unread += fromTeam; syncBadge(); }
      }
      scheduleNextPoll();
    }).catch(() => {
      pollBusy = false;
      scheduleNextPoll();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.chat) {
      if (state.open && state.view === 'thread') markSeen();
      poll();
    }
  });

  /* ----- enquiry form ----- */
  function renderEnquiry(focus) {
    state.shownAt = Date.now();
    const form = el('form', 'dvc-form');
    form.noValidate = true;
    const offlineIntro = state.chatOff
      ? 'Send us your enquiry and our trade desk will reply by email or WhatsApp.'
      : 'Our trade desk is offline right now. Leave your enquiry and we will reply by email or WhatsApp.';
    form.appendChild(el('p', 'dvc-intro', (state.chatNote ? state.chatNote + ' ' : '') + offlineIntro));
    form.appendChild(registerStrip());
    const f = {
      name: field('dvc-e-name', 'Your name', 'input', { autocomplete: 'name', maxlength: '80', required: '' }),
      contact: field('dvc-e-contact', 'Email or WhatsApp number', 'input', { autocomplete: 'email', maxlength: '100', required: '', inputmode: 'email' }),
      company: field('dvc-e-company', 'Company (optional)', 'input', { autocomplete: 'organization', maxlength: '100' }),
      country: field('dvc-e-country', 'Country (optional)', 'input', { autocomplete: 'country-name', maxlength: '60' }),
      product: field('dvc-e-product', 'Product (optional)', 'input', { maxlength: '150', placeholder: 'e.g. Makhana' }),
      quantity: field('dvc-e-qty', 'Quantity (optional)', 'input', { maxlength: '80', placeholder: 'e.g. 1 x 20ft' }),
      message: field('dvc-e-message', 'Your message', 'textarea', { rows: '3', maxlength: '1500', required: '', placeholder: 'Tell us what you need.' })
    };
    f.name.control.value = state.draft.name;
    f.contact.control.value = state.draft.contact;
    f.company.control.value = state.draft.company;
    f.country.control.value = state.draft.country;
    f.product.control.value = state.draft.product;
    f.quantity.control.value = state.draft.quantity;
    f.message.control.value = state.draft.message;
    [f.name, f.contact].forEach(x => form.appendChild(x.wrap));
    const pairA = el('div', 'dvc-pair');
    pairA.appendChild(f.company.wrap);
    pairA.appendChild(f.country.wrap);
    form.appendChild(pairA);
    const pair = el('div', 'dvc-pair');
    pair.appendChild(f.product.wrap);
    pair.appendChild(f.quantity.wrap);
    form.appendChild(pair);
    form.appendChild(f.message.wrap);
    const bt = basketText();
    let basketBox = null;
    if (bt) {
      const n = basketItems().length;
      basketBox = checkbox('dvc-e-basket', el('span', '', 'Include my RFQ list (' + n + (n === 1 ? ' product' : ' products') + ')'));
      basketBox.box.checked = state.includeBasket;
      form.appendChild(basketBox.wrap);
    }
    const consent = checkbox('dvc-e-consent', consentLabel());
    form.appendChild(consent.wrap);
    const hp = honeypot();
    form.appendChild(hp.wrap);
    const go = el('button', 'btn solid dvc-go');
    go.type = 'submit';
    go.appendChild(el('span', '', 'Send enquiry'));
    form.appendChild(go);
    const wa = el('a', 'btn text dvc-alt', 'Or write on WhatsApp');
    wa.href = whatsappLink('Hello Dasverra, I have an enquiry.');
    wa.target = '_blank';
    wa.rel = 'noopener';
    form.appendChild(wa);

    form.addEventListener('input', e => {
      const x = [f.name, f.contact, f.message].find(y => y.control === e.target);
      if (x && !x.error.hidden) clearErr(x);
      if (e.target === consent.box) consent.error.hidden = true;
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (go.disabled) return;
      keepDraft(f);
      state.includeBasket = basketBox ? basketBox.box.checked : false;
      const name = f.name.control.value.trim();
      const contact = f.contact.control.value.trim();
      const message = f.message.control.value.trim();
      const product = f.product.control.value.trim();
      [f.name, f.contact, f.message].forEach(clearErr);
      let bad = null;
      if (name.length < 2) { showErr(f.name, 'Please enter your name.'); bad = bad || f.name; }
      if (!isEmail(contact) && !isPhone(contact)) { showErr(f.contact, 'Enter a valid email address or a phone number with country code.'); bad = bad || f.contact; }
      if (!message && !product) { showErr(f.message, 'Please tell us what you need.'); bad = bad || f.message; }
      if (!consent.box.checked) {
        consent.error.textContent = 'Please tick this box to continue.';
        consent.error.hidden = false;
        bad = bad || { control: consent.box };
      }
      if (bad) { bad.control.focus(); return; }
      if (hp.input.value) { state.view = 'sent'; state.enquiry = { data: { ref: 'DV-E-000000-0000' }, ok: true }; render(true); return; } // a bot: pretend it worked
      const data = {
        role: 'enquiry', ref: makeRef(), name, company: f.company.control.value.trim(), country: f.country.control.value.trim(),
        product, quantity: f.quantity.control.value.trim(), message, source: 'chat widget', page: pageName(),
        basket: basketBox && basketBox.box.checked ? bt : '', consent: 'Yes',
        elapsed_s: String(Math.round((Date.now() - state.shownAt) / 1000))
      };
      if (isEmail(contact)) data.email = contact; else data.phone = contact;
      state.enquiry = { data, ok: false, tries: 0 };
      state.view = 'sending';
      render(false);
      sendEnquiry();
    });
    body.appendChild(form);
    if (focus) f.name.control.focus({ preventScroll: true });
  }

  function makeRef() {
    const d = new Date();
    const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rnd = (window.crypto && window.crypto.getRandomValues)
      ? Array.from(window.crypto.getRandomValues(new Uint32Array(4)))
      : [0, 0, 0, 0].map(() => Math.floor(Math.random() * 4294967295));
    return 'DV-E-' + ymd + '-' + rnd.map(n => alphabet[n % alphabet.length]).join('');
  }

  /* The form is posted without waiting for an answer (a post to another site cannot be read), then the script is asked
     whether the enquiry arrived. If it cannot be confirmed, the visitor is told, and nothing is claimed. */
  function sendEnquiry() {
    const job = state.enquiry;
    if (!job) return;
    job.tries += 1;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    let posted;
    try {
      posted = fetch(API.endpoint(), { method: 'POST', mode: 'no-cors', body: new URLSearchParams(job.data), signal: ctrl ? ctrl.signal : undefined });
    } catch (err) {
      posted = Promise.reject(err);
    }
    // Whether or not the post answered in time, the script is asked afterwards: a slow start can still have stored the enquiry.
    posted.catch(() => null).then(() => { if (timer) clearTimeout(timer); return confirmEnquiry(job); }).then(ok => {
      if (state.enquiry !== job) return;
      job.ok = ok;
      state.view = ok ? 'sent' : 'contact';
      state.contactReason = ok ? '' : 'unconfirmed';
      render(true);
      if (ok) emit('enquiry-sent', { ref: job.data.ref });
    }).catch(() => {
      if (timer) clearTimeout(timer);
      if (state.enquiry !== job) return;
      state.view = 'contact';
      state.contactReason = 'unconfirmed';
      render(true);
    });
  }
  function confirmEnquiry(job) {
    let i = 0;
    const waits = [1200, 2500, 4000, 6000];
    const next = () => {
      if (i >= waits.length) return Promise.resolve(false);
      return sleep(waits[i++]).then(() => API.call({ action: 'chat_enq_check', ref: job.data.ref }, 8000)).then(
        res => (res && res.ok && res.found ? true : next()),
        () => next()
      );
    };
    return next();
  }

  function renderSending() {
    const box = el('div', 'dvc-center');
    box.appendChild(el('span', 'dvc-spinner'));
    box.appendChild(el('p', '', 'Sending your enquiry…'));
    body.appendChild(box);
  }
  function renderSent() {
    const box = el('div', 'dvc-center dvc-done');
    const tick = el('span', 'dvc-tick');
    tick.appendChild(icon('i-check'));
    box.appendChild(tick);
    box.appendChild(el('h3', '', 'Enquiry received'));
    box.appendChild(el('p', '', 'Thank you. Our trade desk will reply by email or WhatsApp.'));
    const ref = state.enquiry && state.enquiry.data ? state.enquiry.data.ref : '';
    if (ref && ref !== 'DV-E-000000-0000') {
      const r = el('p', 'dvc-ref');
      r.appendChild(document.createTextNode('Reference '));
      r.appendChild(el('b', '', ref));
      box.appendChild(r);
    }
    const again = el('button', 'btn text', 'Send another enquiry');
    again.type = 'button';
    again.addEventListener('click', () => {
      state.draft.message = ''; state.draft.product = ''; state.draft.quantity = '';
      state.enquiry = null;
      state.view = 'enquiry';
      render(true);
    });
    box.appendChild(again);
    box.appendChild(registerStrip('Want to work with us? Register as:'));
    body.appendChild(box);
  }

  /* ----- WhatsApp and email ----- */
  function renderContact() {
    const box = el('div', 'dvc-contact');
    const reason = state.contactReason;
    let title = 'Reach us directly';
    let text = 'Live chat is not available right now. These two always work, and our trade desk reads both.';
    if (reason === 'unconfirmed') {
      title = 'We could not confirm your enquiry';
      text = 'It may not have reached us. Please send it again, or write to us directly so nothing is lost.';
    } else if (reason === 'offline') {
      title = 'Connection problem';
      text = 'We could not reach the chat just now. Check your connection and try again, or write to us directly.';
    }
    box.appendChild(el('h3', '', title));
    box.appendChild(el('p', '', text));
    const d = state.draft;
    const summary = state.enquiry && state.enquiry.data
      ? ['Hello Dasverra, I tried to send an enquiry on your website.', 'Name: ' + state.enquiry.data.name,
          state.enquiry.data.product ? 'Product: ' + state.enquiry.data.product : '', state.enquiry.data.quantity ? 'Quantity: ' + state.enquiry.data.quantity : '',
          state.enquiry.data.country ? 'Country: ' + state.enquiry.data.country : '', 'Message: ' + state.enquiry.data.message].filter(Boolean).join('\n')
      : 'Hello Dasverra, I have a question' + (d.name ? ' (' + d.name + ')' : '') + '.';
    const actions = el('div', 'dvc-actions');
    if (reason === 'unconfirmed' && state.enquiry) {
      const retry = el('button', 'btn solid', 'Send it again');
      retry.type = 'button';
      retry.addEventListener('click', () => { state.view = 'sending'; render(false); sendEnquiry(); });
      actions.appendChild(retry);
    }
    const wa = el('a', 'btn ' + (reason === 'unconfirmed' ? 'dark' : 'solid'));
    wa.href = whatsappLink(summary);
    wa.target = '_blank';
    wa.rel = 'noopener';
    wa.appendChild(icon('i-chat'));
    wa.appendChild(document.createTextNode('WhatsApp'));
    actions.appendChild(wa);
    const mail = el('a', 'btn dark');
    mail.href = mailLink('Enquiry from dasverra.org', summary);
    mail.appendChild(icon('i-mail'));
    mail.appendChild(document.createTextNode('Email'));
    actions.appendChild(mail);
    box.appendChild(actions);
    if (reason !== 'unconfirmed') {
      const retry = el('button', 'btn text', 'Try the chat again');
      retry.type = 'button';
      retry.addEventListener('click', () => { state.view = 'boot'; boot(); });
      box.appendChild(retry);
    }
    box.appendChild(registerStrip());
    body.appendChild(box);
  }

  /* ---------- Mount ---------- */
  function mount() {
    if (document.getElementById('dvc-panel')) return;
    document.body.appendChild(root);
    document.documentElement.classList.add('dvc-on');
    syncBadge();
    // a chat started earlier in this browser: ask once, quietly, whether the team has answered
    const saved = loadSaved();
    if (saved && Date.now() - saved.at < BACKGROUND_MS) {
      state.chat = saved;
      state.seenN = saved.seen || 0;
      state.view = 'thread';
      state.lastActivity = saved.at;
      setTimeout(() => poll(true), 1500 + Math.floor(Math.random() * 1500));
    }
  }
  window.DVChat = { open, close };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
