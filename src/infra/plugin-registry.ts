import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isNoEntryError } from '../shared/utils.js';

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

export function createPluginRegistry(): PluginRegistry {
  const cache = new Map<string, string | null>();
  let installedPlugins: InstalledPluginsFile | null | undefined;

  function loadInstalledPlugins(): InstalledPluginsFile | null {
    if (installedPlugins !== undefined) return installedPlugins;

    const registryPath = process.env.CORAL_PLUGIN_REGISTRY ?? join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

    try {
      const raw = fs.readFileSync(registryPath, 'utf-8');
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
        if (!fs.existsSync(entry.installPath)) continue;
        cache.set(namespace, entry.installPath);
        return entry.installPath;
      }
    }

    cache.set(namespace, null);
    return null;
  }

  return { discoverPluginRoot };
}
