// templates/dashboard.html: the status strip and the recordings table.

'use strict';

const { pySplitlines } = require('../../pipeline/compat');
const { html, raw } = require('../html');
const { base } = require('./base');
const { pageLinks } = require('./page-links');

const PLAY_ICONS =
  '<svg class="i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg><svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.8h3v10.4H4zM9 2.8h3v10.4H9z"/></svg>';
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 1.5h2v6.8l2.4-2.4 1.4 1.4L8 12.1 3.2 7.3l1.4-1.4L7 8.3zM2.5 13h11v1.8h-11z"/></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3h4.8l1.5 1.5h6.7v8.5h-13z"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2.5h2v4.5h4.5v2H9v4.5H7V9H2.5V7H7z"/></svg>';
const TRASH_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5h4l.6 1H14v1.8H2V2.5h3.4zM3.3 5.2h9.4l-.7 9.3H4z"/></svg>';

function firstLine(text) {
  return pySplitlines(text)[0];
}

function actions(r, config, local) {
  const j = r.job;
  const name = j.title || j.recordingId;
  const busy = r.statusTone === 'work' || r.statusTone === 'idle';
  const audio = r.hasAudio
    ? html`
          <button type="button" class="icon-btn play-btn" data-play="/admin/recordings/${j.recordingId}/audio" title="Play" aria-label="Play">${raw(PLAY_ICONS)}</button>
          <a class="icon-btn" href="/admin/recordings/${j.recordingId}/audio" title="Download the audio" aria-label="Download">${raw(DOWNLOAD_ICON)}</a>
          ${
            local
              ? html`
          <form method="post" action="/admin/recordings/${j.recordingId}/folder">
            <button type="submit" class="icon-btn" title="Show in Explorer" aria-label="Show in folder">${raw(FOLDER_ICON)}</button>
          </form>
          `
              : ''
          }
          `
    : '';
  let review;
  if (busy) {
    review = html`
          <span class="icon-btn icon-btn-disabled" title="Busy — wait for the job to finish" aria-label="Add review unavailable">${raw(PLUS_ICON)}</span>
          `;
  } else if (!r.hasTranscript) {
    review = html`
          <span class="icon-btn icon-btn-disabled" title="No transcript yet — nothing to review" aria-label="Add review unavailable">${raw(PLUS_ICON)}</span>
          `;
  } else {
    review = html`
          <details class="confirm menu">
            <summary class="icon-btn" title="Add an AI review" aria-label="Add review">${raw(PLUS_ICON)}</summary>
            <div class="confirm-pop">
              <p>Add an AI review of <strong>${name}</strong></p>
              <form method="post" action="/admin/recordings/${j.recordingId}/reviews" class="review-menu" data-busy>
                ${r.reviews.map(
                  (c) => html`
                <button type="submit" name="kind" value="${c.kind}" class="btn btn-secondary btn-small">${c.verb} ${c.label}</button>
                `,
                )}
              </form>
              <p class="muted">Written from the transcript by ${config.default_writer !== 'none' ? config.default_writer : j.writer}${j.publish ? ', then published' : ''}.</p>
            </div>
          </details>
          `;
  }
  const remove = busy
    ? html`
          <span class="icon-btn icon-btn-disabled" title="Busy — wait for the job to finish" aria-label="Delete unavailable">${raw(TRASH_ICON)}</span>
          `
    : html`
          <details class="confirm">
            <summary class="icon-btn icon-btn-danger" title="Delete from this PC" aria-label="Delete">${raw(TRASH_ICON)}</summary>
            <div class="confirm-pop">
              <p>Delete <strong>${name}</strong> from this PC?</p>
              <p class="muted">Audio, transcript, AI reviews, published pages and job history are removed. The R1 keeps its copy, and USB mode will not copy it back.</p>
              <form method="post" action="/admin/recordings/${j.recordingId}/delete" data-busy>
                <button type="submit" class="btn btn-danger btn-small">Delete recording</button>
              </form>
            </div>
          </details>
          `;
  return html`
          ${audio}
          ${review}
          ${remove}
        `;
}

function row(r, config, local) {
  const j = r.job;
  return html`
      
      <tr>
        <td class="rec">
          <a class="rec-title" href="/admin/jobs/${j.jobId}">${j.title || j.recordingId}</a>
          <span class="rec-id">${j.recordingId}${r.runs > 1 ? html` · ${r.runs} runs` : ''}</span>
          ${r.pages.length ? html`
          <span class="rec-pages">${pageLinks(r.pages)}</span>
          ` : ''}
        </td>
        <td class="num len" data-len="${r.duration || '—'}">${r.duration || '—'}</td>
        <td class="num">${r.size || '—'}</td>
        <td><span class="pill pill-${r.statusTone}" ${j.error ? html`title="${firstLine(j.error)}"` : ''}>${r.statusLabel}</span></td>
        <td class="mono-cell">${j.reviews.length ? j.writer : '—'}</td>
        <td class="mono-cell">${r.updated}</td>
        <td class="actions">${actions(r, config, local)}</td>
      </tr>
    `;
}

