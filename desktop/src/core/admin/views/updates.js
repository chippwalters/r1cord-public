// The Updates page (consent for update checks, R1 auto-update choice, Check now, what the last
// signed manifest offers, and per-R1 app updates found when an R1 was plugged in, with Install)
// and the small banner other pages show: the first-run question until it is answered, then
// "Update available" when the signed manifest names a newer desktop.

'use strict';

const { html, raw } = require('../html');
const { base } = require('./base');

const R1_AUTO_UPDATE_OPTIONS = [
  ['off', 'Off — never offer R1 updates'],
  ['ask', 'Ask — show R1 updates here and install only when I press Install'],
  ['install', 'Install — install verified R1 updates when the R1 is plugged in and idle'],
];

const ENTRY_LABELS = { r1cord: 'R1CORD app', controls: 'R1CORD device controls', tailscale: 'Tailscale' };

function checked(on) {
  return on ? raw('checked') : '';
}

function selected(on) {
  return on ? raw('selected') : '';
}

function localTime(iso) {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

function stateOf(page) {
  if (page.updates) return page.updates;
  return require('../../updates').updateState();
}

/**
 * The banner for another admin page, or '' when there is nothing to say.
 * @param {{config: object, updates?: object}} page  `updates` is updateState(); read here when absent.
 */
function updateBanner(page) {
  const config = page && page.config;
  if (!config) return '';
  if (!config.update_check_asked) {
    return html`
<section class="banner banner-work update-banner">
  <p><strong>Check for updates?</strong> Once a day R1CORD Desktop can download the signed release list from widgetgadget.com to tell you about new versions of the desktop and the R1 apps. It sends a plain web request and nothing about you or your recordings.</p>
  <div class="button-row">
    <form method="post" action="/admin/updates/settings">
      <input type="hidden" name="update_check" value="on">
      <input type="hidden" name="return_to" value="${page.path || '/admin'}">
      <button type="submit" class="btn btn-small">Yes, check daily</button>
    </form>
    <form method="post" action="/admin/updates/settings">
      <input type="hidden" name="return_to" value="${page.path || '/admin'}">
      <button type="submit" class="btn btn-secondary btn-small">No thanks</button>
    </form>
    <a class="btn btn-secondary btn-small" href="/admin/updates">More options</a>
  </div>
</section>
`;
  }
  const state = stateOf(page);
  if (state && state.desktop && state.desktop.available) {
    return html`
<p class="banner banner-work update-banner">R1CORD Desktop ${state.desktop.latest} is available (this is ${state.desktop.current}). <a href="/admin/updates">See Updates</a></p>
`;
  }
  return '';
}

function androidRows(android) {
  const names = Object.keys(android);
  if (!names.length) return html`<p class="empty">No R1 APKs listed yet.</p>`;
  return html`
  <div class="table-scroll">
  <table class="compact">
    <thead><tr><th>APK</th><th>Package</th><th>Version</th><th class="num">versionCode</th><th>File</th></tr></thead>
    <tbody>
    ${names.map((name) => {
      const e = android[name];
      return html`
      <tr>
        <td>${ENTRY_LABELS[name] || name}</td>
        <td class="mono-cell">${e.package}</td>
        <td>${e.versionName}</td>
        <td class="num">${e.versionCode}</td>
        <td class="mono-cell">${e.file}</td>
      </tr>`;
    })}
    </tbody>
  </table>
  </div>`;
}

function r1ItemLine(item) {
  return html`<li>Update ${item.name} ${item.from.versionName || item.from.versionCode} → ${item.to.versionName || item.to.versionCode}</li>`;
}

function r1Row(row, local) {
  const check = row.check;
  const result = row.lastResult;
  let offer = '';
  if (row.installing) {
    offer = html`<p class="banner banner-work">Installing… keep the R1 plugged in.</p>`;
  } else if (check && check.error && !check.items.length) {
    offer = html`<p class="warn">Check failed: ${check.error}</p>`;
  } else if (check && check.items.length) {
    const action = check.legacy
      ? html`<p class="caption">This R1CORD is older than 0.4.0 and has no maintenance gate, so it is never updated from here. Stay with the R1 and use <a href="/admin/setup#r1-${row.serial}">Set up R1</a>.</p>`
      : local
        ? html`<form method="post" action="/admin/updates/r1/${row.serial}/install" data-busy><button type="submit" class="btn btn-small">Install</button></form>
  <p class="caption">Installs over USB only while R1CORD is idle; recording and uploads pause until it is done.</p>`
        : html`<p class="caption">Open this page on the server PC to install.</p>`;
    offer = html`<ul>${check.items.map(r1ItemLine)}</ul>
  ${check.error ? html`<p class="warn">${check.error}</p>` : ''}
  ${action}`;
  } else if (check) {
    offer = html`<p class="ok">Up to date.</p>`;
  }
  const last = result
    ? html`<p class="caption">Last install ${localTime(result.at)}: <span class="pill ${result.ok ? 'pill-ok' : 'pill-bad'}">${result.ok ? 'Done' : 'Failed'}</span> ${result.detail}</p>`
    : '';
  return html`
  <div class="stack" id="r1-update-${row.serial}">
    <h3>R1 <span class="count">${row.serial}</span>${check ? html` <span class="caption">checked ${localTime(check.checkedAt)}</span>` : ''}</h3>
    ${offer}
    ${last}
  </div>`;
}

function r1Panel(page) {
  const rows = page.r1Updates || [];
  const mode = page.config.r1_auto_update;
  const intro = mode === 'off'
    ? 'R1 app updates are off: nothing is checked when an R1 is plugged in.'
    : 'When an adopted R1 is plugged in, its apps are compared with the verified APKs on this PC.';
  return html`
<section class="panel" id="r1-updates">
  <div class="panel-head"><h2 class="eyebrow eyebrow-bar">R1 app updates</h2></div>
  <p class="lede">${intro}</p>
  ${rows.length ? rows.map((row) => r1Row(row, page.local)) : html`<p class="empty">No R1 has been checked since R1CORD Desktop started.</p>`}
</section>`;
}

/** @param {object} page path, config, updates (updateState()), notice, error, saved, r1Updates, local */
function updates(page) {
  const cfg = page.config;
  const state = stateOf(page);
  const desktop = state.desktop;
  let desktopLine;
  if (!desktop.latest) {
    desktopLine = html`<p class="muted">No signed release list has been checked yet.</p>`;
  } else if (desktop.available) {
    desktopLine = html`<p class="warn">R1CORD Desktop ${desktop.latest} is available (this is ${desktop.current}). Download it from <a href="${desktop.url}" rel="noopener noreferrer" target="_blank">${desktop.url}</a>${desktop.notes ? html` — <a href="${desktop.notes}" rel="noopener noreferrer" target="_blank">what's new</a>` : ''}. Updates never install themselves: quit R1CORD Desktop and unzip the new version over the old one.</p>`;
  } else {
    desktopLine = html`<p class="ok">R1CORD Desktop ${desktop.current} is up to date.</p>`;
  }
  const body = html`
${page.notice ? html`<p class="banner banner-bad">${page.notice}</p>` : ''}
${page.error ? html`<p class="banner banner-bad">${page.error}</p>` : ''}
${page.saved ? html`<p class="ok">Saved to config.toml.</p>` : ''}

<section class="panel">
  <div class="panel-head">
    <h1 class="eyebrow eyebrow-bar">Updates</h1>
    <span class="pill ${cfg.update_check ? 'pill-ok' : 'pill-idle'}">${cfg.update_check ? 'Daily checks on' : 'Checks off'}</span>
  </div>
  <p class="lede">R1CORD Desktop only contacts the release server when you allow it. A check downloads the release list (<span class="path">${cfg.update_manifest_url}</span>) and its signature. Anything not signed by the R1CORD publication key, older than a list already accepted, or signed by a different app key is refused.</p>
  <form method="post" action="/admin/updates/settings" class="stack">
    <label><input type="checkbox" name="update_check" ${checked(cfg.update_check)}> Check for updates once a day (first check 30 seconds after start)</label>
    <label>R1 app updates
      <select name="r1_auto_update">${R1_AUTO_UPDATE_OPTIONS.map(([value, label]) => html`
        <option value="${value}" ${selected(cfg.r1_auto_update === value)}>${label}</option>`)}
      </select>
    </label>
    <p class="muted">R1 updates are only installed over the USB cable, never while the R1 is recording or uploading.</p>
    <button type="submit">Save</button>
  </form>
</section>

<section class="panel">
  <div class="panel-head"><h2 class="eyebrow eyebrow-bar">Latest release</h2>${state.checking ? html`<span class="pill pill-work">Checking</span>` : ''}</div>
  <dl class="facts">
    <dt>Last check</dt><dd>${localTime(state.lastCheckAt)}</dd>
    <dt>Result</dt><dd>${state.lastError ? html`<span class="pill pill-bad">Failed</span> ${state.lastError}` : state.lastCheckAt ? 'OK' : '—'}</dd>
    <dt>Release</dt><dd>${state.sequence !== null ? html`#${state.sequence}${state.publishedAt ? html`, published ${localTime(state.publishedAt)}` : ''}` : '—'}</dd>
  </dl>
  ${desktopLine}
  ${androidRows(state.android)}
  <div class="button-row">
    <form method="post" action="/admin/updates/check" data-busy>
      <button type="submit" class="btn btn-small">Check now</button>
    </form>
  </div>
  <p class="caption">Check now fetches the signed release list once, even when daily checks are off.</p>
</section>
${r1Panel(page)}
`;
  return base({ path: page.path, refresh: page.refresh, title: 'Updates — R1CORD Server', body });
}

module.exports = { R1_AUTO_UPDATE_OPTIONS, updateBanner, updates };
