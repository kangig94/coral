/**
 * Side-effect module: install a `process.on('warning')` filter that silently
 * drops node:sqlite's `ExperimentalWarning`. node:sqlite emits this on first
 * database construction until the API graduates from experimental — too noisy
 * for stdout-disciplined CLI surfaces and unhelpful in the daemon log.
 *
 * MUST be imported as the *first* import in each entry point so the listener
 * is attached before any sibling import path constructs a `DatabaseSync`.
 *
 * Node ships a default 'warning' listener that writes to stderr and stays
 * attached even when extra listeners are registered. We strip the default
 * listeners and re-emit non-SQLite warnings ourselves so the filtering works
 * but real warnings still surface.
 */
const previousListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
    return;
  }
  for (const listener of previousListeners) {
    listener(warning);
  }
});
