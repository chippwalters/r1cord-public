// templates/republish.html: the dry-run plan, or the progress and results of the last run.

'use strict';

const { html, raw } = require('../html');
const { base } = require('./base');

// Jinja's `{% for x in xs %}{{ x }}{% if not loop.last %}sep{% endif %}{% else %}—{% endfor %}`.
function joined(items, render, separator) {
  if (!items.length) return '—';
  return html`${items.map((item, index) => html`${render(item)}${index < items.length - 1 ? separator : ''}`)}`;
}

const BACK = html`<a class="btn btn-secondary btn-small" href="/admin/config#pages">Back to Settings</a>`;

function planPanel(plan, theme, labels) {
  const todo = plan.filter((item) => !item.skip);
  const table = plan.length
    ? html`
  <div class="table-scroll">
  <table class="compact">
    <thead>
      <tr><th>Recording</th><th>Folder</th><th>Pages it writes</th><th>Legacy files it removes</th><th>Status</th></tr>
    </thead>
    <tbody>
    ${plan.map(
      (item) => html`
      <tr>
        <td><span class="rec-title">${item.title}</span><span class="rec-id">${item.recordingId}</span></td>
        <td class="path">${item.folder}</td>
        <td class="mono-cell">${joined(item.pages, (k) => labels[k], ' · ')}</td>
        <td class="mono-cell">${joined(item.legacy, (name) => name, raw('<br>'))}</td>
        <td>${item.skip ? html`<span class="pill pill-idle">Skipped: ${item.skip}</span>` : html`<span class="pill">Republish</span>`}</td>
      </tr>
    `,
    )}
    </tbody>
  </table>
  </div>
  `
    : html`
  <p class="empty">No recording on this PC has a publish folder yet.</p>
  `;
  return html`

<section class="panel">
  <div class="panel-head">
    <h1 class="eyebrow eyebrow-bar">Republish preview <span class="count">${todo.length} of ${plan.length}</span></h1>
    <span class="pill pill-idle">Dry run — nothing written</span>
  </div>
  <p class="lede">Republishing rebuilds each recording below in <strong>${theme.name}</strong> from the Markdown on this PC, deploys it into its folder, then removes the MD DOCS files those pages replace. Nothing else in a folder, and nothing outside the recordings' folders, is touched.</p>
  ${table}
  <div class="button-row">
    ${todo.length ? html`
    <form method="post" action="/admin/republish" data-busy>
      <button type="submit" class="btn btn-small">Republish ${todo.length} recording${todo.length !== 1 ? 's' : ''}</button>
    </form>
    ` : ''}
    ${BACK}
  </div>
</section>
`;
}

function resultCell(r) {
  if (r.error) {
    return html`<span class="pill pill-bad" title="${r.error}">Failed</span> <span class="muted">${r.error}</span>
          `;
  }
  if (r.skip) {
    return html`<span class="pill pill-idle">Skipped: ${r.skip}</span>
          `;
  }
  return html`<span class="pill pill-ok">Done</span>`;
}

function runPanel(run, theme, labels) {
  const failed = run.results.filter((r) => r.error);
  let pill = '';
  if (run.running) {
    pill = html`
    <span class="pill pill-work">Running</span>
    `;
  } else if (run.startedAt !== null) {
    const bad = failed.length || run.error;
    pill = html`
    <span class="pill ${bad ? 'pill-bad' : 'pill-ok'}">${bad ? 'Finished with errors' : 'Done'}</span>
    `;
  }
  let content;
  if (run.startedAt === null) {
    content = html`
  <p class="empty">No republish has run since the server started. Start one from <a href="/admin/config#pages">Settings, Pages</a>.</p>
  `;
  } else {
    let results = '';
    if (run.results.length) {
      results = html`
  <div class="table-scroll">
  <table class="compact">
    <thead>
      <tr><th>Recording</th><th>Folder</th><th>Pages</th><th class="num">Files written</th><th>Removed</th><th>Result</th></tr>
    </thead>
    <tbody>
    ${run.results.map(
      (r) => html`
      <tr>
        <td><span class="rec-title">${r.title}</span><span class="rec-id">${r.recordingId}</span></td>
        <td class="path">${r.folder}</td>
        <td class="mono-cell">${joined(r.pages, (k) => labels[k], ' · ')}</td>
        <td class="num">${!r.skip ? r.written : '—'}</td>
        <td class="mono-cell">${joined(r.removed, (name) => name, raw('<br>'))}</td>
        <td>
          ${resultCell(r)}
        </td>
      </tr>
    `,
    )}
    </tbody>
  </table>
  </div>
  `;
    } else if (!run.running) {
      results = html`
  <p class="empty">No recording on this PC has a publish folder yet.</p>
  `;
    }
    content = html`
  <p class="lede">${
    run.running
      ? html`Republishing in <strong>${theme.name}</strong>; this page updates itself.`
      : html`Republished in <strong>${theme.name}</strong>.`
  }</p>
  ${run.error ? html`<p class="banner banner-bad">Stopped: ${run.error}</p>` : ''}
  ${results}
  `;
  }
  return html`

<section class="panel">
  <div class="panel-head">
    <h1 class="eyebrow eyebrow-bar">Republish</h1>
    ${pill}
  </div>
  ${content}
  <div class="button-row">
    ${BACK}
  </div>
</section>
`;
}

/** @param {object} page path, refresh, notice, plan (dry run) or run (Republisher), theme, labels */
function republish(page) {
  const body = html`
${page.notice ? html`<p class="banner banner-bad">${page.notice}</p>` : ''}
${page.plan ? planPanel(page.plan, page.theme, page.labels) : runPanel(page.run, page.theme, page.labels)}
`;
  return base({ path: page.path, refresh: page.refresh, title: 'Republish pages — R1CORD Server', body });
}

module.exports = { republish };
