// The 12 MD DOCS themes vendored in r1cord_server/render/themes, with metadata
// parsed exactly as MD DOCS does (src/main.js, themes:read-all).

const fs = require('node:fs');
const path = require('node:path');
const { ValueError } = require('../errors');

const THEMES_DIR = path.join(__dirname, '..', '..', '..', 'r1cord_server', 'render', 'themes');
const DEFAULT_THEME_ID = 'toolmaker-noir';

// Same patterns as MD DOCS; JS \w without the unicode flag is ASCII-only.
const NAME = /@name\s+(.+)/;
const BACKGROUND = /@background\s+(#[0-9A-Fa-f]{6})/;
const TEXT = /@text\s+(#[0-9A-Fa-f]{6})/;
const LAYOUT = /@layout\s+(\w+)/;

class Theme {
  constructor({ id, name, background, text, layout, css }) {
    this.id = id;
    this.name = name;
    this.background = background;
    this.text = text;
    this.layout = layout;
    this.css = css;
  }

  // MD DOCS' export default: a theme whose @background red channel is >= 128 opens light.
  get light() {
    return parseInt(this.background.slice(1, 3), 16) >= 128;
  }
}

function parseTheme(themeId, css) {
  const name = css.match(NAME);
  const background = css.match(BACKGROUND);
  const text = css.match(TEXT);
  const layout = css.match(LAYOUT);
  const declared = layout ? layout[1].trim().toLowerCase() : 'standard';
  return new Theme({
    id: themeId,
    name: name ? name[1].trim() : 'Untitled Theme',
    background: background ? background[1] : '#FFFFFF',
    text: text ? text[1] : '#000000',
    layout: declared === 'toc' || themeId.startsWith('altuit-toc') ? 'toc' : 'standard',
    css,
  });
}

function pyRepr(value) {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(value);
}

let cachedThemes = null;

function themes() {
  if (cachedThemes) return cachedThemes;
  const found = [];
  for (const name of fs.readdirSync(THEMES_DIR)) {
    if (!name.endsWith('.css')) continue;
    const css = fs.readFileSync(path.join(THEMES_DIR, name));
    found.push(parseTheme(path.parse(name).name, css.toString('utf8')));
  }
  found.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  cachedThemes = found;
  return cachedThemes;
}

function listThemes() {
  return themes().slice();
}

function getTheme(theme) {
  const wanted = String(theme).trim().toLowerCase();
  for (const candidate of themes()) {
    if (wanted === candidate.id.toLowerCase() || wanted === candidate.name.toLowerCase()) {
      return candidate;
    }
  }
  throw new ValueError(`unknown theme: ${pyRepr(theme)}`);
}

module.exports = {
  THEMES_DIR,
  DEFAULT_THEME_ID,
  Theme,
  parseTheme,
  listThemes,
  getTheme,
};
