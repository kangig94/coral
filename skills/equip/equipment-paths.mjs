import { homedir } from 'node:os';
import { join } from 'node:path';

const EQUIPMENT_ADDON_FILENAMES = Object.freeze({
  needle: 'coral-needle.node',
});

function coralBaseDir(baseDir) {
  return baseDir ?? join(homedir(), '.coral');
}

export function equipmentDataDir(name, options = {}) {
  return join(coralBaseDir(options.baseDir), 'data', 'equipment', name);
}

export function equipmentInstallLockPath(name, options = {}) {
  return join(equipmentDataDir(name, options), 'install.lock');
}

export function equipmentAddonPath(name, options = {}) {
  return join(equipmentDataDir(name, options), EQUIPMENT_ADDON_FILENAMES[name] ?? `${name}.node`);
}
