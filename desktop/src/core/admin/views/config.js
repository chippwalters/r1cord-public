// templates/config.html: Settings, the page theme and republish, AI review defaults and prompts.

'use strict';

const { html } = require('../html');
const { thousands } = require('../../pipeline/compat');
const { ASR_DEVICE_VALUES, ASR_QUANT_VALUES } = require('../../config');
const { base } = require('./base');

const WRITERS = ['claude_code', 'codex', 'grok_build', 'none'];
const ASR_DEVICES = ASR_DEVICE_VALUES;
const ASR_QUANTS = ASR_QUANT_VALUES;
const USB_ACTION_OPTIONS = [
  ['archive', 'archive — copy only'],
  ['transcribe', 'transcribe — transcript only'],
  ['review', 'review — transcript + default AI reviews'],
  ['publish', 'publish — default AI reviews, then publish'],
];
const RUN_MODE_OPTIONS = [
  ['plug', 'plug — started by hand when you plug in, exits when idle'],
  ['always', 'always — resident at logon (Wi‑Fi / tunnel users)'],
];

function selected(on) {
  return on ? 'selected' : '';
}

function checked(on) {
  return on ? 'checked' : '';
}

function promptPanel(p, maxPromptChars) {
  const restore = p.custom
    ? html`
      <details class="confirm">
        <summary class="btn btn-secondary btn-small">Restore default</summary>
        <div class="confirm-pop confirm-pop-left">
          <p>Replace your ${p.label} prompt with the default?</p>
          <p class="muted">Your edited prompt is deleted. New ${p.label} reviews use the default.</p>
          <form method="post" action="/admin/prompts/${p.kind}/restore">
            <button type="submit" class="btn btn-danger btn-small">Restore default</button>
          </form>
        </div>
      </details>
      `
    : html`
      <button type="button" class="btn btn-secondary btn-small" disabled title="This prompt is already the default">Restore default</button>
      `;
  return html`
  <div class="panel prompt-panel" id="prompt-${p.kind}">
    <div class="panel-head">
      <h3 class="eyebrow eyebrow-bar">${p.label} prompt</h3>
      <span class="pill ${p.custom ? 'pill-ok' : 'pill-idle'}">${p.custom ? 'Custom' : 'Default'}</span>
    </div>
    ${p.error ? html`<p class="banner banner-bad">${p.error}</p>` : ''}
    <form method="post" action="/admin/prompts/${p.kind}" id="prompt-form-${p.kind}">
      <textarea name="prompt" class="prompt-text" rows="14" maxlength="${maxPromptChars}" spellcheck="false" aria-label="${p.label} prompt">${p.text}</textarea>
    </form>
    <div class="button-row">
      <button type="submit" form="prompt-form-${p.kind}" class="btn btn-small">Save</button>
      ${restore}
    </div>
    <p class="caption">The server always adds the fixed part: which file to write, the title heading, photos, the recording's date and length, and "never invent facts". Up to ${thousands(maxPromptChars)} characters.</p>
  </div>
  `;
}

const SCRIPTS = html`
<script>
(() => {
  // Live preview: the sample recording in the theme picked in the list (built on its first view).
  const select = document.getElementById("theme-select");
  const frame = document.getElementById("theme-preview");
  select.addEventListener("change", () => {
    frame.src = \`/admin/theme-preview/\${encodeURIComponent(select.value)}/summary.html\`;
  });
})();
</script>
`;

/**
 * @param {object} page path, refresh, config, saved, restartNote, gwsPath, prompts, reviewKinds,
 *   labels, maxPromptChars, themes, themeChanged, promptSaved, promptRestored
 */
