const path = require('path');
const { buildLoginTaskXml, buildPlugCmd, buildPlugTaskXml } = require('./taskXml');

const LOGIN_TASK = 'R1CORD';
const PLUG_TASK = 'R1CORD-plug';
const LEGACY_TASK = 'r1cord-server';
const STARTUP_MODES = ['manual', 'plug', 'login'];

function schtasksDelete(name) {
  return { file: 'schtasks.exe', args: ['/Delete', '/TN', name, '/F'] };
}

function schtasksCreate(name, xmlPath) {
  return { file: 'schtasks.exe', args: ['/Create', '/TN', name, '/XML', xmlPath, '/F'] };
}

class StartupManager {
  constructor({ os, logger = console, taskDir }) {
    if (!os) throw new Error('StartupManager requires an os adapter');
    if (!taskDir) throw new Error('StartupManager requires a taskDir');
    this.os = os;
    this.logger = logger;
    this.taskDir = taskDir;
  }

  paths() {
    return {
      loginXmlPath: path.join(this.taskDir, 'R1CORD.xml'),
      plugXmlPath: path.join(this.taskDir, 'R1CORD-plug.xml'),
      plugCmdPath: path.join(this.taskDir, 'R1CORD-plug.cmd'),
    };
  }

  commandsFor(mode, { loginXmlPath, plugXmlPath } = this.paths()) {
    if (!STARTUP_MODES.includes(mode)) {
      throw new Error(`unknown startup mode: ${mode}`);
    }
    const commands = [
      schtasksDelete(LOGIN_TASK),
      schtasksDelete(PLUG_TASK),
      schtasksDelete(LEGACY_TASK),
    ];
    if (mode === 'login') commands.push(schtasksCreate(LOGIN_TASK, loginXmlPath));
    if (mode === 'plug') commands.push(schtasksCreate(PLUG_TASK, plugXmlPath));
    return commands;
  }

  async apply(mode, ctx) {
    if (!STARTUP_MODES.includes(mode)) {
      throw new Error(`unknown startup mode: ${mode}`);
    }
    const { loginXmlPath, plugXmlPath, plugCmdPath } = this.paths();
    await this.os.writeFile(loginXmlPath, buildLoginTaskXml(ctx));
    await this.os.writeFile(
      plugCmdPath,
      buildPlugCmd({
        exePath: ctx.exePath,
        watcherScript: ctx.watcherScript,
        adbPath: ctx.adbPath,
        downloadedAdb: ctx.downloadedAdb,
        adoptedSerialsFile: ctx.adoptedSerialsFile,
      }),
    );
    await this.os.writeFile(
      plugXmlPath,
      buildPlugTaskXml({
        cmdPath: plugCmdPath,
        workingDirectory: ctx.workingDirectory,
        userId: ctx.userId,
      }),
    );
    const commands = this.commandsFor(mode, { loginXmlPath, plugXmlPath });
    const failures = [];
    for (const command of commands) {
      const result = await this.os.execFile(command.file, command.args, { windowsHide: true });
      this.logger.info?.('[startup] schtasks', {
        args: command.args,
        status: result && result.status,
        dryRun: this.os.dryRun,
      });
      const status = result && result.status;
      if (!this.os.dryRun && status !== 0 && command.args[0] === '/Create') {
        failures.push({
          args: command.args,
          status,
          stderr: (result && result.stderr) || '',
        });
      }
    }
    if (failures.length) {
      const detail = failures
        .map((row) => `${row.args.join(' ')} -> ${row.status}${row.stderr ? ` ${row.stderr}` : ''}`)
        .join('; ');
      throw new Error(`schtasks failed: ${detail}`);
    }
    if (this.os.dryRun) {
      return { dryRun: true, ok: true, message: 'dry run: not registered', commands };
    }
    return { dryRun: false, ok: true, commands };
  }
}

module.exports = {
  StartupManager,
  LOGIN_TASK,
  PLUG_TASK,
  LEGACY_TASK,
  STARTUP_MODES,
};
