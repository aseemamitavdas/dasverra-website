(() => {
  'use strict';

  /* Shared by the visitor chat (chat.js) and the chat desk (chatdesk.js).
     Every call is a plain GET to the Google Apps Script web app, answered with JSON. A GET is used because the website can read
     its answer (a form post cannot be read from another site), and because it is the same kind of call the Trade Board and
     Track already make. Nothing is cached, nothing is sent with cookies. */
  if (window.DVChatAPI) return;

  const endpoint = () => (window.DVCONF && window.DVCONF.formEndpoint) || '';

  /* A lone half of an emoji (a pair cut in two, or pasted broken) makes encodeURIComponent throw. It is replaced by the
     replacement character, which is what a browser would show for it anyway. */
  function wellFormed(value) {
    return String(value)
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
      .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1\uFFFD');
  }

  function urlFor(params) {
    const base = endpoint();
    if (!base) return '';
    const qs = Object.keys(params)
      .filter(k => params[k] !== undefined && params[k] !== null)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(wellFormed(params[k])))
      .join('&');
    return base + (base.indexOf('?') === -1 ? '?' : '&') + qs;
  }

  function viaFetch(url, ms) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no-fetch'));
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(res => {
        if (!res.ok) throw new Error('http-' + res.status);
        return res.text();
      })
      .then(text => {
        try { return JSON.parse(text); } catch (err) { throw new Error('not-json'); }
      })
      .then(
        data => { if (timer) clearTimeout(timer); return data; },
        err => {
          if (timer) clearTimeout(timer);
          if (err && err.name === 'AbortError') throw new Error('timeout');
          throw err;
        }
      );
  }

  function viaJsonp(url, ms) {
    return new Promise((resolve, reject) => {
      const name = 'dvchat_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
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

  /* One GET. When the browser cannot read the answer (a restrictive network), the same call is made as a script tag.
     A slow answer is not retried that way, and neither is an endpoint that answers with something other than JSON
     (an older script without chat): both are reported as they are. */
  function call(params, ms) {
    const url = urlFor(params);
    if (!url) return Promise.reject(new Error('no-endpoint'));
    const limit = ms || 10000;
    return viaFetch(url, limit).catch(err => {
      const m = err && err.message;
      if (m === 'timeout' || m === 'not-json' || /^http-/.test(m || '')) throw err;
      return viaJsonp(url, limit);
    });
  }

  /* Why a call failed, in words the screens can use. */
  function failure(err) {
    const m = (err && err.message) || '';
    if (m === 'not-json' || /^http-4/.test(m)) return 'unsupported';
    if (m === 'timeout') return 'slow';
    if (m === 'no-endpoint') return 'unsupported';
    return 'offline';
  }

  /* Length of text once it is part of a web address. Google's servers take long addresses, but a few kilobytes is the
     most that every browser and network is sure to pass, and non-Latin text grows to nine characters per letter. */
  const encLen = s => encodeURIComponent(wellFormed(s)).length;

  /* Index of the last space or line break before position "cut", or -1. */
  function breakBefore(s, cut) {
    for (let i = cut - 1; i > 0; i--) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 10) return i;
    }
    return -1;
  }

  /* Cuts a long text into parts whose encoded length stays under "limit", at a space or line break where one is close. */
  function split(text, limit) {
    const out = [];
    let rest = String(text || '').trim();
    while (rest) {
      if (encLen(rest) <= limit) { out.push(rest); break; }
      let lo = 1;
      let hi = rest.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (encLen(rest.slice(0, mid)) <= limit) lo = mid; else hi = mid - 1;
      }
      let cut = lo;
      const last = rest.charCodeAt(cut - 1);
      if (cut > 1 && last >= 0xD800 && last <= 0xDBFF) cut -= 1; // never cut a character in half
      const space = breakBefore(rest, cut);
      if (space > cut * 0.6) cut = space + 1;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return out;
  }

  /* A text cut into messages that each stay within "maxChars" characters (the script's limit for one message) and within
     "budget" encoded characters (one call). Nothing is dropped; cuts fall at a space or line break where one is close.
     The cut by characters comes first, so a long message becomes a few full messages rather than many odd-sized ones. */
  function splitMessage(text, maxChars, budget) {
    const pieces = [];
    let rest = String(text || '').trim();
    while (rest.length > maxChars) {
      let cut = maxChars;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
      const space = breakBefore(rest, cut);
      if (space > cut * 0.6) cut = space + 1;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
    const out = [];
    pieces.forEach(piece => split(piece, budget).forEach(part => out.push(part)));
    return out;
  }

  /* A short random id. It starts with a letter so a spreadsheet can never read it as a number. */
  function uid(prefix) {
    const bytes = (window.crypto && window.crypto.getRandomValues)
      ? Array.from(window.crypto.getRandomValues(new Uint8Array(8)))
      : [0, 0, 0, 0, 0, 0, 0, 0].map(() => Math.floor(Math.random() * 256));
    return (prefix || 'm') + bytes.map(b => (b % 36).toString(36)).join('');
  }

  window.DVChatAPI = { endpoint, url: urlFor, call, failure, split, splitMessage, encLen, uid };
})();
