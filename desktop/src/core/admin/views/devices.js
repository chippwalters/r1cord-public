// templates/devices.html: USB mode, Wi-Fi pairing, connected and adopted R1s.

'use strict';

const { html } = require('../html');
const { humanSize, localtimeFilter, roundOne } = require('../format');
const { base } = require('./base');

function tokenLabel(t) {
  return t.label !== '' && t.label !== 'device' ? t.label : 'R1';
}

const PLATFORM_TOOLS_LICENSE = 'https://developer.android.com/studio/releases/platform-tools';
const TOOLS_PHASES = { extracting: 'Extracting', verifying: 'Checking the signature of', installing: 'Installing' };

function toolsProgress(tools) {
  if (tools.phase !== 'downloading') return html`${TOOLS_PHASES[tools.phase] || 'Installing'} the Android platform tools…`;
  const total = tools.total ? html` of ${humanSize(tools.total)}` : '';
  return html`Downloading the Android platform tools · ${humanSize(tools.received)}${total}…`;
}

// Offered only while no adb is found; the running download and the last outcome stay visible.
function adbDownload(usb, tools, local) {
  if (!tools) return '';
  const missing = usb.adb === 'not found';
  if (!missing && !tools.active && !tools.error && !tools.done) return '';
  const offer = missing && !tools.active;
  const button = local
    ? html`<form method="post" action="/admin/devices/platform-tools"><button type="submit" class="btn btn-primary">Download Android platform tools</button></form>`
    : html`<p class="caption">Open this page on the server PC to download adb.</p>`;
  return html`
  ${tools.active ? html`<p class="banner banner-work">${toolsProgress(tools)}</p>` : ''}
  ${tools.error ? html`<p class="banner banner-bad">Platform tools download failed: ${tools.error}</p>` : ''}
  ${tools.done ? html`<p class="banner banner-ok">Android platform tools installed at ${tools.done}</p>` : ''}
  ${offer
    ? html`<div class="button-row">${button}</div>
  <p class="caption">From Google (dl.google.com, about 7 MB), under the <a href="${PLATFORM_TOOLS_LICENSE}" target="_blank" rel="noopener">Android SDK Platform-Tools license</a></p>`
    : ''}`;
}

function usbPanel(config, usb, tools, local) {
  return html`<section class="panel">
  <div class="panel-head">
    <h1 class="eyebrow eyebrow-bar">USB mode</h1>
    <span class="pill ${usb.enabled ? 'pill-ok' : 'pill-idle'}">${usb.enabled ? 'On' : 'Off'}</span>
  </div>
  <p class="lede">${
    usb.enabled
      ? html`Plug in an adopted R1 and every finished recording is copied here and processed as <strong>${config.usb_auto_action}</strong>. Nothing on the R1 is changed or deleted.`
      : 'Off — nothing is watched or copied. Recordings arrive only when you press Send on the R1.'
  }</p>
  ${usb.syncing ? html`<p class="banner banner-work">Copying ${usb.syncing}…</p>` : ''}
  ${usb.last_error ? html`<p class="banner banner-bad">${usb.last_error}</p>` : ''}
  <div class="button-row">
    <form method="post" action="/admin/usb/toggle"><button type="submit" class="btn ${usb.enabled ? 'btn-secondary' : 'btn-primary'}">${usb.enabled ? 'Turn USB mode off' : 'Turn USB mode on'}</button></form>
    ${usb.enabled ? html`<form method="post" action="/admin/usb/poll"><button type="submit" class="btn btn-secondary">Check now</button></form>` : ''}
  </div>
  <p class="caption">adb: ${usb.adb} · change the action for new recordings in <a href="/admin/config">Settings</a> · turn USB mode off before any mtkclient / fastboot work</p>
  ${adbDownload(usb, tools, local)}
</section>`;
}

function pairingPanel(paired, revoked) {
  const pairedTable = paired.length
    ? html`
  <table class="compact">
    <thead><tr><th>Paired device</th><th>Paired</th><th>Last used</th><th></th></tr></thead>
    <tbody>
    ${paired.map(
      (t) => html`
      <tr>
        <td>${tokenLabel(t)} <span class="rec-id rec-id-inline">key #${t.id}</span></td>
        <td class="mono-cell">${localtimeFilter(t.createdAt)}</td>
        <td class="mono-cell">${localtimeFilter(t.lastUsedAt)}</td>
        <td class="actions"><form method="post" action="/admin/tokens/${t.id}/revoke"><button type="submit" class="btn btn-danger btn-small">Revoke</button></form></td>
      </tr>
    `,
    )}
    </tbody>
  </table>
  `
    : html`
  <p class="empty">No R1 is paired for Wi-Fi yet.</p>
  `;
  const revokedFold = revoked.length
    ? html`
  <details class="fold">
    <summary>Revoked (${revoked.length})</summary>
    <table class="compact">
      <tbody>
      ${revoked.map(
        (t) => html`
        <tr><td>${tokenLabel(t)} <span class="rec-id rec-id-inline">key #${t.id}</span></td><td class="mono-cell">paired ${localtimeFilter(t.createdAt)}</td><td class="mono-cell">last used ${localtimeFilter(t.lastUsedAt)}</td></tr>
      `,
      )}
      </tbody>
    </table>
  </details>
  `
    : '';
  return html`<section class="panel" id="paired">
  <div class="panel-head">
    <h2 class="eyebrow eyebrow-bar">Wi-Fi pairing</h2>
    <form method="post" action="/admin/pair"><button type="submit" class="btn btn-primary btn-small">Generate pairing code</button></form>
  </div>
  <p class="lede">To Send over Wi-Fi, an R1 pairs once: generate a code here and enter it on the R1 under Settings → Desktop server. Each paired R1 gets its own key. Revoke it if the device is lost; the R1 then has to pair again.</p>
  ${pairedTable}
  ${revokedFold}
</section>`;
}

