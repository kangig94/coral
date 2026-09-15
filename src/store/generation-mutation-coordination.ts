import { basename, dirname, join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import { assertNever } from '../infra/error-format.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import {
  acquireDirectoryLock,
  createDirectoryLockParent,
  isDirectoryLockTimeoutError,
  tryAcquireDirectoryLock,
  type ActuatedDirectoryLockLease,
} from '../infra/fs-lock.js';
import { recordedProcessIdentitySchema, type RecordedProcessIdentity } from '../infra/process-containment.js';
import type { StorageActuator } from '../infra/storage-actuator.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';

export type GenerationMutationKind = 'install' | 'update' | 'uninstall' | 'kb-child' | 'routing-status';

export interface GenerationReadinessCompletion {
  release(): void;
}

export interface GenerationWriterLease {
  readonly directoryLock: ActuatedDirectoryLockLease;
  assertOwned(): void;
  release(): void;
}

export type GenerationWriterLeaseAttempt =
  | Readonly<{ kind: 'acquired'; lease: GenerationWriterLease }>
  | Readonly<{ kind: 'maintenance-active' }>
  | Readonly<{ kind: 'contended' }>;

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

/**
 * A previous generation's tree is never a precondition for this one. Whether its
 * store is readable by this build or not makes no difference to startup: the
 * generation boundary exists to end the coupling, so legacy bytes are left where
 * they are and this generation initializes its own state. `legacy-ignored`
 * therefore covers both a foreign store and one this build happens to be able to
 * read — the distinction only ever mattered to a migration path that no longer
 * exists.
 */
export type GenerationReadiness =
  | { readonly kind: 'generated-ready' }
  | { readonly kind: 'no-legacy' }
  | {
      readonly kind: 'legacy-ignored';
      readonly legacyPath: string;
      readonly generatedPath: string;
    };

export interface GenerationMaintenanceLease {
  assertOwned(): void;
  maintain(): void;
  release(): void;
}

export interface GenerationAdoptionLease {
  assertOwned(): void;
  release(): void;
}

const GENERATION_ADOPTION_LOCK_BRAND: unique symbol = Symbol('GenerationAdoptionLockLease');

export type GenerationAdoptionLockLease = ActuatedDirectoryLockLease & {
  readonly [GENERATION_ADOPTION_LOCK_BRAND]: true;
};

const GENERATION_COORDINATION_TIMEOUT_MS = 5_000;
const GENERATION_COORDINATION_STALE_MS = 10 * 60 * 1_000;
const GENERATION_COORDINATION_HEARTBEAT_MS = 10 * 1_000;
const GENERATION_COORDINATION_RETRY_MS = 25;
const WRITER_IDENTITY_FILE = 'identity.json';

export function resolveGenerationBoundaryPaths(runtime: Pick<Runtime, 'paths'>): GenerationBoundaryPaths {
  const generation = runtime.paths.coral.generation;
  const flavorDir = basename(generation.dataRoot);
  const coordinationRoot = join(generation.root, `.mutation-${flavorDir}`);
  return {
    baseDir: dirname(generation.legacyDataRoot),
    generationRoot: generation.root,
    generatedFlavorRoot: generation.dataRoot,
    legacyFlavorRoot: generation.legacyDataRoot,
    adoptionLock: generation.adoptionLock,
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
    return { kind: 'no-legacy' };
  }

  return {
    kind: 'legacy-ignored',
    legacyPath: paths.legacyFlavorRoot,
    generatedPath: paths.generatedFlavorRoot,
  };
}

export function formatLegacyGenerationIgnoredNotice(
  readiness: Extract<GenerationReadiness, { readonly kind: 'legacy-ignored' }>,
): string {
  return (
    `Legacy Coral history remains at ${readiness.legacyPath}; its contents were not inspected or changed. ` +
    `This generation initializes its own state at ${readiness.generatedPath}.`
  );
}

function directoryLockDeps(runtime: Runtime) {
  return {
    storage: runtime.storage,
    time: {
      now: () => runtime.time.now(),
      monotonicNow: () => runtime.time.monotonicNow(),
      sleep: (ms: number) => runtime.time.sleep(ms),
      setInterval: runtime.time.setInterval.bind(runtime.time),
      clearInterval: runtime.time.clearInterval.bind(runtime.time),
    },
    staleMs: GENERATION_COORDINATION_STALE_MS,
    heartbeatMs: GENERATION_COORDINATION_HEARTBEAT_MS,
  };
}

export function generationNotQuiescentError(
  runtime: Pick<Runtime, 'flavor'>,
  holder: string,
  writerObservation: 'writer-live' | 'writer-unobservable',
): Error {
  return documentedCoralSetupError({
    code:
      writerObservation === 'writer-live' ? 'legacy_source_not_quiescent' : 'legacy_source_writer_observation_unknown',
    flavor: runtime.flavor,
    holder,
  });
}

function ensureCoordinationRoot(runtime: Runtime, paths: GenerationBoundaryPaths): void {
  createDirectoryLockParent(runtime.storage, paths.writersRoot);
}

