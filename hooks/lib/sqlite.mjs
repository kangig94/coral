// Side-effect module: install an `ExperimentalWarning` filter for node:sqlite
// BEFORE the binding loads, then re-export `DatabaseSync`.
//
// Hook scripts run as `node hooks/<name>.mjs` with no shared bootstrap, so the
// warning suppressor cannot live in a centrally-imported module — it has to be
// the first thing that runs in a hook process. This module has no static
// imports, so its body executes top-to-bottom on load. The dynamic
// `await import('node:sqlite')` then triggers the warning, which the
// already-attached listener filters out.

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

const { DatabaseSync } = await import('node:sqlite');

export { DatabaseSync };
