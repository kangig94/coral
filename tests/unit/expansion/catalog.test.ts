import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { catalogEntrySchema } from '#src/expansion/contracts.js';
import { EQUIPMENT_ADDON_FILENAMES } from '#src/expansion/paths.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  CATALOG,
  getCatalogEntry,
  listCatalogEntries,
} from '#src/expansion/catalog.js';
import {
  EquipmentAddonStrategy,
  equipmentAddonStrategy,
} from '#src/expansion/strategies/equipment-addon.js';
import {
  GithubBinaryStrategy,
  githubBinaryStrategy,
} from '#src/expansion/strategies/github-binary.js';

describe('expansion catalog (AC3)', () => {
  it('resolves the needle equipment-addon binding with the planned metadata and config', () => {
    const needle = getCatalogEntry('needle');

    expect(needle).toBeDefined();
    expect(needle?.entry).toEqual({
      id: 'needle',
      name: 'Knowledge Base Vector Runtime',
      description: 'Installs coral-needle native addon for vector search',
      activation: 'equipment',
      status: 'not_equipped',
    });
    expect(needle?.strategy).toBe(equipmentAddonStrategy);
    expect(needle?.strategy).toBeInstanceOf(EquipmentAddonStrategy);
    expect(needle?.config).toEqual({
      name: 'needle',
      repo: 'kangig94/coral-needle',
      needleVersion: '0.2.0',
      addonFilename: EQUIPMENT_ADDON_FILENAMES.needle,
      postInstall: ['register_equipment'],
    });
    expect(needle?.resolveConfig({ env: { homedir: () => '/tmp/coral-home' } } as unknown as Runtime)).toMatchObject({
      onboarding: {
        envPath: join('/tmp/coral-home', '.coral', '.env'),
        requiredEnv: [
          {
            provider: 'local-onnx',
            env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_MODEL'],
          },
          {
            provider: 'default',
            env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
          },
        ],
        providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
        modelEnvKey: 'CORAL_EMBEDDING_MODEL',
        apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
        securityNotice: 'Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json.',
        localRuntime: {
          targetDir: join('/tmp/coral-home', '.coral', 'data', 'kb'),
          bootstrapPackageJson: true,
          packageManager: 'npm',
          packageName: 'onnxruntime-node',
        },
        choices: [
          {
            id: 'local-nomic-embed-text',
            label: 'Local model: nomic-embed-text',
            provider: 'local-onnx',
            model: 'nomic-embed-text',
            dims: 768,
          },
          {
            id: 'local-bge-m3',
            label: 'Local model: bge-m3',
            provider: 'local-onnx',
            model: 'bge-m3',
            dims: 1024,
          },
          {
            id: 'manual',
            label: 'Manual setup',
            provider: null,
            model: null,
            dims: null,
          },
        ],
      },
    });
  });

  it('resolves the cgc github-binary binding with the planned metadata and config', () => {
    const cgc = getCatalogEntry('cgc');

    expect(cgc).toBeDefined();
    expect(cgc?.entry).toEqual({
      id: 'cgc',
      name: 'CodeGraphContext',
      description: 'Indexes code into a graph database for AI-powered analysis',
      activation: 'none',
      status: 'not_installed',
    });
    expect(cgc?.strategy).toBe(githubBinaryStrategy);
    expect(cgc?.strategy).toBeInstanceOf(GithubBinaryStrategy);
    expect(cgc?.config).toEqual({
      name: 'cgc',
      repo: 'CodeGraphContext/CodeGraphContext',
      fallbackVersion: 'v0.3.1',
      binaries: {
        'linux-x64': 'cgc-linux-x64',
        'darwin-x64': 'cgc-macos-x64',
        'win32-x64': 'cgc-windows-x64.exe',
      },
      pip: 'codegraphcontext',
    });
  });

  it('lists both catalog entries and keeps every entry schema-valid', () => {
    expect(Object.keys(CATALOG).sort()).toEqual(['cgc', 'needle']);
    expect(listCatalogEntries().map((binding) => binding.entry.id).sort()).toEqual(['cgc', 'needle']);

    for (const binding of listCatalogEntries()) {
      expect(catalogEntrySchema.parse(binding.entry)).toEqual(binding.entry);
    }
  });
});
