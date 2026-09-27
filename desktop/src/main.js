const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  utilityProcess,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHandler } = require('./main/ipc/createHandler');
const { openExternalSafely } = require('./main/services/security/externalUrlPolicy');
const { CoreProcess, startupModeForRunMode } = require('./main/services/core/CoreProcess');
const { createRealOsAdapter } = require('./main/services/startup/osAdapter');
const { StartupManager } = require('./main/services/startup/StartupManager');
const { adoptedSerialsPath, writeAdoptedSerials } = require('./main/services/startup/adoptedSerials');
const {
  applyCliOverrides,
  bundledFfmpegPath,
  hasFlag,
  loadSettings,
  normalizeSettings,
  parseUserDataDir,
  nodeCoreInput,
  nodeCoreScript,
  saveSettings,
} = require('./main/services/settings');
const {
  fetchStatus,
  notificationsFromStatus,
  tooltip,
} = require('./core/status');
const { defaultConfigPath, platformToolsAdb } = require('./core/paths');
const { buildTrayTemplate } = require('./main/services/tray/trayMenu');

const POLL_MS = 3000;

let mainWindow;
let tray;
let settings;
let core;
let startup;
let osAdapter;
let pollTimer;
let statusCursor = {};
let lastStatus = null;
let isQuitting = false;
let backgroundStart = false;
let lastStartupApply = null;
let serverError = null;
// Start screen: the window shows the local start page (index.html) until the core answers, and
// admin pages load over it, so the window is never shown empty while the admin is on its way.
const STARTING = { phase: 'starting', message: 'Starting R1CORD…', detail: '', note: '' };
let startState = STARTING;
let coreReady = false;
let coreEverReady = false;
let windowPainted = false;
let revealPending = false;
let pendingAdminPath = null;

function logLine(message) {
  const stamp = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(getLogFilePath(), stamp, 'utf8');
  } catch (_err) {
    // logging must never crash the shell
  }
}

function getLogFilePath() {
  return path.join(app.getPath('userData'), 'desktop.log');
}

global.writeLog = (message) => logLine(message);

// A real folder to run from: the install folder when packaged (app.asar cannot be a working directory).
function projectRoot() {
  if (app.isPackaged) return path.dirname(process.execPath);
  return app.getAppPath();
}

function resourcePath(...parts) {
  if (app.isPackaged) return path.join(process.resourcesPath, ...parts);
  return path.join(app.getAppPath(), ...parts);
}

function watcherScriptPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'plug-watcher.js');
  return path.join(app.getAppPath(), 'src', 'main', 'services', 'startup', 'plug-watcher.js');
}

function trayIconPath() {
  return resourcePath('assets', 'r1cord-tray.png');
}

function appIconPath() {
  return resourcePath('assets', 'r1cord.ico');
}

function adminOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

function isAdminUrl(url, port) {
  try {
    const parsed = new URL(url);
    const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    return parsed.protocol === 'http:' && hostOk && parsed.port === String(port);
  } catch (_err) {
    return false;
  }
}

function parseArgv() {
  return process.argv.slice(1);
}

const userDataDir = parseUserDataDir(process.argv);
if (userDataDir) {
  app.setPath('userData', path.resolve(userDataDir));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!hasFlag(argv, '--background')) openAdmin('/admin');
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });
}

