// Native HTML renderer for recording pages: MD DOCS' themes and export shell.

const { renderFragment } = require('./markdown');
const { MANIFEST_NAME, PAGE_KINDS, RENDERER_VERSION, PageSource, SiteManifest, buildSite, deploySite } = require('./site');
const { DEFAULT_THEME_ID, Theme, getTheme, listThemes } = require('./themes');

module.exports = {
  DEFAULT_THEME_ID,
  MANIFEST_NAME,
  PAGE_KINDS,
  RENDERER_VERSION,
  PageSource,
  SiteManifest,
  Theme,
  buildSite,
  deploySite,
  getTheme,
  listThemes,
  renderFragment,
};
