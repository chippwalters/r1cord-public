// Node core entry: `node src/core/index.js --config <toml> --port <n> [--host <h>]`
// Black-box tests: R1CORD_TARGET=node R1CORD_NODE_CMD="node src/core/index.js"
// Flags --no-worker / --no-usb (and env R1CORD_NO_WORKER / R1CORD_NO_USB) skip those loops.
// R1CORD_SERVER_CONFIG selects config.toml when --config is omitted.

'use strict';

require('./sqlite-warning');

const childProcess = require('node:child_process');
const { loadConfig, withUpdates } = require('./config');
const { resolveConfigPath } = require('./paths');
const { createApp } = require('./app');
const desktop = require('./desktop');
const { installHost } = require('./host');

function openDashboard(url) {
  if (process.platform === 'win32') {
    childProcess.spawn('cmd.exe', ['/c', 'start', '', url], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      shell: false,
    }).unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  childProcess.spawn(opener, [url], { stdio: 'ignore', detached: true, shell: false }).unref();
}

function parseArgs(argv) {
  const args = { config: null, port: null, host: null, noWorker: false, noUsb: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config') args.config = argv[(i += 1)];
    else if (token === '--port') args.port = argv[(i += 1)];
    else if (token === '--host') args.host = argv[(i += 1)];
    else if (token === '--no-worker') args.noWorker = true;
    else if (token === '--no-usb') args.noUsb = true;
    else if (token === '--no-tray') continue;
    else if (token === '--help' || token === '-h') {
      process.stdout.write(
        'Usage: node src/core/index.js [--config PATH] [--port N] [--host HOST] [--no-worker] [--no-usb]\n',
      );
      process.exit(0);
    } else if (token && token.startsWith('-')) {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function isAddressInUse(error) {
  for (let current = error; current; current = current.cause) {
    if (current.code === 'EADDRINUSE') return true;
    if (typeof current.message === 'string' && current.message.includes('EADDRINUSE')) return true;
  }
  return false;
}

function listenError(error, host, port) {
  if (!isAddressInUse(error)) return error;
  const wrapped = new Error(
    `listen address ${host}:${port} is already in use; another R1CORD server or core is bound to this port`,
  );
  wrapped.code = 'EADDRINUSE';
  wrapped.cause = error;
  return wrapped;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configPath = resolveConfigPath({ config: args.config || null });
  let config = loadConfig(configPath);
  const updates = {};
  if (args.port != null && args.port !== '') {
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 0) throw new Error(`invalid --port: ${args.port}`);
    updates.listen_port = port;
  }
  if (args.host) updates.listen_host = args.host;
  if (Object.keys(updates).length) config = withUpdates(config, updates);

  const noWorker = args.noWorker || process.env.R1CORD_NO_WORKER === '1';
  const noUsb = args.noUsb || process.env.R1CORD_NO_USB === '1';
  const app = createApp(config, { configPath, noWorker, noUsb });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.state.request_exit = shutdown;
  app.state.requestExit = shutdown;
  const dashboard = `http://127.0.0.1:${config.listen_port}/admin`;
  app.state.open_dashboard = () => openDashboard(dashboard);
  app.state.openDashboard = app.state.open_dashboard;

  try {
    await app.listen({ host: config.listen_host, port: config.listen_port });
  } catch (error) {
    try {
      await app.close();
    } catch (_close) {
      // listen failed
    }
    throw listenError(error, config.listen_host, config.listen_port);
  }

  const host = installHost({
    port: config.listen_port,
    desktop,
    onShutdown: shutdown,
    onWindowOpen: (open) => {
      app.state.windowOpen = Boolean(open);
      app.state.loggers.app.info(`host: windowOpen=${open}`);
    },
  });
  app.state.host = host;
  if (host.spawnWorker) app.state.worker.spawnWorker = host.spawnWorker;
  app.state.request_exit = () => host.requestExit();
  app.state.requestExit = app.state.request_exit;
  app.state.open_dashboard = () => {
    if (host.connected) host.openDashboard();
    else openDashboard(dashboard);
  };
  app.state.openDashboard = app.state.open_dashboard;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, listenError };
