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
 *   poll on a timer   cross device, the only way a revocation somewhere else
 *                     reaches a tab the user is not touching; see
 *                     SESSION_POLL_INTERVAL_MS below for the trade off
 *   visibilitychange  a tab the user comes back to corrects at once, without
 *                     waiting for the next tick
 *
 * This used to hold a WebSocket to a per user Durable Object, which pushed the
 * same invalidation in under a second. Durable Objects require Workers Paid,
 * and the gateway runs on the free plan, so the push became a pull. What did
 * not change is that no session state ever crosses the wire: every path ends
 * in the same place, refetch get-session and trust the answer, so a sign out on
 * one device still cannot sign the others out.
 *
 * Written without template literals so it can live in one here.
 */
export const BROWSER_CLIENT_JS = `(function () {
  'use strict';

  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : window.location.origin;
  var base = origin + '/api/auth';
  var CHANNEL = 'auth-gateway';

  // How long a revoked session can still look live in a tab nobody is
  // touching. Shorter spends more of the Workers free tier daily request
  // budget, which one continuously visible tab draws on at 86400 / this many
  // seconds per day; longer leaves a stale session on screen for longer. A tab
  // the user returns to does not wait for it: visibilitychange refetches at
  // once. Revocation itself is still immediate, because D1 is the authority
  // and every request re-reads it; this only bounds how long an idle tab takes
  // to notice.
  var SESSION_POLL_INTERVAL_MS = 30000;

  var listeners = [];
  var session = undefined;
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
        if (changed) emit();
        return session;
      });
  }

  function announce() {
    if (channel) channel.postMessage({ at: Date.now() });
  }

  if (channel) channel.onmessage = function () { refresh(); };

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });

  // Only a visible tab polls. A hidden one is not being read, and it refetches
  // the moment it is shown again, so ticking in the background would spend the
  // request budget to correct a screen nobody is looking at.
  var poll = setInterval(function () {
    if (closed) return;
    if (document.visibilityState === 'visible') refresh();
  }, SESSION_POLL_INTERVAL_MS);

  window.addEventListener('pagehide', function () {
    closed = true;
    clearInterval(poll);
  });

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
