#!/usr/bin/env node
// Stage the R1 APKs that R1CORD Desktop bundles for offline USB setup: the newest R1CORD app and
// device-controls helper from a release folder go into resources/apk/, which forge.config.cjs
// ships as the packaged app's resources/apk. Every candidate must pass the APK Signature Scheme
// v2/v3 check and carry its pinned signer; anything else stops the script.
//
//   node scripts/stage-apks.js [--from <dir>]
//
// The source folder must hold R1CORD-<version>.apk and R1CORD-controls-<version>.apk (e.g. the
// downloaded auto-update-files folder). It is, in order: --from <dir>, R1CORD_APK_DIR, else the
// app's dist/release/auto-update-files found next to this project (public monorepo: ../dist/...;
// separate app checkout: ../r1cord/dist/...).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { checkPinned, verifyApk } = require('../src/core/apk');
const { pinFor } = require('../src/core/release-keys');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCES = [
  path.resolve(ROOT, '..', 'dist', 'release', 'auto-update-files'),
  path.resolve(ROOT, '..', 'r1cord', 'dist', 'release', 'auto-update-files'),
];
const USAGE = 'usage: node scripts/stage-apks.js [--from <dir>]\n'
  + '  <dir> holds R1CORD-<version>.apk and R1CORD-controls-<version>.apk (e.g. the downloaded\n'
  + '  auto-update-files folder); defaults to R1CORD_APK_DIR, else\n'
  + DEFAULT_SOURCES.map((dir) => `  ${dir}\n`).join('');

class UsageError extends Error {}

function sourceDir(argv) {
  let from = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === '--from') {
      if (!argv[i + 1]) throw new UsageError('--from needs a folder');
      from = argv[++i];
    } else if (arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
      if (!from) throw new UsageError('--from needs a folder');
    } else {
      throw new UsageError(`unknown argument ${arg}`);
    }
  }
  if (from) return path.resolve(from);
  if (process.env.R1CORD_APK_DIR) return path.resolve(process.env.R1CORD_APK_DIR);
  const found = DEFAULT_SOURCES.find((dir) => fs.existsSync(dir));
  if (!found) throw new UsageError(`no APK folder given and none of the defaults exist`);
  return found;
}

const DEST = path.resolve(ROOT, 'resources', 'apk');
const WANTED = [
  { entry: 'r1cord', pattern: /^R1CORD-\d+\.\d+\.\d+\.apk$/ },
  { entry: 'controls', pattern: /^R1CORD-controls-\d+\.\d+\.\d+\.apk$/ },
];

function verified(file, entry) {
  try {
    return checkPinned(verifyApk(file), pinFor(entry));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

function main() {
  const SOURCE = sourceDir(process.argv.slice(2));
  if (!fs.existsSync(SOURCE)) throw new UsageError(`APK folder ${SOURCE} does not exist`);
  const names = fs.readdirSync(SOURCE);
  const picked = WANTED.map(({ entry, pattern }) => {
    const candidates = names.filter((name) => pattern.test(name));
    if (!candidates.length) throw new Error(`no ${pattern} in ${SOURCE}`);
    let best = null;
    for (const name of candidates) {
      const file = path.join(SOURCE, name);
      const info = verified(file, entry);
      if (!best || info.versionCode > best.info.versionCode) best = { name, file, info, entry };
    }
    return best;
  });

  fs.mkdirSync(DEST, { recursive: true });
  for (const name of fs.readdirSync(DEST)) {
    if (name.toLowerCase().endsWith('.apk')) fs.rmSync(path.join(DEST, name));
  }
  for (const item of picked) {
    const target = path.join(DEST, item.name);
    fs.copyFileSync(item.file, target);
    verified(target, item.entry);
    console.log(`staged ${item.name}: ${item.info.package} ${item.info.versionName} (${item.info.versionCode}), signer ${item.info.signerCertSha256[0]}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`stage-apks: ${error.message}`);
  if (error instanceof UsageError) console.error(USAGE.trimEnd());
  process.exit(1);
}
