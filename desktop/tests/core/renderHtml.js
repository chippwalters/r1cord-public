// Tiny DOM + active-markup scanner for the renderer tests.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const FORBIDDEN = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'style', 'template']);
const ASSET_JS = /^assets\/page\.[0-9a-f]{12}\.js$/;
const ASSET_CSS = /^assets\/(?:site|theme)\.[0-9a-f]{12}\.css$/;
const WEB = /^(?:https?:\/\/|mailto:)/i;

class Node {
  constructor(tag, attrs) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
  }

  *iter() {
    yield this;
    for (const child of this.children) {
      if (child instanceof Node) yield* child.iter();
    }
  }

  findAll(match) {
    return [...this.iter()].filter(match);
  }

  byId(elementId) {
    const found = this.findAll((n) => n.attrs.id === elementId);
    if (found.length !== 1) throw new Error(`expected one #${elementId}, found ${found.length}`);
    return found[0];
  }

  text() {
    return this.children.map((child) => (typeof child === 'string' ? child : child.text())).join('');
  }
}

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
    const lower = body.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'minus') return '\u2212';
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (Number.isFinite(code)) return String.fromCharCode(code);
    }
    return entity;
  });
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : null;
    attrs[match[1]] = value === null ? null : decodeEntities(value);
  }
  return attrs;
}

function parse(html) {
  const root = new Node('#document', {});
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^>]*)>/g;
  let last = 0;
  let match;
  while ((match = re.exec(html))) {
    if (match.index > last) stack[stack.length - 1].children.push(decodeEntities(html.slice(last, match.index)));
    last = re.lastIndex;
    if (match[0].startsWith('<!--') || match[0].startsWith('<!')) continue;
    if (match[1]) {
      const tag = match[1].toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === tag) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    const tag = match[2].toLowerCase();
    let attrSource = match[3] || '';
    const selfClose = attrSource.trim().endsWith('/');
    if (selfClose) attrSource = attrSource.replace(/\/\s*$/, '');
    const node = new Node(tag, parseAttrs(attrSource));
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !selfClose) stack.push(node);
  }
  if (last < html.length) stack[stack.length - 1].children.push(decodeEntities(html.slice(last)));
  return root;
}

function activeMarkup(html, { pages = new Set(), photos = new Set() } = {}) {
  const pageSet = pages instanceof Set ? pages : new Set(pages);
  const photoSet = photos instanceof Set ? photos : new Set(photos);
  const problems = [];
  for (const node of parse(html).iter()) {
    const { tag, attrs } = node;
    for (const name of Object.keys(attrs)) {
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction' || name === 'xlink:href') {
        problems.push(`<${tag} ${name}>`);
      }
    }
    if (FORBIDDEN.has(tag)) {
      problems.push(`<${tag}>`);
    } else if (tag === 'script') {
      if (!ASSET_JS.test(attrs.src || '')) problems.push(`<script src=${JSON.stringify(attrs.src)}>`);
    } else if (tag === 'link') {
      if (!(attrs.rel === 'stylesheet' && ASSET_CSS.test(attrs.href || ''))) problems.push(`<link ${JSON.stringify(attrs)}>`);
    } else if (tag === 'meta') {
      if ((attrs['http-equiv'] || '').toLowerCase() === 'refresh') problems.push('<meta refresh>');
    } else if (tag === 'img') {
      if (![...photoSet].map((name) => `photos/${name}`).includes(attrs.src || '')) {
        problems.push(`<img src=${JSON.stringify(attrs.src)}>`);
      }
    } else if (tag === 'a' || tag === 'area') {
      const href = attrs.href;
      if (href !== undefined && !(href.startsWith('#') || WEB.test(href) || pageSet.has(href.split('#')[0]))) {
        problems.push(`<a href=${JSON.stringify(href)}>`);
      }
    } else if ('src' in attrs || 'href' in attrs || 'action' in attrs || 'data' in attrs) {
      problems.push(`<${tag} ${JSON.stringify(attrs)}>`);
    }
  }
  return problems;
}

module.exports = { Node, parse, activeMarkup };
