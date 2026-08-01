import { basename, dirname, join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { acquireDirectoryLock, type DirectoryLockLease } from '../infra/fs-lock.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';

export type GenerationMutationKind = 'install' | 'update' | 'uninstall';

export interface GenerationReadinessCompletion {
  release(): void;
}

export interface GenerationWriterLease {
  assertOwned(): void;
  release(): void;
}

export interface GenerationMutationCoordination {
  completeReadiness(
    runtime: Runtime,
    mutation: { readonly kind: GenerationMutationKind; readonly name: string },
  ): Promise<GenerationReadinessCompletion>;
  acquireWriterLease(
    runtime: Runtime,
    mutation: { readonly kind: GenerationMutationKind; readonly name: string },
  ): Promise<GenerationWriterLease>;
}

export type GenerationBoundaryPaths = {
  readonly baseDir: string;
  readonly generationRoot: string;
  readonly generatedFlavorRoot: string;
  readonly legacyFlavorRoot: string;
  readonly adoptionLock: string;
  readonly coordinationRoot: string;
  readonly admissionLock: string;
  readonly maintenanceLock: string;
  readonly writersRoot: string;
};

export type GenerationReadiness =
  | { readonly kind: 'generated-ready' }
  | { readonly kind: 'ready-to-initialize'; readonly legacyPath?: string };

export interface GenerationMaintenanceLease {
  assertOwned(): void;
  release(): void;
}

export interface GenerationAdoptionLease {
  assertOwned(): void;
  release(): void;
}

const GENERATION_COORDINATION_TIMEOUT_MS = 5_000;
const GENERATION_COORDINATION_STALE_MS = 10 * 60 * 1_000;
const GENERATION_COORDINATION_HEARTBEAT_MS = 10 * 1_000;
const GENERATION_COORDINATION_RETRY_MS = 25;
const LEGACY_GENERATION_READER_VERSION = '0.9.x';

function flavorDirectory(runtime: Pick<Runtime, 'flavor'>): string {
  return runtime.flavor === 'dev' ? 'data-dev' : 'data';
}

export function resolveGenerationBoundaryPaths(runtime: Pick<Runtime, 'flavor' | 'paths'>): GenerationBoundaryPaths {
  const generatedFlavorRoot = dirname(runtime.paths.coral.engine.engineRoot);
  const generationRoot = dirname(generatedFlavorRoot);
  const baseDir = dirname(generationRoot);
  const flavorDir = flavorDirectory(runtime);
  if (basename(generatedFlavorRoot) !== flavorDir) {
    throw new Error(`Generated flavor root does not end in '${flavorDir}': ${generatedFlavorRoot}`);
  }
  const coordinationRoot = join(generationRoot, `.mutation-${flavorDir}`);
  return {
    baseDir,
    generationRoot,
    generatedFlavorRoot,
    legacyFlavorRoot: join(baseDir, flavorDir),
    adoptionLock: join(generationRoot, `.adoption-${flavorDir}.lock`),
    coordinationRoot,
    admissionLock: join(coordinationRoot, 'admission.lock'),
    maintenanceLock: join(coordinationRoot, 'maintenance.lock'),
    writersRoot: join(coordinationRoot, 'writers'),
  };
}

export function inspectGenerationReadiness(
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage'>,
): GenerationReadiness {
  const paths = resolveGenerationBoundaryPaths(runtime);
  if (runtime.storage.existsSync(paths.generatedFlavorRoot)) {
    return { kind: 'generated-ready' };
  }
  if (!runtime.storage.existsSync(paths.legacyFlavorRoot)) {
    return { kind: 'ready-to-initialize' };
  }

  backendLog.warn(
    `Legacy Coral history remains at ${paths.legacyFlavorRoot}; Coral ${LEGACY_GENERATION_READER_VERSION} ` +
      `continues to own and read that tree. This generation will initialize empty state at ` +
      `${paths.generatedFlavorRoot} without inspecting or changing the legacy tree.`,
  );
  return { kind: 'ready-to-initialize', legacyPath: paths.legacyFlavorRoot };
}

function directoryLockDeps(runtime: Runtime) {
  return {
    storage: runtime.storage,
    time: {
      now: () => runtime.time.now(),
      sleep: (ms: number) => runtime.time.sleep(ms),
      setInterval: runtime.time.setInterval.bind(runtime.time),
      clearInterval: runtime.time.clearInterval.bind(runtime.time),
    },
    staleMs: GENERATION_COORDINATION_STALE_MS,
    heartbeatMs: GENERATION_COORDINATION_HEARTBEAT_MS,
  };
}

function ensureCoordinationRoot(runtime: Runtime, paths: GenerationBoundaryPaths): void {
  runtime.storage.mkdirSync(paths.writersRoot, { recursive: true });
}

async function acquireAdoptionLock(runtime: Runtime, paths: GenerationBoundaryPaths): Promise<DirectoryLockLease> {
  runtime.storage.mkdirSync(paths.generationRoot, { recursive: true });
  return acquireDirectoryLock(paths.adoptionLock, directoryLockDeps(runtime), GENERATION_COORDINATION_TIMEOUT_MS);
}

export async function acquireGenerationAdoptionLease(runtime: Runtime): Promise<GenerationAdoptionLease> {
  const paths = resolveGenerationBoundaryPaths(runtime);
  const releaseAdoption = await acquireAdoptionLock(runtime, paths);
  try {
    inspectGenerationReadiness(runtime);
  } catch (error) {
    releaseAdoption();
    throw error;
  }
  return {
    assertOwned: releaseAdoption.assertOwned,
    release: releaseAdoption,
  };
}

function writerLeaseName(runtime: Runtime, mutation: { readonly kind: GenerationMutationKind; readonly name: string }) {
  return `${runtime.env.pid()}-${mutation.kind}-${encodeURIComponent(mutation.name)}.lease-${runtime.ids.uuid()}.lock`;
}

function writerHolder(entry: string): { readonly pid: number; readonly description: string } | null {
  const match = /^(\d+)-(install|update|uninstall)-(.+)\.lease-[^.]+\.lock$/u.exec(entry);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  return { pid, description: `${match[2]}:${name} (pid ${pid})` };
}

function writerEntries(runtime: Runtime, paths: GenerationBoundaryPaths): string[] {
  try {
    return runtime.storage.readdirSync(paths.writersRoot).filter((entry) => entry.endsWith('.lock'));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw quiescenceError(runtime, `unreadable writer lease directory at ${paths.writersRoot}`);
  }
}

function removeDeadWriterLeases(runtime: Runtime, paths: GenerationBoundaryPaths): string[] {
  const live: string[] = [];
  for (const entry of writerEntries(runtime, paths)) {
    const holder = writerHolder(entry);
    if (holder === null) {
      live.push(entry);
      continue;
    }
    if (runtime.process.isAlive(holder.pid)) {
      live.push(holder.description);
      continue;
    }
    runtime.storage.rmSync(join(paths.writersRoot, entry), { recursive: true, force: true });
  }
  return live;
}

function quiescenceError(runtime: Pick<Runtime, 'flavor'>, holder: string): Error {
  return documentedCoralSetupError({
    code: 'legacy_source_not_quiescent',
    flavor: runtime.flavor,
    holder,
  });
}

export const generationMutationCoordinationSeam: GenerationMutationCoordination = {
  async completeReadiness(runtime) {
    return acquireGenerationAdoptionLease(runtime);
  },
  async acquireWriterLease(runtime, mutation) {
    const paths = resolveGenerationBoundaryPaths(runtime);
    ensureCoordinationRoot(runtime, paths);
    const deadline = runtime.time.now() + GENERATION_COORDINATION_TIMEOUT_MS;

    while (runtime.time.now() < deadline) {
      const releaseAdmission = await acquireDirectoryLock(
        paths.admissionLock,
        directoryLockDeps(runtime),
        GENERATION_COORDINATION_TIMEOUT_MS,
      );
      try {
        if (!runtime.storage.existsSync(paths.maintenanceLock)) {
          const releaseWriter = await acquireDirectoryLock(
            join(paths.writersRoot, writerLeaseName(runtime, mutation)),
            directoryLockDeps(runtime),
            GENERATION_COORDINATION_TIMEOUT_MS,
          );
          return {
            assertOwned: releaseWriter.assertOwned,
            release: releaseWriter,
          };
        }
      } finally {
        releaseAdmission();
      }
      await runtime.time.sleep(GENERATION_COORDINATION_RETRY_MS);
    }

    throw quiescenceError(runtime, 'generation maintenance');
  },
};

export async function acquireGenerationMaintenanceLease(
  runtime: Runtime,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationMaintenanceLease> {
  const paths = resolveGenerationBoundaryPaths(runtime);
  ensureCoordinationRoot(runtime, paths);
  const releaseAdmission = await acquireDirectoryLock(paths.admissionLock, directoryLockDeps(runtime), timeoutMs);
  let releaseMaintenance: DirectoryLockLease;
  try {
    releaseMaintenance = await acquireDirectoryLock(paths.maintenanceLock, directoryLockDeps(runtime), timeoutMs);
  } finally {
    releaseAdmission();
  }

  const deadline = runtime.time.now() + timeoutMs;
  try {
    while (true) {
      const live = removeDeadWriterLeases(runtime, paths);
      if (live.length === 0) break;
      if (runtime.time.now() >= deadline) {
        throw quiescenceError(runtime, live.join(', '));
      }
      await runtime.time.sleep(GENERATION_COORDINATION_RETRY_MS);
    }

    let owned = true;
    return {
      assertOwned() {
        if (!owned) throw new Error('Generation maintenance lease is no longer owned.');
        releaseMaintenance.assertOwned();
      },
      release() {
        if (!owned) return;
        owned = false;
        releaseMaintenance();
      },
    };
  } catch (error) {
    releaseMaintenance();
    throw error;
  }
}

export async function acquireGenerationWriterLeaseAfterReadiness(
  coordination: GenerationMutationCoordination,
  runtime: Runtime,
  mutation: { readonly kind: GenerationMutationKind; readonly name: string },
): Promise<GenerationWriterLease> {
  const readiness = await coordination.completeReadiness(runtime, mutation);
  readiness.release();
  return coordination.acquireWriterLease(runtime, mutation);
}
