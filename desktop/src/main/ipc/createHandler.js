function defaultLogger() {
  return {
    error: (...args) => {
      if (typeof global.writeLog === 'function') {
        global.writeLog(`[ERROR] [IPC] ${args.map(String).join(' ')}`);
      }
    },
    info: (...args) => {
      if (typeof global.writeLog === 'function') {
        global.writeLog(`[INFO] [IPC] ${args.map(String).join(' ')}`);
      }
    },
  };
}

function createHandler({ validate, handler, logger = defaultLogger(), services = {} }) {
  if (typeof handler !== 'function') {
    throw new Error('createHandler requires a handler function');
  }

  return async function wrappedIpcHandler(event, input) {
    try {
      const validatedInput = validate ? validate(input) : input;
      const data = await handler({ event, input: validatedInput, services });
      return { success: true, data };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (logger && typeof logger.error === 'function') {
        logger.error('[IPC] Handler failed', { error: message });
      }
      return { success: false, error: message };
    }
  };
}

module.exports = { createHandler };
