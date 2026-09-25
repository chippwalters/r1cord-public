// templates/base.html: the page shell, the nav with the current section marked, and the
// data-busy script every page shares.

'use strict';

const { html, raw } = require('../html');

function active(on) {
  return on ? raw('class="active"') : '';
}

/**
 * @param {{path: string, refresh?: boolean, title: string|import('../html').SafeString,
 *   body: import('../html').SafeString, scripts?: import('../html').SafeString|string,
 *   refreshBlock?: import('../html').SafeString|string}} page
 */
function base({ path, refresh = false, title, body, scripts = '', refreshBlock }) {
  const refreshMeta = refreshBlock !== undefined ? refreshBlock : refresh ? html`<meta http-equiv="refresh" content="5">` : '';
  const recordings = path === '/admin' || path.startsWith('/admin/jobs') || path.startsWith('/admin/recordings') || path === '/admin/import';
  const devices = path.startsWith('/admin/devices') || path === '/admin/pair';
  const settings = path === '/admin/config' || path === '/admin/republish';
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refreshMeta}
  <title>${title}</title>
  <link rel="stylesheet" href="/static/admin.css">
  <link rel="icon" type="image/png" href="/static/favicon-64.png">
</head>
<body>
  
  <header class="top">
    <a class="brand" href="/admin" aria-label="R1CORD Server — recordings">
      <img class="brand-mark" src="/static/r1cord-logomark.svg" alt="">
      <img class="brand-type" src="/static/r1cord-logotype.svg" alt="R1CORD">
      <span class="brand-tag">Server</span>
    </a>
    <nav>
      <a href="/admin" ${active(recordings)}>Recordings</a>
      <a href="/admin/devices" ${active(devices)}>Devices</a>
      <a href="/admin/config" ${active(settings)}>Settings</a>
      <a href="/admin/system" ${active(path === '/admin/system')}>System</a>
    </nav>
  </header>
  <main>
    ${body}
  </main>
  <script>
  // Forms marked data-busy: the pressed button shows a spinner and "Working…" until the next page
  // loads, and further clicks are ignored. Disabling waits a tick so the pressed button's own
  // name/value is still submitted.
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.matches("form[data-busy]")) return;
    const button = event.submitter || form.querySelector("button[type=submit], button:not([type])");
    setTimeout(() => {
      form.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      if (button) {
        button.classList.add("is-busy");
        button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Working…';
      }
    }, 0);
  });
  </script>
  ${scripts}
</body>
</html>`;
}

module.exports = { base };