function createWindow(hash = '') {
  nativeTheme.themeSource = 'dark';
  windowPainted = false;
  revealPending = false;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0E1013',
    show: false,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Shown only once the local start page has painted; then a waiting admin page may load.
  mainWindow.once('ready-to-show', () => {
    windowPainted = true;
    if (!backgroundStart || revealPending) revealWindow();
    flushAdmin();
  });

  // A failed admin load (the core went away mid-navigation) would leave an empty error page:
  // go back to the start screen, which says what happened and offers Retry. The dashboard, not
  // the failed URL, comes back: that may have been a form POST.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !isAdminUrl(validatedURL, settings.port)) return;
    logLine(`[WARN] [Window] admin page did not load: ${errorDescription} (${errorCode})`);
    pendingAdminPath = '/admin';
    setStartState({ phase: 'error', message: 'The dashboard did not load.', detail: errorDescription || '' });
    loadStartingPage();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  bindWindowOpen(mainWindow);

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (isAdminUrl(navigationUrl, settings.port)) return;
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL && navigationUrl.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)) return;
    event.preventDefault();
    openExternalSafely(shell, navigationUrl).catch((err) => {
      logLine(`[WARN] [Security] Navigation blocked: ${navigationUrl} (${err.message})`);
    });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAdminUrl(url, settings.port)) {
      mainWindow.loadURL(url);
    } else {
      openExternalSafely(shell, url).catch((err) => {
        logLine(`[WARN] [Security] New window blocked: ${url} (${err.message})`);
      });
    }
    return { action: 'deny' };
  });

  loadStartingPage(hash);
}

function loadStartingPage(hash = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const loading = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? mainWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}${hash}`)
    : mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      hash ? { hash: hash.replace(/^#/, '') } : undefined,
    );
  loading.catch((err) => logLine(`[WARN] [Window] start page: ${err.message}`));
}

function setStartState(next) {
  startState = { ...STARTING, ...next };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sidecar:status', startState);
  }
}

// Show the window now if its page has painted, else as soon as it has.
function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!windowPainted) {
    revealPending = true;
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

// Load the requested admin page once the core answers and the window has something on screen.
function flushAdmin() {
  if (!pendingAdminPath || !coreReady || !windowPainted) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = `${adminOrigin(settings.port)}${pendingAdminPath}`;
  pendingAdminPath = null;
  // Failures surface through did-fail-load.
  mainWindow.loadURL(url).catch(() => {});
}

function openAdmin(pathname = '/admin') {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  pendingAdminPath = pathname;
  flushAdmin();
  revealWindow();
}

function notifyFinished(status) {
  for (const note of notificationsFromStatus(status)) {
    try {
      const notification = new Notification({
        title: note.title,
        body: note.body,
        icon: trayIconPath(),
      });
      notification.show();
    } catch (err) {
      logLine(`[WARN] [Tray] notification failed: ${err.message}`);
    }
  }
}

async function pollStatus() {
  try {
    const body = await fetchStatus({
      fetchImpl: globalThis.fetch,
      port: settings.port,
      cursor: statusCursor,
    });
    lastStatus = body;
    statusCursor = body.cursor || {};
    try {
      writeAdoptedSerials(app.getPath('userData'), body.adopted_serials || []);
    } catch (writeErr) {
      logLine(`[WARN] [Tray] adopted serials file: ${writeErr.message}`);
    }
    refreshTray();
    notifyFinished(body);
  } catch (err) {
    logLine(`[WARN] [Tray] status poll failed: ${err.message}`);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollStatus();
  pollTimer = setInterval(pollStatus, POLL_MS);
}

function refreshTray() {
  if (!tray) return;
  const template = buildTrayTemplate(lastStatus, trayActions(), {
    startupMode: settings.startupMode,
    startupNote: serverError || (lastStartupApply && lastStartupApply.message),
  });
  tray.setContextMenu(Menu.buildFromTemplate(template));
  const title = tooltip(
    (lastStatus && lastStatus.device_line) || 'Starting…',
    (lastStatus && lastStatus.work_line) || 'Starting…',
  );
  tray.setToolTip(title);
}

function trayActions() {
  return {
    openDashboard: () => openAdmin('/admin'),
    openDevices: () => openAdmin('/admin/devices'),
    openSettings: () => openAdmin('/admin/config'),
    toggleUsb: () => toggleFlag('usb'),
    toggleEmail: () => toggleFlag('email'),
    openRecordings: () => openFolder(lastStatus && lastStatus.recordings_folder),
    openLogs: () => openFolder(lastStatus && lastStatus.logs_folder),
    setStartupMode: (mode) => applyStartupMode(mode),
    openPreferences: () => openPreferences(),
    quit: () => quitApp(),
  };
}

async function toggleFlag(toggle) {
  try {
    const res = await fetch(`${adminOrigin(settings.port)}/admin/api/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toggle }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastStatus = await res.json();
    statusCursor = lastStatus.cursor || statusCursor;
    refreshTray();
  } catch (err) {
    logLine(`[ERROR] [Tray] toggle ${toggle} failed: ${err.message}`);
  }
}