function config(page) {
  const { config: cfg, labels } = page;
  const current = page.themes.find((t) => t.id === cfg.theme);
  const themeName = current ? current.name : cfg.theme;
  const isLabel = (kind) => kind !== null && Object.hasOwn(labels, kind);
  const body = html`


<h1>Settings</h1>
${page.saved ? html`<p class="ok">Saved to config.toml.</p>` : ''}
${page.restartNote ? html`<p class="warn">Listen host/port changes take effect on restart.</p>` : ''}
${page.themeChanged ? html`<p class="ok">Pages built from now on use ${themeName}. Published pages keep their theme until you <a href="#pages">republish them</a>.</p>` : ''}
${isLabel(page.promptSaved) ? html`<p class="ok">Saved the ${labels[page.promptSaved]} prompt.</p>` : ''}
${isLabel(page.promptRestored) ? html`<p class="ok">Restored the default ${labels[page.promptRestored]} prompt.</p>` : ''}

<form method="post" action="/admin/config" class="stack" id="settings">
  <label>server_name <input type="text" name="server_name" value="${cfg.server_name}"></label>
  <label>listen_host <input type="text" name="listen_host" value="${cfg.listen_host}"></label>
  <label>listen_port <input type="number" name="listen_port" value="${cfg.listen_port}"></label>
  <p class="muted">Datastore (not editable here): <span class="path">${cfg.datastore}</span></p>
  <h2>Publish (optional)</h2>
  <label>webdav_folder <input type="text" name="webdav_folder" value="${cfg.webdav_folder}"></label>
  <label>public_url_base <input type="text" name="public_url_base" value="${cfg.public_url_base}" placeholder="https://… (empty = publish not configured)"></label>
  <p class="muted">The page theme is under <a href="#pages">Pages</a> below.</p>
  <h2>AI reviews writer (optional — needs a writer CLI logged in on this PC)</h2>
  <p class="muted">Which reviews are written by default, and their prompts, are under <a href="#reviews">AI reviews</a> below.</p>
  <label>default_writer
    <select name="default_writer">
      ${WRITERS.map((w) => html`
      <option value="${w}" ${selected(cfg.default_writer === w)}>${w}</option>
      `)}
    </select>
  </label>
  <label>writer_timeout_s <input type="number" name="writer_timeout_s" value="${cfg.writer_timeout_s}"></label>
  <label>claude_cmd <input type="text" name="claude_cmd" value="${cfg.claude_cmd}"></label>
  <label>codex_cmd <input type="text" name="codex_cmd" value="${cfg.codex_cmd}"></label>
  <label>grok_cmd <input type="text" name="grok_cmd" value="${cfg.grok_cmd}"></label>
  <label>asr_model <input type="text" name="asr_model" value="${cfg.asr_model}"></label>
  <label>asr_quant
    <select name="asr_quant">
      ${ASR_QUANTS.map((q) => html`
      <option value="${q}" ${selected(cfg.asr_quant === q)}>${q}</option>
      `)}
    </select>
  </label>
  <label>asr_device
    <select name="asr_device">
      ${ASR_DEVICES.map((d) => html`
      <option value="${d}" ${selected(cfg.asr_device === d)}>${d}</option>
      `)}
    </select>
  </label>
  <label>asr_language <input type="text" name="asr_language" value="${cfg.asr_language}" placeholder="empty = auto-detect"></label>
  <label>pair_code_ttl_s <input type="number" name="pair_code_ttl_s" value="${cfg.pair_code_ttl_s}"></label>
  <h2>USB mode</h2>
  <label><input type="checkbox" name="usb_enabled" ${checked(cfg.usb_enabled)}> usb_enabled</label>
  <label>adb_cmd <input type="text" name="adb_cmd" value="${cfg.adb_cmd}"></label>
  <label>usb_poll_s <input type="number" name="usb_poll_s" min="1" value="${cfg.usb_poll_s}"></label>
  <label>usb_auto_action
    <select name="usb_auto_action">${USB_ACTION_OPTIONS.map(([value, label]) => html`
      <option value="${value}" ${selected(cfg.usb_auto_action === value)}>${label}</option>`)}
    </select>
  </label>
  <label>usb_device_root <input type="text" name="usb_device_root" value="${cfg.usb_device_root}"></label>
  <h2>Email (optional — needs the gws CLI signed in on this PC)</h2>
  <label><input type="checkbox" name="email_enabled" ${checked(cfg.email_enabled)}> email_enabled — email each finished job's summary (else another AI review, else the transcript)</label>
  <label>email_to <input type="text" name="email_to" value="${cfg.email_to}" placeholder="you@example.com"></label>
  <label>gws_cmd <input type="text" name="gws_cmd" value="${cfg.gws_cmd}"></label>
  <p class="muted">gws: <span class="path">${page.gwsPath || 'not found'}</span>. Sent from the Gmail account gws is signed in with (<span class="path">gws auth login</span>).</p>
  <h2>Lifecycle</h2>
  <label>run_mode
    <select name="run_mode">${RUN_MODE_OPTIONS.map(([value, label]) => html`
      <option value="${value}" ${selected(cfg.run_mode === value)}>${label}</option>`)}
    </select>
  </label>
  <label>idle_exit_min (plug mode) <input type="number" name="idle_exit_min" min="1" value="${cfg.idle_exit_min}"></label>
  <p class="muted">Saving run_mode also sets how R1CORD Desktop starts: always = at login, plug = when the R1 is plugged in. The tray icon's Start menu does the same.</p>
  <label><input type="checkbox" name="admin_remote" ${checked(cfg.admin_remote)}> Allow admin through the tunnel (password required)</label>
  <p>admin_password: <span class="path">${cfg.admin_password}</span> <span class="muted">— only asked for when the admin page is reached through a tunnel or proxy; direct access on this PC needs no login.</span></p>
  <label>new_admin_password (leave blank to keep)
    <input type="password" name="new_admin_password" value="" autocomplete="new-password">
  </label>
  <button type="submit">Save</button>
</form>
<p class="muted">Listen host and port changes take effect on restart.</p>

<section class="panel" id="pages">
  <div class="panel-head">
    <h2 class="eyebrow eyebrow-bar">Pages</h2>
  </div>
  <p class="lede">Each recording's pages are built on this PC in this theme, published or not; publishing copies that same build. A new theme applies to pages built from now on; pages already published keep theirs until you republish them.</p>
  <label>theme
    <select name="theme" form="settings" id="theme-select">
      ${page.themes.map((t) => html`
      <option value="${t.id}" ${selected(t.id === cfg.theme)}>${t.name}</option>
      `)}
    </select>
  </label>
  <iframe class="theme-preview" id="theme-preview" src="/admin/theme-preview/${cfg.theme}/summary.html" title="A sample recording in the chosen theme"></iframe>
  <p class="caption">Preview: a sample recording in the theme chosen above. Save to use it.</p>
  <div class="button-row">
    <button type="submit" form="settings" class="btn btn-small">Save theme</button>
    <form method="post" action="/admin/republish?dry_run=1" data-busy>
      <button type="submit" class="btn btn-secondary btn-small">Preview republish</button>
    </form>
    <details class="confirm">
      <summary class="btn btn-secondary btn-small">Republish all pages</summary>
      <div class="confirm-pop confirm-pop-left">
        <p>Rebuild every published recording in <strong>${themeName}</strong> and replace its pages?</p>
        <p class="muted">Each recording's folder gets the rebuilt pages; the MD DOCS files they replace (the page's .css and _images folder) are removed. Nothing else is touched.</p>
        <form method="post" action="/admin/republish" data-busy>
          <button type="submit" class="btn btn-danger btn-small">Republish all pages</button>
        </form>
      </div>
    </details>
  </div>
</section>

<section class="reviews-settings" id="reviews">
  <h2 class="eyebrow eyebrow-bar">AI reviews</h2>
  <p class="lede">A writer CLI rewrites each transcript into the reviews chosen for it. These are the defaults for USB mode and imports; the R1 chooses its own on each Send.</p>
  <fieldset class="review-defaults">
    <legend>Default reviews</legend>
    
    <input type="hidden" name="default_reviews" value="" form="settings">
    ${page.reviewKinds.map((kind) => html`
    <label class="check"><input type="checkbox" name="default_reviews" value="${kind}" form="settings" ${checked(cfg.default_reviews.includes(kind))}> ${labels[kind]}</label>
    `)}
    <button type="submit" form="settings" class="btn btn-secondary btn-small">Save defaults</button>
  </fieldset>

  ${page.prompts.map((p) => promptPanel(p, page.maxPromptChars))}
</section>
`;
  return base({ path: page.path, refresh: page.refresh, title: 'Settings — R1CORD Server', body, scripts: SCRIPTS });
}

module.exports = { config };
