import type * as NodeFs from 'node:fs';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsCalls = vi.hoisted(() => ({
  readFileSync: [] as unknown[][],
  existsSync: [] as unknown[][],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    readFileSync: ((...args: unknown[]) => {
      fsCalls.readFileSync.push(args);
      return (actual.readFileSync as (...innerArgs: unknown[]) => unknown)(...args);
    }) as typeof actual.readFileSync,
    existsSync: ((...args: unknown[]) => {
      fsCalls.existsSync.push(args);
      return (actual.existsSync as (...innerArgs: unknown[]) => unknown)(...args);
    }) as typeof actual.existsSync,
  };
});

import { createPluginRegistry } from '../plugin-registry.js';

let tmpRoot = '';
let originalRegistryPath: string | undefined;

function setRegistry(contents: unknown): string {
  const registryPath = join(tmpRoot, 'installed_plugins.json');
  const payload = typeof contents === 'string' ? contents : JSON.stringify(contents);
  writeFileSync(registryPath, payload, 'utf-8');
  process.env.CORAL_PLUGIN_REGISTRY = registryPath;
  return registryPath;
}

function createPluginRoot(name: string): string {
  const pluginRoot = join(tmpRoot, name);
  mkdirSync(pluginRoot, { recursive: true });
  return pluginRoot;
}

describe('createPluginRegistry', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'coral-plugin-registry-'));
    originalRegistryPath = process.env.CORAL_PLUGIN_REGISTRY;
    fsCalls.readFileSync = [];
    fsCalls.existsSync = [];
  });

  afterEach(() => {
    if (originalRegistryPath === undefined) {
      delete process.env.CORAL_PLUGIN_REGISTRY;
    } else {
      process.env.CORAL_PLUGIN_REGISTRY = originalRegistryPath;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('resolves the install path for a registered namespace', () => {
    const pluginRoot = createPluginRoot('ui-ux-plugin');
    setRegistry({
      version: 1,
      plugins: {
        'ui-ux@marketplace': [{ installPath: pluginRoot, scope: 'project' }],
      },
    });

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('ui-ux')).toBe(pluginRoot);
  });

  it('returns null when the registry file is missing', () => {
    process.env.CORAL_PLUGIN_REGISTRY = join(tmpRoot, 'missing-installed_plugins.json');

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('anything')).toBeNull();
  });

  it('returns null when the registry file contains malformed JSON', () => {
    setRegistry('not valid json');

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('anything')).toBeNull();
  });

  it('returns null when the registry file shape is invalid', () => {
    setRegistry({
      version: 1,
      plugins: {
        foo: { installPath: createPluginRoot('invalid-shape-root') },
      },
    });

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('foo')).toBeNull();
  });

  it('uses outer-key insertion order when multiple keys share the same namespace', () => {
    const firstRoot = createPluginRoot('foo-first');
    const secondRoot = createPluginRoot('foo-second');
    setRegistry({
      version: 1,
      plugins: {
        'foo@m1': [{ installPath: firstRoot, scope: 'user' }],
        'foo@m2': [{ installPath: secondRoot, scope: 'workspace' }],
      },
    });

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('foo')).toBe(firstRoot);
  });

  it('uses inner-array order within a matching registry key', () => {
    const firstRoot = createPluginRoot('foo-array-first');
    const secondRoot = createPluginRoot('foo-array-second');
    setRegistry({
      version: 1,
      plugins: {
        'foo@m1': [
          { installPath: firstRoot, scope: 'workspace' },
          { installPath: secondRoot, scope: 'project' },
        ],
      },
    });

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('foo')).toBe(firstRoot);
  });

  it('skips stale install paths and continues searching matching keys', () => {
    const freshRoot = createPluginRoot('foo-fresh');
    setRegistry({
      version: 1,
      plugins: {
        'foo@m1': [{ installPath: join(tmpRoot, 'foo-stale'), scope: 'user' }],
        'foo@m2': [{ installPath: freshRoot, scope: 'project' }],
      },
    });

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('foo')).toBe(freshRoot);
  });

  it('caches resolved namespaces and does not reread the registry file on repeat lookup', () => {
    const cachedRoot = createPluginRoot('foo-cached');
    const registryPath = setRegistry({
      version: 1,
      plugins: {
        'foo@m1': [{ installPath: cachedRoot, scope: 'workspace' }],
      },
    });

    const registry = createPluginRegistry({
      storage: {
        readFileSync: (path, encoding) => readFileSync(path, encoding),
        existsSync: (path) => existsSync(path),
      },
      env: {
        get: (key) => process.env[key],
      },
    });

    expect(registry.discoverPluginRoot('foo')).toBe(cachedRoot);
    expect(registry.discoverPluginRoot('foo')).toBe(cachedRoot);
    expect(fsCalls.readFileSync).toEqual([[registryPath, 'utf-8']]);
    expect(fsCalls.existsSync).toEqual([[cachedRoot]]);
  });

  it('parses plugin keys with indexOf so marketplace names can contain @', () => {
    const pluginRoot = createPluginRoot('foo-marketplace-root');
    setRegistry({
      version: 1,
      plugins: {
        'foo@bar@baz': [{ installPath: pluginRoot, scope: 'workspace' }],
      },
    });

    const registry = createPluginRegistry();

    expect(registry.discoverPluginRoot('foo')).toBe(pluginRoot);
    expect(registry.discoverPluginRoot('foo@bar')).toBeNull();
  });
});
