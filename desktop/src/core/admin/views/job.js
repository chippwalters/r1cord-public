// templates/job.html: one job's result, files, email and retry forms, and log.

'use strict';

const { html } = require('../html');
const { base } = require('./base');
const { pageLinks } = require('./page-links');

function joined(items, render, empty) {
  if (!items.length) return empty;
  return html`${items.map((item, index) => html`${render(item)}${index < items.length - 1 ? ' · ' : ''}`)}`;
}

function jobBody(page) {
  const { config, job, result, labels, pages, files, active } = page;
  const busy = active ? html`disabled title="Busy — wait for the job to finish"` : '';
  const asr = result.asr
    ? html`
      ${result.asr.model} / ${result.asr.device} / ${result.asr.language}
      `
    : '—';
  const emailTo = config.email_to
    ? html`to ${config.email_to}`
    : html`Set email_to on the <a href="/admin/config">Settings</a> page first.`;
  return html`
<h1>${job.title}</h1>
<p class="muted">${job.jobId} · ${job.recordingId} · ${job.status}</p>

${job.error ? html`<p class="error">${job.error}</p>` : ''}
${active ? html`<p class="banner banner-work busy-banner"><span class="spinner" aria-hidden="true"></span> Working: ${job.status}. This page updates by itself.</p>` : ''}

<section class="card">
  <h2>Result</h2>
  <dl class="grid">
    <dt>status</dt><dd>${result.status}</dd>
    <dt>error</dt><dd>${result.error || '—'}</dd>
    <dt>writer</dt><dd>${result.writer}</dd>
    <dt>AI reviews</dt><dd>${joined(result.reviews, (kind) => labels[kind], 'none (transcript only)')}</dd>
    <dt>publish</dt><dd>${result.publish}</dd>
    <dt>created</dt><dd>${result.createdAt}</dd>
    <dt>updated</dt><dd>${result.updatedAt}</dd>
    <dt>publish folder</dt><dd class="path">${result.publishFolder || '—'}</dd>
    <dt>pages</dt>
    <dd>${pages.length ? html`<span class="rec-pages">${pageLinks(pages)}</span>` : 'none yet'}</dd>
    <dt>timings (ms)</dt>
    <dd>asr ${result.timingsMs.asr} · writer ${result.timingsMs.writer} · publish ${result.timingsMs.publish}</dd>
    <dt>asr</dt>
    <dd>
      ${asr}
    </dd>
  </dl>
</section>

<section class="card">
  <h2>Outbox files</h2>
  <ul>
    ${
      files.length
        ? files.map(
            (name) => html`
    <li><a href="/admin/files/${job.recordingId}/${name}">${name}</a></li>
    `,
          )
        : html`
    <li class="muted">None yet.</li>
    `
    }
  </ul>
</section>

<section class="card">
  <h2>Email</h2>
  <form method="post" action="/admin/jobs/${job.jobId}/email">
    <button type="submit" ${config.email_to ? '' : 'disabled'}>Email review</button>
    <span class="muted">${emailTo}</span>
  </form>
</section>

<section class="card">
  <h2>Retry</h2>
  <div class="retry-grid">
    <form method="post" action="/admin/jobs/${job.jobId}/retry-writer" class="retry-block" data-busy>
      <h3>Rewrite AI reviews</h3>
      <p class="muted">Runs the writer again on the stored transcript for the reviews you tick, then republishes the pages.</p>
      <label>Writer
        <select name="writer">
          <option value="">Same as last time (${job.writer})</option>
          <option value="claude_code">claude_code</option>
          <option value="codex">codex</option>
          <option value="grok_build">grok_build</option>
        </select>
      </label>
      <input type="hidden" name="reviews" value="">
      <div class="retry-checks">
        ${page.reviewKinds.map(
          (kind) => html`
        <label class="check"><input type="checkbox" name="reviews" value="${kind}" ${page.retryReviews.includes(kind) ? 'checked' : ''}> ${labels[kind]}</label>
        `,
        )}
      </div>
      <button type="submit" ${busy}>Rewrite reviews</button>
    </form>
    <form method="post" action="/admin/jobs/${job.jobId}/retry-publish" class="retry-block" data-busy>
      <h3>Republish pages</h3>
      <p class="muted">Rebuilds the HTML and .md pages from the reviews already written, in the current theme, and copies them to the publish folder. No AI runs.</p>
      <button type="submit" class="btn-secondary" ${busy}>Republish pages</button>
    </form>
  </div>
</section>

<section class="card">
  <h2>Log</h2>
  <pre class="log">${page.logLines.map((line) => html`${line}\n`)}</pre>
</section>
`;
}

/**
 * @param {object} page path, refresh, config, job (null when unknown), jobId, notice, sent, and for
 *   a known job: result, labels, pages, reviewKinds, retryReviews, logLines, files, active
 */
function job(page) {
  const body = html`
${page.notice ? html`<p class="error">${page.notice}</p>` : ''}
${page.sent ? html`<p class="ok">Emailed to ${page.sent}.</p>` : ''}
${
  page.job
    ? jobBody(page)
    : html`
<h1>Unknown job</h1>
<p class="muted">${page.jobId}</p>
`
}
`;
  return base({ path: page.path, refresh: page.refresh, title: html`Job ${page.jobId} — R1CORD Server`, body });
}

module.exports = { job };
