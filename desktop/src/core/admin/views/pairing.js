// templates/pairing.html: a fresh single-use pairing code.

'use strict';

const { html } = require('../html');
const { base } = require('./base');

/** @param {object} page path, refresh, code, ttlS, serverName */
function pairing(page) {
  const { ttlS } = page;
  const body = html`
<section class="panel">
  <div class="panel-head"><h1 class="eyebrow eyebrow-bar">Pairing code</h1></div>
  <p class="lede">On the R1: Settings → Desktop server, enter this code. It works once and expires in ${ttlS >= 60 ? Math.floor(ttlS / 60) : ttlS} ${ttlS >= 60 ? 'minutes' : 'seconds'}.</p>
  <p class="code">${page.code}</p>
  <p class="caption">Server name: ${page.serverName}</p>
  <div class="button-row"><a class="btn btn-secondary" href="/admin/devices#paired">Back to Devices</a></div>
</section>
`;
  return base({ path: page.path, refresh: page.refresh, title: 'Pairing code — R1CORD Server', body });
}

module.exports = { pairing };
