import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type { Runtime } from '../runtime/ports.js';
import { catalogEntrySchema, onboardingSchema, type CatalogEntry, type Onboarding } from './contracts.js';
import { EQUIPMENT_ADDON_FILENAMES } from './paths.js';
import {
  equipmentAddonStrategy,
  type EquipmentAddonConfig,
} from './strategies/equipment-addon.js';
import {
  githubBinaryStrategy,
  type GithubBinaryConfig,
} from './strategies/github-binary.js';
import type { Strategy } from './strategies/strategy.js';

const catalogIdSchema = z.enum(['needle', 'cgc']);
const activationSchema = z.enum(['equipment', 'none']);
const strategyKindSchema = z.enum(['equipment-addon', 'github-binary']);

const equipmentAddonConfigSchema = z
  .object({
    name: z.literal('needle'),
    repo: z.string().min(1),
    needleVersion: z.string().min(1),
    addonFilename: z.string().min(1),
    postInstall: z.array(z.literal('register_equipment')).optional(),
  })
  .strict();

const githubBinaryConfigSchema = z
  .object({
    name: z.literal('cgc'),
    repo: z.string().min(1),
    fallbackVersion: z.string().min(1),
    binaries: z.record(z.string(), z.string().min(1)),
    pip: z.string().min(1).optional(),
  })
  .strict();

const equipmentAddonBindingSchema = z
  .object({
    id: z.literal('needle'),
    name: z.string().min(1),
    description: z.string().min(1),
    activation: z.literal('equipment'),
    strategy: z.literal('equipment-addon'),
    config: equipmentAddonConfigSchema,
  })
  .strict();

const githubBinaryBindingSchema = z
  .object({
    id: z.literal('cgc'),
    name: z.string().min(1),
    description: z.string().min(1),
    activation: z.literal('none'),
    strategy: z.literal('github-binary'),
    config: githubBinaryConfigSchema,
  })
  .strict();

const catalogSourceSchema = z.record(
  catalogIdSchema,
  z.discriminatedUnion('strategy', [equipmentAddonBindingSchema, githubBinaryBindingSchema]),
);

const NEEDLE_SECURITY_NOTICE = 'Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json.';

const NEEDLE_REQUIRED_ENV = [
  {
    provider: 'local-onnx',
    env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_MODEL'],
  },
  {
    provider: 'default',
    env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
  },
] as const;

const NEEDLE_ONBOARDING_CHOICES = [
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
] as const;

type Activation = z.infer<typeof activationSchema>;
type StrategyKind = z.infer<typeof strategyKindSchema>;

type CatalogSourceEntry = z.infer<typeof equipmentAddonBindingSchema> | z.infer<typeof githubBinaryBindingSchema>;

export interface CatalogBinding<Config> {
  readonly entry: CatalogEntry;
  readonly strategyKind: StrategyKind;
  readonly strategy: Strategy<Config>;
  readonly config: Config;
  resolveConfig(runtime: Runtime): Config;
}

function buildNeedleOnboarding(homeDir: string): Onboarding {
  return onboardingSchema.parse({
    envPath: join(homeDir, '.coral', '.env'),
    requiredEnv: NEEDLE_REQUIRED_ENV.map((rule) => ({ provider: rule.provider, env: [...rule.env] })),
    providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
    modelEnvKey: 'CORAL_EMBEDDING_MODEL',
    apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
    securityNotice: NEEDLE_SECURITY_NOTICE,
    localRuntime: {
      targetDir: join(homeDir, '.coral', 'data', 'kb'),
      bootstrapPackageJson: true,
      packageManager: 'npm',
      packageName: 'onnxruntime-node',
    },
    choices: NEEDLE_ONBOARDING_CHOICES.map((choice) => ({ ...choice })),
  });
}

function buildCatalogBinding(entry: CatalogSourceEntry): CatalogBinding<EquipmentAddonConfig | GithubBinaryConfig> {
  if (entry.strategy === 'equipment-addon') {
    const config: EquipmentAddonConfig = {
      ...entry.config,
      addonFilename: EQUIPMENT_ADDON_FILENAMES.needle,
      onboarding: buildNeedleOnboarding(homedir()),
    };
    return {
      entry: catalogEntrySchema.parse({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        activation: entry.activation,
        status: 'not_equipped',
      }),
      strategyKind: entry.strategy,
      strategy: equipmentAddonStrategy,
      config,
      resolveConfig: (runtime) => ({
        ...config,
        onboarding: buildNeedleOnboarding(runtime.env.homedir()),
      }),
    };
  }

  const config: GithubBinaryConfig = { ...entry.config };
  return {
    entry: catalogEntrySchema.parse({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      activation: entry.activation,
      status: 'not_installed',
    }),
    strategyKind: entry.strategy,
    strategy: githubBinaryStrategy,
    config,
    resolveConfig: () => ({ ...config }),
  };
}

const catalogSource = catalogSourceSchema.parse({
  needle: {
    id: 'needle',
    name: 'Knowledge Base Vector Runtime',
    description: 'Installs coral-needle native addon for vector search',
    activation: 'equipment',
    strategy: 'equipment-addon',
    config: {
      name: 'needle',
      repo: 'kangig94/coral-needle',
      needleVersion: '0.2.0',
      addonFilename: EQUIPMENT_ADDON_FILENAMES.needle,
      postInstall: ['register_equipment'],
    },
  },
  cgc: {
    id: 'cgc',
    name: 'CodeGraphContext',
    description: 'Indexes code into a graph database for AI-powered analysis',
    activation: 'none',
    strategy: 'github-binary',
    config: {
      name: 'cgc',
      repo: 'CodeGraphContext/CodeGraphContext',
      fallbackVersion: 'v0.3.1',
      binaries: {
        'linux-x64': 'cgc-linux-x64',
        'darwin-x64': 'cgc-macos-x64',
        'win32-x64': 'cgc-windows-x64.exe',
      },
      pip: 'codegraphcontext',
    },
  },
});

export const CATALOG = Object.freeze(
  Object.fromEntries(
    Object.entries(catalogSource).map(([name, entry]) => [name, buildCatalogBinding(entry)]),
  ) as Record<keyof typeof catalogSource, CatalogBinding<EquipmentAddonConfig | GithubBinaryConfig>>,
);

export type CatalogName = keyof typeof CATALOG;

export function getCatalogEntry(name: string): CatalogBinding<EquipmentAddonConfig | GithubBinaryConfig> | null {
  return CATALOG[name as keyof typeof CATALOG] ?? null;
}

export function listCatalogEntries(): Array<CatalogBinding<EquipmentAddonConfig | GithubBinaryConfig>> {
  return Object.values(CATALOG);
}
