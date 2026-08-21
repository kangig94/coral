// Canonical CoralPaths composer. Public surface of the `infra/path/` subdir;
// sibling files (root/store/coordinator/engine) stay subdir-internal so the
// runtime port (`runtime.paths.coral`) is the single access path. The retired
// `src/infra/paths.ts` magnet must not return — see
// tests/invariants/architecture-boundary.test.ts.

import { basename, join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { type CoordinatorPaths, coordinatorPaths, socketPathForRunDir } from './coordinator.js';
import { coralStateRoot, generationRoot, generationStateRoot, kbVaultRoot } from './root.js';
import { type EnginePaths, enginePaths } from './engine.js';
import { type KbRuntimePaths, kbRuntimePaths } from './kb-runtime.js';
import {
  ProviderProxyEndpointError,
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerHandoffCapsuleFileSuffix,
  providerHandoffCapsulePath,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
} from './provider-proxy.js';
import { type StorePaths, storePaths } from './store.js';

export interface CorpusPaths {
  kbRoot: string;
  notesDir: string;
  sourcesDir: string;
  principlesDir: string;
  communitiesDir: string;
  wikiDir: string;
}

export interface ExportsPaths {
  jobsRoot: string;
}

export interface ProjectsPaths {
  readonly root: string;
  dataDir(source: string): string;
}

export interface GenerationPaths {
  readonly root: string;
  readonly dataRoot: string;
  readonly legacyDataRoot: string;
  readonly adoptionLock: string;
}

export type CoralPaths = {
  readonly generation: GenerationPaths;
  readonly store: StorePaths;
  readonly corpus: CorpusPaths;
  readonly kbRuntime: KbRuntimePaths;
  readonly coordinator: CoordinatorPaths;
  readonly exports: ExportsPaths;
  readonly engine: EnginePaths;
  readonly projects: ProjectsPaths;
};

// Re-export per-family types so external callers (transport, expansion,
// test fixtures) see a single public surface for path-shape vocabulary.
// Stable path construction stays behind the eager runtime port; instance-keyed
// provider endpoint and capsule paths are dynamic and therefore publish their constructors here.
export type { CoordinatorPaths } from './coordinator.js';
export { socketPathForRunDir };
export { isRelocatedSocket } from './unix-socket.js';
export type {
  ProviderBootstrapCapsulePathOptions,
  ProviderGuardianEndpointIdentity,
  ProviderProxyEndpointEnvironment,
  ProviderProxyEndpointErrorCode,
  ProviderProxyEndpointIdentity,
  ProviderReaperEndpointIdentity,
} from './provider-proxy.js';
export {
  ProviderProxyEndpointError,
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerHandoffCapsuleFileSuffix,
  providerHandoffCapsulePath,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
};
// Config-dir resolution remains public for plugin discovery and provider
// credentials. It never participates in Coral daemon path composition.
export { resolveClaudeConfigDir, resolveUserHomeDir } from './root.js';

export interface FamilyPathOptions {
  readonly baseDir?: string;
}

export interface CorpusPathOptions extends FamilyPathOptions {
  /** Resolved CORAL_KB_PATH value from caller's env port (vault override). */
  readonly customKbRoot?: string;
}

// `corpusPaths` and `exportsPaths` live inside the composer file rather than
// in their own siblings: corpus piggybacks on `kbVaultRoot` (already in
// root.ts) and exports has a single field. Splitting either into its own
// file would be premature. They stay exported for path-layout tests that
// assert each family in isolation.
export function corpusPaths(flavor: BuildFlavor, opts?: CorpusPathOptions): CorpusPaths {
  const kbRootDir = kbVaultRoot(flavor, {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
    ...(opts?.customKbRoot === undefined ? {} : { customRoot: opts.customKbRoot }),
  });
  return {
    kbRoot: kbRootDir,
    notesDir: join(kbRootDir, 'notes'),
    sourcesDir: join(kbRootDir, 'sources'),
    principlesDir: join(kbRootDir, 'principles'),
    communitiesDir: join(kbRootDir, 'communities'),
    wikiDir: join(kbRootDir, 'wiki'),
  };
}

export function exportsPaths(flavor: BuildFlavor, opts?: FamilyPathOptions): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return {
    jobsRoot: join(coralStateRoot(opts?.baseDir), base, 'jobs'),
  };
}

/** Map a project source (`owner/repo` or `local/basename`) to its directory slug. */
function sourceToSlug(source: string): string {
  return source.replace(/\//g, '-');
}

// Flavor-separated like every other family: prod writes under `projects`, dev
// under `projects-dev`, so a dev build never shares a project's memo tree with
// prod. Enforced uniformly by tests/invariants/flavor-path-separation.test.ts.
export function projectsPaths(flavor: BuildFlavor, opts?: FamilyPathOptions): ProjectsPaths {
  const root = join(coralStateRoot(opts?.baseDir), flavor === 'dev' ? 'projects-dev' : 'projects');
  return {
    root,
    dataDir: (source) => join(root, sourceToSlug(source)),
  };
}

export interface ComposeCoralPathOptions {
  readonly baseDir?: string;
  /** Resolved CORAL_KB_PATH value from caller's env port. */
  readonly customKbRoot?: string;
}

function generationPaths(flavor: BuildFlavor, opts?: FamilyPathOptions): GenerationPaths {
  const root = generationRoot(opts);
  const dataRoot = generationStateRoot(flavor, opts);
  const dataDirectory = basename(dataRoot);
  return {
    root,
    dataRoot,
    legacyDataRoot: join(coralStateRoot(opts?.baseDir), dataDirectory),
    adoptionLock: join(root, `.adoption-${dataDirectory}.lock`),
  };
}

export function composeCoralPaths(flavor: BuildFlavor, opts?: ComposeCoralPathOptions): CoralPaths {
  // Provider account selection never changes Coral-owned state paths.
  const stateOpts: FamilyPathOptions = {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
  };
  const corpusOpts: CorpusPathOptions = {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
    ...(opts?.customKbRoot === undefined ? {} : { customKbRoot: opts.customKbRoot }),
  };
  return {
    generation: generationPaths(flavor, stateOpts),
    store: storePaths(flavor, stateOpts),
    corpus: corpusPaths(flavor, corpusOpts),
    kbRuntime: kbRuntimePaths(flavor, stateOpts),
    coordinator: coordinatorPaths(flavor, stateOpts),
    exports: exportsPaths(flavor, stateOpts),
    engine: enginePaths(flavor, stateOpts),
    projects: projectsPaths(flavor, stateOpts),
  };
}
