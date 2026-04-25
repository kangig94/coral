import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { InfraEnvPort, InfraStoragePort } from './port-types.js';
import { isNoEntryError } from './fs-errors.js';

const installedPluginEntrySchema = z
  .object({
    installPath: z.string(),
    scope: z.string().optional(),
  })
  .passthrough();

const installedPluginsFileSchema = z
  .object({
    version: z.unknown().optional(),
    plugins: z.record(z.string(), z.array(installedPluginEntrySchema)),
  })
  .passthrough();

export type InstalledPluginEntry = z.infer<typeof installedPluginEntrySchema>;
export type InstalledPluginsFile = z.infer<typeof installedPluginsFileSchema>;

export type PluginRegistry = {
  discoverPluginRoot(namespace: string): string | null;
};

export type PluginRegistryDeps = {
  storage?: Pick<InfraStoragePort, 'existsSync' | 'readFileSync'>;
  env?: Pick<InfraEnvPort, 'get'>;
  registryPath?: string;
  homeDir?: string;
};

type ResolvedPluginRegistryDeps = {
  storage: Pick<InfraStoragePort, 'existsSync' | 'readFileSync'>;
  env: Pick<InfraEnvPort, 'get'>;
  registryPath?: string;
  homeDir?: string;
};
function defaultStorage(): Pick<InfraStoragePort, 'existsSync' | 'readFileSync'> {
  return { existsSync, readFileSync };
}

function defaultEnv(): Pick<InfraEnvPort, 'get'> {
  return {
    get: (key) => process.env[key],
  };
}

function resolvePluginRegistryDeps(deps?: PluginRegistryDeps): ResolvedPluginRegistryDeps {
  if (deps?.storage && deps?.env) {
    return {
      storage: deps.storage,
      env: deps.env,
      registryPath: deps.registryPath,
      homeDir: deps.homeDir,
    };
  }

  return {
    storage: deps?.storage ?? defaultStorage(),
    env: deps?.env ?? defaultEnv(),
    registryPath: deps?.registryPath,
    homeDir: deps?.homeDir,
  };
}

function resolveRegistryPath(deps: ResolvedPluginRegistryDeps): string {
  const override = deps.registryPath ?? deps.env.get('CORAL_PLUGIN_REGISTRY');
  if (override) {
    return override;
  }

  const resolvedHome = deps.homeDir ?? deps.env.get('HOME') ?? deps.env.get('USERPROFILE') ?? homedir();
  return join(resolvedHome, '.claude', 'plugins', 'installed_plugins.json');
}

export function createPluginRegistry(deps?: PluginRegistryDeps): PluginRegistry {
  const resolvedDeps = resolvePluginRegistryDeps(deps);
  const cache = new Map<string, string | null>();
  let installedPlugins: InstalledPluginsFile | null | undefined;
  const storage = resolvedDeps.storage;

  function loadInstalledPlugins(): InstalledPluginsFile | null {
    if (installedPlugins !== undefined) return installedPlugins;

    const registryPath = resolveRegistryPath(resolvedDeps);

    try {
      const raw = storage.readFileSync(registryPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const result = installedPluginsFileSchema.safeParse(parsed);
      installedPlugins = result.success ? result.data : null;
      return installedPlugins;
    } catch (error: unknown) {
      if (isNoEntryError(error) || error instanceof SyntaxError) {
        installedPlugins = null;
        return installedPlugins;
      }
      throw error;
    }
  }

  function discoverPluginRoot(namespace: string): string | null {
    if (cache.has(namespace)) return cache.get(namespace) ?? null;

    const registry = loadInstalledPlugins();
    if (!registry) {
      cache.set(namespace, null);
      return null;
    }

    for (const key of Object.keys(registry.plugins)) {
      const atIdx = key.indexOf('@');
      const name = atIdx === -1 ? key : key.slice(0, atIdx);
      if (name !== namespace) continue;

      for (const entry of registry.plugins[key]) {
        if (!storage.existsSync(entry.installPath)) continue;
        cache.set(namespace, entry.installPath);
        return entry.installPath;
      }
    }

    cache.set(namespace, null);
    return null;
  }

  return { discoverPluginRoot };
}
