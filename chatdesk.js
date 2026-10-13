(() => {
  'use strict';

  /* Dasverra chat desk (early access)
     The page where the trade desk reads and answers website chats and enquiries, on a phone or a laptop.
     It talks to the same Google Apps Script web app as the website (chat-api.js). Signing in sends the desk key once and gets back
     a session that lasts 7 days; the key itself is never kept. Everything a visitor wrote is drawn with textContent, never as
     HTML, and links in messages are not made clickable. */

  const API = window.DVChatAPI;
  const root = document.getElementById('desk');
  if (!API || !root) return;

  const CONF = window.DVCONF || {};
  const KEY = 'dv_desk_v1';
  const PING_MS = 10000;          // presence and counts, while this page is visible
  const THREAD_MS = 3000;         // new messages of the chat that is open
  const MAX_REPLY = 1500;         // characters in one reply message (the script cuts at the same number)
  const URL_BUDGET = 1100;        // encoded characters of reply text allowed in one call; longer replies go as several
  const CHAT_FILTERS = [['open', 'Open'], ['closed', 'Closed'], ['spam', 'Spam']];
  const ENQ_FILTERS = [['new', 'New'], ['work', 'In progress'], ['done', 'Done'], ['spam', 'Spam']];
  const ENQ_STATUSES = ['New', 'Replied', 'Quoted', 'Won', 'Lost', 'Possible spam'];
  const QUICK = [
    ['Greeting', 'Hello, thank you for contacting Dasverra. How can I help you?'],
    ['Ask for details', 'Could you share the product, quantity and destination port? Then I can come back to you with the details.'],
    ['Will check', 'Thank you. I will check this with our team and get back to you shortly.'],
    ['WhatsApp', 'You can also reach me directly on WhatsApp: +91 80139 06621.']
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WIDE = window.matchMedia ? window.matchMedia('(min-width: 900px)') : { matches: true, addEventListener() {} };
  const TOUCH = window.matchMedia ? window.matchMedia('(pointer: coarse)') : { matches: false };

  const $ = (sel, scope = document) => scope.querySelector(sel);
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
  function button(cls, label, handler) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (handler) b.addEventListener('click', handler);
    return b;
  }

  /* ---------- Storage that never throws ---------- */
  const memory = {};
  const store = {
    get(key) {
      try {
        const v = window.localStorage.getItem(key);
        if (v !== null) return v;
      } catch (err) { /* blocked: use memory */ }
      return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
    },
    set(key, value) {
      memory[key] = value;
      try { window.localStorage.setItem(key, value); } catch (err) { /* memory copy still works */ }
    },
    del(key) {
      delete memory[key];
      try { window.localStorage.removeItem(key); } catch (err) { /* ignore */ }
    }
  };

  const state = {
    session: '', avail: true, sound: true,
    tab: 'chats', chatFilter: 'open', enqFilter: 'new',
    chats: null, enq: null,
    counts: { unread: 0, open: 0, enquiries: 0 }, lastUnread: -1,
    ver: '', net: true, serverOnline: false,
    open: null,        // the chat on screen: { id, meta, msgs, lastN, pending, away, loaded, chain }
    want: null,        // a chat or enquiry asked for by the link that was opened
    expand: '',        // reference of the enquiry whose editor starts open
    editing: ''        // reference of the enquiry whose editor is being used
  };
  let ui = {};
  let pingTimer = null;
  let threadTimer = null;
  let audio = null;
  let pushed = false;

  function loadPrefs() {
    try {
      const o = JSON.parse(store.get(KEY) || '{}');
      const exp = typeof o.s === 'string' ? Number(o.s.split('.')[0]) : 0;
      state.session = exp > Math.floor(Date.now() / 1000) ? o.s : '';
      state.avail = o.avail !== false;
      state.sound = o.sound !== false;
    } catch (err) {
      state.session = '';
    }
  }
  function savePrefs() {
    store.set(KEY, JSON.stringify({ s: state.session, avail: state.avail, sound: state.sound }));
  }

  /* ---------- Small helpers ---------- */
  const pad = n => String(n).padStart(2, '0');
  const digits = s => String(s || '').replace(/\D/g, '');
  const isEmail = s => /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(String(s || ''));
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  /* 14:05 today, otherwise 12 Oct. */
  function stamp(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return sameDay(d, new Date()) ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : d.getDate() + ' ' + MONTHS[d.getMonth()];
  }
  function fullStamp(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dayLabel(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, new Date(now.getTime() - 86400000))) return 'Yesterday';
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  /* Email, WhatsApp and phone links for a contact written by a visitor. Only a well-formed address or the digits of a number
     ever reach a link, so nothing a visitor typed can add anything to it. */
  function contactLinks(contact, name) {
    const out = [];
    if (isEmail(contact)) {
      out.push({ label: 'Email', href: 'mailto:' + contact, icon: 'i-mail' });
    } else if (digits(contact).length >= 7) {
      out.push({ label: 'WhatsApp', href: 'https://wa.me/' + digits(contact), icon: 'i-chat', blank: true });
      out.push({ label: 'Call', href: 'tel:+' + digits(contact), icon: 'i-phone' });
    }
    return out;
  }
  function linkRow(contact, name) {
    const row = el('div', 'cd-links');
    contactLinks(contact, name).forEach(l => {
      const a = el('a', 'cd-link');
      a.href = l.href;
      if (l.blank) { a.target = '_blank'; a.rel = 'noopener'; }
      a.appendChild(icon(l.icon));
      a.appendChild(document.createTextNode(l.label));
      row.appendChild(a);
    });
    return row;
  }

  /* ---------- Calls ---------- */
  function call(params, ms) {
    return API.call(Object.assign({ s: state.session }, params), ms).then(res => {
      if (res && res.ok === false && res.error === 'auth') {
        signedOut('Your session has ended. Please sign in again.');
        throw new Error('auth');
      }
      return res;
    });
  }
  const isAuth = err => !!err && err.message === 'auth';

  /* ---------- Sound, title, connection ---------- */
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio = audio || new AC();
      if (audio.state === 'suspended') audio.resume();
    } catch (err) { /* no sound */ }
  }
  function beep() {
    if (!state.sound || !audio) return;
    try {
      if (audio.state === 'suspended') audio.resume();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(audio.destination);
      const t0 = audio.currentTime;
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      o.start(t0);
      o.stop(t0 + 0.45);
    } catch (err) { /* no sound */ }
  }
  function setTitle() {
    const n = state.counts.unread + state.counts.enquiries;
    document.title = (n ? '(' + n + ') ' : '') + 'Chat desk · Dasverra';
  }
  function setNet(ok) {
    if (state.net === ok) return;
    state.net = ok;
    drawStatus();
  }

  /* ---------- Sign in ---------- */
  function stopTimers() {
    clearTimeout(pingTimer);
    clearTimeout(threadTimer);
    pingTimer = null;
    threadTimer = null;
  }

  function showLogin(message) {
    stopTimers();
    state.open = null;
    state.chats = null;
    state.enq = null;
    state.ver = '';
    state.lastUnread = -1;
    state.counts = { unread: 0, open: 0, enquiries: 0 };
    ui = {};
    setTitle();
    root.textContent = '';
    root.className = 'cd cd-login';
    const card = el('div', 'cd-login-card');
    const logo = el('img', 'cd-logo');
    logo.src = 'logo.svg';
    logo.alt = '';
    logo.width = 44;
    logo.height = 44;
    card.appendChild(logo);
    card.appendChild(el('h1', '', CONF.sandbox ? 'Chat desk · sandbox' : 'Chat desk'));
    card.appendChild(el('p', 'cd-lead', 'Answer chats and enquiries from the Dasverra website. Sign in with your desk key.'));

    const form = el('form', 'cd-loginform');
    form.noValidate = true;
    const field = el('div', 'field');
    const lab = el('label', '', 'Desk key');
    lab.setAttribute('for', 'cd-key');
    const input = el('input');
    input.id = 'cd-key';
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.maxLength = 200;
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    field.appendChild(lab);
    field.appendChild(input);
    const show = el('div', 'cd-show');
    const showBox = el('input');
    showBox.type = 'checkbox';
    showBox.id = 'cd-show';
    const showLab = el('label', '', 'Show the key');
    showLab.setAttribute('for', 'cd-show');
    show.appendChild(showBox);
    show.appendChild(showLab);
    showBox.addEventListener('change', () => { input.type = showBox.checked ? 'text' : 'password'; });
    const err = el('p', 'cd-error', message || '');
    err.setAttribute('role', 'alert');
    err.hidden = !message;
    const go = el('button', 'btn solid cd-wide');
    go.type = 'submit';
    go.appendChild(el('span', '', 'Sign in'));
    form.appendChild(field);
    form.appendChild(show);
    form.appendChild(err);
    form.appendChild(go);
    card.appendChild(form);
    if (CONF.deskHint) card.appendChild(el('p', 'cd-hint', String(CONF.deskHint)));
    const fine = el('p', 'cd-fine', 'The key is set in the Google Sheet (Dasverra menu, Chat, Set the chat desk key). Use a long phrase that you use nowhere else.');
    card.appendChild(fine);
    root.appendChild(card);

    form.addEventListener('submit', e => {
      e.preventDefault();
      unlockAudio();
      if (go.disabled) return;
      const key = input.value;
      if (!key) {
        err.textContent = 'Please type your desk key.';
        err.hidden = false;
        input.focus();
        return;
      }
      err.hidden = true;
      go.disabled = true;
      go.firstChild.textContent = 'Checking…';
      API.call({ action: 'desk_login', k: key }, 15000).then(res => {
        if (res && res.ok === true && typeof res.s === 'string') {
          input.value = '';
          state.session = res.s;
          savePrefs();
          startApp();
          return;
        }
        const e2 = res && res.error;
        err.textContent = e2 === 'locked' ? 'Too many wrong tries. Please wait 10 minutes and try again.'
          : e2 === 'nokey' ? 'No desk key has been set yet. In the Google Sheet open the Dasverra menu, then Chat, then Set the chat desk key.'
          : e2 === 'denied' ? 'That key is not right.'
          : 'The chat desk is not available on the server yet.';
        err.hidden = false;
        go.disabled = false;
        go.firstChild.textContent = 'Sign in';
        input.focus();
        input.select();
      }).catch(() => {
        err.textContent = 'Could not reach the server. Check your connection and try again.';
        err.hidden = false;
        go.disabled = false;
        go.firstChild.textContent = 'Sign in';
      });
    });
    input.focus({ preventScroll: true });
  }

  function signedOut(message) {
    state.session = '';
    savePrefs();
    showLogin(message || '');
  }
  function signOut() {
    try { fetch(API.url({ action: 'desk_ping', s: state.session, online: '0' }), { keepalive: true, mode: 'no-cors', credentials: 'omit' }); } catch (err) { /* it expires by itself */ }
    signedOut('');
  }

  /* ---------- The app ---------- */
  function startApp() {
    parseWant();
    buildShell();
    ping();
    if (state.want && state.want.type === 'chat') openChat(state.want.id);
    if (state.want && state.want.type === 'enq') selectTab('enq');
    state.want = null;
  }
  function parseWant() {
    const h = decodeURIComponent((location.hash || '').slice(1));
    if (/^DV-C-\d{6}-[A-Z0-9]{4}$/.test(h)) state.want = { type: 'chat', id: h };
    else if (/^DV-E-\d{6}-[A-Z0-9]{4}$/.test(h)) { state.want = { type: 'enq', ref: h }; state.editing = ''; state.expand = h; }
  }

  function buildShell() {
    root.textContent = '';
    root.className = 'cd cd-app';
    root.dataset.pane = 'list';
    root.dataset.tab = state.tab;
    ui = {};

    const top = el('header', 'cd-top');
    const brand = el('div', 'cd-brand');
    const logo = el('img', 'cd-mark');
    logo.src = 'logo-light.svg';
    logo.alt = '';
    logo.width = 30;
    logo.height = 30;
    brand.appendChild(logo);
    const bt = el('div', 'cd-brand-text');
    bt.appendChild(el('h1', 'cd-title', CONF.sandbox ? 'Chat desk · sandbox' : 'Chat desk'));
    ui.status = el('span', 'cd-status', '');
    bt.appendChild(ui.status);
    brand.appendChild(bt);
    top.appendChild(brand);

    const tools = el('div', 'cd-tools');
    ui.switch = el('button', 'cd-switch');
    ui.switch.type = 'button';
    ui.switch.setAttribute('role', 'switch');
    ui.switchDot = el('i', 'cd-dot');
    ui.switchDot.setAttribute('aria-hidden', 'true');
    ui.switchText = el('span', '', 'Available');
    ui.switch.appendChild(ui.switchDot);
    ui.switch.appendChild(ui.switchText);
    ui.switch.addEventListener('click', () => {
      unlockAudio();
      state.avail = !state.avail;
      savePrefs();
      drawStatus();
      ping();
    });
    tools.appendChild(ui.switch);

    ui.sound = el('button', 'cd-iconbtn');
    ui.sound.type = 'button';
    ui.sound.addEventListener('click', () => {
      unlockAudio();
      state.sound = !state.sound;
      savePrefs();
      drawStatus();
      if (state.sound) beep();
    });
    tools.appendChild(ui.sound);

    const out = el('button', 'cd-iconbtn');
    out.type = 'button';
    out.setAttribute('aria-label', 'Sign out');
    out.title = 'Sign out';
    out.appendChild(icon('i-out'));
    out.addEventListener('click', signOut);
    tools.appendChild(out);
    top.appendChild(tools);
    root.appendChild(top);

    const tabs = el('div', 'cd-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Chats and enquiries');
    ui.tabChats = makeTab('chats', 'Chats');
    ui.tabEnq = makeTab('enq', 'Enquiries');
    tabs.appendChild(ui.tabChats.btn);
    tabs.appendChild(ui.tabEnq.btn);
    tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      selectTab(state.tab === 'chats' ? 'enq' : 'chats', true);
    });
    root.appendChild(tabs);

    const main = el('div', 'cd-main');
    const left = el('section', 'cd-left');

    const chatPane = el('div', 'cd-chatpane');
    chatPane.id = 'cd-panel-chats';
    chatPane.setAttribute('role', 'tabpanel');
    chatPane.setAttribute('aria-labelledby', 'cd-tab-chats');
    ui.chatFilters = el('div', 'seg cd-filters');
    ui.chatFilters.setAttribute('role', 'group');
    ui.chatFilters.setAttribute('aria-label', 'Show chats');
    chatPane.appendChild(ui.chatFilters);
    ui.list = el('ul', 'cd-list');
    chatPane.appendChild(ui.list);
    left.appendChild(chatPane);

    const enqPane = el('div', 'cd-enqpane');
    enqPane.id = 'cd-panel-enq';
    enqPane.setAttribute('role', 'tabpanel');
    enqPane.setAttribute('aria-labelledby', 'cd-tab-enq');
    ui.enqFilters = el('div', 'seg cd-filters');
    ui.enqFilters.setAttribute('role', 'group');
    ui.enqFilters.setAttribute('aria-label', 'Show enquiries');
    enqPane.appendChild(ui.enqFilters);
    ui.enqList = el('div', 'cd-enqlist');
    enqPane.appendChild(ui.enqList);
    left.appendChild(enqPane);
    main.appendChild(left);

    ui.detail = el('section', 'cd-detail');
    ui.detail.setAttribute('aria-label', 'Conversation');
    main.appendChild(ui.detail);
    root.appendChild(main);

    drawStatus();
    drawTabs();
    drawFilters();
    renderList();
    renderEnq();
    renderDetail();
  }

  function makeTab(id, label) {
    const btn = el('button', 'cd-tab');
    btn.type = 'button';
    btn.id = 'cd-tab-' + id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', 'cd-panel-' + id);
    btn.appendChild(el('span', '', label));
    const count = el('span', 'cd-count');
    count.hidden = true;
    btn.appendChild(count);
    btn.addEventListener('click', () => selectTab(id));
    return { btn, count };
  }
  function selectTab(tab, focus) {
    state.tab = tab;
    root.dataset.tab = tab;
    drawTabs();
    if (tab === 'enq') {
      if (state.enq === null) loadEnquiries(); else renderEnq();
    } else {
      renderList();
    }
    if (focus) (tab === 'chats' ? ui.tabChats : ui.tabEnq).btn.focus();
  }
  function drawTabs() {
    [['chats', ui.tabChats, state.counts.unread], ['enq', ui.tabEnq, state.counts.enquiries]].forEach(([id, t, n]) => {
      const on = state.tab === id;
      t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      t.btn.tabIndex = on ? 0 : -1;
      t.count.hidden = !n;
      t.count.textContent = n > 99 ? '99+' : String(n);
      t.btn.classList.toggle('on', on);
    });
  }
  function drawStatus() {
    if (!ui.switch) return;
    ui.switch.setAttribute('aria-checked', state.avail ? 'true' : 'false');
    ui.switch.classList.toggle('on', state.avail);
    ui.switchText.textContent = state.avail ? 'Available' : 'Away';
    ui.switch.title = state.avail ? 'Visitors can start a chat with you. Click to go away.' : 'Visitors see the enquiry form. Click to become available.';
    ui.sound.setAttribute('aria-label', state.sound ? 'Sound on. Turn sound off' : 'Sound off. Turn sound on');
    ui.sound.title = state.sound ? 'Sound on for new messages' : 'Sound off';
    ui.sound.textContent = '';
    ui.sound.appendChild(icon(state.sound ? 'i-sound' : 'i-mute'));
    ui.status.className = 'cd-status' + (state.net ? '' : ' bad');
    ui.status.textContent = !state.net ? 'No connection. Trying again…'
      : state.avail ? (state.serverOnline ? 'Visitors can chat' : 'Connecting…') : 'Enquiry form is shown';
  }
  function drawFilters() {
    if (!ui.chatFilters) return;
    const chats = state.chats || [];
    const nChat = key => chats.filter(c => chatMatches(c, key)).length;
    segment(ui.chatFilters, CHAT_FILTERS, state.chatFilter, key => (key === 'open' ? nChat('open') : 0),
      key => { state.chatFilter = key; drawFilters(); renderList(); });
    const enq = state.enq || [];
    const nEnq = key => enq.filter(r => enqMatches(r, key)).length;
    segment(ui.enqFilters, ENQ_FILTERS, state.enqFilter, key => (key === 'new' ? nEnq('new') : 0),
      key => { state.enqFilter = key; drawFilters(); renderEnq(); });
  }
  function segment(box, defs, current, countOf, onPick) {
    box.textContent = '';
    defs.forEach(([key, label]) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', key === current ? 'true' : 'false');
      const n = countOf(key);
      if (n) b.appendChild(el('span', 'cd-n', ' ' + n));
      b.addEventListener('click', () => onPick(key));
      box.appendChild(b);
    });
  }

  /* ---------- Presence and counts ---------- */
  function applyCounts(res) {
    const c = { unread: Number(res.unread) || 0, open: Number(res.open) || 0, enquiries: Number(res.enquiries) || 0 };
    const grew = state.lastUnread >= 0 && (c.unread > state.lastUnread || c.enquiries > state.counts.enquiries);
    state.lastUnread = c.unread;
    state.counts = c;
    drawTabs();
    setTitle();
    if (grew) beep();
  }

  function ping() {
    clearTimeout(pingTimer);
    pingTimer = null;
    if (!state.session) return;
    call({ action: 'desk_ping', online: state.avail ? '1' : '0' }, 10000).then(res => {
      if (!res || res.ok !== true) throw new Error('bad');
      setNet(true);
      state.serverOnline = !!res.online;
      drawStatus();
      applyCounts(res);
      if (res.ver !== state.ver) {
        state.ver = res.ver;
        return refresh();
      }
      return null;
    }).catch(err => {
      if (!isAuth(err)) setNet(false);
    }).then(() => {
      if (state.session) pingTimer = setTimeout(ping, document.hidden ? 60000 : PING_MS);
    });
  }
  function refresh() {
    return Promise.all([loadChats(), state.tab === 'enq' || state.enq !== null ? loadEnquiries() : null]);
  }

  /* ---------- Chat list ---------- */
  function chatMatches(c, key) {
    if (key === 'open') return c.st === 'Open';
    if (key === 'closed') return c.st === 'Closed';
    if (key === 'spam') return c.st === 'Possible spam';
    return true;
  }
  function loadChats() {
    return call({ action: 'desk_list' }, 15000).then(res => {
      if (!res || res.ok !== true) throw new Error('bad');
      setNet(true);
      state.chats = Array.isArray(res.chats) ? res.chats : [];
      drawFilters();
      renderList();
    }).catch(err => {
      if (!isAuth(err)) setNet(false);
    });
  }

  function renderList() {
    if (!ui.list) return;
    const box = ui.list;
    box.textContent = '';
    if (state.chats === null) {
      const li = el('li', 'cd-state');
      li.appendChild(el('span', 'cd-spin'));
      li.appendChild(document.createTextNode('Loading chats…'));
      box.appendChild(li);
      return;
    }
    const rows = state.chats.filter(c => chatMatches(c, state.chatFilter));
    if (!rows.length) {
      const text = state.chatFilter === 'open' ? 'No open chats. A chat from a visitor appears here.'
        : state.chatFilter === 'closed' ? 'No closed chats yet.' : 'Nothing is marked as spam.';
      box.appendChild(el('li', 'cd-state', text));
      return;
    }
    rows.forEach(c => box.appendChild(chatItem(c)));
  }

  function chatItem(c) {
    const li = el('li', 'cd-li');
    const current = !!(state.open && state.open.id === c.id);
    const b = el('button', 'cd-item' + (c.unread ? ' unread' : '') + (current ? ' current' : ''));
    b.type = 'button';
    b.dataset.id = c.id;
    if (current) b.setAttribute('aria-current', 'true');
    const initial = (c.name || '?').trim().charAt(0).toUpperCase() || '?';
    b.appendChild(el('span', 'cd-avatar', initial));
    const body = el('span', 'cd-item-body');
    const top = el('span', 'cd-item-top');
    top.appendChild(el('b', 'cd-item-name', c.name || 'Visitor'));
    top.appendChild(el('time', 'cd-item-time', stamp(c.last)));
    body.appendChild(top);
    const bottom = el('span', 'cd-item-bottom');
    const prefix = c.lastFrom === 's' ? 'You: ' : '';
    bottom.appendChild(el('span', 'cd-preview', prefix + (c.preview || '')));
    if (c.unread) {
      const n = el('span', 'cd-badge', c.unread > 99 ? '99+' : String(c.unread));
      n.appendChild(el('span', 'sr-only', c.unread === 1 ? ' unread message' : ' unread messages'));
      bottom.appendChild(n);
    }
    body.appendChild(bottom);
    const meta = [c.country, c.st === 'Closed' ? 'Closed' : (c.st === 'Possible spam' ? 'Possible spam' : '')].filter(Boolean).join(' · ');
    if (meta) body.appendChild(el('span', 'cd-item-meta', meta));
    b.appendChild(body);
    b.addEventListener('click', () => { unlockAudio(); openChat(c.id); });
    li.appendChild(b);
    return li;
  }

  /* ---------- One chat ---------- */
  function showPane(pane) {
    root.dataset.pane = pane;
  }

  function openChat(id) {
    if (state.open && state.open.id === id) { showPane('detail'); return; }
    stopThread();
    const known = (state.chats || []).find(c => c.id === id);
    const t = {
      id, meta: known ? Object.assign({ notes: '' }, known) : { id, st: 'Open', name: '', contact: '', country: '', page: '', basket: '', started: 0, notes: '' },
      msgs: [], lastN: 0, pending: [], away: false, loaded: false, failedOpen: false, chain: Promise.resolve()
    };
    state.open = t;
    if (state.tab !== 'chats') selectTab('chats');
    showPane('detail');
    if (!WIDE.matches && !pushed) {
      try { history.pushState({ cd: 1 }, ''); pushed = true; } catch (err) { /* the Back button of the page still works */ }
    }
    renderDetail(true);
    renderList();
    call({ action: 'desk_open', id }, 15000).then(res => {
      if (state.open !== t) return;
      if (!res || res.ok !== true) {
        t.failedOpen = true;
        t.loaded = true;
        renderDetail();
        return;
      }
      t.meta = Object.assign({}, t.meta, res.chat);
      t.away = !!(res.chat && res.chat.away);
      t.loaded = true;
      t.msgs = [];
      mergeMessages(t, res.messages || []);
      const row = (state.chats || []).find(c => c.id === id);
      if (row) { row.unread = 0; renderList(); }
      renderDetail(true);
      scheduleThread();
    }).catch(err => {
      if (state.open !== t || isAuth(err)) return;
      t.failedOpen = true;
      t.loaded = true;
      renderDetail();
    });
  }

  function closeChat() {
    stopThread();
    state.open = null;
    showPane('list');
    renderDetail();
    renderList();
  }
  function backToList() {
    if (pushed) { history.back(); return; } // the popstate handler does the closing
    closeChat();
  }
  window.addEventListener('popstate', () => {
    pushed = false;
    if (state.open) closeChat();
  });

  function stopThread() {
    clearTimeout(threadTimer);
    threadTimer = null;
  }
  function scheduleThread() {
    clearTimeout(threadTimer);
    threadTimer = null;
    if (state.open && !document.hidden && state.session) threadTimer = setTimeout(pollThread, THREAD_MS);
  }

  /* Takes messages from the script into a chat (each number once). Returns how many came from the visitor. */
  function mergeMessages(t, list) {
    let fromVisitor = 0;
    list.forEach(m => {
      if (!m || typeof m.n !== 'number' || t.msgs.some(x => x.n === m.n)) return;
      t.msgs.push({ n: m.n, f: m.f, t: String(m.t), ts: Number(m.ts) || 0 });
      if (m.f === 'v') fromVisitor++;
      if (m.f === 's') {
        const i = t.pending.findIndex(p => !p.failed && p.text === String(m.t));
        if (i > -1) t.pending.splice(i, 1);
      }
    });
    t.msgs.sort((a, b) => a.n - b.n);
    t.lastN = t.msgs.length ? t.msgs[t.msgs.length - 1].n : 0;
    return fromVisitor;
  }

  function pollThread() {
    const t = state.open;
    threadTimer = null;
    if (!t || document.hidden) return;
    call({ action: 'desk_open', id: t.id, after: t.lastN }, 10000).then(res => {
      if (state.open !== t) return;
      if (!res || res.ok !== true) throw new Error('bad');
      setNet(true);
      const before = t.msgs.length;
      const incoming = mergeMessages(t, res.messages || []);
      const awayChanged = t.away !== !!res.away;
      t.away = !!res.away;
      const stChanged = res.st && res.st !== t.meta.st;
      if (stChanged) { t.meta.st = res.st; syncListRow(t); }
      if (t.msgs.length !== before) { drawThread(false); syncListRow(t); }
      if (stChanged || awayChanged) drawHead();
      if (incoming) beep();
    }).catch(err => {
      if (!isAuth(err)) setNet(false);
    }).then(() => {
      if (state.open === t) scheduleThread();
    });
  }

  /* Keeps the list row of the open chat in line with what is on screen, without asking the script. */
  function syncListRow(t) {
    const row = (state.chats || []).find(c => c.id === t.id);
    if (!row) return;
    const last = t.msgs.filter(m => m.f !== 'x').slice(-1)[0];
    if (last) { row.preview = last.t.replace(/\s+/g, ' ').slice(0, 120); row.lastFrom = last.f; row.last = last.ts; }
    row.count = Math.max(row.count || 0, t.lastN);
    row.unread = 0;
    row.st = t.meta.st;
    drawFilters();
    renderList();
  }

  /* ----- the detail pane ----- */
  let dom = {};

  function renderDetail(focusHead) {
    const box = ui.detail;
    if (!box) return;
    box.textContent = '';
    dom = {};
    const t = state.open;
    if (!t) {
      const empty = el('div', 'cd-nochat');
      empty.appendChild(icon('i-chat'));
      empty.appendChild(el('p', '', 'Pick a chat from the list to read and answer it.'));
      box.appendChild(empty);
      return;
    }
    const conv = el('div', 'cd-conv');

    const head = el('header', 'cd-dhead');
    const back = button('cd-back', '', backToList);
    back.setAttribute('aria-label', 'Back to the chat list');
    back.appendChild(icon('i-back'));
    head.appendChild(back);
    dom.who = el('div', 'cd-who');
    head.appendChild(dom.who);
    dom.state = el('button', 'btn dark small cd-state-btn');
    dom.state.type = 'button';
    dom.state.addEventListener('click', () => {
      setStatus(t, t.meta.st === 'Closed' ? 'Open' : 'Closed');
    });
    head.appendChild(dom.state);
    conv.appendChild(head);

    dom.presence = el('p', 'cd-presence');
    conv.appendChild(dom.presence);

    dom.info = el('details', 'cd-info');
    dom.infoSummary = el('summary', '', 'Details and notes');
    dom.info.appendChild(dom.infoSummary);
    dom.infoBody = el('div', 'cd-info-body');
    dom.info.appendChild(dom.infoBody);
    conv.appendChild(dom.info);

    dom.thread = el('div', 'cd-thread');
    dom.thread.setAttribute('role', 'log');
    dom.thread.setAttribute('aria-label', 'Conversation');
    dom.thread.setAttribute('aria-live', 'polite');
    dom.thread.tabIndex = 0;
    conv.appendChild(dom.thread);

    dom.quick = el('div', 'cd-quick');
    dom.quick.setAttribute('role', 'group');
    dom.quick.setAttribute('aria-label', 'Quick replies (they fill the box, you send them)');
    QUICK.forEach(([label, text]) => {
      const q = button('cd-chip', label, () => {
        const ta = dom.text;
        if (!ta) return;
        ta.value = ta.value ? ta.value.replace(/\s+$/, '') + ' ' + text : text;
        ta.dispatchEvent(new Event('input'));
        ta.focus();
      });
      dom.quick.appendChild(q);
    });
    conv.appendChild(dom.quick);

    dom.compose = el('form', 'cd-compose');
    const lab = el('label', 'sr-only', 'Your reply');
    lab.setAttribute('for', 'cd-reply');
    dom.text = el('textarea');
    dom.text.id = 'cd-reply';
    dom.text.rows = 1;
    dom.text.maxLength = MAX_REPLY * 2;
    dom.text.placeholder = 'Write a reply';
    dom.text.setAttribute('enterkeyhint', 'send');
    const send = el('button', 'cd-send');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Send reply');
    send.appendChild(icon('i-arrow'));
    dom.compose.appendChild(lab);
    dom.compose.appendChild(dom.text);
    dom.compose.appendChild(send);
    conv.appendChild(dom.compose);
    box.appendChild(conv);

    const grow = () => {
      dom.text.style.height = 'auto';
      dom.text.style.height = Math.min(dom.text.scrollHeight, 140) + 'px';
    };
    dom.text.addEventListener('input', grow);
    dom.text.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !TOUCH.matches) {
        e.preventDefault();
        if (dom.compose.requestSubmit) dom.compose.requestSubmit(); else dom.compose.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    dom.compose.addEventListener('submit', e => {
      e.preventDefault();
      const text = dom.text.value.trim();
      if (!text) return;
      dom.text.value = '';
      grow();
      sendReply(t, text);
      dom.text.focus({ preventScroll: true });
    });

    drawHead();
    drawInfo();
    drawThread(true);
    if (focusHead && !WIDE.matches && dom.who) {
      dom.who.tabIndex = -1;
      dom.who.focus({ preventScroll: true });
    }
  }

  function drawHead() {
    const t = state.open;
    if (!t || !dom.who) return;
    const m = t.meta;
    dom.who.textContent = '';
    dom.who.appendChild(el('h2', 'cd-name', m.name || 'Visitor'));
    const sub = [m.contact, m.country].filter(Boolean).join(' · ');
    dom.who.appendChild(el('p', 'cd-sub', sub));
    dom.state.textContent = m.st === 'Closed' ? 'Reopen' : 'Close chat';
    dom.state.hidden = m.st === 'Possible spam';
    dom.presence.className = 'cd-presence' + (t.away ? ' away' : ' here');
    dom.presence.textContent = !t.loaded ? '' : (t.away
      ? 'The visitor is not on the page right now. They will see your reply when they come back' + (m.contact ? ', and you can write to ' + m.contact + '.' : '.')
      : 'The visitor is on the page now.');
    dom.presence.hidden = !t.loaded || t.failedOpen || m.st === 'Closed' || m.st === 'Possible spam';
    if (m.st === 'Possible spam') {
      dom.presence.hidden = false;
      dom.presence.className = 'cd-presence away';
      dom.presence.textContent = 'Marked as possible spam. Replying is still possible.';
    }
  }

  function drawInfo() {
    const t = state.open;
    if (!t || !dom.infoBody) return;
    const m = t.meta;
    const body = dom.infoBody;
    body.textContent = '';
    const rows = [['Contact', m.contact], ['Country', m.country], ['Started', m.started ? fullStamp(m.started) : ''], ['Page', m.page], ['RFQ list', m.basket]];
    const dl = el('dl', 'cd-facts');
    rows.forEach(([k, v]) => {
      if (!v) return;
      dl.appendChild(el('dt', '', k));
      dl.appendChild(el('dd', '', String(v)));
    });
    body.appendChild(dl);
    if (m.contact) body.appendChild(linkRow(m.contact, m.name));

    const nlab = el('label', 'cd-notelabel', 'Private notes (only you see these)');
    nlab.setAttribute('for', 'cd-note');
    const note = el('textarea');
    note.id = 'cd-note';
    note.rows = 3;
    note.maxLength = 2000;
    note.value = m.notes || '';
    const row = el('div', 'cd-noterow');
    const save = button('btn dark small', 'Save note', () => {
      save.disabled = true;
      call({ action: 'desk_set', id: t.id, note: note.value }, 12000).then(res => {
        if (res && res.ok === true) { m.notes = note.value; saved.textContent = 'Saved'; } else { saved.textContent = 'Not saved. Try again.'; }
      }).catch(err => { if (!isAuth(err)) saved.textContent = 'Not saved. Try again.'; }).then(() => {
        save.disabled = false;
        setTimeout(() => { saved.textContent = ''; }, 3000);
      });
    });
    const saved = el('span', 'cd-saved', '');
    saved.setAttribute('role', 'status');
    row.appendChild(save);
    row.appendChild(saved);
    body.appendChild(nlab);
    body.appendChild(note);
    body.appendChild(row);

    const flag = button('btn text', m.st === 'Possible spam' ? 'This is not spam' : 'Mark as spam', () => {
      setStatus(t, m.st === 'Possible spam' ? 'Open' : 'Possible spam');
    });
    body.appendChild(flag);
  }

  function setStatus(t, status) {
    dom.state.disabled = true;
    call({ action: 'desk_set', id: t.id, status }, 12000).then(res => {
      if (state.open !== t) return;
      if (res && res.ok === true) {
        t.meta.st = res.st || status;
        const row = (state.chats || []).find(c => c.id === t.id);
        if (row) row.st = t.meta.st;
        drawFilters();
        renderList();
        drawHead();
        drawInfo();
        pollThread(); // brings the system note of a closed chat
      }
    }).catch(() => { /* the button works again below */ }).then(() => {
      if (dom.state) dom.state.disabled = false;
    });
  }

  function drawThread(forceBottom) {
    const t = state.open;
    const box = dom.thread;
    if (!t || !box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    box.textContent = '';
    if (!t.loaded) {
      const w = el('p', 'cd-fine');
      w.appendChild(el('span', 'cd-spin'));
      w.appendChild(document.createTextNode('Loading the conversation…'));
      box.appendChild(w);
      return;
    }
    if (t.failedOpen) {
      box.appendChild(el('p', 'cd-fine', 'This chat could not be opened. It may have been removed from the Sheet.'));
      return;
    }
    let lastDay = '';
    t.msgs.forEach(m => {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { box.appendChild(el('p', 'cd-day', day)); lastDay = day; }
      if (m.f === 'x') { box.appendChild(el('p', 'cd-system', m.t)); return; }
      const row = el('div', 'cd-msg ' + (m.f === 's' ? 'me' : 'them'));
      row.appendChild(el('p', 'cd-text', m.t));
      row.appendChild(el('span', 'cd-time', (m.f === 's' ? 'You · ' : '') + stamp(m.ts)));
      box.appendChild(row);
    });
    t.pending.forEach(p => {
      const row = el('div', 'cd-msg me pending' + (p.failed ? ' failed' : ''));
      row.appendChild(el('p', 'cd-text', p.text));
      if (p.failed) {
        const meta = el('span', 'cd-time');
        meta.appendChild(document.createTextNode((p.reason || 'Not sent') + ' · '));
        meta.appendChild(button('cd-linkbtn', 'Try again', () => retryReply(t, p.mid)));
        row.appendChild(meta);
      } else {
        row.appendChild(el('span', 'cd-time', 'Sending…'));
      }
      box.appendChild(row);
    });
    if (forceBottom || near) box.scrollTop = box.scrollHeight;
  }

  /* ----- replying ----- */
  function sendReply(t, text) {
    API.splitMessage(text.slice(0, MAX_REPLY * 2), MAX_REPLY, URL_BUDGET).forEach(part => {
      const entry = { mid: API.uid('r'), text: part, failed: false, reason: '' };
      t.pending.push(entry);
      enqueue(t, entry);
    });
    drawThread(true);
  }
  function enqueue(t, entry) {
    t.chain = t.chain.then(() => deliver(t, entry)).catch(() => {
      entry.failed = true;
      entry.reason = 'Not sent';
      if (state.open === t) drawThread(true);
    });
  }
  function retryReply(t, mid) {
    const entry = t.pending.find(p => p.mid === mid);
    if (!entry) return;
    entry.failed = false;
    entry.reason = '';
    drawThread(true);
    enqueue(t, entry);
  }
  function deliver(t, entry) {
    return call({ action: 'desk_reply', id: t.id, m: entry.text, mid: entry.mid, after: t.lastN }, 15000).then(res => {
      if (res && res.ok === true) {
        const i = t.pending.indexOf(entry);
        if (i > -1) t.pending.splice(i, 1);
        mergeMessages(t, res.messages || []);
        if (t.meta.st === 'Closed') t.meta.st = 'Open'; // the script reopens a closed chat when you write in it
        if (state.open === t) { drawThread(true); drawHead(); }
        syncListRow(t);
        return;
      }
      entry.failed = true;
      const e = res && res.error;
      entry.reason = e === 'limit' ? 'This chat is full' : e === 'unknown' ? 'This chat no longer exists' : 'Not sent';
      if (state.open === t) drawThread(true);
    }).catch(err => {
      if (isAuth(err)) return;
      entry.failed = true;
      entry.reason = 'Not sent';
      if (state.open === t) drawThread(true);
    });
  }

  /* ---------- Enquiries ---------- */
  function enqMatches(r, key) {
    if (key === 'new') return r.st === 'New';
    if (key === 'work') return r.st === 'Replied' || r.st === 'Quoted';
    if (key === 'done') return r.st === 'Won' || r.st === 'Lost';
    if (key === 'spam') return r.st === 'Possible spam';
    return true;
  }
  function loadEnquiries() {
    return call({ action: 'desk_enq' }, 15000).then(res => {
      if (!res || res.ok !== true) throw new Error('bad');
      setNet(true);
      state.enq = Array.isArray(res.items) ? res.items : [];
      if (state.expand && state.enq.some(r => r.ref === state.expand)) {
        const hit = state.enq.find(r => r.ref === state.expand);
        state.enqFilter = ENQ_FILTERS.map(f => f[0]).find(k => enqMatches(hit, k)) || state.enqFilter;
      }
      drawFilters();
      renderEnq();
    }).catch(err => {
      if (!isAuth(err)) setNet(false);
    });
  }

  function renderEnq() {
    const box = ui.enqList;
    if (!box) return;
    if (state.editing && box.contains(document.activeElement) && state.enq !== null) return; // do not pull the form away while it is being used
    box.textContent = '';
    if (state.enq === null) {
      const s = el('p', 'cd-state');
      s.appendChild(el('span', 'cd-spin'));
      s.appendChild(document.createTextNode('Loading enquiries…'));
      box.appendChild(s);
      return;
    }
    const rows = state.enq.filter(r => enqMatches(r, state.enqFilter));
    if (!rows.length) {
      const text = state.enqFilter === 'new' ? 'No new enquiries. Enquiries left on the website appear here.'
        : state.enqFilter === 'work' ? 'Nothing in progress.' : state.enqFilter === 'done' ? 'Nothing won or lost yet.' : 'Nothing is marked as spam.';
      box.appendChild(el('p', 'cd-state', text));
      return;
    }
    rows.forEach(r => box.appendChild(enquiryCard(r)));
  }

  function enquiryCard(r) {
    const card = el('article', 'cd-card' + (r.st === 'New' ? ' fresh' : ''));
    card.id = 'enq-' + r.ref;
    const head = el('div', 'cd-card-head');
    head.appendChild(el('span', 'cd-ref', r.ref));
    head.appendChild(el('span', 'cd-pill st-' + r.st.toLowerCase().replace(/[^a-z]+/g, '-'), r.st === 'Possible spam' ? 'Spam?' : r.st));
    card.appendChild(head);
    const title = [r.name, r.company].filter(Boolean).join(', ') + (r.country ? ' (' + r.country + ')' : '');
    card.appendChild(el('h3', 'cd-card-title', title || 'Visitor'));
    if (r.product || r.qty) card.appendChild(el('p', 'cd-card-line', [r.product, r.qty].filter(Boolean).join(' · ')));
    if (r.message) card.appendChild(el('p', 'cd-card-msg', r.message));
    if (r.basket) card.appendChild(el('p', 'cd-card-small', 'RFQ list: ' + r.basket));
    const small = [r.at ? r.at + ' IST' : '', r.source, r.page].filter(Boolean).join(' · ');
    if (small) card.appendChild(el('p', 'cd-card-small', small));
    const contactLine = [r.email, r.phone].filter(Boolean).join(' · ');
    if (contactLine) card.appendChild(el('p', 'cd-card-small', contactLine));
    if (r.email) card.appendChild(linkRow(r.email, r.name));
    if (r.phone) card.appendChild(linkRow(r.phone, r.name));
    if (r.next) card.appendChild(el('p', 'cd-card-next', 'Next step: ' + r.next));
    if (r.notes) card.appendChild(el('p', 'cd-card-small', 'Notes: ' + r.notes));

    const edit = el('details', 'cd-edit');
    if (state.expand === r.ref) { edit.open = true; }
    edit.appendChild(el('summary', '', 'Update status, next step and notes'));
    const form = el('form', 'cd-editform');
    const f1 = el('div', 'field');
    const l1 = el('label', '', 'Status');
    l1.setAttribute('for', 'st-' + r.ref);
    const sel = el('select');
    sel.id = 'st-' + r.ref;
    ENQ_STATUSES.forEach(s => {
      const o = el('option', '', s === 'Possible spam' ? 'Spam?' : s);
      o.value = s;
      if (s === r.st) o.selected = true;
      sel.appendChild(o);
    });
    f1.appendChild(l1);
    f1.appendChild(sel);
    const f2 = el('div', 'field');
    const l2 = el('label', '', 'Next step');
    l2.setAttribute('for', 'nx-' + r.ref);
    const next = el('input');
    next.id = 'nx-' + r.ref;
    next.type = 'text';
    next.maxLength = 300;
    next.value = r.next || '';
    f2.appendChild(l2);
    f2.appendChild(next);
    const f3 = el('div', 'field');
    const l3 = el('label', '', 'Private notes');
    l3.setAttribute('for', 'nt-' + r.ref);
    const notes = el('textarea');
    notes.id = 'nt-' + r.ref;
    notes.rows = 3;
    notes.maxLength = 2000;
    notes.value = r.notes || '';
    f3.appendChild(l3);
    f3.appendChild(notes);
    const row = el('div', 'cd-noterow');
    const save = el('button', 'btn dark small');
    save.type = 'submit';
    save.textContent = 'Save';
    const msg = el('span', 'cd-saved', '');
    msg.setAttribute('role', 'status');
    row.appendChild(save);
    row.appendChild(msg);
    form.appendChild(f1);
    form.appendChild(f2);
    form.appendChild(f3);
    form.appendChild(row);
    edit.appendChild(form);
    card.appendChild(edit);

    form.addEventListener('input', () => { state.editing = r.ref; });
    edit.addEventListener('toggle', () => { if (!edit.open && state.editing === r.ref) state.editing = ''; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      save.disabled = true;
      msg.textContent = 'Saving…';
      call({ action: 'desk_enq_set', ref: r.ref, status: sel.value, next: next.value, note: notes.value }, 15000).then(res => {
        if (res && res.ok === true) {
          r.st = sel.value;
          r.next = next.value;
          r.notes = notes.value;
          state.editing = '';
          msg.textContent = 'Saved';
          ping(); // counts and the other lists follow
          setTimeout(() => { state.expand = r.ref; renderEnq(); drawFilters(); }, 600);
        } else {
          msg.textContent = 'Not saved. Try again.';
          save.disabled = false;
        }
      }).catch(err => {
        if (isAuth(err)) return;
        msg.textContent = 'Not saved. Try again.';
        save.disabled = false;
      });
    });
    return card;
  }

  /* ---------- Page events ---------- */
  // Browsers only allow sound after a tap or key press, so the first one of either unlocks it.
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!state.session || !ui.list) return;
    if (!document.hidden) {
      ping();
      if (state.open) { clearTimeout(threadTimer); pollThread(); }
    }
  });
  window.addEventListener('pagehide', () => {
    if (!state.session) return;
    try { fetch(API.url({ action: 'desk_ping', s: state.session, online: '0' }), { keepalive: true, mode: 'no-cors', credentials: 'omit' }); } catch (err) { /* it expires by itself in a minute */ }
  });
  window.addEventListener('online', () => { if (state.session) ping(); });

  /* On a phone the page follows the visible area, so the reply box stays above the keyboard. */
  function fitViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    root.style.top = Math.round(vv.offsetTop) + 'px';
    root.style.height = Math.round(vv.height) + 'px';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
    fitViewport();
  }
  window.addEventListener('hashchange', () => {
    if (!state.session || !ui.list) return;
    parseWant();
    if (state.want && state.want.type === 'chat') openChat(state.want.id);
    if (state.want && state.want.type === 'enq') { selectTab('enq'); if (state.enq !== null) loadEnquiries(); }
    state.want = null;
  });

  /* ---------- Start ---------- */
  loadPrefs();
  if (state.session) startApp(); else showLogin('');
})();
