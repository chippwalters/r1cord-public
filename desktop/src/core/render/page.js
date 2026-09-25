// Page shells reproducing MD DOCS' browser export: two layouts chosen by the
// theme, Jinja templates ported to plain JS template functions with MarkupSafe
// HTML escaping. No inline script or style.

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ASSETS_DIR = path.join(__dirname, '..', '..', '..', 'r1cord_server', 'render', 'assets');

const IMPORT = /@import\s+(?:url\(\s*)?['"]?(https:\/\/[^'")\s;]+)/gi;
const FONT_FACE = /@font-face\s*\{[^}]*\}/gi;
const URL_IN_BLOCK = /url\(\s*['"]?(https:\/\/[^'")\s]+)/gi;
const HOST = /^[a-z0-9.-]+(?::[0-9]+)?$/;
const FONT_FILES_HOST = { 'https://fonts.googleapis.com': 'https://fonts.gstatic.com' };

const assetCache = new Map();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/>/g, '&gt;')
    .replace(/</g, '&lt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&#34;');
}

function defaultMode(theme) {
  return theme.id === 'altuit-toc-light' || theme.light ? 'light' : 'dark';
}

function originOf(url) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch (_error) {
    return null;
  }
  return HOST.test(host) ? `https://${host}` : null;
}

function csp(theme) {
  const styleHosts = new Set();
  const fontHosts = new Set();
  const css = theme.css;
  let match;
  IMPORT.lastIndex = 0;
  while ((match = IMPORT.exec(css))) {
    const origin = originOf(match[1]);
    if (origin) {
      styleHosts.add(origin);
      fontHosts.add(FONT_FILES_HOST[origin] || origin);
    }
  }
  FONT_FACE.lastIndex = 0;
  while ((match = FONT_FACE.exec(css))) {
    URL_IN_BLOCK.lastIndex = 0;
    let urlMatch;
    while ((urlMatch = URL_IN_BLOCK.exec(match[0]))) {
      const origin = originOf(urlMatch[1]);
      if (origin) fontHosts.add(origin);
    }
  }
  const styles = Array.from(styleHosts).sort().map((host) => ` ${host}`).join('');
  const fonts = Array.from(fontHosts).sort().map((host) => ` ${host}`).join('');
  return (
    "default-src 'none'; img-src 'self' data:; "
    + `style-src 'self'${styles}; font-src 'self'${fonts}; script-src 'self'; `
    + "base-uri 'none'; form-action 'none'"
  );
}

function assetText(name) {
  if (!assetCache.has(name)) {
    assetCache.set(name, fs.readFileSync(path.join(ASSETS_DIR, name)).toString('utf8'));
  }
  return assetCache.get(name);
}

function siteCss(theme) {
  if (theme.layout === 'toc') return assetText('site.css');
  const colors = `:root {\n  --r1-bg: ${theme.background};\n  --r1-fg: ${theme.text};\n}\n\n`;
  return `${assetText('site.css')}\n${colors}${assetText('standard.css')}`;
}

function pageJs() {
  return assetText('page.js');
}

function buildToc(headings) {
  const top = [];
  let h1 = null;
  let h2 = null;

  function closeH2() {
    if (h2) {
      (h1 ? h1.children : top).push(h2);
      h2 = null;
    }
  }

  function closeH1() {
    closeH2();
    if (h1) {
      top.push(h1);
      h1 = null;
    }
  }

  for (const heading of headings) {
    const entry = { id: heading.id, html: heading.html, section: '', children: [] };
    if (heading.level === 1) {
      closeH1();
      entry.section = 'toc-h1';
      h1 = entry;
    } else if (heading.level === 2) {
      closeH2();
      entry.section = 'toc-h2';
      h2 = entry;
    } else {
      (h2 ? h2.children : h1 ? h1.children : top).push(entry);
    }
  }
  closeH1();
  return top;
}

function tocEntry(entry) {
  if (entry.section) {
    const collapsed = entry.section !== 'toc-h1' ? ' collapsed' : '';
    const empty = entry.children.length === 0 ? ' toc-toggle-empty' : '';
    let html = `<li class="toc-section ${escapeHtml(entry.section)}${collapsed}">\n`;
    html += '<div class="toc-section-header">\n';
    html += `<span class="toc-toggle${empty}">&#9660;</span>\n`;
    html += `<a href="#${escapeHtml(entry.id)}">${entry.html}</a>\n`;
    html += '</div>\n';
    if (entry.children.length) {
      html += '<ul class="toc-children">\n';
      for (const child of entry.children) html += tocEntry(child);
      html += '</ul>\n';
    }
    html += '</li>\n';
    return html;
  }
  return `<li><a href="#${escapeHtml(entry.id)}">${entry.html}</a></li>\n`;
}

