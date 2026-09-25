// What `npm run make` puts in app.asar, checked without building: the packager's filter and the
// after-prune hook from forge.config.cjs, applied to this repo and to a stand-in node_modules.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const forgeConfig = require('../../forge.config.cjs');
const { bundledFfmpegPath, nodeCoreScript } = require('../../src/main/services/settings');

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1cord-package-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Copy the repo the way @electron/packager does: packager paths are '/'-rooted, and a folder the
// filter drops is not entered. node_modules is pruned by the packager itself, so the copy links to
// this checkout's instead.
function packagedCopy() {
  const ignore = forgeConfig.packagerConfig.ignore;
  const dest = tmpPath();
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (child === '/node_modules' || ignore(child)) continue;
      const target = path.join(dest, child);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        visit(child);
      } else {
        fs.copyFileSync(path.join(REPO, child), target);
      }
    }
  };
  visit('');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
  return dest;
}

function files(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(rel, entry.name);
    if (child === 'node_modules') return [];
    return entry.isDirectory() ? files(root, child) : [child];
  });
}

describe('the packaged app files', () => {
  it('run the core: its entry, the ASR worker, static files, themes and page assets', async () => {
    const root = packagedCopy();
    expect(fs.existsSync(nodeCoreScript(root))).toBe(true);
    expect(fs.existsSync(require(path.join(root, 'src/core/pipeline/asr-whispercpp.js')).WORKER_SCRIPT)).toBe(true);

    const { PageSource, buildSite, DEFAULT_THEME_ID } = require(path.join(root, 'src/core/render'));
    const site = path.join(tmpPath(), 'site');
    buildSite([new PageSource('summary', 'Summary', '# T\n')], { title: 'T', photosDir: null, theme: DEFAULT_THEME_ID, dest: site });
    expect(fs.existsSync(path.join(site, 'summary.html'))).toBe(true);

    const { defaultConfig, withUpdates } = require(path.join(root, 'src/core/config'));
    const { createApp } = require(path.join(root, 'src/core/app'));
    const data = tmpPath();
    const config = withUpdates(defaultConfig(), { datastore: path.join(data, 'ds'), webdav_folder: path.join(data, 'wd') });
    const app = createApp(config, { noWorker: true, noUsb: true });
    cleanup.push(() => app.close());
    const css = await app.inject({ method: 'GET', url: '/static/admin.css' });
    expect(css.statusCode).toBe(200);
  });

  it('leave out the Python server, the tests and the docs', () => {
    const shipped = files(packagedCopy());
    expect(shipped.filter((file) => /\.(py|pyc|md|toml|bat|ps1)$/.test(file))).toEqual([]);
    expect(shipped.filter((file) => file.split(path.sep)[0] === 'tests')).toEqual([]);
  });
});

describe('the whisper.cpp builds in the package', () => {
  function standInModules() {
    const build = tmpPath();
    const scope = path.join(build, 'node_modules', '@fugood');
    for (const name of ['node-whisper-win32-x64', 'node-whisper-win32-x64-vulkan', 'node-whisper-win32-x64-cuda',
      'node-whisper-wasm', 'node-whisper-linux-x64']) {
      fs.mkdirSync(path.join(scope, name), { recursive: true });
      fs.writeFileSync(path.join(scope, name, 'package.json'), '{}');
    }
    for (const file of ['package.json', 'lib/index.js', 'whisper.cpp/src/whisper.cpp', 'src/addon.cc', 'CMakeLists.txt']) {
      fs.mkdirSync(path.dirname(path.join(scope, 'whisper.node', file)), { recursive: true });
      fs.writeFileSync(path.join(scope, 'whisper.node', file), '');
    }
    fs.mkdirSync(path.join(build, 'node_modules', '@electron-forge'));
    return build;
  }

  it('are the CPU and Vulkan builds for the target, without CUDA, wasm or build sources', async () => {
    const build = standInModules();
    await forgeConfig.hooks.packageAfterPrune(forgeConfig, build, '44.4.5', 'win32', 'x64');
    const scope = path.join(build, 'node_modules', '@fugood');
    expect(fs.readdirSync(scope).sort()).toEqual(['node-whisper-win32-x64', 'node-whisper-win32-x64-vulkan', 'whisper.node']);
    expect(fs.readdirSync(path.join(scope, 'whisper.node')).sort()).toEqual(['lib', 'package.json']);
    expect(fs.readdirSync(path.join(build, 'node_modules'))).toEqual(['@fugood']);
  });
});

describe('the ffmpeg in the package', () => {
  // A checkout whose binaries/win32 holds a stand-in ffmpeg.exe next to the real NOTICE.txt.
  function standInCheckout(exeContents) {
    const checkout = tmpPath();
    const dir = path.join(checkout, 'binaries', 'win32');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ffmpeg.exe'), exeContents);
    fs.copyFileSync(path.join(REPO, 'binaries', 'win32', 'NOTICE.txt'), path.join(dir, 'NOTICE.txt'));
    return checkout;
  }

  // The packager copies each extraResource to resources/<its basename>.
  function packagedResources(checkout) {
    const resources = tmpPath();
    for (const entry of forgeConfig.packagerConfig.extraResource) {
      const standIn = path.resolve(checkout, entry);
      const from = fs.existsSync(standIn) ? standIn : path.resolve(REPO, entry);
      fs.cpSync(from, path.join(resources, path.basename(from)), { recursive: true });
    }
    return resources;
  }

  it('lands where the packaged app runs it from, next to its NOTICE', () => {
    const resources = packagedResources(standInCheckout('stand-in ffmpeg'));
    const exe = bundledFfmpegPath({ isPackaged: true, resourcesPath: resources });
    expect(fs.readFileSync(exe, 'utf8')).toBe('stand-in ffmpeg');
    expect(fs.existsSync(path.join(path.dirname(exe), 'NOTICE.txt'))).toBe(true);
  });

  it('stops the build when ffmpeg.exe is missing or is not the pinned build', async () => {
    const dir = path.join(standInCheckout('not the gyan.dev build'), 'binaries', 'win32');
    const config = { packagerConfig: { extraResource: ['./assets', dir] } };
    await expect(forgeConfig.hooks.prePackage(config, 'win32', 'x64')).rejects.toThrow(/sha256/);
    fs.rmSync(path.join(dir, 'ffmpeg.exe'));
    await expect(forgeConfig.hooks.prePackage(config, 'win32', 'x64')).rejects.toThrow(/ffmpeg\.exe is missing/);
  });
});
