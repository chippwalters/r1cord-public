function buildTrayTemplate(status, actions, { startupMode, startupNote } = {}) {
  const emailTo = status && status.email_to ? String(status.email_to).trim() : '';
  return [
    { label: 'R1CORD Desktop', click: actions.openDashboard },
    { label: (status && status.device_line) || 'Starting…', enabled: false },
    { label: (status && status.work_line) || 'Starting…', enabled: false },
    { type: 'separator' },
    { label: 'Open dashboard', click: actions.openDashboard },
    { label: 'Devices', click: actions.openDevices },
    { label: 'Settings', click: actions.openSettings },
    { type: 'separator' },
    {
      label: 'USB mode',
      type: 'checkbox',
      checked: Boolean(status && status.usb_enabled),
      click: actions.toggleUsb,
    },
    {
      label: 'Email finished jobs',
      type: 'checkbox',
      checked: Boolean(status && status.email_enabled),
      enabled: Boolean(emailTo),
      click: actions.toggleEmail,
    },
    { type: 'separator' },
    { label: 'Open recordings folder', click: actions.openRecordings },
    { label: 'Open logs folder', click: actions.openLogs },
    { type: 'separator' },
    {
      label: 'Start',
      submenu: [
        {
          label: 'Manual',
          type: 'radio',
          checked: startupMode === 'manual',
          click: () => actions.setStartupMode('manual'),
        },
        {
          label: 'When the R1 is plugged in',
          type: 'radio',
          checked: startupMode === 'plug',
          click: () => actions.setStartupMode('plug'),
        },
        {
          label: 'At login',
          type: 'radio',
          checked: startupMode === 'login',
          click: () => actions.setStartupMode('login'),
        },
      ],
    },
    ...(startupNote ? [{ label: startupNote, enabled: false }] : []),
    { label: 'Desktop preferences', click: actions.openPreferences },
    { type: 'separator' },
    { label: 'Quit R1CORD Desktop', click: actions.quit },
  ];
}

module.exports = { buildTrayTemplate };