function renderNav(nav, indent, linkClass) {
  let html = '';
  for (const item of nav) {
    const current = item.current ? ' aria-current="page"' : '';
    html += `${indent}<a class="${linkClass}" href="${escapeHtml(item.href)}"${current}>${escapeHtml(item.label)}</a>\n`;
  }
  return html;
}

function renderTocPage({ csp: policy, title, label, siteCssHref, themeCssHref, nav, mdHref, body, mode, toc, pageJsHref }) {
  let html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n';
  html += '  <meta charset="UTF-8">\n';
  html += `  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">\n`;
  html += '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  html += `  <title>${escapeHtml(title)} \u2014 ${escapeHtml(label)}</title>\n`;
  html += `  <link rel="stylesheet" href="${escapeHtml(siteCssHref)}">\n`;
  html += `  <link rel="stylesheet" href="${escapeHtml(themeCssHref)}">\n`;
  html += '</head>\n';
  html += `<body data-theme="${escapeHtml(mode)}">\n`;
  html += '  <header class="site-header">\n';
  html += '    <div class="header-inner">\n';
  html += `      <div class="brand">${escapeHtml(title)}</div>\n`;
  html += '      <nav class="r1-pages" aria-label="Pages">\n';
  html += renderNav(nav, '        ', 'btn');
  html += '      </nav>\n';
  html += '      <div class="spacer"></div>\n';
  html += '      <div class="r1-actions">\n';
  html += `        <a class="btn" id="downloadMd" href="${escapeHtml(mdHref)}" download>Download .md</a>\n`;
  html += '        <button class="btn" id="themeToggle" type="button">Toggle Theme</button>\n';
  html += '      </div>\n';
  html += '    </div>\n';
  html += '  </header>\n';
  html += '  <main class="layout">\n';
  html += '    <nav class="toc">\n';
  html += '      <div class="toc-header">\n';
  html += '        <h3>Contents</h3>\n';
  html += '        <div class="toc-controls">\n';
  html += '          <button id="tocExpandAll" type="button" title="Expand all">+</button>\n';
  html += '          <button id="tocCollapseAll" type="button" title="Collapse all">&minus;</button>\n';
  html += '        </div>\n';
  html += '      </div>\n';
  html += '      <ul id="tocList">\n';
  for (const entry of toc) html += tocEntry(entry);
  html += '      </ul>\n';
  html += '    </nav>\n';
  html += '    <section class="card">\n';
  html += '      <article class="doc">\n';
  html += `${body}\n`;
  html += '      </article>\n';
  html += '    </section>\n';
  html += '  </main>\n';
  html += `  <script src="${escapeHtml(pageJsHref)}"></script>\n`;
  html += '</body>\n';
  html += '</html>\n';
  return html;
}

function renderStandardPage({ csp: policy, title, label, siteCssHref, themeCssHref, nav, mdHref, body, themeId }) {
  let html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n';
  html += '  <meta charset="UTF-8">\n';
  html += `  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">\n`;
  html += '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  html += `  <title>${escapeHtml(title)} \u2014 ${escapeHtml(label)}</title>\n`;
  html += `  <link rel="stylesheet" href="${escapeHtml(siteCssHref)}">\n`;
  html += `  <link rel="stylesheet" href="${escapeHtml(themeCssHref)}">\n`;
  html += '</head>\n';
  html += `<body class="theme-${escapeHtml(themeId)}">\n`;
  html += '  <header class="r1-bar">\n';
  html += `    <span class="r1-title">${escapeHtml(title)}</span>\n`;
  html += '    <nav class="r1-pages" aria-label="Pages">\n';
  html += renderNav(nav, '      ', 'r1-link');
  html += '    </nav>\n';
  html += '    <span class="r1-spacer"></span>\n';
  html += `    <a class="r1-link r1-download" href="${escapeHtml(mdHref)}" download>Download .md</a>\n`;
  html += '  </header>\n';
  html += `${body}\n`;
  html += '</body>\n';
  html += '</html>\n';
  return html;
}

function renderPage({ theme, title, label, kind, nav, rendered, assets }) {
  const context = {
    csp: csp(theme),
    title,
    label,
    siteCssHref: assets.siteCss,
    themeCssHref: assets.themeCss,
    nav,
    mdHref: `${kind}.md`,
    body: rendered.html.replace(/\n+$/, ''),
  };
  if (theme.layout === 'toc') {
    return renderTocPage({
      ...context,
      mode: defaultMode(theme),
      toc: buildToc(rendered.headings),
      pageJsHref: assets.pageJs,
    });
  }
  return renderStandardPage({ ...context, themeId: theme.id });
}

module.exports = {
  ASSETS_DIR,
  escapeHtml,
  defaultMode,
  csp,
  siteCss,
  pageJs,
  buildToc,
  renderPage,
};
