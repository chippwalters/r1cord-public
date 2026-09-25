// Port of r1cord_server/naming.py: publish-folder slug, collision suffix, public WebDAV
// URL. Lexical path handling only — Path.resolve()/realpath raise WinError 1005 on the
// rclone WebDAV mount.

const fs = require('node:fs');
const path = require('node:path');
const { PAGE_KINDS } = require('./config');
const { pathParts, pathString } = require('./paths');

const NON_SLUG = /[^a-z0-9]+/g;
const SLUG_MAX = 48;

function slugify(title) {
  let s = String(title).trim().toLowerCase().replace(NON_SLUG, '-').replace(/^-+|-+$/g, '');
  if (!s) return 'recording';
  s = s.slice(0, SLUG_MAX).replace(/-+$/g, '');
  return s || 'recording';
}

// str(Path(p)).replace("/", "\\").lower() from naming.py: one lexical form per folder.
function norm(value) {
  return pathString(value).toLowerCase();
}

// `<webdav_folder>\<YYYY>\<MM>\<YYYYMMDD-HHMM>-<slug>\` in local time.
//
// If that folder already exists for a *different* recording id (on disk or in `occupied`
// as [folderPath, recordingId] pairs), append `-2`, `-3`, ... The same recording id
// reuses its folder so the public URL stays stable.
function publishFolder(config, createdAtMs, title, recordingId, occupied = null) {
  const date = new Date(Number(createdAtMs));
  const pad = (value) => String(value).padStart(2, '0');
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const stamp = `${year}${month}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slug = slugify(title);
  const parent = path.join(String(config.webdav_folder), year, month);
  const baseName = `${stamp}-${slug}`;

  const occupiedMap = new Map();
  for (const [folder, owner] of occupied || []) occupiedMap.set(norm(folder), owner);

  let n = 1;
  for (;;) {
    const name = n === 1 ? baseName : `${baseName}-${n}`;
    const candidate = path.join(parent, name);
    const owner = occupiedMap.get(norm(candidate));
    if (owner === recordingId) return candidate;
    const taken = owner !== undefined || fs.existsSync(candidate);
    if (!taken) return candidate;
    n += 1;
  }
}

// urllib.parse.quote(segment, safe="-_."): unreserved ASCII only, uppercase percent
// escapes, UTF-8 bytes.
function quoteSegment(value) {
  let out = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.~-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// `<public_url_base>/<YYYY>/<MM>/<folder>/<page>` with encoded segments.
//
// Root matching is case-insensitive and boundary-aware (a sibling like `wd2` next to
// root `wd` is not under the root); a folder outside the root falls back to its last
// three segments.
function webdavUrl(config, folder, page = 'summary.html') {
  const segments = pathParts(folder);
  const rootParts = pathParts(config.webdav_folder).map(norm);
  const folderParts = segments.map(norm);
  const underRoot = folderParts.length > rootParts.length
    && rootParts.every((part, index) => folderParts[index] === part);
  const relative = underRoot ? segments.slice(rootParts.length) : segments.slice(-3);
  const base = String(config.public_url_base ?? '').replace(/\/+$/, '');
  return `${base}/${[...relative, page].map(quoteSegment).join('/')}`;
}

// `{"<kind>.html" | "<kind>.md": url}` for each page file in a recording's publish folder.
// One directory listing, no resolve(): the folder usually sits on the rclone WebDAV
// mount. A missing or unreadable folder has no pages.
function publishedFiles(config, folder) {
  if (!folder) return {};
  let names;
  try {
    names = new Set(fs.readdirSync(folder).map((name) => name.toLowerCase()));
  } catch (error) {
    return {};
  }
  const files = {};
  for (const kind of PAGE_KINDS) {
    for (const name of [`${kind}.html`, `${kind}.md`]) {
      if (names.has(name)) files[name] = webdavUrl(config, folder, name);
    }
  }
  return files;
}

// `[{"kind", "url"}]` for every `<kind>.html` in a recording's publish folder, in page order.
function publishedPages(config, folder) {
  const files = publishedFiles(config, folder);
  return PAGE_KINDS
    .filter((kind) => Object.prototype.hasOwnProperty.call(files, `${kind}.html`))
    .map((kind) => ({ kind, url: files[`${kind}.html`] }));
}

// True when `folder` sits strictly inside `webdav_folder`: never the root itself, never
// outside it. Lexical (resolve() raises WinError 1005 on the rclone WebDAV mount), but
// relative paths are made absolute against the cwd like Python's os.path.abspath.
function inPublishRoot(config, folder) {
  const root = pathParts(path.resolve(String(config.webdav_folder))).map(norm);
  const parts = pathParts(path.resolve(String(folder))).map(norm);
  return parts.length > root.length && root.every((part, index) => parts[index] === part);
}

module.exports = { slugify, publishFolder, webdavUrl, publishedFiles, publishedPages, inPublishRoot };
