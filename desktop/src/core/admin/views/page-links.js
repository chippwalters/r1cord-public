// templates/_page_links.html: a recording's pages in page order, the published page or else the
// copy built on this PC (tagged local), each followed by its Markdown source.

'use strict';

const { html } = require('../html');

/**
 * @param {Array<{label: string, url: string, local: boolean, mdUrl: string|null, mdLocal: boolean}>} pages
 */
function pageLinks(pages) {
  return html`${pages.map(
    (p) => html`
<span>${
      p.local
        ? html`<a class="page-link page-local" href="${p.url}" title="Not published — view the copy on this PC">${p.label}<span class="page-tag">local</span></a>`
        : html`<a class="page-link" href="${p.url}" target="_blank" rel="noopener" title="Published page">${p.label}</a>`
    }
  ${
    p.mdUrl
      ? html`<a class="page-link page-local" href="${p.mdUrl}" download title="Download the ${p.label} Markdown${p.mdLocal ? '' : ' (published)'}">.md</a>`
      : ''
  }
</span>
`,
  )}`;
}

module.exports = { pageLinks };
