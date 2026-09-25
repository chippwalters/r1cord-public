function registerIpcHandlers(ipcMain, handlerGroups = []) {
  for (const group of handlerGroups) {
    if (typeof group === 'function') {
      group(ipcMain);
    }
  }
}

module.exports = { registerIpcHandlers };
