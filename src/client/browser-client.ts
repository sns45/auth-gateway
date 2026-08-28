/**
 * The browser client the gateway serves at /client.js.
 *
 * Onboarding a new site is meant to be two lines, so everything awkward lives
 * here rather than in each client codebase:
 *
 *   <script src="https://auth.in8.sh/client.js"></script>
 *   <script>authGateway.subscribe(function (session) { ... })</script>
 *
 * Three sync mechanisms, because no single one covers every case:
 *
 *   BroadcastChannel  same origin tabs, instant, works while signed out, so
 *                     it is what makes a sign in appear in the other tabs
 *   WebSocket to hub  cross device, the only way a revocation somewhere else
 *                     reaches an idle tab; needs a session to address the hub,
 *                     which is why it cannot cover sign in
 *   visibilitychange  backstop for anything missed while the tab was hidden
 *
 * Events from the hub are invalidation signals, never state, so every path
 * ends in the same place: refetch get-session and trust the answer.
 *
 * Written without template literals so it can live in one here.
 */
export const BROWSER_CLIENT_JS = `(function () {
  'use strict';

  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : window.location.origin;
  var base = origin + '/api/auth';
  var CHANNEL = 'auth-gateway';

  var listeners = [];
  var session = undefined;
  var socket = null;
  var retry = 0;
  var closed = false;
  var channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](session); } catch (error) { console.error('[auth-gateway]', error); }
    }
  }

  function sameSession(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.session && b.session && a.session.id === b.session.id;
  }

  function refresh() {
    return fetch(base + '/get-session', {
      credentials: 'include',
      headers: { accept: 'application/json' }
    })
      .then(function (response) { return response.ok ? response.json() : null; })
      .catch(function () { return session === undefined ? null : session; })
      .then(function (next) {
        var changed = session === undefined || !sameSession(session, next);
        session = next || null;
        if (changed) { emit(); connect(); }
        return session;
      });
  }

  // Only an authenticated tab can open the hub connection: it is addressed by
  // user id, which the gateway resolves from the session cookie.
  function connect() {
    if (!session) { disconnect(); return; }
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;

    var url = origin.replace(/^http/, 'ws') + '/api/auth/session-stream';
    try { socket = new WebSocket(url); } catch (error) { return; }

    socket.onopen = function () { retry = 0; };
    socket.onmessage = function (event) { if (event.data !== 'pong') refresh(); };
    socket.onclose = function () {
      socket = null;
      if (closed || !session) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.pow(2, retry) * 250 + Math.random() * 250);
    };
    socket.onerror = function () { if (socket) socket.close(); };
  }

  function disconnect() {
    if (!socket) return;
    var open = socket;
    socket = null;
    try { open.close(1000); } catch (error) { /* already gone */ }
  }

  function announce() {
    if (channel) channel.postMessage({ at: Date.now() });
  }

  if (channel) channel.onmessage = function () { refresh(); };

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });

  window.addEventListener('pagehide', function () { closed = true; disconnect(); });

  var api = {
    /** Current session, or null. Undefined until the first fetch resolves. */
    get session() { return session; },

    /** Called immediately with the current session, then on every change. */
    subscribe: function (listener) {
      listeners.push(listener);
      if (session !== undefined) listener(session);
      return function () { listeners = listeners.filter(function (l) { return l !== listener; }); };
    },

    signIn: function (provider, options) {
      var settings = options || {};
      var target = settings.callbackURL || window.location.href;
      return fetch(base + '/sign-in/social', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: provider || 'google', callbackURL: target })
      })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          if (body && body.url) window.location.href = body.url;
          return body;
        });
    },

    signOut: function () {
      // Better Auth rejects this without a JSON content type and a body: a
      // bodyless fetch sends no content type at all and comes back 415.
      return fetch(base + '/sign-out', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }).then(function () { announce(); return refresh(); });
    },

    refresh: refresh
  };

  window.authGateway = api;
  refresh();
})();
`;