function statusStrip({ config, usb, device, running, runningLabel, queued, issues }) {
  const deviceValue = !usb.enabled ? 'USB mode off' : device ? html`${device} connected` : 'No device connected';
  let deviceSub;
  if (usb.syncing) deviceSub = html`Copying ${usb.syncing}…`;
  else if (usb.enabled) deviceSub = html`New recordings: ${config.usb_auto_action}`;
  else deviceSub = 'Recordings arrive only by Send';
  const now = running
    ? html`
    <span class="tile-value"><span class="dot dot-work"></span>${runningLabel} · <a href="/admin/jobs/${running.job.jobId}">${running.job.title || running.job.recordingId}</a></span>
    <span class="tile-sub">${running.elapsed} in this step</span>
    `
    : html`
    <span class="tile-value"><span class="dot dot-off"></span>Idle</span>
    <span class="tile-sub">Nothing is being processed</span>
    `;
  const system = issues.length
    ? html`
    <span class="tile-value"><span class="dot dot-bad"></span>${issues.length} need${issues.length === 1 ? 's' : ''} attention</span>
    <span class="tile-sub">${issues[0].name}${issues.length > 1 ? html` and ${issues.length - 1} more` : ''}</span>
    `
    : html`
    <span class="tile-value"><span class="dot dot-ok"></span>Ready</span>
    <span class="tile-sub">All checks pass</span>
    `;
  return html`<section class="status-strip" aria-label="Status">
  <a class="tile" href="/admin/devices">
    <span class="eyebrow">Device</span>
    <span class="tile-value"><span class="dot ${device ? 'dot-ok' : 'dot-off'}"></span>${deviceValue}</span>
    <span class="tile-sub">${deviceSub}</span>
  </a>
  <div class="tile">
    <span class="eyebrow">Now</span>
    ${now}
  </div>
  <div class="tile">
    <span class="eyebrow">Queue</span>
    <span class="tile-value">${queued ? html`${queued} waiting` : 'Empty'}</span>
    <span class="tile-sub">Jobs run one at a time</span>
  </div>
  <a class="tile" href="/admin/system">
    <span class="eyebrow">System</span>
    ${system}
  </a>
</section>`;
}

function scripts(refresh) {
  return html`
<script>
(() => {
  // One player for the page: Play starts a recording here in the browser, a second press pauses,
  // and the Length cell counts up while it plays.
  const audio = new Audio();
  let button = null;
  const clock = (s) => \`\${Math.floor(s / 60)}:\${String(Math.floor(s % 60)).padStart(2, "0")}\`;
  const lenCell = (btn) => btn.closest("tr").querySelector(".len");
  const show = (btn, playing) => {
    btn.classList.toggle("is-playing", playing);
    btn.title = playing ? "Pause" : "Play";
    btn.setAttribute("aria-label", btn.title);
  };
  const reset = (btn) => { show(btn, false); const c = lenCell(btn); c.textContent = c.dataset.len; };
  document.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-play]");
    if (!btn) return;
    if (btn === button) { audio.paused ? audio.play() : audio.pause(); return; }
    if (button) reset(button);
    button = btn;
    audio.src = btn.dataset.play;
    audio.play().catch(() => { reset(btn); btn.title = "Could not play this recording"; });
  });
  audio.addEventListener("play", () => button && show(button, true));
  audio.addEventListener("pause", () => button && show(button, false));
  audio.addEventListener("ended", () => { if (button) reset(button); button = null; });
  audio.addEventListener("timeupdate", () => {
    if (button) lenCell(button).textContent = \`\${clock(audio.currentTime)} / \${lenCell(button).dataset.len}\`;
  });
  ${refresh ? raw(`
  // Keep the page current while a job runs, but never reload over a recording that is playing.
  setInterval(() => { if (audio.paused) location.reload(); }, 5000);
  `) : ''}
})();
</script>
`;
}

/**
 * @param {object} page path, config, rows, running, runningLabel, queued, usb, device, issues,
 *   local, notice, deleted, refresh
 */
function dashboard(page) {
  const { config, rows, local, notice, deleted, refresh } = page;
  const table = rows.length
    ? html`
  <div class="table-scroll">
  <table class="recordings">
    <thead>
      <tr>
        <th>Recording</th><th class="num">Length</th><th class="num">Size</th><th>Status</th><th>Writer</th><th>Updated</th><th class="actions-head"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
    ${rows.map((r) => row(r, config, local))}
    </tbody>
  </table>
  </div>
  `
    : html`
  <p class="empty">No recordings yet. Plug in an adopted R1, or press Send on one.</p>
  `;
  const body = html`
${notice ? html`<p class="banner banner-bad">${notice}</p>` : ''}
${deleted ? html`<p class="banner banner-ok">Deleted ${deleted} from this PC. The R1 keeps its own copy.</p>` : ''}

${statusStrip(page)}

<section class="panel" id="recordings">
  <div class="panel-head">
    <h1 class="eyebrow eyebrow-bar">Recordings <span class="count">${rows.length}</span></h1>
    <a class="btn btn-secondary btn-small" href="/admin/import">Import a folder</a>
  </div>
  ${table}
</section>
`;
  // Reloading is done by the page script, so a recording that is playing is not cut off.
  return base({
    path: page.path,
    title: 'Recordings — R1CORD Server',
    refreshBlock: '',
    body,
    scripts: scripts(refresh),
  });
}

module.exports = { dashboard };