function unknownPanel(unknown) {
  if (!unknown.length) return '';
  return html`
<section class="panel">
  <div class="panel-head"><h2 class="eyebrow eyebrow-bar">Connected, not adopted</h2></div>
  <table class="compact">
    <thead><tr><th>Serial</th><th>Model</th><th></th></tr></thead>
    <tbody>
    ${unknown.map(
      (d) => html`
    <tr>
      <td class="path">${d.serial}</td>
      <td>${d.model || '—'}</td>
      <td class="actions">
        <form method="post" action="/admin/devices/${d.serial}/adopt"><button type="submit" class="btn btn-primary btn-small">Adopt</button></form>
      </td>
    </tr>
    `,
    )}
    </tbody>
  </table>
  <p class="caption">Nothing is pulled from a device until it is adopted.</p>
</section>
`;
}

function recordingRow(d, r, actions) {
  const job = r.latestJob;
  const jobCell = job
    ? html`
        <a href="/admin/jobs/${job.jobId}">${job.status}</a>
        ${job.status === 'complete' && job.publish && job.webdavUrl ? html`
        · <a href="${job.webdavUrl}">page</a>
        ` : ''}
        `
    : html`<span class="muted">none</span>`;
  const canProcess = r.pulledAt && r.deviceStatus === 'SAVED' && !(job && !['complete', 'error'].includes(job.status));
  const processForm = canProcess
    ? html`
        <form method="post" action="/admin/devices/${d.info.serial}/recordings/${r.recordingId}/process" class="inline-form">
          <select name="action">
            ${actions.map((a) => html`<option value="${a}">${a}</option>`)}
          </select>
          <button type="submit" class="btn btn-secondary btn-small">${job ? 'Re-process' : 'Process'}</button>
        </form>
        `
    : '';
  return html`
    <tr>
      <td class="path">${r.recordingId}</td>
      <td>${r.title || '—'}</td>
      <td>${r.deviceStatus}</td>
      <td>${r.pulledAt ? html`${r.fileCount} files · ${roundOne(r.bytes / 1048576)} MB` : html`<span class="muted">not yet</span>`}</td>
      <td>
        ${jobCell}
      </td>
      <td>
        ${r.changedSinceJob ? html`<span class="warn">changed since job</span>` : ''}
        ${r.flag === 'audio_mismatch' ? html`<span class="error">audio differs from inbox</span>` : ''}
        ${r.flag === 'pull_failed' ? html`<span class="error">pull failed</span>` : ''}
        ${r.flag === 'process_failed' ? html`<span class="error">could not queue</span>` : ''}
        ${r.deviceStatus === 'INTERRUPTED' ? html`<span class="muted">interrupted — archive only</span>` : ''}
      </td>
      <td>
        ${processForm}
      </td>
    </tr>
    `;
}

function adoptedPanel(d, actions) {
  const info = d.info;
  const recordings = d.recordings.length
    ? html`
  <div class="table-scroll">
  <table class="compact">
    <thead><tr>
      <th>Recording</th><th>Title</th><th>On device</th><th>Copied</th><th>Job</th><th>Flags</th><th>Action</th>
    </tr></thead>
    <tbody>
    ${d.recordings.map((r) => recordingRow(d, r, actions))}
    </tbody>
  </table>
  </div>
  `
    : html`
  <p class="empty">No recordings seen on this device yet.</p>
  `;
  return html`
<section class="panel">
  <div class="panel-head">
    <h2 class="eyebrow eyebrow-bar">${(info.model || 'device').replace(/_/g, ' ')} <span class="count">${info.serial}</span></h2>
    <span class="pill ${d.connected ? 'pill-ok' : 'pill-idle'}">${d.connected ? 'Connected' : 'Not connected'}</span>
  </div>
  <p class="caption caption-top">adopted ${localtimeFilter(info.adoptedAt)} · last seen ${localtimeFilter(info.lastSeenAt)} · last sync ${localtimeFilter(info.lastSyncAt)}</p>
  ${info.lastError ? html`<p class="banner banner-bad">${info.lastError}</p>` : ''}
  ${recordings}
  <div class="button-row">
    <form method="post" action="/admin/devices/${info.serial}/forget"><button type="submit" class="btn btn-danger btn-small">Forget this device</button></form>
  </div>
</section>
`;
}

/** @param {object} page path, refresh, config, usb, adopted, unknown, actions, error, paired, revoked, tools, local */
function devices(page) {
  const adopted = page.adopted.length
    ? page.adopted.map((d) => adoptedPanel(d, page.actions))
    : html`
<section class="panel">
  <p class="empty">No adopted devices. Plug the R1 in with USB debugging on; it appears here to adopt.</p>
</section>
`;
  const body = html`
${page.error ? html`<p class="banner banner-bad">${page.error}</p>` : ''}

${usbPanel(page.config, page.usb, page.tools, page.local)}

${pairingPanel(page.paired, page.revoked)}

${unknownPanel(page.unknown)}

${adopted}
`;
  return base({ path: page.path, refresh: page.refresh, title: 'Devices — R1CORD Server', body });
}

module.exports = { devices };
