// The Setup page: one numbered, guided workflow — install Tailscale, sign in, share /v1, the tailnet
// policy, tag this PC, create an R1 auth key, set up each adopted R1 — each step showing whether it
// is done, needs the owner, or is blocked by an earlier one. A Set up R1 run shows its live step list
// in a modal dialog that polls the run's JSON until it ends and the owner closes it.

'use strict';

const { html, raw } = require('../html');
const { humanSize } = require('../format');
const { APKS, DOWNLOAD_LABEL, POLICY_LABEL } = require('../../setup');
const { R1_TAG, SERVER_TAG } = require('../../tailscale');
const { base } = require('./base');

const CONSOLE = {
  policy: 'https://login.tailscale.com/admin/acls/file',
  machines: 'https://login.tailscale.com/admin/machines',
  keys: 'https://login.tailscale.com/admin/settings/keys',
};
const STATE_PILLS = { done: ['pill-ok', 'Done'], todo: ['pill-todo', 'Needs you'], blocked: ['pill-idle', 'Blocked'] };
const STEP_PILLS = { done: 'pill-ok', skipped: 'pill-idle', failed: 'pill-bad', running: 'pill-work', pending: 'pill-idle' };
const STEP_WORDS = { done: 'Done', skipped: 'Skipped', failed: 'Failed', running: 'Running', pending: 'Not run' };
const ISOLATION = {
  pass: ['pill-ok', 'Isolation: pass'],
  inconclusive: ['pill-todo', 'Isolation: inconclusive'],
  fail: ['pill-bad', 'Isolation: FAIL'],
};
const INSTALL_PHASES = { checking: 'Checking pkgs.tailscale.com', verifying: 'Checking the signature of', installing: 'Installing' };
const APP_NAMES = { r1cord: 'R1CORD', controls: 'controls', tailscale: 'Tailscale' };

function statusPill(ts) {
  if (!ts.installed) return html`<span class="pill pill-idle">Not installed</span>`;
  if (ts.running) return html`<span class="pill pill-ok">Connected</span>`;
  return html`<span class="pill pill-todo">${ts.backendState || 'Not running'}</span>`;
}