export async function acquireGenerationAdoptionLock(
  runtime: Runtime,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationAdoptionLockLease> {
  const lease = await tryAcquireGenerationAdoptionLock(runtime, timeoutMs);
  if (lease !== null) return lease;
  const paths = resolveGenerationBoundaryPaths(runtime);
  throw generationNotQuiescentError(runtime, `adoption lock at ${paths.adoptionLock}`, 'writer-live');
}

export async function tryAcquireGenerationAdoptionLock(
  runtime: Runtime,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationAdoptionLockLease | null> {
  const paths = resolveGenerationBoundaryPaths(runtime);
  createDirectoryLockParent(runtime.storage, paths.generationRoot);
  try {
    const lease = await acquireDirectoryLock(paths.adoptionLock, directoryLockDeps(runtime), timeoutMs);
    Object.defineProperty(lease, GENERATION_ADOPTION_LOCK_BRAND, { value: true });
    return lease as GenerationAdoptionLockLease;
  } catch (error: unknown) {
    if (isDirectoryLockTimeoutError(error)) return null;
    throw error;
  }
}

export async function acquireGenerationAdoptionLease(
  runtime: Runtime,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationAdoptionLease> {
  const releaseAdoption = await acquireGenerationAdoptionLock(runtime, timeoutMs);
  try {
    const readiness = inspectGenerationReadiness(runtime);
    switch (readiness.kind) {
      case 'generated-ready':
      case 'no-legacy':
        break;
      case 'legacy-ignored':
        backendLog.warn(formatLegacyGenerationIgnoredNotice(readiness));
        break;
      default:
        assertNever(readiness);
    }
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

function writerIdentity(runtime: Runtime): RecordedProcessIdentity {
  const pid = runtime.env.pid();
  const incarnation = runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform);
  if (incarnation === null) {
    throw generationNotQuiescentError(runtime, `writer process identity for pid ${pid}`, 'writer-unobservable');
  }
  return { pid, incarnation };
}

function writerHolder(
  runtime: Runtime,
  paths: GenerationBoundaryPaths,
  entry: string,
): { readonly identity: RecordedProcessIdentity; readonly description: string } | null {
  const match = /^(\d+)-(install|update|uninstall|kb-child|routing-status)-(.+)\.lease-[^.]+\.lock$/u.exec(entry);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  try {
    const parsed = recordedProcessIdentitySchema.safeParse(
      JSON.parse(runtime.storage.readFileSync(join(paths.writersRoot, entry, WRITER_IDENTITY_FILE), 'utf-8')),
    );
    if (!parsed.success || parsed.data.pid !== pid) return null;
    return { identity: parsed.data, description: `${match[2]}:${name} (pid ${pid})` };
  } catch {
    return null;
  }
}

function writerEntries(runtime: Runtime, paths: GenerationBoundaryPaths): string[] {
  try {
    return runtime.storage.readdirSync(paths.writersRoot).filter((entry) => entry.endsWith('.lock'));
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw generationNotQuiescentError(
      runtime,
      `unreadable writer lease directory at ${paths.writersRoot}`,
      'writer-unobservable',
    );
  }
}

type GenerationWriterBlocker = Readonly<{
  description: string;
  observation: 'alive' | 'unknown';
}>;

function removeWriterLease(paths: GenerationBoundaryPaths, entry: string, held: StorageActuator): void {
  held.remove(join(paths.writersRoot, entry), { recursive: true, force: true });
}

function reclaimStaleWriterLease(runtime: Runtime, paths: GenerationBoundaryPaths, entry: string): boolean {
  const recovered = tryAcquireDirectoryLock(join(paths.writersRoot, entry), directoryLockDeps(runtime));
  if (recovered === null) return false;
  recovered();
  return true;
}

function removeDeadWriterLeases(
  runtime: Runtime,
  paths: GenerationBoundaryPaths,
  held: StorageActuator,
): GenerationWriterBlocker[] {
  const blockers: GenerationWriterBlocker[] = [];
  for (const entry of writerEntries(runtime, paths)) {
    const holder = writerHolder(runtime, paths, entry);
    if (holder === null) {
      if (!reclaimStaleWriterLease(runtime, paths, entry)) {
        blockers.push({ description: `${entry} (identity unreadable)`, observation: 'unknown' });
      }
      continue;
    }

    let incarnation: ReturnType<Runtime['process']['readProcessIncarnation']> = null;
    let liveness: ReturnType<Runtime['process']['observeLiveness']>;
    try {
      incarnation = runtime.process.readProcessIncarnation(
        holder.identity.pid,
        runtime.env.platform() as NodeJS.Platform,
      );
      if (incarnation !== null && incarnation !== holder.identity.incarnation) {
        removeWriterLease(paths, entry, held);
        continue;
      }
      liveness = runtime.process.observeLiveness(holder.identity.pid);
    } catch {
      liveness = 'unknown';
    }

    switch (liveness) {
      case 'absent':
        removeWriterLease(paths, entry, held);
        continue;
      case 'alive':
        if (incarnation === holder.identity.incarnation) {
          blockers.push({ description: holder.description, observation: 'alive' });
          continue;
        }
        break;
      case 'unknown':
        break;
      default:
        assertNever(liveness);
    }

    // A failed process observation cannot authorize deletion; only the independent heartbeat lease can age out.
    if (reclaimStaleWriterLease(runtime, paths, entry)) {
      continue;
    }
    blockers.push({ description: `${holder.description}, process identity unobservable`, observation: 'unknown' });
  }
  return blockers;
}

function acquireWriterLeaseUnderAdmission(
  runtime: Runtime,
  paths: GenerationBoundaryPaths,
  mutation: { readonly kind: GenerationMutationKind; readonly name: string },
): GenerationWriterLeaseAttempt {
  const maintenanceProbe = tryAcquireDirectoryLock(paths.maintenanceLock, directoryLockDeps(runtime));
  if (maintenanceProbe === null) return { kind: 'maintenance-active' };
  maintenanceProbe();
  const identity = writerIdentity(runtime);
  const leasePath = join(paths.writersRoot, writerLeaseName(runtime, mutation));
  const releaseWriter = tryAcquireDirectoryLock(leasePath, directoryLockDeps(runtime));
  if (releaseWriter === null) return { kind: 'contended' };
  const identityPath = join(leasePath, WRITER_IDENTITY_FILE);
  const held = releaseWriter.actuator;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      releaseWriter.assertOwned();
      held.unlink(identityPath);
    } catch {
      // Ownership is the authority to remove identity.json; the path may belong to a successor after loss.
    }
    try {
      releaseWriter();
    } catch {
      // Release is a total cleanup boundary; an underlying cleanup failure cannot escape.
    }
  };
  try {
    held.writeWholeFile(identityPath, JSON.stringify(identity), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (error) {
    release();
    throw error;
  }
  return {
    kind: 'acquired',
    lease: {
      directoryLock: releaseWriter,
      assertOwned: releaseWriter.assertOwned,
      release,
    },
  };
}

export function tryAcquireGenerationWriterLease(
  runtime: Runtime,
  mutation: { readonly kind: GenerationMutationKind; readonly name: string },
): GenerationWriterLeaseAttempt {
  const paths = resolveGenerationBoundaryPaths(runtime);
  ensureCoordinationRoot(runtime, paths);
  const releaseAdmission = tryAcquireDirectoryLock(paths.admissionLock, directoryLockDeps(runtime));
  if (releaseAdmission === null) return { kind: 'contended' };
  try {
    return acquireWriterLeaseUnderAdmission(runtime, paths, mutation);
  } finally {
    releaseAdmission();
  }
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
        const attempt = acquireWriterLeaseUnderAdmission(runtime, paths, mutation);
        if (attempt.kind === 'acquired') return attempt.lease;
      } finally {
        releaseAdmission();
      }
      await runtime.time.sleep(GENERATION_COORDINATION_RETRY_MS);
    }

    throw generationNotQuiescentError(runtime, 'generation maintenance', 'writer-live');
  },
};

export async function acquireGenerationMaintenanceLease(
  runtime: Runtime,
  timeoutMs = GENERATION_COORDINATION_TIMEOUT_MS,
): Promise<GenerationMaintenanceLease> {
  const paths = resolveGenerationBoundaryPaths(runtime);
  ensureCoordinationRoot(runtime, paths);
  const deadline = runtime.time.monotonicNow() + BigInt(timeoutMs);
  const remainingBudget = (): number => {
    const remaining = deadline - runtime.time.monotonicNow();
    return remaining > 0n ? Number(remaining) : 0;
  };
  const releaseAdmission = await acquireDirectoryLock(
    paths.admissionLock,
    directoryLockDeps(runtime),
    remainingBudget(),
  );
  let releaseMaintenance: ActuatedDirectoryLockLease;
  try {
    releaseMaintenance = await acquireDirectoryLock(
      paths.maintenanceLock,
      directoryLockDeps(runtime),
      remainingBudget(),
    );
  } finally {
    releaseAdmission();
  }

  try {
    const held = releaseMaintenance.actuator;
    while (true) {
      const blockers = removeDeadWriterLeases(runtime, paths, held);
      if (blockers.length === 0) break;
      if (runtime.time.monotonicNow() >= deadline) {
        throw generationNotQuiescentError(
          runtime,
          blockers.map((blocker) => blocker.description).join(', '),
          blockers.some((blocker) => blocker.observation === 'unknown') ? 'writer-unobservable' : 'writer-live',
        );
      }
      await runtime.time.sleep(GENERATION_COORDINATION_RETRY_MS);
    }

    let owned = true;
    const assertOwned = (): void => {
      if (!owned) throw new Error('Generation maintenance lease is no longer owned.');
      releaseMaintenance.assertOwned();
    };
    return {
      assertOwned,
      maintain() {
        if (!owned) assertOwned();
        releaseMaintenance.maintain();
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