async function openFolder(folder) {
  if (!folder) return;
  fs.mkdirSync(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error) logLine(`[ERROR] [Tray] openPath failed: ${error}`);
}

function openPreferences() {
  // The user asked for Preferences: a waiting admin page must not replace them.
  pendingAdminPath = null;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow('#prefs');
  else loadStartingPage('#prefs');
  revealWindow();
}

function settingsPayload() {
  return {
    ...settings,
    osDryRun: Boolean(osAdapter && osAdapter.dryRun),
    lastStartupApply,
  };
}

async function applyStartupMode(mode) {
  settings = saveSettings(app.getPath('userData'), { ...settings, startupMode: mode });
  lastStartupApply = await startup.apply(mode, {
    exePath: process.execPath,
    workingDirectory: projectRoot(),
    userId: process.env.USERNAME || os.userInfo().username,
    watcherScript: watcherScriptPath(),
    adbPath: settings.adbPath,
    // The core downloads adb next to the config it runs with (%LOCALAPPDATA%\R1CORD by default).
    downloadedAdb: platformToolsAdb(path.dirname(settings.configPath || defaultConfigPath())),
    adoptedSerialsFile: adoptedSerialsPath(app.getPath('userData')),
  });
  refreshTray();
  return lastStartupApply;
}

function createTray() {
  const image = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  // Left-click opens the app, as on other Windows tray apps; right-click shows the menu.
  tray.on('click', () => trayActions().openDashboard());
  refreshTray();
  logLine('[INFO] [Tray] icon shown');
}

function bindWindowOpen(win) {
  const send = (open) => {
    if (core) core.sendWindowOpen(open);
  };
  win.on('show', () => send(true));
  win.on('hide', () => send(false));
  win.on('closed', () => send(false));
}

function handleRunModeChanged(mode) {
  const startupMode = startupModeForRunMode(mode);
  if (!startupMode) {
    logLine(`[WARN] [Core] unknown run_mode: ${mode}`);
    return;
  }
  applyStartupMode(startupMode).catch((err) => {
    logLine(`[ERROR] [Core] runModeChanged failed: ${err.message}`);
  });
}

function probeUrlFor(port) {
  return `${adminOrigin(port)}/admin/api/status`;
}

function coreScriptError() {
  const script = nodeCoreScript(app.getAppPath());
  return fs.existsSync(script) ? null : `Node core not found: ${script}`;
}

function startCore() {
  if (serverError) {
    setStartState({ phase: 'error', message: 'R1CORD could not start.', detail: serverError });
    refreshTray();
    logLine(`[ERROR] [Core] ${serverError}`);
    return;
  }
  core = new CoreProcess({
    forkImpl: utilityProcess.fork.bind(utilityProcess),
    asrWorkerScript: path.join(app.getAppPath(), 'src', 'asr-worker', 'index.js'),
    logger: {
      info: (msg, data) => logLine(`[INFO] [Core] ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`),
      error: (msg, data) => logLine(`[ERROR] [Core] ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`),
    },
    handlers: {
      reveal: (filePath) => {
        if (filePath) shell.showItemInFolder(filePath);
      },
      openDashboard: () => openAdmin('/admin'),
      requestExit: () => quitApp(),
      runModeChanged: (mode) => handleRunModeChanged(mode),
    },
  });
  const ffmpegPath = bundledFfmpegPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  logLine(`[INFO] [Core] audio decoder: ${ffmpegPath || 'ffmpeg on PATH'}`);
  // The core ships as plain files inside app.asar (the project folder in dev).
  const input = nodeCoreInput(settings, { appPath: app.getAppPath(), cwd: projectRoot(), ffmpegPath });
  setStartState(STARTING);
  core.supervise(input, {
    probeUrl: probeUrlFor(settings.port),
    probeTimeoutMs: 90000,
    backoffMs: 500,
    maxBackoffMs: 8000,
    onReady: () => {
      coreReady = true;
      coreEverReady = true;
      setStartState({ phase: 'ready', message: 'Opening R1CORD…' });
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) core.sendWindowOpen(true);
      if (!backgroundStart) openAdmin(pendingAdminPath || '/admin');
      else flushAdmin();
      startPolling();
    },
    onRestart: ({ delayMs, reason }) => {
      coreReady = false;
      setStartState({
        phase: 'error',
        message: coreEverReady ? 'The R1CORD server stopped.' : 'R1CORD could not start.',
        detail: reason || '',
        note: `Trying again in ${Math.max(1, Math.round(delayMs / 1000))} s…`,
      });
    },
    onCleanExit: () => {
      logLine('[INFO] [Core] exited cleanly');
      quitApp();
    },
  });
}

