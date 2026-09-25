// templates/import.html: import a recording folder and queue it.

'use strict';

const { html } = require('../html');
const { base } = require('./base');

/** @param {object} page path, refresh, config, error, reviewKinds, labels */
function importPage(page) {
  const { config, labels } = page;
  const body = html`
<h1>Import folder</h1>
${page.error ? html`<p class="error">${page.error}</p>` : ''}
<form method="post" action="/admin/import" class="stack">
  <label>Folder path <input type="text" name="folder" required placeholder="D:\\path\\to\\recording"></label>
  <label>Title (optional) <input type="text" name="title"></label>
  <fieldset class="review-defaults">
    <legend>AI reviews</legend>
    <input type="hidden" name="reviews" value="">
    ${page.reviewKinds.map(
      (kind) => html`
    <label class="check"><input type="checkbox" name="reviews" value="${kind}" ${config.default_reviews.includes(kind) ? 'checked' : ''}> ${labels[kind]}</label>
    `,
    )}
  </fieldset>
  <label class="check"><input type="checkbox" name="publish" value="on" checked> Publish</label>
  <button type="submit">Import and queue</button>
</form>
`;
  return base({ path: page.path, refresh: page.refresh, title: 'Import folder — R1CORD Server', body });
}

module.exports = { importPage };
