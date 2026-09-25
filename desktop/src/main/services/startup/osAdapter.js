const { execFile, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function shouldDryRun({ isPackaged = false, env = process.env } = {}) {
  if (String(env.R1CORD_DESKTOP_DRY_RUN || '') === '1') return true;
  return !isPackaged;
}

function createOsAdapter({
  dryRun,
  allowOs,
  execFileImpl,
  spawnImpl,
  writeFileImpl,
  unlinkImpl,
} = {}) {
  const isDry = dryRun != null ? Boolean(dryRun) : allowOs === false;
  const calls = [];

  return {
    dryRun: isDry,
    allowOs: !isDry,
    calls,
    async execFile(file, args, opts = {}) {
      const record = { op: 'execFile', file, args, opts };
      calls.push(record);
      if (isDry) return { status: 0, stdout: '', stderr: '', dryRun: true };
      if (!execFileImpl) throw new Error('execFile implementation missing');
      return execFileImpl(file, args, opts);
    },
    spawn(file, args, opts = {}) {
      const record = { op: 'spawn', file, args, opts };
      calls.push(record);
      if (isDry) {
        return { pid: -1, unref() {}, on() {}, stdout: null, stderr: null };
      }
      if (!spawnImpl) throw new Error('spawn implementation missing');
      return spawnImpl(file, args, opts);
    },
    async writeFile(filePath, contents) {
      calls.push({ op: 'writeFile', filePath, contents });
      if (isDry) return;
      if (!writeFileImpl) throw new Error('writeFile implementation missing');
      return writeFileImpl(filePath, contents);
    },
    async unlink(filePath) {
      calls.push({ op: 'unlink', filePath });
      if (isDry) return;
      if (!unlinkImpl) return;
      return unlinkImpl(filePath);
    },
  };
}

function createRealOsAdapter({ isPackaged = false, env = process.env } = {}) {
  return createOsAdapter({
    dryRun: shouldDryRun({ isPackaged, env }),
    async execFileImpl(file, args, opts) {
      try {
        const { stdout, stderr } = await execFileAsync(file, args, {
          ...opts,
          windowsHide: true,
          shell: false,
        });
        return { status: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      } catch (err) {
        const status = err && err.code === 'ENOENT' ? 127 : Number(err && err.status != null ? err.status : 1);
        return {
          status,
          stdout: String((err && err.stdout) || ''),
          stderr: String((err && err.stderr) || ''),
        };
      }
    },
    spawnImpl(file, args, opts) {
      return spawn(file, args, { ...opts, shell: false, windowsHide: true });
    },
    async writeFileImpl(filePath, contents) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      return fs.writeFile(filePath, contents, 'utf8');
    },
    unlinkImpl(filePath) {
      return fs.unlink(filePath).catch(() => {});
    },
  });
}

module.exports = { shouldDryRun, createOsAdapter, createRealOsAdapter };
