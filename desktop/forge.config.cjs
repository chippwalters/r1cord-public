const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// What goes into app.asar, as packager paths ('/'-rooted, '/'-separated). The main process and
// the preload are Vite bundles in .vite. The Node core and the ASR worker ship as plain CommonJS
// at their repo paths, so `node src/core/index.js` is the same program in dev, in the tests and
// in the package, and it finds its static files, themes and page assets through __dirname.
// node_modules is pruned to production dependencies by the packager.
const APP_PATHS = [
  '/package.json',
  '/.vite',
  '/src/core',
  '/src/asr-worker',
  '/r1cord_server/static',
  '/r1cord_server/render/assets',
  '/r1cord_server/render/themes',
  '/node_modules',
];

// Inside the kept paths: the faster-whisper bridge script and Python caches never run here, and
// node_modules' npm/Vite bookkeeping (.bin shims, .vite caches, .package-lock.json) is not the app.
const DROPPED_FILES = /(\.py|\.pyc|\/__pycache__)$|^\/node_modules\/(\.bin|\.vite|\.package-lock\.json)($|\/)/;

function ignoreForPackage(file) {
  if (!file) return false;
  if (DROPPED_FILES.test(file)) return true;
  return !APP_PATHS.some((keep) => file === keep || file.startsWith(`${keep}/`) || keep.startsWith(`${file}/`));
}

// whisper.cpp builds: the target's CPU build and its Vulkan build. Dropped: the -cuda build (119 MB
// without the CUDA runtime it needs, ELECTRON-PLAN P5), the wasm build, other platforms, and the
// C/C++ sources @fugood/whisper.node ships for building from source.
const WHISPER_SCOPE = path.join('node_modules', '@fugood');
const WHISPER_SOURCES = ['whisper.cpp', 'src', 'scripts', 'CMakeLists.txt'];

function keptWhisperBuilds(platform, arch) {
  return new Set([`node-whisper-${platform}-${arch}`, `node-whisper-${platform}-${arch}-vulkan`]);
}

async function pruneWhisperBuilds(buildPath, platform, arch) {
  const scope = path.join(buildPath, WHISPER_SCOPE);
  if (!fs.existsSync(scope)) return;
  const kept = keptWhisperBuilds(platform, arch);
  for (const name of fs.readdirSync(scope)) {
    if (name.startsWith('node-whisper-') && !kept.has(name)) {
      await fs.promises.rm(path.join(scope, name), { recursive: true, force: true });
    }
  }
  for (const name of WHISPER_SOURCES) {
    await fs.promises.rm(path.join(scope, 'whisper.node', name), { recursive: true, force: true });
  }
}

// The packager prunes dev packages but keeps their (now empty) @scope folders.
async function removeEmptyScopes(buildPath) {
  const modules = path.join(buildPath, 'node_modules');
  if (!fs.existsSync(modules)) return;
  for (const name of fs.readdirSync(modules)) {
    const dir = path.join(modules, name);
    if (name.startsWith('@') && fs.readdirSync(dir).length === 0) await fs.promises.rmdir(dir);
  }
}

// The audio decoder: ffmpeg 8.0.1, gyan.dev "essentials" build (GPL v3; binaries/win32/NOTICE.txt).
// It is not in git (99 MB). Before `npm run make`, put its bin\ffmpeg.exe in binaries\win32\ from
//   https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip
// (that zip's exe has exactly this sha256; the build refuses any other).
const FFMPEG_ZIP_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip';
const FFMPEG_EXE_SHA256 = '5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d';

// The extraResource folder that becomes resources/win32 (main's bundledFfmpegPath) must hold that
// exact ffmpeg.exe and its NOTICE.txt; a package without them cannot transcribe.
async function checkBundledFfmpeg(packagerConfig) {
  const entry = packagerConfig.extraResource.find((item) => path.basename(item) === 'win32');
  if (!entry) throw new Error('forge.config.cjs: no binaries/win32 extraResource for ffmpeg.exe');
  const dir = path.resolve(__dirname, entry);
  const exe = path.join(dir, 'ffmpeg.exe');
  if (!fs.existsSync(exe)) {
    throw new Error(`${exe} is missing: take bin\\ffmpeg.exe from ${FFMPEG_ZIP_URL} (see forge.config.cjs)`);
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(exe)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== FFMPEG_EXE_SHA256) {
    throw new Error(`${exe} has sha256 ${actual}, expected ${FFMPEG_EXE_SHA256} (ffmpeg 8.0.1 gyan.dev essentials)`);
  }
  if (!fs.existsSync(path.join(dir, 'NOTICE.txt'))) throw new Error(`${path.join(dir, 'NOTICE.txt')} is missing`);
}

module.exports = {
  packagerConfig: {
    asar: true,
    icon: './assets/r1cord',
    appBundleId: 'com.chippwalters.r1cord',
    extraResource: [
      './assets',
      './src/main/services/startup/plug-watcher.js',
      // ffmpeg.exe + NOTICE.txt -> resources/win32; see FFMPEG_EXE_SHA256 for where the exe comes from.
      './binaries/win32',
    ],
    ignore: ignoreForPackage,
  },
  rebuildConfig: {},
  hooks: {
    prePackage: async (forgeConfig) => {
      await checkBundledFfmpeg(forgeConfig.packagerConfig);
    },
    packageAfterPrune: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      await pruneWhisperBuilds(buildPath, platform, arch);
      await removeEmptyScopes(buildPath);
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
  plugins: [
    {
      // Every *.node file goes to app.asar.unpacked: Windows can only LoadLibrary a real file.
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      // Plug-mode watcher runs this exe with ELECTRON_RUN_AS_NODE=1 (not the full Chromium app), and
      // the core forks the ASR worker with child_process.fork, which needs it too.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