function consoleLink(url, label) {
  return html`<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
}

/** A step that waits for an earlier one: no actions, just which step to finish first. */
function blocked(step, first) {
  return { ...step, state: 'blocked', summary: '', body: html`<p class="caption">Finish step ${first} first.</p>` };
}

/** The step to finish before anything that needs this PC signed in: install first, then sign in. */
function signInFirst(ts) {
  return ts.installed ? 2 : 1;
}

// --- 1. Install Tailscale -----------------------------------------------------------------------------

function installProgress(install) {
  if (install.phase !== 'downloading') return html`${INSTALL_PHASES[install.phase] || 'Installing'} Tailscale…`;
  const total = install.total ? html` of ${humanSize(install.total)}` : '';
  return html`Downloading Tailscale · ${humanSize(install.received)}${total}…`;
}

function installStep({ ts, install, local }) {
  const step = { id: 'install', title: 'Install Tailscale' };
  if (ts.installed) {
    return { ...step, state: 'done', summary: install.done ? `Tailscale ${install.done} installed` : 'Tailscale is installed on this PC', body: '' };
  }
  const offer = install.active
    ? ''
    : local
      ? html`<form method="post" action="/admin/setup/tailscale/install" class="stack" data-busy>
    <label class="check"><input type="checkbox" name="consent" value="yes" required> Download the official Windows installer from pkgs.tailscale.com, check its published SHA-256 and its Tailscale Inc. signature, and install it (one Windows permission prompt)</label>
    <div class="button-row"><button type="submit" class="btn">Install Tailscale</button></div>
  </form>`
      : html`<p class="caption">Open this page on the server PC to install Tailscale.</p>`;
  const body = html`
  ${install.active ? html`<p class="banner banner-work">${installProgress(install)}</p>` : ''}
  ${install.error ? html`<p class="banner banner-bad">Tailscale install failed: ${install.error}</p>` : ''}
  ${offer}`;
  return { ...step, state: 'todo', summary: '', body };
}

// --- 2. Sign in ----------------------------------------------------------------------------------------

function signInStep({ ts, loginUrl, local }) {
  const step = { id: 'signin', title: 'Sign this PC in to Tailscale' };
  if (ts.running) {
    const where = ts.tailnetName ? ` on ${ts.tailnetName}` : '';
    return { ...step, state: 'done', summary: `Signed in as ${ts.dnsName || ts.hostName}${where}`, body: '' };
  }
  if (!ts.installed) return blocked(step, 1);
  const body = html`
  <p class="lede">Tailscale on this PC is ${ts.backendState || 'not running'}.</p>
  ${loginUrl ? html`<p class="banner banner-work">Finish signing in: <a href="${loginUrl}" target="_blank" rel="noopener">open the Tailscale sign-in page</a>, then reload this page.</p>` : ''}
  ${local
    ? html`<div class="button-row"><form method="post" action="/admin/setup/tailscale/login" data-busy><button type="submit" class="btn">Sign this PC in to Tailscale</button></form></div>`
    : html`<p class="caption">Open this page on the server PC to sign in.</p>`}`;
  return { ...step, state: 'todo', summary: '', body };
}

// --- 3. Share /v1 and verify ------------------------------------------------------------------------

function verifyBlock(verify) {
  if (!verify) return '';
  const rows = verify.checks.map(
    (c) => html`<tr><td class="mono-cell">${c.path}</td><td>${c.status ?? '—'}</td><td>${c.expected}</td><td><span class="pill ${c.pass ? 'pill-ok' : 'pill-bad'}">${c.pass ? 'OK' : 'Exposed'}</span> ${c.detail}</td></tr>`,
  );
  return html`
  <p class="banner ${verify.ok ? 'banner-ok' : 'banner-bad'}">${verify.ok ? 'Only /v1 is shared: the admin, its files and traversal paths are not reachable over the tailnet.' : 'The tailnet check failed — see below.'} <span class="caption">checked ${verify.at}</span></p>
  <div class="table-scroll"><table class="compact">
    <thead><tr><th>Path</th><th>HTTP</th><th>Expected</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function shareStep({ ts, config, local, verify, serveConsentUrl }) {
  // The serve and verify routes redirect back to #remote.
  const step = { id: 'share', anchor: 'remote', title: 'Share /v1 on the tailnet' };
  if (!ts.running) return blocked(step, signInFirst(ts));
  const on = Boolean(config.tailscale_serve);
  const url = `https://${ts.dnsName}/v1`;
  const failed = Boolean(verify && !verify.ok);
  const body = html`
  <p class="lede">${on
    ? html`<strong>On</strong> — <span class="path">${url}</span> reaches only the R1 API (127.0.0.1:${config.api_port}). Nothing is published to the internet (no Funnel).`
    : 'Off — nothing on this PC is reachable over the tailnet.'}</p>
  ${!on && serveConsentUrl
    ? html`<p class="banner banner-work">Serve is not enabled on your tailnet yet — open <a href="${serveConsentUrl}" target="_blank" rel="noopener">${serveConsentUrl}</a> (opens in the browser), approve, then press Share /v1 again.</p>`
    : ''}
  ${local
    ? html`<div class="button-row">
    <form method="post" action="/admin/setup/serve" data-busy><input type="hidden" name="serve" value="${on ? 'off' : 'on'}"><button type="submit" class="btn ${on ? 'btn-secondary' : ''}">${on ? 'Stop sharing /v1' : 'Share /v1'}</button></form>
    ${on ? html`<form method="post" action="/admin/setup/verify" data-busy><button type="submit" class="btn btn-secondary">Verify from the tailnet</button></form>` : ''}
  </div>`
    : html`<p class="caption">Open this page on the server PC to change sharing.</p>`}
  ${verifyBlock(verify)}`;
  if (!on || failed) return { ...step, state: 'todo', summary: '', body };
  return { ...step, state: 'done', summary: verify ? `Sharing ${url} · verified ${verify.at}` : `Sharing ${url}`, body };
}

// --- 4. Tailnet policy ------------------------------------------------------------------------------

function policyStep({ ts, policy }, proven) {
  const step = { id: 'policy', title: 'Tailnet policy' };
  if (!ts.running) return blocked(step, signInFirst(ts));
  const body = html`
  <p class="lede"><strong>${policy.instructions}</strong> (${consoleLink(CONSOLE.policy, 'open Access controls')})</p>
  <textarea id="policy-json" class="prompt-text" rows="18" readonly spellcheck="false" aria-label="Tailnet policy">${policy.json}</textarea>
  <div class="button-row"><button type="button" class="btn btn-secondary btn-small" data-copy="policy-json">Copy</button></div>
  ${policy.notes.map((note) => html`<p class="caption">${note}</p>`)}
  <p class="caption">This step shows done once an R1 finishes setup Ready: that run tests the policy from the R1.</p>`;
  if (proven) return { ...step, state: 'done', summary: 'In place — an R1 finished setup Ready, isolation passed', body };
  return { ...step, state: 'todo', summary: '', body };
}

// --- 5. Tag this PC --------------------------------------------------------------------------------

function tagStep({ ts }) {
  const step = { id: 'tag', title: `Tag this PC ${SERVER_TAG}` };
  if (!ts.running) return blocked(step, signInFirst(ts));
  if (ts.tags.includes(SERVER_TAG)) return { ...step, state: 'done', summary: `Tailscale reports this PC as ${SERVER_TAG}`, body: '' };
  const name = ts.hostName || ts.dnsName;
  const body = html`
  <p class="lede">Admin console → ${consoleLink(CONSOLE.machines, 'Machines')} → <strong>${name}</strong> → ⋯ → Edit ACL tags → add <span class="path">${SERVER_TAG}</span> → Save.</p>
  <p class="caption">Save the policy (step 4) first: it defines the tag. Tagging changes this PC's identity and key expiry; check anything else you use it for. This step turns done once Tailscale reports the tag — reload the page.</p>`;
  return { ...step, state: 'todo', summary: '', body };
}

// --- 6. Auth key -----------------------------------------------------------------------------------

function keyStep({ ts, devices }) {
  const step = { id: 'key', title: 'Create an auth key for the R1' };
  if (!ts.running) return blocked(step, signInFirst(ts));
  const body = html`
  <p class="lede">Admin console → ${consoleLink(CONSOLE.keys, 'Settings → Keys')} → Generate auth key:</p>
  <ul class="key-settings">
    <li>Reusable: <strong>off</strong></li>
    <li>Expiration: <strong>1 day</strong></li>
    <li>Ephemeral: <strong>off</strong></li>
    <li>Tags: <strong>on</strong> → <span class="path">${R1_TAG}</span></li>
  </ul>
  <p class="caption">Pre-approved appears only if device approval is on; if you see it, turn it on.</p>
  <p class="caption">Copy the key (tskey-auth-…) into step 7. Without the tag the R1 joins untagged and can reach every device on your tailnet.</p>`;
  if (devices.length && devices.every((d) => d.record)) {
    return { ...step, state: 'done', summary: 'Every R1 is already on the tailnet — no key needed; leave the key box blank', body };
  }
  return { ...step, state: 'todo', summary: '', body };
}

// --- 7. Set up R1 ----------------------------------------------------------------------------------

/** done: the last run (this session) or the saved record says Ready; otherwise it needs the owner. */
function deviceState(d) {
  if (d.run) return !d.run.active && d.run.ready ? 'done' : 'todo';
  return d.record && d.record.readyAt ? 'done' : 'todo';
}

function releaseHost(config) {
  try {
    return new URL(String(config.update_manifest_url)).host;
  } catch (_error) {
    return 'the release server';
  }
}

/** The download box only when an app is missing here; otherwise which versions setup will use. */
function downloadBlock(apps, config) {
  if (apps && APKS.every((spec) => apps[spec.entry])) {
    return html`<p class="caption">Apps on this PC: ${APKS.map((spec) => `${APP_NAMES[spec.entry]} ${apps[spec.entry].versionName}`).join(', ')}</p>`;
  }
  const missing = apps ? APKS.filter((spec) => !apps[spec.entry]).map((spec) => APP_NAMES[spec.entry]) : [];
  return html`<label class="check"><input type="checkbox" name="download" value="yes"> ${DOWNLOAD_LABEL}</label>
    <p class="caption">${missing.length ? `Not on this PC yet: ${missing.join(', ')}. ` : ''}Contacts ${releaseHost(config)} for the signed release list and any APK this PC does not have yet (the Tailscale APK is about 105 MB). Unticked, setup uses only the apps bundled with R1CORD Desktop or downloaded before.</p>`;
}

function runVerdict(run) {
  return run.ready ? 'Ready' : `Not ready${run.readyDetail || run.error ? `: ${run.readyDetail || run.error}` : ''}`;
}

function lastRunLine(d) {
  const run = d.run;
  if (!run) return '';
  const button = html`<button type="button" class="btn btn-secondary btn-small" data-open-run="${d.serial}">${run.active ? 'Show progress' : 'Show last run'}</button>`;
  if (run.active) return html`<p class="banner banner-work run-line">Setting up now. ${button}</p>`;
  return html`<p class="banner ${run.ready ? 'banner-ok' : 'banner-bad'} run-line">Last run: ${runVerdict(run)} ${button}</p>`;
}

function deviceBlock(d, page, state, policyProven) {
  const run = d.run;
  const active = Boolean(run && run.active);
  const [tone, word] = active ? ['pill-work', 'Running'] : STATE_PILLS[state];
  const form = page.local
    ? html`<form method="post" action="/admin/setup/run/${d.serial}" class="stack" autocomplete="off" data-busy>
    <label>Tailscale auth key <input type="password" name="authkey" autocomplete="off" spellcheck="false" placeholder="tskey-auth-… (step 6)"></label>
    <p class="caption caption-top">Leave it blank when this R1 is already on the tailnet.</p>
    ${downloadBlock(page.apps, page.config)}
    <label class="check"><input type="checkbox" name="policy" value="yes"${policyProven ? raw(' checked') : ''}> ${POLICY_LABEL}</label>
    <div class="button-row"><button type="submit" class="btn" ${active || !d.connected ? raw('disabled') : ''}>${run || d.record ? 'Run setup again' : 'Run setup'}</button></div>
  </form>`
    : html`<p class="caption">Open this page on the server PC to run setup.</p>`;
  const record = d.record
    ? html`<p class="caption caption-top">tailnet: <span class="path">${d.record.dnsName}</span> · ${d.record.ip} · verified ${d.record.verifiedAt}${d.record.readyAt ? html` · Ready ${d.record.readyAt}` : ''}</p>`
    : '';
  return html`
  <div class="wf-device" id="r1-${d.serial}" data-device="${d.serial}" data-state="${state}">
    <div class="panel-head">
      <h3 class="wf-device-name">R1 <span class="count">${d.serial}</span></h3>
      <span class="wf-pills"><span class="pill ${d.connected ? 'pill-ok' : 'pill-idle'}">${d.connected ? 'Connected' : 'Not connected'}</span> <span class="pill ${tone}">${word}</span></span>
    </div>
    ${record}
    ${lastRunLine(d)}
    ${form}
  </div>`;
}

function r1Step(page, states, firstUnfinished, policyProven) {
  const step = { id: 'r1', title: 'Set up R1' };
  const { devices } = page;
  if (!devices.length) {
    const body = html`<p class="empty">No adopted R1. Plug it in with USB debugging on and adopt it on the <a href="/admin/devices">Devices</a> page.</p>`;
    return { ...step, state: firstUnfinished ? 'blocked' : 'todo', summary: '', body };
  }
  const blocks = devices.map((d, i) => deviceBlock(d, page, states[i], policyProven));
  if (firstUnfinished) {
    return { ...step, state: 'blocked', summary: '', body: html`<p class="caption">Finish step ${firstUnfinished} first.</p>${blocks}` };
  }
  if (states.every((s) => s === 'done')) {
    return { ...step, state: 'done', summary: `Ready: ${devices.map((d) => d.serial).join(', ')}`, body: blocks };
  }
  return { ...step, state: 'todo', summary: '', body: blocks };
}

// --- the run dialog ----------------------------------------------------------------------------------

function stepRows(run) {
  return run.steps.map(
    (s) => html`<li><span class="pill ${STEP_PILLS[s.status] || 'pill-idle'}">${STEP_WORDS[s.status] || s.status}</span> ${s.label}${s.detail ? html` <span class="caption">— ${s.detail}</span>` : ''}</li>`,
  );
}

function runResult(run) {
  if (run.active) return '';
  const iso = run.isolation ? ISOLATION[run.isolation] : null;
  return html`<p class="banner ${run.ready ? 'banner-ok' : 'banner-bad'}">${runVerdict(run)}${run.ready ? '.' : ''}</p>
  ${iso ? html`<p><span class="pill ${iso[0]}">${iso[1]}</span> <span class="caption">${run.isolationDetail}</span></p>` : ''}`;
}

function runDialog(d) {
  const run = d.run;
  if (!run) return '';
  const [tone, word] = run.active ? ['pill-work', 'Running'] : run.ready ? ['pill-ok', 'Ready'] : ['pill-bad', 'Not ready'];
  return html`
<dialog class="run-dialog" id="run-${d.serial}" data-run="${d.serial}" data-active="${run.active ? '1' : ''}" data-started="${run.startedAt}" aria-labelledby="run-title-${d.serial}">
  <div class="panel-head">
    <h2 id="run-title-${d.serial}">Setting up ${d.serial}</h2>
    <span class="pill ${tone}" data-run-pill>${word}</span>
  </div>
  ${run.active ? html`<p class="banner banner-work" data-run-note>Keep the R1 plugged in.</p>` : ''}
  <ol class="steps">${stepRows(run)}</ol>
  <div data-run-result>${runResult(run)}</div>
  <div class="button-row"><button type="button" class="btn" data-close-run ${run.active ? raw('disabled') : ''}>Close</button></div>
</dialog>`;
}

const SCRIPT = raw(`<script>
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  navigator.clipboard.writeText(source.value).then(() => { button.textContent = "Copied"; });
});
// Set up R1 runs: an active run owns the screen in its dialog, polled every 2 s; a finished run's
// dialog stays until it is closed once (remembered per run), then the page reloads for new states.
(() => {
  const WORDS = { done: "Done", skipped: "Skipped", failed: "Failed", running: "Running", pending: "Not run" };
  const TONES = { done: "pill-ok", skipped: "pill-idle", failed: "pill-bad", running: "pill-work", pending: "pill-idle" };
  const ISOLATION = { pass: ["pill-ok", "Isolation: pass"], inconclusive: ["pill-todo", "Isolation: inconclusive"], fail: ["pill-bad", "Isolation: FAIL"] };
  const key = (dialog) => "r1cord-setup-run:" + dialog.dataset.run + ":" + dialog.dataset.started;
  const seen = (dialog) => { try { return localStorage.getItem(key(dialog)) === "1"; } catch (_error) { return false; } };
  const show = (dialog) => { if (!dialog.open) dialog.showModal(); };
  const setPill = (el, tone, text) => { el.className = "pill " + tone; el.textContent = text; };
  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function render(dialog, run) {
    dialog.querySelectorAll("ol.steps li").forEach((li, i) => {
      const step = run.steps && run.steps[i];
      if (!step) return;
      setPill(li.querySelector(".pill"), TONES[step.status] || "pill-idle", WORDS[step.status] || step.status);
      let caption = li.querySelector(".caption");
      if (step.detail) {
        if (!caption) { caption = element("span", "caption"); li.append(" ", caption); }
        caption.textContent = "— " + step.detail;
      }
    });
    if (run.active) return;
    dialog.dataset.active = "";
    dialog.dataset.finishedHere = "1";
    setPill(dialog.querySelector("[data-run-pill]"), run.ready ? "pill-ok" : "pill-bad", run.ready ? "Ready" : "Not ready");
    const note = dialog.querySelector("[data-run-note]");
    if (note) note.remove();
    const reason = run.readyDetail || run.error;
    const result = dialog.querySelector("[data-run-result]");
    result.replaceChildren(element("p", "banner " + (run.ready ? "banner-ok" : "banner-bad"), run.ready ? "Ready." : "Not ready" + (reason ? ": " + reason : "")));
    const iso = ISOLATION[run.isolation];
    if (iso) {
      const line = element("p");
      line.append(element("span", "pill " + iso[0], iso[1]), " ", element("span", "caption", run.isolationDetail || ""));
      result.append(line);
    }
    dialog.querySelector("[data-close-run]").disabled = false;
  }
  function poll(dialog) {
    const timer = setInterval(async () => {
      let run;
      try {
        const response = await fetch("/admin/setup/run/" + encodeURIComponent(dialog.dataset.run) + ".json", { cache: "no-store" });
        run = await response.json();
      } catch (_error) {
        return;
      }
      render(dialog, run);
      if (!run.active) clearInterval(timer);
    }, 2000);
  }
  for (const dialog of document.querySelectorAll("dialog.run-dialog")) {
    // Escape must not hide a run that is still going.
    dialog.addEventListener("cancel", (event) => { if (dialog.dataset.active === "1") event.preventDefault(); });
    dialog.addEventListener("close", () => {
      try { localStorage.setItem(key(dialog), "1"); } catch (_error) { /* not remembered */ }
      if (dialog.dataset.finishedHere === "1") location.reload();
    });
    if (dialog.dataset.active === "1") { show(dialog); poll(dialog); }
    else if (!seen(dialog)) show(dialog);
  }
  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open-run]");
    if (opener) {
      const dialog = document.getElementById("run-" + opener.dataset.openRun);
      if (dialog) show(dialog);
      return;
    }
    const closer = event.target.closest("[data-close-run]");
    if (closer && !closer.disabled) closer.closest("dialog").close();
  });
})();
</script>`);

// --- the page -------------------------------------------------------------------------------------

function stepItem(n, step) {
  const [tone, word] = STATE_PILLS[step.state];
  const done = step.state === 'done';
  return html`
<li class="wf-step wf-${step.state}" id="${step.anchor || `step-${step.id}`}" data-step="${step.id}" data-state="${step.state}">
  <details class="wf"${done ? '' : raw(' open')}>
    <summary class="wf-head">
      <span class="wf-num">${n}</span>
      <span class="wf-title">${step.title}</span>
      ${done ? html`<span class="wf-summary">✓ ${step.summary}</span>` : ''}
      <span class="pill ${tone}">${word}</span>
    </summary>
    ${step.body ? html`<div class="wf-body">${step.body}</div>` : ''}
  </details>
</li>`;
}

/** @param {object} page path, config, ts, install, loginUrl, serveConsentUrl, verify, policy, apps, devices, local, error, notice */
function setup(page) {
  const { ts } = page;
  const states = page.devices.map(deviceState);
  const policyProven = states.includes('done');
  const early = [installStep(page), signInStep(page), shareStep(page)];
  const firstUnfinished = early.findIndex((s) => s.state !== 'done') + 1;
  const steps = [...early, policyStep(page, policyProven), tagStep(page), keyStep(page), r1Step(page, states, firstUnfinished, policyProven)];
  const facts = ts.installed && ts.dnsName
    ? html`<p class="caption caption-top"><span class="path">${ts.dnsName}</span> · ${ts.tailscaleIPs.join(', ')}${ts.tags.length ? html` · ${ts.tags.join(', ')}` : ''}${ts.keyExpiry ? html` · key expires ${ts.keyExpiry}` : ''}</p>`
    : '';
  const body = html`
${page.error ? html`<p class="banner banner-bad">${page.error}</p>` : ''}
${page.notice ? html`<p class="banner banner-ok">${page.notice}</p>` : ''}
<section class="panel" id="setup">
  <div class="panel-head">
    <h1 class="eyebrow eyebrow-bar">Set up remote access</h1>
    ${statusPill(ts)}
  </div>
  <p class="lede">R1s send recordings to this PC over your private Tailscale network. Only the R1 API is shared, only to devices your tailnet policy allows. Work down the list; finished steps fold to one line.</p>
  ${facts}
  ${ts.error ? html`<p class="banner banner-bad">${ts.error}</p>` : ''}
  <ol class="workflow">${steps.map((step, i) => stepItem(i + 1, step))}</ol>
</section>
${page.devices.map(runDialog)}
`;
  return base({ path: page.path, refresh: page.refresh, title: 'Setup — R1CORD Server', body, scripts: SCRIPT });
}

module.exports = { setup };
