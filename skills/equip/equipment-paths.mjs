import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const EQUIPMENT_ADDON_FILENAMES = Object.freeze({
  needle: 'coral-needle.node',
});

function coralBaseDir(baseDir) {
  return baseDir ?? join(homedir(), '.coral');
}

function resolvePluginRoot() {
  if (typeof process.env.CLAUDE_PLUGIN_ROOT === 'string' && process.env.CLAUDE_PLUGIN_ROOT.length > 0) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return process.cwd();
}

function readBuildFlavor(pluginRoot = resolvePluginRoot()) {
  try {
    const raw = readFileSync(join(pluginRoot, 'bridge', 'manifest.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.flavor === 'dev' ? 'dev' : 'prod';
  } catch {
    return 'prod';
  }
}

function resolveBuildFlavor(options = {}) {
  const env = options.env ?? process.env;
  if (env.CORAL_FLAVOR === 'dev') {
    return 'dev';
  }
  return readBuildFlavor(options.pluginRoot);
}

export function equipmentDataDir(name, options = {}) {
  return join(
    coralBaseDir(options.baseDir),
    resolveBuildFlavor(options) === 'dev' ? 'data-dev' : 'data',
    'equipment',
    name,
  );
}

export function equipmentInstallLockPath(name, options = {}) {
  return join(equipmentDataDir(name, options), 'install.lock');
}

export function equipmentAddonPath(name, options = {}) {
  return join(equipmentDataDir(name, options), EQUIPMENT_ADDON_FILENAMES[name] ?? `${name}.node`);
}
