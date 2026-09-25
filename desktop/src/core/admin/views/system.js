// templates/system.html: the dependency checks and facts about this server.

'use strict';

const { html } = require('../html');
const { megabytes } = require('../../pipeline/models');
const { base } = require('./base');

const DOT = { ok: 'ok', warn: 'bad', off: 'off' };
const STATE = { ok: 'OK', warn: 'Needs attention', off: 'Not in use' };

function modelStateLine(model) {
  if (!model) return '';
  if (model.error) return model.error;
  if (model.state === 'present') return `present · ${megabytes(model.size)}`;
  if (model.state === 'partial') {
    return `downloading · ${megabytes(model.received)} of ${megabytes(model.size)} (${model.percent}%)`;
  }
  return `missing · ${megabytes(model.size)}`;
}

function modelPanel(page) {
  const model = page.model;
  if (!model) return '';
  const missing = model.state !== 'present' && !model.error;
  const download = missing && !model.active
    ? html`
    <form method="post" action="/admin/system/model-download">
      <button type="submit" class="btn btn-small">Download model</button>
    </form>`
    : '';
  const cancel = model.active
    ? html`
    <form method="post" action="/admin/system/model-cancel">
      <button type="submit" class="btn btn-secondary btn-small">Cancel download</button>
    </form>`
    : '';
  return html`
<section class="panel">
  <div class="panel-head"><h2 class="eyebrow eyebrow-bar">whisper.cpp model</h2></div>
  <dl class="facts">
    <dt>File</dt><dd class="path">${model.file || ''}</dd>
    <dt>State</dt><dd>${modelStateLine(model)}</dd>
    <dt>Path</dt><dd class="path">${model.path || ''}</dd>
  </dl>
  ${download}${cancel}
  <p class="caption">Reload this page to see download progress. The model is also downloaded on the first whisper.cpp job. Nothing is downloaded at startup.</p>
</section>
`;
}

/** @param {object} page path, config, checks, lastJob, serverVersion, configPath, model */
function system(page) {
  const { config, checks } = page;
  const warn = checks.filter((c) => c.state === 'warn');
  const runMode =
    config.run_mode === 'plug'
      ? html` — exits after ${config.idle_exit_min} idle minutes`
      : ' — starts at logon and stays running';
  const body = html`

<section class="panel">
  <div class="panel-head">
    <h1 class="eyebrow eyebrow-bar">System</h1>
    <span class="pill ${warn.length ? 'pill-bad' : 'pill-ok'}">${warn.length ? html`${warn.length} need${warn.length === 1 ? 's' : ''} attention` : 'Ready'}</span>
  </div>
  <ul class="sys-checks">
    ${checks.map(
      (c) => html`
    <li class="sys-check sys-${c.state}">
      <span class="dot dot-${DOT[c.state]}"></span>
      <span class="sys-name">${c.name}</span>
      <span class="sys-detail">${c.detail}</span>
      <span class="sys-state">${STATE[c.state]}</span>
    </li>
    `,
    )}
  </ul>
</section>

<section class="panel">
  <div class="panel-head"><h2 class="eyebrow eyebrow-bar">About this server</h2></div>
  <dl class="facts">
    <dt>Version</dt><dd>r1cord-server ${page.serverVersion}</dd>
    <dt>Server name</dt><dd>${config.server_name}</dd>
    <dt>Listening on</dt><dd class="path">http://${config.listen_host}:${config.listen_port}</dd>
    <dt>Run mode</dt><dd>${config.run_mode}${runMode}</dd>
    <dt>Last job</dt><dd>${page.lastJob}</dd>
    <dt>Data</dt><dd class="path">${config.datastore}</dd>
    <dt>Config file</dt><dd class="path">${page.configPath}</dd>
  </dl>
</section>
${modelPanel(page)}
`;
  return base({ path: page.path, refresh: page.refresh, title: 'System — R1CORD Server', body });
}

module.exports = { system };