// The start screen's Retry: start a core that could not be found, relaunch one waiting out its
// restart backoff, or reload the admin page that failed while the core was up.
function retryStart() {
  if (serverError) {
    serverError = coreScriptError();
    if (!serverError) {
      startCore();
      refreshTray();
    } else {
      setStartState({ phase: 'error', message: 'R1CORD could not start.', detail: serverError });
    }
    return startState;
  }
  if (coreReady) {
    setStartState({ phase: 'ready', message: 'Opening R1CORD…' });
    pendingAdminPath = pendingAdminPath || '/admin';
    flushAdmin();
    return startState;
  }
  if (core && core.retryNow()) setStartState(STARTING);
  return startState;
}

async function quitApp() {
  if (isQuitting) return;
  isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (core) {
    await core.stopGracefully({ timeoutMs: 8000 });
  }
  app.quit();
}

function registerIpc() {
  ipcMain.handle(
    'settings:get',
    createHandler({
      handler: async () => settingsPayload(),
    }),
  );
  ipcMain.handle(
    'settings:set-startup-mode',
    createHandler({
      validate(input) {
        if (!input || typeof input !== 'string') throw new Error('startup mode is required');
        return input;
      },
      async handler({ input }) {
        await applyStartupMode(input);
        return settingsPayload();
      },
    }),
  );
  ipcMain.handle(
    'core:start-state',
    createHandler({
      handler: async () => startState,
    }),
  );
  ipcMain.handle(
    'core:retry',
    createHandler({
      handler: async () => retryStart(),
    }),
  );
  ipcMain.handle('log:append', async (_event, payload) => {
    if (typeof payload === 'string') logLine(payload);
    else logLine(`[${(payload && payload.level) || 'INFO'}] [${(payload && payload.category) || 'Renderer'}] ${(payload && payload.message) || ''}`);
  });
}

app.setAppUserModelId('com.chippwalters.r1cord');

// A second instance only hands its launch to the first (second-instance above) and quits: it
// must not make a tray icon, a window or a core of its own on the way out.
if (gotLock) app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const argv = parseArgv();
  backgroundStart = hasFlag(argv, '--background');
  const loaded = loadSettings(app.getPath('userData'));
  settings = normalizeSettings(applyCliOverrides(loaded, argv));
  if (!settings.noUsb && process.env.R1CORD_NO_USB === '1') settings.noUsb = true;
  if (!settings.noWorker && process.env.R1CORD_NO_WORKER === '1') settings.noWorker = true;
  serverError = coreScriptError();
  osAdapter = createRealOsAdapter({ isPackaged: app.isPackaged });
  startup = new StartupManager({
    os: osAdapter,
    logger: { info: (msg, data) => logLine(`${msg} ${data ? JSON.stringify(data) : ''}`.trim()) },
    taskDir: path.join(app.getPath('userData'), 'tasks'),
  });
  registerIpc();
  // The start screen first, so it is loading while the core boots.
  if (!backgroundStart) createWindow();
  startCore();
  createTray();
});

app.on('window-all-closed', () => {
  // Stay in the tray until Quit.
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (core && core.isRunning()) core.stopAll();
});
