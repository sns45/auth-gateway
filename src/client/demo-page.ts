/**
 * A live integration example, served at /demo.
 *
 * It exists for three reasons, in order of how often they matter:
 *
 *   1. It is the fastest way to verify a deployment by hand. Open it in two
 *      tabs, sign out in one, and watch the other flip without a reload.
 *   2. It is the shortest honest answer to "how do I integrate this": the page
 *      source is the integration, and it is the same two lines the README
 *      claims.
 *   3. An OAuth flow has to be started from a browser, because Better Auth
 *      keeps the state in a cookie as well as in the database. A curl minted
 *      sign in URL always fails with state_mismatch.
 *
 * It has no privileges of its own; everything it does goes through the public
 * client at /client.js.
 */
export const DEMO_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Auth Gateway demo</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 2.5rem 1.5rem; background: #0b0b0c; color: #e8e8ea;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
  p.lede { margin: 0 0 2rem; color: #9b9ba1; }
  section { border: 1px solid #232327; border-radius: 10px; padding: 1.15rem 1.25rem; margin-bottom: 1.15rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .09em; color: #8a8a92; margin: 0 0 .85rem; font-weight: 600; }
  .status { display: flex; align-items: center; gap: .6rem; font-size: 1.05rem; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b6b73; flex: none; }
  .dot.on { background: #4ade80; }
  button {
    font: inherit; padding: .5rem 1rem; border-radius: 7px; cursor: pointer;
    border: 1px solid #2f2f35; background: #17171a; color: #e8e8ea;
  }
  button:hover { background: #1f1f24; }
  button.primary { background: #e8e8ea; color: #0b0b0c; border-color: #e8e8ea; }
  .row { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: 1rem; }
  pre {
    margin: 0; padding: .85rem; background: #121215; border-radius: 7px;
    overflow-x: auto; font-size: 12.5px; color: #c8c8d0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #log { max-height: 15rem; overflow-y: auto; }
  #log div { padding: .2rem 0; border-bottom: 1px solid #1a1a1e; }
  #log div:last-child { border-bottom: 0; }
  .t { color: #6b6b73; }
  code { background: #17171a; padding: .1rem .35rem; border-radius: 4px; font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <h1>Auth Gateway demo</h1>
  <p class="lede">
    Open this page in two tabs. Sign in on one, and the other follows without a
    reload. Sign out on either, and both drop at once.
  </p>

  <section>
    <h2>Session</h2>
    <div class="status"><span class="dot" id="dot"></span><span id="who">checking…</span></div>
    <div class="row">
      <button class="primary" id="in">Sign in with Google</button>
      <button id="out">Sign out</button>
      <button id="ref">Refresh</button>
    </div>
  </section>

  <section>
    <h2>Live events</h2>
    <div id="log"><div class="t">waiting…</div></div>
  </section>

  <section>
    <h2>Raw session</h2>
    <pre id="raw">null</pre>
  </section>

  <section>
    <h2>The whole integration</h2>
    <pre>&lt;script src="/client.js"&gt;&lt;/script&gt;
&lt;script&gt;
  authGateway.subscribe(function (session) {
    render(session ? session.user : null);
  });
&lt;/script&gt;</pre>
  </section>
</main>

<script src="/client.js"></script>
<script>
  var log = document.getElementById('log');
  var first = true;
  function say(message) {
    if (first) { log.innerHTML = ''; first = false; }
    var line = document.createElement('div');
    var at = new Date().toLocaleTimeString();
    line.innerHTML = '<span class="t">' + at + '</span>  ' + message;
    log.prepend(line);
  }

  authGateway.subscribe(function (session) {
    document.getElementById('dot').className = 'dot' + (session ? ' on' : '');
    document.getElementById('who').textContent = session
      ? (session.user.name || session.user.email)
      : 'signed out';
    document.getElementById('raw').textContent = JSON.stringify(session, null, 2);
    say(session ? 'session active: ' + session.user.email : 'no session');
  });

  document.getElementById('in').onclick = function () {
    say('starting google sign in…');
    authGateway.signIn('google', { callbackURL: window.location.href });
  };
  document.getElementById('out').onclick = function () {
    say('signing out…');
    authGateway.signOut();
  };
  document.getElementById('ref').onclick = function () {
    say('refetching…');
    authGateway.refresh();
  };
</script>
</body>
</html>
`;
