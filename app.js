(() => {
  'use strict';

  /* ---------- Settings ----------
     formEndpoint: the Google Apps Script web app URL (ends in /exec).
     While it is empty, applications are handed over through WhatsApp instead. */
  const DV = Object.assign({
    formEndpoint: '',
    whatsapp: '918013906621',
    email: 'aseem.das@dasverra.org'
  }, window.DV_CONFIG || {});

  const ROLE = {
    buyer: { code: 'B', label: 'Buyer' },
    supplier: { code: 'S', label: 'Supplier' },
    forwarder: { code: 'F', label: 'Freight forwarder' },
    partner: { code: 'P', label: 'Partner' }
  };
  const openedAt = Date.now();
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const scrollMode = reduceMotion ? 'auto' : 'smooth';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  $$('[data-year]').forEach(el => { el.textContent = String(new Date().getFullYear()); });

  /* ---------- Mobile menu ---------- */
  const menuBtn = $('.menu-toggle');
  const navLinks = $('#nav-links');
  const closeMenu = () => {
    if (!menuBtn || !navLinks) return;
    menuBtn.setAttribute('aria-expanded', 'false');
    navLinks.classList.remove('open');
  };
  if (menuBtn && navLinks) {
    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') === 'true';
      menuBtn.setAttribute('aria-expanded', String(!open));
      navLinks.classList.toggle('open', !open);
    });
    navLinks.addEventListener('click', e => { if (e.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && menuBtn.getAttribute('aria-expanded') === 'true') { closeMenu(); menuBtn.focus(); }
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 1220) closeMenu(); });
  }

  /* ---------- Role tabs ---------- */
  const tabs = $$('.tab[role="tab"]');
  function selectRole(role, focusTab) {
    if (!ROLE[role]) return;
    tabs.forEach(tab => {
      const on = tab.dataset.role === role;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
      if (on && focusTab) tab.focus();
    });
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectRole(tab.dataset.role));
    tab.addEventListener('keydown', e => {
      const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(e.key in moves)) return;
      e.preventDefault();
      const j = (moves[e.key] + tabs.length) % tabs.length;
      selectRole(tabs[j].dataset.role, true);
    });
  });
  $$('[data-apply]').forEach(link => link.addEventListener('click', () => selectRole(link.dataset.apply)));

  function applyHash(smooth) {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!ROLE[h] || !tabs.length) return;
    selectRole(h);
    const target = $('#onboard');
    if (target) target.scrollIntoView({ behavior: smooth ? scrollMode : 'auto' });
  }
  applyHash(false);
  window.addEventListener('hashchange', () => applyHash(true));

  /* ---------- Copy helpers ---------- */
  function flash(btn, message) {
    const label = $('[data-text]', btn) || btn;
    if (!btn.dataset.original) btn.dataset.original = label.textContent;
    label.textContent = message;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => { label.textContent = btn.dataset.original; }, 2000);
  }
  function selectContents(el) {
    if (!el) return;
    if (typeof el.select === 'function') { el.focus(); el.select(); return; }
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  async function copyText(text, btn, fallbackEl) {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (err) {
      ok = false;
    }
    if (!ok) selectContents(fallbackEl);
    if (btn) flash(btn, ok ? 'Copied' : 'Selected, press Ctrl+C');
  }
  $$('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.contact-item');
      copyText(btn.dataset.copy, btn, item ? $('.contact-value', item) : null);
    });
  });

  /* ---------- Validation ---------- */
  function controlOf(field) {
    return $('input:not([type="hidden"]), select, textarea', field);
  }
  function showError(field, message) {
    const msg = $('.err-msg', field);
    if (msg) { msg.textContent = message; msg.hidden = false; }
    const chips = $('.chips', field);
    if (chips) { chips.classList.add('invalid'); return; }
    const control = controlOf(field);
    if (control) control.setAttribute('aria-invalid', 'true');
  }
  function clearError(field) {
    const msg = $('.err-msg', field);
    if (msg) { msg.textContent = ''; msg.hidden = true; }
    const chips = $('.chips', field);
    if (chips) chips.classList.remove('invalid');
    $$('[aria-invalid]', field).forEach(el => el.removeAttribute('aria-invalid'));
  }
  function messageFor(control) {
    const v = control.validity;
    if (v.valueMissing) {
      if (control.type === 'checkbox') return 'Please tick this box to continue.';
      if (control.tagName === 'SELECT') return 'Choose an option.';
      return 'This field is required.';
    }
    if (v.typeMismatch && control.type === 'email') return 'Enter a valid email address, like name@company.com.';
    if (v.patternMismatch) return control.dataset.patternMsg || 'Check the format of this field.';
    if (v.tooLong) return 'This entry is too long.';
    return control.validationMessage || 'Check this field.';
  }
  function validateField(field) {
    const chips = $('.chips[data-required]', field);
    if (chips) {
      if (!$('input:checked', chips)) { showError(field, 'Choose at least one option.'); return false; }
      clearError(field);
      return true;
    }
    const control = controlOf(field);
    if (!control) return true;
    if (!control.checkValidity()) { showError(field, messageFor(control)); return false; }
    clearError(field);
    return true;
  }
  function validateForm(form) {
    let firstBad = null;
    $$('.field', form).forEach(field => {
      if (!validateField(field) && !firstBad) firstBad = field;
    });
    if (!firstBad) return true;
    firstBad.scrollIntoView({ block: 'center', behavior: scrollMode });
    const control = controlOf(firstBad);
    if (control) control.focus({ preventScroll: true });
    return false;
  }
  function revalidate(e) {
    const field = e.target.closest('.field');
    if (!field) return;
    const msg = $('.err-msg', field);
    if (msg && !msg.hidden) validateField(field);
  }

  /* ---------- Submission ---------- */
  function collect(form) {
    const data = {};
    new FormData(form).forEach((value, key) => {
      const v = String(value).trim();
      if (!v) return;
      data[key] = data[key] ? data[key] + ', ' + v : v;
    });
    return data;
  }
  function makeRef(role) {
    const d = new Date();
    const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rnd = (window.crypto && window.crypto.getRandomValues)
      ? Array.from(window.crypto.getRandomValues(new Uint32Array(4)))
      : [0, 0, 0, 0].map(() => Math.floor(Math.random() * 4294967295));
    return 'DV-' + ROLE[role].code + '-' + ymd + '-' + rnd.map(n => alphabet[n % alphabet.length]).join('');
  }
  function buildSummary(form, data) {
    const lines = ['Dasverra onboarding: ' + ROLE[data.role].label + ' application', 'Reference: ' + data.ref, ''];
    $$('.field[data-name]', form).forEach(field => {
      const name = field.dataset.name;
      if (name === 'consent' || !data[name]) return;
      lines.push(field.dataset.label + ': ' + data[name]);
    });
    return lines.join('\n');
  }
  function whatsappUrl(text) {
    const max = 1800;
    const body = text.length > max ? text.slice(0, max - 1) + '…' : text;
    return 'https://wa.me/' + DV.whatsapp + '?text=' + encodeURIComponent(body);
  }
  async function send(data) {
    if (!DV.formEndpoint) return false;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    try {
      await fetch(DV.formEndpoint, {
        method: 'POST',
        mode: 'no-cors',
        body: new URLSearchParams(data),
        signal: ctrl ? ctrl.signal : undefined
      });
      return true;
    } catch (err) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function showResult(panel, form, data, sent) {
    const result = $('.result', panel);
    const slot = name => $('[data-slot="' + name + '"]', result);
    const summary = buildSummary(form, data);

    const badge = slot('badge');
    badge.className = 'result-badge' + (sent ? '' : ' pending');
    badge.textContent = sent ? 'Application received' : 'One more step';
    slot('title').textContent = sent ? 'Thank you. Your application is in.' : 'Send your application to our trade desk';
    slot('body').textContent = sent
      ? 'We have logged it under the reference below and will reply by email or WhatsApp. Keep the reference for any follow-up.'
      : 'Tap the button to send these details on WhatsApp, or copy them and email ' + DV.email + '. Keep the reference for any follow-up.';
    slot('ref').textContent = data.ref;

    const wa = slot('wa');
    wa.href = whatsappUrl(summary);
    wa.className = 'btn ' + (sent ? 'dark' : 'solid');
    slot('wa-label').textContent = sent ? 'Also message us on WhatsApp' : 'Send on WhatsApp';

    $('textarea.summary', result).value = summary;
    slot('summary-wrap').hidden = sent;
    $('[data-action="copy"]', result).hidden = sent;
    $('[data-action="edit"]', result).hidden = sent;

    form.hidden = true;
    result.hidden = false;
    panel.scrollIntoView({ block: 'start', behavior: scrollMode });
    result.focus({ preventScroll: true });
  }

  $$('form.dv-form').forEach(form => {
    const panel = form.closest('[role="tabpanel"]');
    const result = $('.result', panel);
    const submitBtn = $('button[type="submit"]', form);
    const submitLabel = $('[data-text]', submitBtn);
    const summaryBox = $('textarea.summary', result);

    form.addEventListener('input', revalidate);
    form.addEventListener('change', revalidate);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (submitBtn.disabled) return;
      if (!validateForm(form)) return;

      const data = collect(form);
      const isBot = Boolean(data.contact_fax);
      delete data.contact_fax;
      data.role = form.dataset.role;
      data.ref = makeRef(data.role);
      data.page = location.href.split('#')[0];
      data.elapsed_s = String(Math.round((Date.now() - openedAt) / 1000));
      data.submitted_at = new Date().toISOString();

      submitBtn.disabled = true;
      if (submitLabel) submitLabel.textContent = 'Submitting…';
      const sent = isBot ? true : await send(data);
      submitBtn.disabled = false;
      if (submitLabel) submitLabel.textContent = 'Submit application';
      showResult(panel, form, data, sent);
    });

    $('[data-action="copy"]', result).addEventListener('click', e => {
      copyText(summaryBox.value, e.currentTarget, summaryBox);
    });
    $('[data-action="edit"]', result).addEventListener('click', () => {
      result.hidden = true;
      form.hidden = false;
      const first = controlOf(form);
      if (first) first.focus();
    });
    $('[data-action="reset"]', result).addEventListener('click', () => {
      form.reset();
      $$('.field', form).forEach(clearError);
      result.hidden = true;
      form.hidden = false;
      panel.scrollIntoView({ block: 'start', behavior: scrollMode });
    });
  });
})();
