// Markdown -> body HTML with MD DOCS' parser settings, minus raw HTML, plus the
// link/image policy. markdown-it 14 default (raw HTML escaped, tables, strikethrough)
// with linkify and typographer, heading ids from MD DOCS' slug algorithm, and task
// lists as disabled checkboxes.

const MarkdownIt = require('markdown-it');
const anchor = require('markdown-it-anchor');

const PHOTO_NAME = /^photo-[A-Za-z0-9._-]+\.jpg$/;
const PHOTO_SRC = /^photos\/(photo-[A-Za-z0-9._-]+\.jpg)$/;
const EXTERNAL = /^(?:https?:\/\/|mailto:)/i;
const WEB = /^https?:\/\//i;
const SIBLING = /^([a-z]+\.(?:html|md))(#[A-Za-z0-9_-]*)?$/;
const BRAND_HEADER = /^\uFEFF?(?:[ \t]*\r?\n)*[ \t]*\[brand-header\][ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/i;
const TAG = /<[^>]+>/g;
const GFM_WHITESPACE = /[ \t\n\v\f\r]/;

class Policy {
  constructor({ pages = [], photos = [] } = {}) {
    this.pages = pages instanceof Set ? pages : new Set(pages);
    this.photos = photos instanceof Set ? photos : new Set(photos);
  }
}

function slugify(text) {
  // MD DOCS' GitHub-style slug (anchorSlug.js slugify): JS \w is ASCII, \s is Unicode.
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function headingSlug(text) {
  // MD DOCS would emit id="" for a heading with no slug characters; give it a usable anchor.
  return slugify(text) || 'section';
}

function stripBrandHeader(markdown) {
  return String(markdown).replace(BRAND_HEADER, '');
}

function allowedHref(href, policy) {
  if (href.startsWith('#')) return true;
  if (EXTERNAL.test(href)) return true;
  const sibling = href.match(SIBLING);
  return Boolean(sibling && policy.pages.has(sibling[1]));
}

function applyPolicy(state) {
  const policy = state.env.policy;
  const shown = state.env.photos;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const children = [];
    const openLinks = [];
    for (const token of block.children) {
      if (token.type === 'link_open') {
        const href = String(token.attrGet('href') || '');
        const keep = allowedHref(href, policy);
        openLinks.push(keep);
        if (!keep) continue;
        if (WEB.test(href)) {
          token.attrSet('target', '_blank');
          token.attrSet('rel', 'noopener noreferrer');
        }
      } else if (token.type === 'link_close') {
        if (openLinks.length && !openLinks.pop()) continue;
      } else if (token.type === 'image') {
        const match = String(token.attrGet('src') || '').match(PHOTO_SRC);
        if (match && policy.photos.has(match[1])) {
          shown.add(match[1]);
        } else {
          const alt = state.md.renderer.renderInlineAsText(token.children || [], state.md.options, state.env);
          if (alt.trim()) {
            const open = new state.Token('em_open', 'em', 1);
            const text = new state.Token('text', '', 0);
            text.content = alt;
            const close = new state.Token('em_close', 'em', -1);
            children.push(open, text, close);
          }
          continue;
        }
      }
      children.push(token);
    }
    block.children = children;
  }
}

// Port of mdit_py_plugins.tasklists (itself a port of markdown-it-task-lists):
// disabled checkboxes, contains-task-list / task-list-item classes, raw html_inline input.
function tasklistsPlugin(md) {
  function parentToken(tokens, index) {
    const targetLevel = tokens[index].level - 1;
    for (let i = 1; i <= index; i += 1) {
      if (tokens[index - i].level === targetLevel) return index - i;
    }
    return -1;
  }

  function startsWithTodoMarkdown(token) {
    return /^\[[ xX]]/.test(token.content) && GFM_WHITESPACE.test(token.content.charAt(3));
  }

  function isTodoItem(tokens, index) {
    return (
      tokens[index].type === 'inline'
      && tokens[index - 1].type === 'paragraph_open'
      && tokens[index - 2].type === 'list_item_open'
      && startsWithTodoMarkdown(tokens[index])
    );
  }

  function todoify(token, Token) {
    const checkbox = new Token('html_inline', '', 0);
    if (token.content.startsWith('[ ] ')) {
      checkbox.content = '<input class="task-list-item-checkbox" disabled="disabled" type="checkbox">';
    } else if (token.content.startsWith('[x] ') || token.content.startsWith('[X] ')) {
      checkbox.content = '<input class="task-list-item-checkbox" checked="checked" disabled="disabled" type="checkbox">';
    }
    token.children.unshift(checkbox);
    token.children[1].content = token.children[1].content.slice(3);
    token.content = token.content.slice(3);
  }

  md.core.ruler.after('inline', 'github-tasklists', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length - 1; i += 1) {
      if (!isTodoItem(tokens, i)) continue;
      todoify(tokens[i], state.Token);
      tokens[i - 2].attrSet('class', 'task-list-item');
      const parent = parentToken(tokens, i - 2);
      if (parent >= 0) tokens[parent].attrSet('class', 'contains-task-list');
    }
  });
}

function build() {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
  md.use(anchor, {
    level: 1,
    slugify: headingSlug,
    uniqueSlugStartIndex: 1,
    tabIndex: false,
    permalink: false,
  });
  tasklistsPlugin(md);
  md.core.ruler.push('r1cord_policy', applyPolicy);
  return md;
}

const MD = build();

function render(markdown, policy = new Policy()) {
  const env = { policy, photos: new Set() };
  const tokens = MD.parse(markdown, env);
  const headings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'heading_open' && (token.tag === 'h1' || token.tag === 'h2' || token.tag === 'h3')) {
      const inline = MD.renderer.renderInline(tokens[index + 1].children || [], MD.options, env);
      const text = inline.replace(TAG, '').trim();
      if (text) headings.push({ level: Number(token.tag.slice(1)), id: String(token.attrGet('id')), html: text });
    }
  }
  const html = MD.renderer.render(tokens, MD.options, env);
  return { html, headings, photos: Array.from(env.photos).sort() };
}

function renderFragment(markdown) {
  return render(stripBrandHeader(markdown)).html;
}

module.exports = {
  PHOTO_NAME,
  Policy,
  slugify,
  stripBrandHeader,
  render,
  renderFragment,
};
