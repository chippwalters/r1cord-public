function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildTaskXml({ command, args = '', workingDirectory, userId, description }) {
  if (!command) throw new Error('task XML requires a command');
  if (!userId) throw new Error('task XML requires a userId');
  const argsXml = args
    ? `\n      <Arguments>${xmlEscape(args)}</Arguments>`
    : '';
  const cwdXml = workingDirectory
    ? `\n      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>`
    : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(description || 'R1CORD Desktop')}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>${argsXml}${cwdXml}
    </Exec>
  </Actions>
</Task>
`;
}

function buildLoginTaskXml({ exePath, workingDirectory, userId }) {
  return buildTaskXml({
    command: exePath,
    args: '--background',
    workingDirectory,
    userId,
    description: 'R1CORD Desktop (start at login)',
  });
}

function buildPlugTaskXml({ cmdPath, workingDirectory, userId }) {
  return buildTaskXml({
    command: cmdPath,
    args: '',
    workingDirectory,
    userId,
    description: 'R1CORD Desktop (start when a device is plugged in)',
  });
}

function buildPlugCmd({ exePath, watcherScript, adbPath, downloadedAdb, adoptedSerialsFile }) {
  if (!exePath) throw new Error('plug watcher command requires exePath');
  if (!watcherScript) throw new Error('plug watcher command requires watcherScript');
  const lines = [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    `set R1CORD_APP_EXE=${exePath}`,
    `set R1CORD_ADB=${adbPath || 'adb'}`,
  ];
  // Where the Devices page's "Download Android platform tools" puts adb; used when adb is not on PATH.
  if (downloadedAdb) lines.push(`set R1CORD_DOWNLOADED_ADB=${downloadedAdb}`);
  if (adoptedSerialsFile) {
    lines.push(`set R1CORD_ADOPTED_SERIALS_FILE=${adoptedSerialsFile}`);
  }
  lines.push(`"${exePath}" "${watcherScript}"`, '');
  return lines.join('\r\n');
}

module.exports = {
  xmlEscape,
  buildTaskXml,
  buildLoginTaskXml,
  buildPlugTaskXml,
  buildPlugCmd,
};
