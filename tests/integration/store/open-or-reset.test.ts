import { currentCoralStoreFormat } from '#src/store-format.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync as renameFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';
import { createStoreResetInspectionFs } from '#src/infra/store-reset-inspection-fs.js';
import { BUNDLED_ENGINES } from '#src/expansion/bundled.js';
import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import { readDefaultExpansionCatalog, readExpansionCatalog } from '#src/cli/expansion/catalog.js';
import { openReadCoralStore } from '#src/cli/read-store.js';
import { createDefaultKbQueryRuntime, KbQueryRegistry } from '#src/read-model/kb-query-runtime.js';
import { documentedCoralSetupError, serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  acquireBackendStoreWriterExclusion,
  acquireBackendStoreResetLock,
  createBackendStoreResetAuthority,
  mintBackendStoreForClaim,
  publishClassifiedBackendStoreResetIncident,
  resolveBackendStoreFileSet,
  resumeBackendStoreResetIncidentForOperator,
  retainTransitionFileInStoreResetQuarantine,
  type BackendStoreResetAuthority,
  type WriterExclusion,
} from '#src/store/backend-store-reset.js';
import { ACTIVE_STORE_SELECTION_VERSION, type ActiveStoreSelection } from '#src/store/active-store-selection.js';
import { coordinateActiveStoreSelection } from '#src/store/active-store-selection-coordination.js';
import * as dbModule from '#src/store/db.js';
import { classifyStoreFile, openStoreDatabase, openWritableStoreDbNoReset } from '#src/store/db.js';
import {
  generationMutationCoordinationSeam,
  resolveGenerationBoundaryPaths,
  type GenerationAdoptionLockLease,
} from '#src/store/generation-mutation-coordination.js';

import { openReadOnlyStoreDatabase } from '#src/store/read-port.js';
import { enumerateActiveEvidence } from '#src/store/reset-active-evidence.js';
import {
  isCanonicalStoreResetIncidentId,
  MAX_INCIDENT_DIR_ENTRIES,
  MAX_INCIDENT_ROOT_ENTRIES,
  MAX_RESET_MANIFEST_BYTES,
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  STORE_RESET_IN_FLIGHT_DIRECTORY,
  STORE_RESET_MINTED_STORE_DIRECTORY,
  STORE_RESET_PARKED_SIDECAR_FILE_NAME,
  type StoreResetIncidentManifestV2,
  type StoreResetIncidentManifestV3,
  type StoreResetPolicyCause,
} from '#src/store/reset-incident.js';
import { listStoreResetIncidents, readStoreResetIncidentReport } from '#src/store/reset-incident-reader.js';
import { formatStoreResetList, formatStoreResetRelease } from '#src/cli/format/store-reset.js';
import { releaseStoreReset } from '#src/store/operator-store-reset.js';
import {
  readStoreResetParkedRecord,
  readStoreResetRetentionLedger,
  releaseStoreResetIncident,
  resolveStoreResetRetentionSlot,
  STORE_RESET_RETENTION_LEDGER_FILE_NAME,
  writeStoreResetParkedRecord,
} from '#src/store/reset-retention.js';
import { pragmaSimple } from '#tests/helpers/test-db.js';

const REPO_ROOT = process.cwd();
const VERSION = '0.9.16';
const BUILD_SET_ID = '123e4567-e89b-42d3-a456-426614174000';
const BUNDLE_HASH = '0123456789abcdef';
const NAMESPACE = 'test-namespace';
const STORE_FORMAT = currentCoralStoreFormat();
const RESET_POLICY_CAUSES = [
  'older-incompatible',
  'corrupt-or-unsupported',
  'newer-incompatible-invalid-target',
] as const;
const MANIFEST_RESUME_CUTS = [
  'manifest-publication',
  'active-file-quarantine',
  'staging-to-final-publication',
  'final-incident-publication',
] as const;

function buildIdentity(bundleHash = BUNDLE_HASH) {
  return {
    version: VERSION,
    buildSetId: BUILD_SET_ID,
    bundleHash,
    cliBundleHash: '123456789abcdef0',
    claudeAppserverBundleHash: '23456789abcdef01',
    durableWrapperBundleHash: '3456789abcdef012',
    flavor: 'prod' as const,
    storeFormatFingerprint: STORE_FORMAT.fingerprint,
  };
}

const tempRoots: string[] = [];

function retainedIncidentNames(quarantineRoot: string): string[] {
  if (!existsSync(quarantineRoot)) return [];
  return readdirSync(quarantineRoot).filter(isCanonicalStoreResetIncidentId);
}

const PRE_EXISTING_SURVIVOR_ID = '923e4567-e89b-42d3-a456-426614174000';

function seedPreExistingTerminalSurvivor(runtime: Runtime, dbPath: string): string {
  const parkingRoot = join(dirname(dbPath), 'store-reset-quarantine', '.parked');
  const directory = join(parkingRoot, PRE_EXISTING_SURVIVOR_ID);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'store.db-wal'), 'pre-existing survivor');
  writeStoreResetParkedRecord(runtime.storage, parkingRoot, {
    version: 1,
    parkingId: PRE_EXISTING_SURVIVOR_ID,
    parkedAt: '2026-09-12T00:00:00.000Z',
    phase: 'terminal',
    cause: 'residual',
    incidentId: null,
    names: ['store.db-wal'],
    entries: [
      {
        name: 'store.db-wal',
        kind: 'regular-file',
        sizeBytes: Buffer.byteLength('pre-existing survivor'),
      },
    ],
    transaction: null,
    classification: null,
  });
  return PRE_EXISTING_SURVIVOR_ID;
}

function terminalSurvivors(
  quarantineRoot: string,
): readonly { readonly kind: 'incident' | 'parking'; readonly id: string }[] {
  const parkingRoot = join(quarantineRoot, '.parked');
  const parkingIds = existsSync(parkingRoot) ? readdirSync(parkingRoot).filter(isCanonicalStoreResetIncidentId) : [];
  return [
    ...retainedIncidentNames(quarantineRoot).map((id) => ({ kind: 'incident' as const, id })),
    ...parkingIds.map((id) => ({ kind: 'parking' as const, id })),
  ];
}

function expectOneTerminalSurvivor(dbPath: string, label = dbPath): void {
  const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
  const stagingRoot = join(quarantineRoot, '.staging');
  const staged = existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
  expect(staged, `${label}: unresolved .staging entries`).toEqual([]);
  expect(
    existsSync(join(quarantineRoot, '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY)),
    `${label}: .parked/.in-flight`,
  ).toBe(false);
  const storage = createRealRuntime('prod', { baseDir: dirname(dbPath) }).storage;
  expect(readStoreResetRetentionLedger(storage, quarantineRoot)?.pending ?? null, `${label}: pending`).toBeNull();
  const survivors = terminalSurvivors(quarantineRoot);
  expect(survivors, `${label}: ${JSON.stringify(survivors)}`).toHaveLength(1);
}

function expectReturnedSurvivorExists(
  dbPath: string,
  survivor: Awaited<ReturnType<typeof settleReset>>['survivor'],
): void {
  const survivors = terminalSurvivors(join(dirname(dbPath), 'store-reset-quarantine'));
  switch (survivor.kind) {
    case 'incident':
      expect(survivors).toContainEqual({ kind: 'incident', id: survivor.incident.incidentId });
      break;
    case 'parking':
      expect(survivors).toContainEqual({ kind: 'parking', id: survivor.parkingId });
      break;
    case 'none':
      expect(survivors).toEqual([]);
      break;
  }
}

function retainedManifest(dbPath: string): StoreResetIncidentManifestV3 {
  const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
  const incidents = retainedIncidentNames(quarantineRoot);
  expect(incidents).toHaveLength(1);
  const manifest = parseStoreResetIncidentManifest(
    readFileSync(join(quarantineRoot, incidents[0], 'reset-manifest.json')),
  );
  expect(manifest.schemaVersion).toBe(3);
  if (manifest.schemaVersion !== 3) throw new Error('Expected a V3 store-reset incident.');
  return manifest;
}

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map(Object.entries(updates).map(([key]) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createRuntime(home = makeTempRoot('coral-store-open-reset-home-')): Runtime {
  return withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () => createRealRuntime('prod'));
}

function createCurrentStore(runtime: Runtime, path = runtime.paths.coral.store.dbFile): void {
  openStoreDatabase({ path, storage: runtime.storage, storeFormat: STORE_FORMAT }).close();
}

function createCompatibleSentinelStore(runtime: Runtime, dbPath: string): void {
  createCurrentStore(runtime, dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE sentinel_replacement (id INTEGER PRIMARY KEY)');
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, name: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined;
  } finally {
    db.close();
  }
}

function retainedIncidentContainsTable(root: string, name: string): boolean {
  const quarantineRoot = join(root, 'store-reset-quarantine');
  return retainedIncidentNames(quarantineRoot).some((incidentId) =>
    tableExists(join(quarantineRoot, incidentId, 'store.db'), name),
  );
}

function readFormatFingerprint(dbPath: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint' LIMIT 1").get() as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function createMissingFingerprintStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('coordinator_id', 'old');
      CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
  } finally {
    db.close();
  }
}

function createMismatchStore(dbPath: string, fingerprint = `sha256:${'0'.repeat(64)}`): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
    db.prepare("INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', ?)").run(fingerprint);
  } finally {
    db.close();
  }
}

function createIncompatibleSentinelStore(dbPath: string, epoch: number): void {
  createMismatchStore(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE sentinel_epoch_${epoch} (id INTEGER PRIMARY KEY)`);
  } finally {
    db.close();
  }
}

function createVersionedStore(dbPath: string, fingerprint: string, productVersion: string): void {
  createMismatchStore(dbPath, fingerprint);
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES ('store_product_version', ?)").run(productVersion);
  } finally {
    db.close();
  }
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function createCorruptStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, 'not a sqlite database', 'utf-8');
}

function authorityFor(runtime: Runtime, dbPath: string): BackendStoreResetAuthority {
  return createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: true },
    {
      path: dbPath,
      namespace: NAMESPACE,
      storeFormat: STORE_FORMAT,
      build: buildIdentity(),
    },
  );
}

function adoptionLease(): GenerationAdoptionLockLease {
  return {
    assertOwned: () => undefined,
    maintain: () => undefined,
  } as unknown as GenerationAdoptionLockLease;
}

function writerExclusion(): WriterExclusion {
  return {
    kind: 'proven',
    lease: { assertOwned: () => undefined, maintain: () => undefined, release: () => undefined },
  };
}

function activeSelection(dbPath: string): ActiveStoreSelection {
  const manifest = { ...buildIdentity(), version: STORE_FORMAT.productVersion };
  const bundleDir = join(dirname(dbPath), 'current-bundle');
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  return {
    version: ACTIVE_STORE_SELECTION_VERSION,
    manifest,
    bundleDir,
    activeStoreFingerprint: manifest.storeFormatFingerprint,
  };
}

async function openReset(
  runtime: Runtime,
  dbPath: string,
  exclusion: WriterExclusion = writerExclusion(),
  overrides: {
    readonly authority?: BackendStoreResetAuthority;
    readonly storeFormat?: typeof STORE_FORMAT;
    readonly startupBusyTimeoutMs?: number;
    readonly steadyStateBusyTimeoutMs?: number;
  } = {},
) {
  return (await settleReset(runtime, dbPath, exclusion, overrides)).db;
}

async function settleReset(
  runtime: Runtime,
  dbPath: string,
  exclusion: WriterExclusion = writerExclusion(),
  overrides: {
    readonly authority?: BackendStoreResetAuthority;
    readonly storeFormat?: typeof STORE_FORMAT;
    readonly startupBusyTimeoutMs?: number;
    readonly steadyStateBusyTimeoutMs?: number;
  } = {},
) {
  const storeFormat = overrides.storeFormat ?? STORE_FORMAT;
  const result = await coordinateActiveStoreSelection(runtime, overrides.authority ?? authorityFor(runtime, dbPath), {
    path: dbPath,
    storeFormat,
    currentSelection: activeSelection(dbPath),
    startupBusyTimeoutMs: overrides.startupBusyTimeoutMs,
    steadyStateBusyTimeoutMs: overrides.steadyStateBusyTimeoutMs,
    dependencies: {
      kind: 'startup',
      validateSelectedTarget: () => {
        throw new Error('The active-evidence fixture never selects a foreign target.');
      },
      acquireWriterExclusion: async () => exclusion,
    },
  });
  if (result.kind !== 'opened') throw new Error('The active-evidence fixture unexpectedly handed off.');
  return result;
}

function publishReset(runtime: Runtime, dbPath: string, exclusion: WriterExclusion = writerExclusion()) {
  const options = {
    path: dbPath,
    storeFormat: STORE_FORMAT,
  };
  const files = resolveBackendStoreFileSet(runtime, options);
  const resetLock = acquireBackendStoreResetLock(runtime, files, adoptionLease());
  try {
    const classification = classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT);
    if (classification.kind !== 'older-incompatible' && classification.kind !== 'corrupt-or-unsupported') {
      throw new Error(`Test fixture is not resettable: ${classification.kind}`);
    }
    return publishClassifiedBackendStoreResetIncident(
      runtime,
      authorityFor(runtime, dbPath),
      files,
      enumerateActiveEvidence(runtime.storage, files),
      classification,
      resetLock,
      exclusion,
    );
  } finally {
    resetLock.release();
  }
}

function createInterruptedCopyReset(
  runtime: Runtime,
  dbPath: string,
): {
  readonly quarantineRoot: string;
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
} {
  createMismatchStore(dbPath);
  writeFileSync(`${dbPath}-wal`, 'durable wal evidence', 'utf-8');
  const renameSync = runtime.storage.renameSync;
  let interrupted = false;
  const renameSpy = vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
    if (String(source).includes(`${join('store-reset-quarantine', '.staging')}`) && !interrupted) {
      interrupted = true;
      throw errno('EIO');
    }
    renameSync(source, destination);
  });
  const error = captureError(() =>
    publishReset(runtime, dbPath, { kind: 'unproven', reason: 'lock-timeout', blockers: null }),
  );
  renameSpy.mockRestore();
  expectSetupCode(error, 'store_reset_quarantine_failed');
  expect(interrupted).toBe(true);

  const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
  const stagingRoot = join(quarantineRoot, '.staging');
  const stagingNames = readdirSync(stagingRoot);
  expect(stagingNames).toHaveLength(1);
  return {
    quarantineRoot,
    stagingRoot,
    stagingDirectory: join(stagingRoot, stagingNames[0]),
  };
}

function resumeReset(runtime: Runtime, dbPath: string) {
  const files = resolveBackendStoreFileSet(runtime, {
    path: dbPath,
    storeFormat: STORE_FORMAT,
  });
  const resetLock = acquireBackendStoreResetLock(runtime, files, adoptionLease());
  try {
    return resumeBackendStoreResetIncidentForOperator(
      runtime,
      files,
      { path: dbPath, storeFormat: STORE_FORMAT },
      resetLock,
      writerExclusion(),
    );
  } finally {
    resetLock.release();
  }
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

const ACTIVE_EVIDENCE_ARMS = ['copy-proven', 'copy-unproven', 'over-bound', 'claim', 'resume'] as const;
const ACTIVE_EVIDENCE_MUTATIONS = [
  'deleted',
  'replaced',
  'symlink-aba',
  'appended',
  'sidecar',
  'non-regular',
  'crash',
] as const;

type ActiveEvidenceArm = (typeof ACTIVE_EVIDENCE_ARMS)[number];
type ActiveEvidenceMutation = (typeof ACTIVE_EVIDENCE_MUTATIONS)[number];
type MutationDisposition = { readonly kind: 'applied' } | { readonly kind: 'unreachable'; readonly reason: string };
type TracePhase = 'before' | 'after';
type TracePoint = Readonly<{ method: string; occurrence: number; phase: TracePhase }>;

function appendTracePoint(trace: TracePoint[], method: string, phase: TracePhase): TracePoint {
  const point = {
    method,
    occurrence: trace.filter((candidate) => candidate.method === method && candidate.phase === phase).length + 1,
    phase,
  };
  trace.push(point);
  return point;
}

function sameTracePoint(left: TracePoint, right: TracePoint): boolean {
  return left.method === right.method && left.occurrence === right.occurrence && left.phase === right.phase;
}

function formatTracePoint(point: TracePoint): string {
  return `${point.method}#${point.occurrence}:${point.phase}`;
}

function assertMutationDisposition(label: string, disposition: MutationDisposition | null): void {
  expect(disposition, `${label}: replay did not encounter the exact semantic key`).not.toBeNull();
  if (disposition?.kind === 'unreachable') {
    expect(disposition.reason, `${label}: unreachable cells require an asserted reason`).not.toHaveLength(0);
  }
}

function replaceActiveStoreWithExternalLegacySymlink(runtime: Runtime, activePath: string): void {
  const externalPath = `${activePath}.external-legacy`;
  createMismatchStore(externalPath, STORE_FORMAT.fingerprint);
  symlinkSync(externalPath, activePath);
}

function traceActivePathCalls(
  runtime: Runtime,
  activePath: string,
  boundary: 'descriptor' | 'identity' | 'second-identity' | 'immediate' | 'manual',
  mutation?: {
    readonly key: TracePoint;
    readonly kind: ActiveEvidenceMutation;
    readonly surface?: 'active' | 'durable';
    readonly sidecarPath?: string;
  },
): {
  readonly runtime: Runtime;
  readonly calls: readonly TracePoint[];
  readonly durableCalls: readonly TracePoint[];
  readonly mutationApplied: () => boolean;
  readonly mutationDisposition: () => MutationDisposition | null;
  readonly injectedIdentity: () => { readonly dev: bigint; readonly ino: bigint } | null;
  readonly start: () => void;
  readonly stop: () => void;
} {
  const calls: TracePoint[] = [];
  const durableCalls: TracePoint[] = [];
  const durableRoot = join(dirname(activePath), 'store-reset-quarantine');
  const parkingRoot = join(durableRoot, '.parked');
  const activeDescriptors = new Set<number>();
  const activeIdentities: Array<{ readonly dev: bigint; readonly ino: bigint }> = [];
  const rememberActiveIdentity = () => {
    if (!existsSync(activePath)) return;
    const observed = statSync(activePath, { bigint: true });
    if (!activeIdentities.some((identity) => identity.dev === observed.dev && identity.ino === observed.ino)) {
      activeIdentities.push({ dev: observed.dev, ino: observed.ino });
    }
  };
  const pathHasActiveIdentity = (path: unknown) => {
    if (typeof path !== 'string' || !existsSync(path)) return false;
    const observed = statSync(path, { bigint: true });
    return activeIdentities.some((identity) => identity.dev === observed.dev && identity.ino === observed.ino);
  };
  rememberActiveIdentity();
  let recording = boundary === 'immediate';
  let identityObservations = 0;
  let stopped = false;
  let applied = false;
  let unreachableReason: string | null = null;
  let injectedIdentity: { readonly dev: bigint; readonly ino: bigint } | null = null;
  let terminalTransitionOpen = false;
  const storage = new Proxy(runtime.storage, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const method = String(property);
        const touchesActivePath = args.some((argument) => argument === activePath);
        if (touchesActivePath) rememberActiveIdentity();
        const touchesActiveDescriptor = args.some(
          (argument) => typeof argument === 'number' && activeDescriptors.has(argument),
        );
        const touchesActiveAlias = args.some(pathHasActiveIdentity);
        const touchesActiveEvidence = touchesActivePath || touchesActiveDescriptor || touchesActiveAlias;
        const writesTerminalSidecar =
          method === 'writeAtomicDurableSync' &&
          String(args[0]).endsWith(STORE_RESET_PARKED_SIDECAR_FILE_NAME) &&
          typeof args[1] === 'string' &&
          args[1].includes('"phase":"terminal"');
        if (writesTerminalSidecar) terminalTransitionOpen = true;
        const renamesTerminalParking =
          method === 'renameSync' &&
          dirname(String(args[1])) === parkingRoot &&
          isCanonicalStoreResetIncidentId(basename(String(args[1])));
        const removesTerminalSurvivor =
          method === 'rmSync' &&
          isCanonicalStoreResetIncidentId(basename(String(args[0]))) &&
          (dirname(String(args[0])) === durableRoot || dirname(String(args[0])) === parkingRoot);
        const syncsTerminalTransition =
          terminalTransitionOpen &&
          method === 'syncDirectoryDurableSync' &&
          (args[0] === durableRoot || args[0] === parkingRoot);
        const touchesDurableRecord =
          writesTerminalSidecar || renamesTerminalParking || removesTerminalSurvivor || syncsTerminalTransition;
        const observesActiveDescriptor = method === 'fstatSync' && touchesActiveDescriptor;
        const activePoint =
          !stopped && recording && touchesActiveEvidence ? appendTracePoint(calls, method, 'before') : null;
        if (
          mutation !== undefined &&
          mutation.surface !== 'durable' &&
          activePoint !== null &&
          sameTracePoint(mutation.key, activePoint)
        ) {
          if (mutation.kind === 'crash') {
            applied = true;
            throw errno('EIO');
          } else if (mutation.kind === 'appended') {
            if (existsSync(activePath) && lstatSync(activePath).isFile()) {
              applied = true;
              const injected = statSync(activePath, { bigint: true });
              injectedIdentity = { dev: injected.dev, ino: injected.ino };
              appendFileSync(activePath, 'same-inode-growth');
            } else {
              unreachableReason = 'append requires a regular active path at this call';
            }
          } else if (mutation.kind === 'sidecar') {
            applied = true;
            if (mutation.sidecarPath === undefined) throw new Error('Sidecar mutation requires its active path.');
            writeFileSync(mutation.sidecarPath, 'injected sidecar evidence');
            const injected = statSync(mutation.sidecarPath, { bigint: true });
            injectedIdentity = { dev: injected.dev, ino: injected.ino };
          } else if (mutation.kind === 'deleted') {
            applied = true;
            rmSync(activePath, { recursive: true, force: true });
          } else {
            applied = true;
            rmSync(activePath, { recursive: true, force: true });
            if (mutation.kind === 'replaced') createCompatibleSentinelStore(runtime, activePath);
            else if (mutation.kind === 'symlink-aba') {
              replaceActiveStoreWithExternalLegacySymlink(runtime, activePath);
            } else {
              mkdirSync(activePath);
            }
            const injected = statSync(activePath, { bigint: true });
            injectedIdentity = { dev: injected.dev, ino: injected.ino };
          }
        }

        const result = Reflect.apply(member, target, args) as unknown;
        const durablePoint = !stopped && touchesDurableRecord ? appendTracePoint(durableCalls, method, 'after') : null;
        if (
          mutation?.surface === 'durable' &&
          mutation.kind === 'crash' &&
          durablePoint !== null &&
          sameTracePoint(mutation.key, durablePoint)
        ) {
          applied = true;
          throw errno('EIO');
        }
        if (
          method === 'openSync' &&
          typeof result === 'number' &&
          (args[0] === activePath || pathHasActiveIdentity(args[0]))
        ) {
          activeDescriptors.add(result);
        }
        if (method === 'closeSync' && typeof args[0] === 'number') activeDescriptors.delete(args[0]);
        if (boundary === 'descriptor' && observesActiveDescriptor) recording = true;
        if (
          (boundary === 'identity' || boundary === 'second-identity') &&
          (method === 'lstatSync' || method === 'statSync') &&
          touchesActivePath &&
          typeof args[1] === 'object' &&
          args[1] !== null &&
          'bigint' in args[1]
        ) {
          identityObservations += 1;
          recording = boundary === 'identity' || identityObservations >= 2;
        }
        return result;
      };
    },
  });
  return {
    runtime: { ...runtime, storage },
    calls,
    durableCalls,
    mutationApplied: () => applied,
    mutationDisposition: () =>
      applied
        ? { kind: 'applied' }
        : unreachableReason === null
          ? null
          : { kind: 'unreachable', reason: unreachableReason },
    injectedIdentity: () => injectedIdentity,
    start: () => {
      rememberActiveIdentity();
      recording = true;
    },
    stop: () => {
      stopped = true;
    },
  };
}

function containsIdentity(root: string, identity: { readonly dev: bigint; readonly ino: bigint }): boolean {
  if (!existsSync(root)) return false;
  const stat = statSync(root, { bigint: true });
  if (stat.dev === identity.dev && stat.ino === identity.ino) return true;
  if (!stat.isDirectory()) return false;
  return readdirSync(root).some((entry) => containsIdentity(join(root, entry), identity));
}

function expectInjectedReplacementConserved(
  dbPath: string,
  identity: { readonly dev: bigint; readonly ino: bigint },
): void {
  const sentinelIsActive = existsSync(dbPath) && tableExists(dbPath, 'sentinel_replacement');
  const incidentCount = retainedIncidentNames(join(dirname(dbPath), 'store-reset-quarantine')).length;
  expect(sentinelIsActive || incidentCount > 1).toBe(true);
  expect(containsIdentity(dirname(dbPath), identity)).toBe(true);
}

function expectReturnedHandleTargetsActiveStore(db: { exec(sql: string): unknown }, dbPath: string): void {
  db.exec('CREATE TABLE returned_handle_identity_probe (id INTEGER PRIMARY KEY)');
  expect(existsSync(dbPath)).toBe(true);
}

async function exerciseActiveEvidenceArm(
  arm: ActiveEvidenceArm,
  mutation?: {
    readonly key: TracePoint;
    readonly kind: ActiveEvidenceMutation;
    readonly surface?: 'active' | 'durable';
  },
  afterCrashMutation?: ActiveEvidenceMutation,
  boundaryOverride?: Parameters<typeof traceActivePathCalls>[2],
): Promise<{
  readonly calls: readonly TracePoint[];
  readonly durableCalls: readonly TracePoint[];
  readonly mutationDisposition: MutationDisposition | null;
}> {
  const runtime = createRuntime();
  const dbPath = join(makeTempRoot(`coral-store-active-${arm}-sweep-`), 'store.db');
  seedPreExistingTerminalSurvivor(runtime, dbPath);
  let boundary: Parameters<typeof traceActivePathCalls>[2];
  let exclusion: WriterExclusion | undefined;
  let startClaimTrace: () => void = () => undefined;
  if (arm === 'over-bound') {
    createMismatchStore(dbPath);
    const holder = await openReset(runtime, dbPath);
    holder.close();
    rmSync(dbPath);
    createVersionedStore(dbPath, STORE_FORMAT.fingerprint, '99.0.0');
    boundary = 'identity';
  } else if (arm === 'resume') {
    createInterruptedCopyReset(runtime, dbPath);
    boundary = 'immediate';
    exclusion = { kind: 'unproven', reason: 'writer-live', blockers: 'resume sweep' };
  } else {
    createMismatchStore(dbPath);
    if (arm === 'claim') {
      const linkSync = runtime.storage.linkSync;
      let injected = false;
      vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
        if (
          !injected &&
          destination === dbPath &&
          String(source).includes(`${join('store-reset-quarantine', '.minted')}`)
        ) {
          createIncompatibleSentinelStore(dbPath, 901);
          injected = true;
          startClaimTrace();
        }
        linkSync(source, destination);
      });
      boundary = 'manual';
    } else {
      boundary = 'descriptor';
      exclusion =
        arm === 'copy-proven'
          ? writerExclusion()
          : { kind: 'unproven', reason: 'writer-live', blockers: 'active-evidence sweep' };
    }
  }

  const trace = traceActivePathCalls(
    runtime,
    dbPath,
    boundaryOverride ?? boundary,
    mutation === undefined ? undefined : { ...mutation, sidecarPath: `${dbPath}-wal` },
  );
  startClaimTrace = trace.start;

  let settlement: Awaited<ReturnType<typeof settleReset>>;
  let db: Awaited<ReturnType<typeof openReset>>;
  if (mutation?.kind === 'crash') {
    let openedAcrossInjectedFailure: Awaited<ReturnType<typeof settleReset>> | null = null;
    const firstFailure = await captureAsyncError(async () => {
      openedAcrossInjectedFailure = await settleReset(trace.runtime, dbPath, exclusion);
    });
    trace.stop();
    if (firstFailure === null) {
      const completed = openedAcrossInjectedFailure as Awaited<ReturnType<typeof settleReset>> | null;
      expect(completed).not.toBeNull();
      completed?.db.close();
      if (completed !== null) expectReturnedSurvivorExists(dbPath, completed.survivor);
      expectOneTerminalSurvivor(dbPath, arm);
      if (trace.mutationDisposition() === null) {
        return { calls: trace.calls, durableCalls: trace.durableCalls, mutationDisposition: null };
      }
      return {
        calls: trace.calls,
        durableCalls: trace.durableCalls,
        mutationDisposition: {
          kind: 'unreachable',
          reason: 'the injected syscall failure is absorbed by the link-to-copy fallback before a crash boundary',
        },
      };
    }
    expect(firstFailure).not.toBeNull();
    expect(trace.mutationDisposition()).toEqual({ kind: 'applied' });

    if (afterCrashMutation === 'crash') {
      const secondCrash = traceActivePathCalls(runtime, dbPath, 'immediate', {
        key: { method: 'existsSync', occurrence: 1, phase: 'before' },
        kind: 'crash',
      });
      const secondFailure = await captureAsyncError(() => openReset(secondCrash.runtime, dbPath, exclusion));
      secondCrash.stop();
      expect(secondFailure).not.toBeNull();
      expect(secondCrash.mutationDisposition()).toEqual({ kind: 'applied' });
    } else if (afterCrashMutation !== undefined) {
      const disposition = applyMutationBetweenCrashAndResume(runtime, dbPath, afterCrashMutation);
      if (disposition.kind === 'unreachable') {
        expect(disposition.reason).toBe('append requires a regular active path between crash and resume');
      }
    }
    settlement = await settleReset(runtime, dbPath, exclusion);
    db = settlement.db;
  } else {
    settlement = await settleReset(trace.runtime, dbPath, exclusion);
    db = settlement.db;
    trace.stop();
  }

  const injectedIdentity = trace.injectedIdentity();
  try {
    expectReturnedHandleTargetsActiveStore(db, dbPath);
    if (
      trace.mutationApplied() &&
      mutation?.kind === 'appended' &&
      mutation.key.method === 'readSync' &&
      (arm === 'copy-proven' || arm === 'copy-unproven')
    ) {
      const ledger = readStoreResetRetentionLedger(runtime.storage, join(dirname(dbPath), 'store-reset-quarantine'));
      const incidents = [ledger?.preserved].filter(
        (incident): incident is NonNullable<typeof incident> => incident !== null && incident !== undefined,
      );
      expect(incidents.some((incident) => incident.preservation?.coherence === 'torn')).toBe(true);
    }
  } finally {
    db.close();
  }
  if (injectedIdentity !== null && mutation?.kind === 'replaced') {
    expectInjectedReplacementConserved(dbPath, injectedIdentity);
  }
  if (injectedIdentity !== null && mutation?.kind !== 'appended') {
    expect(containsIdentity(dirname(dbPath), injectedIdentity)).toBe(true);
  }
  expectOneTerminalSurvivor(dbPath, arm);
  expectReturnedSurvivorExists(dbPath, settlement.survivor);
  return { calls: trace.calls, durableCalls: trace.durableCalls, mutationDisposition: trace.mutationDisposition() };
}

function applyMutationBetweenCrashAndResume(
  runtime: Runtime,
  dbPath: string,
  mutation: Exclude<ActiveEvidenceMutation, 'crash'>,
): MutationDisposition {
  if (mutation === 'appended') {
    if (!existsSync(dbPath) || !lstatSync(dbPath).isFile()) {
      return { kind: 'unreachable', reason: 'append requires a regular active path between crash and resume' };
    }
    appendFileSync(dbPath, 'same-inode-growth-between-crash-and-resume');
    return { kind: 'applied' };
  }
  if (mutation === 'sidecar') {
    writeFileSync(`${dbPath}-wal`, 'sidecar-between-crash-and-resume');
    return { kind: 'applied' };
  }
  rmSync(dbPath, { recursive: true, force: true });
  if (mutation === 'replaced') createCompatibleSentinelStore(runtime, dbPath);
  if (mutation === 'symlink-aba') replaceActiveStoreWithExternalLegacySymlink(runtime, dbPath);
  if (mutation === 'non-regular') mkdirSync(dbPath);
  return { kind: 'applied' };
}

function createInterruptedReset(
  runtime: Runtime,
  dbPath: string,
): {
  readonly quarantineRoot: string;
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
} {
  createMismatchStore(dbPath);
  writeFileSync(`${dbPath}-wal`, 'durable wal evidence', 'utf-8');
  const renameSync = runtime.storage.renameSync;
  let interrupted = false;
  const renameSpy = vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
    if (String(source).includes(`${join('store-reset-quarantine', '.staging')}`) && !interrupted) {
      interrupted = true;
      throw errno('EIO');
    }
    renameSync(source, destination);
  });
  const error = captureError(() => publishReset(runtime, dbPath));
  renameSpy.mockRestore();
  expectSetupCode(error, 'store_reset_quarantine_failed');
  expect(interrupted).toBe(true);

  const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
  const stagingRoot = join(quarantineRoot, '.staging');
  const stagingNames = readdirSync(stagingRoot);
  expect(stagingNames).toHaveLength(1);
  return {
    quarantineRoot,
    stagingRoot,
    stagingDirectory: join(stagingRoot, stagingNames[0]),
  };
}

function setInterruptedResetCause(
  stagingDirectory: string,
  resetPolicyCause: StoreResetPolicyCause,
): StoreResetIncidentManifestV3 {
  const manifestPath = join(stagingDirectory, 'reset-manifest.json');
  const parsed = parseStoreResetIncidentManifest(readFileSync(manifestPath));
  if (parsed.schemaVersion !== 3) throw new Error('Expected a V3 store-reset incident.');
  const manifest: StoreResetIncidentManifestV3 = {
    ...parsed,
    resetPolicyCause,
    resetPolicyEvidence:
      resetPolicyCause === 'newer-incompatible-invalid-target'
        ? {
            validationFailure: { code: 'target_hash_mismatch' },
            observedTarget: {
              version: '99.0.0',
              buildSetId: '323e4567-e89b-42d3-a456-426614174000',
              bundleHash: 'fedcba9876543210',
              flavor: 'prod',
              storeFormatFingerprint: `sha256:${'e'.repeat(64)}`,
            },
          }
        : null,
  };
  writeFileSync(manifestPath, serializeStoreResetIncidentManifest(manifest));
  return manifest;
}

function expectSetupCode(error: unknown, code: string): void {
  expect(serializeCoralSetupError(error)).toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

/**
 * Finding 3: `acquireBackendStoreResetLock` used to call `acquireDirectoryLockSync(lockPath, 250)` — the
 * ambient-fs default overload, which reaches around the `runtime` parameter it already receives instead of
 * threading it through (a Single Runtime World violation, `.claude/rules/design-philosophy.md` §4). The
 * ambient-default overload never touches an injected time port. A call on `runtime.time.monotonicNow` during
 * acquisition is therefore proof the lock went through the runtime ports, not the ambient fallback.
 */
describe('acquireBackendStoreResetLock', () => {
  it('acquires the lock through the runtime storage/time ports rather than the ambient-fs default', () => {
    const runtime = createRealRuntime('prod');
    const dbPath = join(makeTempRoot('coral-reset-lock-'), 'store.db');
    const files = resolveBackendStoreFileSet(runtime, { path: dbPath, storeFormat: STORE_FORMAT });
    const monotonicNowSpy = vi.spyOn(runtime.time, 'monotonicNow');

    const lease = acquireBackendStoreResetLock(runtime, files, adoptionLease());
    try {
      expect(monotonicNowSpy).toHaveBeenCalled();
    } finally {
      lease.release();
    }
  });
});

describe('openOrResetBackendStoreDb', () => {
  it('initializes a missing store with the bundled schema marker', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-fresh-'), 'store.db');

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(existsSync(dbPath)).toBe(true);
    expect(readFormatFingerprint(dbPath)).toBe(STORE_FORMAT.fingerprint);
    expect(readFileSync(`${dbPath}.format`, 'utf8')).toBe(`${STORE_FORMAT.fingerprint}\n`);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('measures writable open with an absent database and a frames-bearing WAL', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-wal-without-db-');
    const sourcePath = join(root, 'source.db');
    const dbPath = join(root, 'store.db');
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE wal_frame_source (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO wal_frame_source (value) VALUES ('frame');
      `);
      copyFileSync(`${sourcePath}-wal`, `${dbPath}-wal`);
      expect(readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(32);
      expect(existsSync(dbPath)).toBe(false);

      const db = openStoreDatabase({ path: dbPath, storage: runtime.storage, storeFormat: STORE_FORMAT });
      db.close();

      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(tableExists(dbPath, 'wal_frame_source')).toBe(false);
      expect(tableExists(dbPath, 'events')).toBe(true);
    } finally {
      source.close();
    }
  });

  it('creates a missing dbDir before reaching the sync reset lock path', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-fresh-lock-parent-');
    const dbDir = join(root, 'missing', 'nested');
    const dbPath = join(dbDir, 'store.db');

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(existsSync(dbDir)).toBe(true);
    expect(readFormatFingerprint(dbPath)).toBe(STORE_FORMAT.fingerprint);
    expect(existsSync(join(dbDir, 'store.db.reset.lock'))).toBe(false);
  });

  it('restores the steady-state busy timeout after the startup reset window', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-steady-busy-timeout-'), 'store.db');

    const db = await openReset(runtime, dbPath, writerExclusion(), {
      startupBusyTimeoutMs: 1,
      steadyStateBusyTimeoutMs: 12_345,
    });
    try {
      expect(pragmaSimple(db, 'busy_timeout')).toBe(12_345);
    } finally {
      db.close();
    }
  });

  it('quarantines a store with no format fingerprint and boots fresh state', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-missing-fingerprint-'), 'store.db');
    createMissingFingerprintStore(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(retainedManifest(dbPath).resetPolicyCause).toBe('corrupt-or-unsupported');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-current store in place without warning', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-current-'), 'store.db');
    const first = await openReset(runtime, dbPath);
    first.close();
    const marker = readFormatFingerprint(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const second = await openReset(runtime, dbPath);
    second.close();

    expect(readFormatFingerprint(dbPath)).toBe(marker);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('quarantines an equal-version mismatched marker and boots fresh state', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-mismatch-'), 'store.db');
    createMismatchStore(dbPath);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    const manifest = retainedManifest(dbPath);
    expect(isCanonicalStoreResetIncidentId(manifest.incidentId)).toBe(true);
    expect(manifest.resetPolicyCause).toBe('corrupt-or-unsupported');
    expect(
      tableExists(
        join(dirname(dbPath), 'store-reset-quarantine', manifest.incidentId, 'store.db'),
        'sentinel_before_reset',
      ),
    ).toBe(true);
  });

  it('quarantines an older incompatible store and boots fresh state', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-older-automatic-reset-'), 'store.db');
    createVersionedStore(dbPath, `sha256:${'0'.repeat(64)}`, '0.0.0-rc.1');

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    const manifest = retainedManifest(dbPath);
    expect(isCanonicalStoreResetIncidentId(manifest.incidentId)).toBe(true);
    expect(manifest.resetPolicyCause).toBe('older-incompatible');
    expect(
      tableExists(
        join(dirname(dbPath), 'store-reset-quarantine', manifest.incidentId, 'store.db'),
        'sentinel_before_reset',
      ),
    ).toBe(true);
  });

  it('copies to an immutable inode with or without proven writer exclusion', async () => {
    const drainedRuntime = createRuntime();
    const drainedPath = join(makeTempRoot('coral-store-reset-drained-'), 'store.db');
    createMismatchStore(drainedPath);
    const drainedLink = vi.spyOn(drainedRuntime.storage, 'linkSync');
    const drained = await acquireBackendStoreWriterExclusion(drainedRuntime, 10);
    expect(drained.kind).toBe('proven');
    try {
      expect(publishReset(drainedRuntime, drainedPath, drained)).toMatchObject({
        kind: 'preserved',
        preservation: {
          kind: 'copied',
          cause: { kind: 'link-unsupported', errno: 'other', code: 'HARD_LINK_NOT_IMMUTABLE' },
          coherence: 'coherent',
        },
      });
    } finally {
      if (drained.kind === 'proven') drained.lease.release();
    }
    expect(drainedLink).not.toHaveBeenCalled();

    const heldRuntime = createRuntime();
    const heldPath = join(makeTempRoot('coral-store-reset-writer-held-'), 'store.db');
    createMismatchStore(heldPath);
    const writer = await generationMutationCoordinationSeam.acquireWriterLease(heldRuntime, {
      kind: 'install',
      name: 'store-reset-mechanism-test',
    });
    const heldLink = vi.spyOn(heldRuntime.storage, 'linkSync');
    try {
      const held = await acquireBackendStoreWriterExclusion(heldRuntime, 25);
      expect(held).toMatchObject({ kind: 'unproven', reason: 'writer-live' });
      expect(publishReset(heldRuntime, heldPath, held)).toMatchObject({
        kind: 'preserved',
        preservation: {
          kind: 'copied',
          cause: { kind: 'exclusion-unproven', reason: 'writer-live' },
          coherence: 'coherent',
        },
      });
    } finally {
      writer.release();
    }
    expect(heldLink).not.toHaveBeenCalled();
  });

  it('does not attempt a hard link while publishing preserved evidence', () => {
    const fallbackRuntime = createRuntime();
    const fallbackPath = join(makeTempRoot('coral-store-reset-link-fallback-'), 'store.db');
    createMismatchStore(fallbackPath);
    const link = vi.spyOn(fallbackRuntime.storage, 'linkSync').mockImplementation(() => {
      throw errno('EXDEV');
    });

    expect(publishReset(fallbackRuntime, fallbackPath)).toMatchObject({
      kind: 'preserved',
      preservation: {
        kind: 'copied',
        cause: { kind: 'link-unsupported', errno: 'other', code: 'HARD_LINK_NOT_IMMUTABLE' },
        coherence: 'coherent',
      },
    });
    expect(link).not.toHaveBeenCalled();
  });

  it('adopts one orphaned committed incident when the preserved slot is vacant', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-adoption-'), 'store.db');
    createMismatchStore(dbPath);
    const publication = publishReset(runtime, dbPath);
    if (publication.kind !== 'preserved') throw new Error('Expected preserved reset evidence.');
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    rmSync(join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME));

    const slot = resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot);

    expect(slot).toMatchObject({
      kind: 'held',
      holder: { incidentId: publication.incident.incidentId },
    });
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toMatchObject({
      incidentId: publication.incident.incidentId,
    });
  });

  it('does not adopt from a truncated incident-root listing', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-adoption-overflow-'), 'store.db');
    createMismatchStore(dbPath);
    const publication = publishReset(runtime, dbPath);
    if (publication.kind !== 'preserved') throw new Error('Expected preserved reset evidence.');
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    rmSync(join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME));
    vi.spyOn(runtime.storage, 'readDirectoryBoundedSync').mockReturnValue({
      entries: [publication.incident.incidentId],
      overflow: true,
    });

    expect(resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot)).toMatchObject({ kind: 'vacant' });
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)).toBeNull();
  });

  it('replaces preserved evidence for an invalid stored version and boots', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-invalid-version-'), 'store.db');
    createMismatchStore(dbPath);
    const holder = publishReset(runtime, dbPath);
    if (holder.kind !== 'preserved') throw new Error('Expected a preserved slot holder.');
    createVersionedStore(dbPath, STORE_FORMAT.fingerprint, 'not-semver\nINJECTED-ROW');

    expect(classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT)).toMatchObject({
      kind: 'corrupt-or-unsupported',
      storedProductVersion: null,
      storedProductVersionState: 'invalid',
    });

    const replacement = publishReset(runtime, dbPath);
    if (replacement.kind !== 'preserved') throw new Error('Expected replacement evidence.');
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    expect(retainedIncidentNames(quarantineRoot)).toEqual([replacement.incident.incidentId]);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toMatchObject({
      incidentId: replacement.incident.incidentId,
    });
    const db = await openReset(runtime, dbPath);
    db.close();
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('keeps exactly the newest preserved incident', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-newest-'), 'store.db');
    createMismatchStore(dbPath);
    const holder = publishReset(runtime, dbPath);
    if (holder.kind !== 'preserved') throw new Error('Expected a preserved slot holder.');
    createMismatchStore(dbPath);

    const replacement = publishReset(runtime, dbPath);
    if (replacement.kind !== 'preserved') throw new Error('Expected replacement preservation.');
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    expect(retainedIncidentNames(quarantineRoot)).toEqual([replacement.incident.incidentId]);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)).toMatchObject({
      pending: null,
      preserved: { incidentId: replacement.incident.incidentId },
    });
    expect(existsSync(join(quarantineRoot, holder.incident.incidentId))).toBe(false);
  });

  it.each([
    ['without interruption', false],
    ['after cleanup is interrupted', true],
  ] as const)(
    'converges a ledgerless multi-incident upgrade to the new incident %s',
    async (_label, interruptCleanup) => {
      const runtime = createRuntime();
      const dbPath = join(makeTempRoot('coral-store-reset-ledgerless-upgrade-'), 'store.db');
      createMismatchStore(dbPath);
      const first = publishReset(runtime, dbPath);
      if (first.kind !== 'preserved') throw new Error('Expected initial preserved evidence.');
      const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
      const secondId = '423e4567-e89b-42d3-a456-426614174000';
      const firstDirectory = join(quarantineRoot, first.incident.incidentId);
      const secondDirectory = join(quarantineRoot, secondId);
      cpSync(firstDirectory, secondDirectory, { recursive: true });
      const copiedManifest = parseStoreResetIncidentManifest(
        readFileSync(join(secondDirectory, 'reset-manifest.json')),
      );
      writeFileSync(
        join(secondDirectory, 'reset-manifest.json'),
        serializeStoreResetIncidentManifest({ ...copiedManifest, incidentId: secondId }),
      );
      rmSync(join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME));
      createMismatchStore(dbPath);

      if (interruptCleanup) {
        const rm = runtime.storage.rmSync;
        let removedPriorIncidents = 0;
        const cleanupSpy = vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
          if ([first.incident.incidentId, secondId].includes(basename(path))) {
            if (removedPriorIncidents === 1) throw errno('EIO');
            removedPriorIncidents += 1;
          }
          rm(path, options);
        });
        expectSetupCode(
          captureError(() => publishReset(runtime, dbPath)),
          'store_reset_quarantine_failed',
        );
        cleanupSpy.mockRestore();
        expect(removedPriorIncidents).toBe(1);

        const db = await openReset(runtime, dbPath);
        db.close();
      } else {
        expect(publishReset(runtime, dbPath).kind).toBe('preserved');
      }

      const ledger = readStoreResetRetentionLedger(runtime.storage, quarantineRoot);
      expect(ledger).toMatchObject({ pending: null, preserved: { incidentId: expect.any(String) } });
      expect(retainedIncidentNames(quarantineRoot)).toEqual([ledger?.preserved?.incidentId]);
    },
  );

  it.each(['missing', 'malformed', 'unreadable'] as const)(
    'removes a superseded incident whose manifest is %s',
    (manifestState) => {
      const runtime = createRuntime();
      const dbPath = join(makeTempRoot(`coral-store-reset-unreadable-prior-${manifestState}-`), 'store.db');
      createMismatchStore(dbPath);
      const first = publishReset(runtime, dbPath);
      if (first.kind !== 'preserved') throw new Error('Expected initial preserved evidence.');
      const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
      const firstDirectory = join(quarantineRoot, first.incident.incidentId);
      const manifestPath = join(firstDirectory, 'reset-manifest.json');
      if (manifestState === 'missing') rmSync(manifestPath);
      if (manifestState === 'malformed') writeFileSync(manifestPath, '{');
      if (manifestState === 'unreadable') {
        const readFileSync = runtime.storage.readFileSync;
        vi.spyOn(runtime.storage, 'readFileSync').mockImplementation((path, options) => {
          if (path === manifestPath) throw errno('EACCES');
          return readFileSync(path, options);
        });
      }
      createMismatchStore(dbPath);

      const replacement = publishReset(runtime, dbPath);

      expect(replacement.kind).toBe('preserved');
      expect(existsSync(firstDirectory)).toBe(false);
      expect(retainedIncidentNames(quarantineRoot)).toEqual([
        replacement.kind === 'preserved' ? replacement.incident.incidentId : '',
      ]);
      vi.restoreAllMocks();
    },
  );

  it('resumes cleanup after recursive deletion removes the prior manifest and then fails', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-partial-prior-delete-'), 'store.db');
    createMismatchStore(dbPath);
    const first = publishReset(runtime, dbPath);
    if (first.kind !== 'preserved') throw new Error('Expected initial preserved evidence.');
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const firstDirectory = join(quarantineRoot, first.incident.incidentId);
    const rm = runtime.storage.rmSync;
    let interrupted = false;
    vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
      if (!interrupted && path === firstDirectory) {
        interrupted = true;
        rm(join(firstDirectory, 'reset-manifest.json'));
        throw errno('EIO');
      }
      rm(path, options);
    });
    createMismatchStore(dbPath);

    expectSetupCode(
      captureError(() => publishReset(runtime, dbPath)),
      'store_reset_quarantine_failed',
    );
    expect(interrupted).toBe(true);
    expect(existsSync(firstDirectory)).toBe(true);
    expect(existsSync(join(firstDirectory, 'reset-manifest.json'))).toBe(false);
    vi.restoreAllMocks();

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(existsSync(firstDirectory)).toBe(false);
    const ledger = readStoreResetRetentionLedger(runtime.storage, quarantineRoot);
    expect(retainedIncidentNames(quarantineRoot)).toEqual([ledger?.preserved?.incidentId]);
  });

  it('finds superseded incidents beyond a bounded quarantine-root page', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-root-overflow-'), 'store.db');
    createMismatchStore(dbPath);
    const first = publishReset(runtime, dbPath);
    if (first.kind !== 'preserved') throw new Error('Expected initial preserved evidence.');
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const firstDirectory = join(quarantineRoot, first.incident.incidentId);
    const readDirectoryBoundedSync = runtime.storage.readDirectoryBoundedSync;
    const observedBounds: number[] = [];
    vi.spyOn(runtime.storage, 'readDirectoryBoundedSync').mockImplementation((path, maxEntries) => {
      if (path === quarantineRoot) {
        observedBounds.push(maxEntries);
        if (maxEntries === MAX_INCIDENT_ROOT_ENTRIES) {
          return {
            entries: ['.minted', '.parked', '.staging', STORE_RESET_RETENTION_LEDGER_FILE_NAME],
            overflow: true,
          };
        }
      }
      return readDirectoryBoundedSync(path, maxEntries);
    });
    createMismatchStore(dbPath);

    const replacement = publishReset(runtime, dbPath);

    expect(replacement.kind).toBe('preserved');
    expect(observedBounds.some((bound) => bound > MAX_INCIDENT_ROOT_ENTRIES)).toBe(true);
    expect(existsSync(firstDirectory)).toBe(false);
    expect(retainedIncidentNames(quarantineRoot)).toEqual([
      replacement.kind === 'preserved' ? replacement.incident.incidentId : '',
    ]);
  });

  it('publishes a torn copy whose recorded evidence still verifies as a match', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-torn-copy-'), 'store.db');
    createMismatchStore(dbPath);
    const openSync = runtime.storage.openSync;
    let sourceDescriptor: number | null = null;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags, mode) => {
      const descriptor = openSync(path, flags, mode);
      if (path === dbPath && flags === 'r') sourceDescriptor = descriptor;
      return descriptor;
    });
    const readSync = runtime.storage.readSync;
    let mutated = false;
    vi.spyOn(runtime.storage, 'readSync').mockImplementation((descriptor, buffer, offset, length, position) => {
      if (descriptor === sourceDescriptor && !mutated) {
        mutated = true;
        appendFileSync(dbPath, 'growth-during-copy');
      }
      return readSync(descriptor, buffer, offset, length, position);
    });

    const publication = publishReset(runtime, dbPath, {
      kind: 'unproven',
      reason: 'writer-live',
      blockers: 'test writer',
    });
    expect(publication).toMatchObject({
      kind: 'preserved',
      preservation: { kind: 'copied', coherence: 'torn' },
    });
    if (publication.kind !== 'preserved') throw new Error('Expected preserved reset evidence.');
    expect(mutated).toBe(true);

    const report = await readStoreResetIncidentReport({
      fs: createStoreResetInspectionFs(),
      quarantineRoot: join(dirname(dbPath), 'store-reset-quarantine'),
      incidentId: publication.incident.incidentId,
      expectedBuild: buildIdentity(),
    });
    expect(report).toMatchObject({
      ok: true,
      report: { files: expect.arrayContaining([expect.objectContaining({ name: 'store.db', verification: 'match' })]) },
    });
  });

  it('settles a newer-incompatible store through the production transition policy', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-newer-refusal-'), 'store.db');
    createVersionedStore(dbPath, STORE_FORMAT.fingerprint, '99.0.0');
    const db = await openReset(runtime, dbPath);
    db.close();

    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    expect(retainedManifest(dbPath).resetPolicyCause).toBe('newer-incompatible-invalid-target');
  });

  it('preserves the direct opener store and quarantine on an unclassified failure', async () => {
    const failure = Object.assign(new Error("EACCES: permission denied, open '/private/customer/store.db'"), {
      code: 'EACCES',
    });
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-store_open_unclassified-');
    const dbPath = join(root, 'store.db');
    const storePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.format`];
    const quarantinePath = join(root, 'store-reset-quarantine');
    for (const [index, path] of storePaths.entries()) {
      writeFileSync(path, `unchanged-${index}`, 'utf-8');
    }
    const before = storePaths.map((path) => readFileSync(path));
    vi.spyOn(dbModule, 'classifyStoreFile').mockImplementation(() => {
      throw failure;
    });

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_open_unclassified');
    expect(serializeCoralSetupError(error)).toMatchObject({ context: { path: dbPath, cause: failure.message } });
    for (const [index, path] of storePaths.entries()) {
      expect(readFileSync(path)).toEqual(before[index]);
    }
    expect(existsSync(quarantinePath)).toBe(false);
    expect(existsSync(join(root, 'store.db.reset.lock'))).toBe(false);
  });

  it('keeps crash-safe quarantine available to the explicit operator boundary', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-mismatch-quarantine-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const originalDbBytes = readFileSync(dbPath);
    writeFileSync(`${dbPath}-wal`, 'dummy wal', 'utf-8');
    writeFileSync(`${dbPath}-shm`, 'dummy shm', 'utf-8');
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
    const events: string[] = [];
    const linkSync = runtime.storage.linkSync;
    vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
      events.push(`link:${source}->${destination}`);
      linkSync(source, destination);
    });
    const openSync = runtime.storage.openSync;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags, mode) => {
      events.push(`open:${path}:${flags}`);
      return openSync(path, flags, mode);
    });
    const unlinkSync = runtime.storage.unlinkSync;
    vi.spyOn(runtime.storage, 'unlinkSync').mockImplementation((path) => {
      events.push(`unlink:${path}`);
      unlinkSync(path);
    });
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      events.push(`sync:${path}`);
      return syncDirectoryDurableSync(path);
    });
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, data, options) => {
      events.push(`write:${path}`);
      return writeAtomicDurableSync(path, data, options);
    });
    const renameSync = runtime.storage.renameSync;
    let finalPublicationObserved = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((oldPath, newPath) => {
      events.push(`rename:${oldPath}->${newPath}`);
      if (dirname(oldPath) === join(dbDir, 'store-reset-quarantine', '.staging')) {
        finalPublicationObserved = true;
        expect(existsSync(dbPath)).toBe(false);
        expect(existsSync(join(oldPath, 'reset-manifest.json'))).toBe(true);
        expect(existsSync(join(oldPath, 'store.db'))).toBe(true);
      }
      renameSync(oldPath, newPath);
    });

    const incident = publishReset(runtime, dbPath);
    expect(incident).toBeDefined();
    expect(finalPublicationObserved).toBe(true);

    const quarantineRoot = join(dbDir, 'store-reset-quarantine');
    const quarantineEntries = retainedIncidentNames(quarantineRoot);
    expect(quarantineEntries).toHaveLength(1);
    const quarantineDir = join(quarantineRoot, quarantineEntries[0]);
    const stagingDirectory = join(quarantineRoot, '.staging', quarantineEntries[0]);
    const dbCopy = events.indexOf(`open:${join(stagingDirectory, 'store.db')}:wx`);
    const manifestWrite = events.indexOf(`write:${join(stagingDirectory, 'reset-manifest.json')}`);
    const manifestSync = events.findIndex(
      (event, index) => index > manifestWrite && event === `sync:${stagingDirectory}`,
    );
    const dbParking = events.findIndex(
      (event) =>
        event.startsWith(`rename:${dbPath}->`) && event.includes(`${join('store-reset-quarantine', '.parked')}`),
    );
    const sourceSync = events.findIndex((event, index) => index > dbParking && event === `sync:${dbDir}`);
    const finalRename = events.indexOf(`rename:${stagingDirectory}->${quarantineDir}`);
    const finalRootSync = events.findIndex((event, index) => index > finalRename && event === `sync:${quarantineRoot}`);
    expect(dbCopy).toBeGreaterThanOrEqual(0);
    expect(dbCopy).toBeLessThan(dbParking);
    expect(dbParking).toBeLessThan(sourceSync);
    expect(sourceSync).toBeLessThan(manifestWrite);
    expect(manifestWrite).toBeLessThan(manifestSync);
    expect(sourceSync).toBeLessThan(finalRename);
    expect(finalRename).toBeLessThan(finalRootSync);
    expect(readFileSync(join(quarantineDir, 'store.db-wal'), 'utf-8')).toBe('dummy wal');
    expect(existsSync(join(quarantineDir, 'store.db-shm'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(quarantineDir, 'reset-manifest.json'), 'utf-8')) as {
      schemaVersion?: unknown;
      reason?: unknown;
      storedFingerprint?: unknown;
      expectedFingerprint?: unknown;
      incidentId?: unknown;
      build?: unknown;
      runtime?: unknown;
      handoff?: unknown;
      files?: Array<{
        name?: unknown;
        sizeBytes?: unknown;
        sha256?: unknown;
      }>;
    };
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      incidentId: quarantineEntries[0],
      reason: 'mismatch',
      resetPolicyCause: 'corrupt-or-unsupported',
      resetPolicyEvidence: null,
      storedFingerprint: `sha256:${'0'.repeat(64)}`,
      expectedFingerprint: STORE_FORMAT.fingerprint,
      build: {
        version: VERSION,
        buildSetId: BUILD_SET_ID,
        backendBundleHash: BUNDLE_HASH,
        flavor: 'prod',
      },
      handoff: { acquiredViaHandoff: true },
    });
    expect(manifest).not.toHaveProperty('dbFile');
    expect(manifest).not.toHaveProperty('quarantineDir');
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'store.db',
          sizeBytes: originalDbBytes.length,
          sha256: sha256(originalDbBytes),
        }),
        expect.objectContaining({
          name: 'store.db-wal',
          sizeBytes: 'dummy wal'.length,
          sha256: sha256('dummy wal'),
        }),
      ]),
    );
    rmSync(join(quarantineDir, 'store.db-wal'), { force: true });
    rmSync(join(quarantineDir, 'store.db-shm'), { force: true });
    expect(tableExists(join(quarantineDir, 'store.db'), 'sentinel_before_reset')).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('automatically resumes an interrupted V3 quarantine and boots fresh state', async () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-interrupted-quarantine-');
    const dbPath = join(dbDir, 'store.db');
    const { quarantineRoot, stagingRoot } = createInterruptedReset(runtime, dbPath);
    expect(existsSync(dbPath)).toBe(false);
    const stagingNames = readdirSync(stagingRoot);
    const db = await openReset(runtime, dbPath);
    db.close();

    const entries = retainedIncidentNames(quarantineRoot);
    expect(entries).toEqual(stagingNames);
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(readFileSync(join(quarantineRoot, entries[0], 'store.db-wal'), 'utf-8')).toBe('durable wal evidence');
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
  });

  it.each(
    RESET_POLICY_CAUSES.flatMap((resetPolicyCause) => MANIFEST_RESUME_CUTS.map((cut) => ({ resetPolicyCause, cut }))),
  )('retains the same $resetPolicyCause V3 incident after the $cut cut', async ({ resetPolicyCause, cut }) => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-policy-resume-cut-'), 'store.db');
    const { quarantineRoot, stagingRoot, stagingDirectory } =
      cut === 'manifest-publication'
        ? createInterruptedCopyReset(runtime, dbPath)
        : createInterruptedReset(runtime, dbPath);
    const manifest = setInterruptedResetCause(stagingDirectory, resetPolicyCause);

    if (cut === 'staging-to-final-publication' || cut === 'final-incident-publication') {
      rmSync(`${dbPath}-wal`, { force: true });
    }
    if (cut === 'final-incident-publication') {
      renameFileSync(stagingDirectory, join(quarantineRoot, manifest.incidentId));
    }

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(retainedIncidentNames(quarantineRoot)).toEqual([manifest.incidentId]);
    const retained = parseStoreResetIncidentManifest(
      readFileSync(join(quarantineRoot, manifest.incidentId, 'reset-manifest.json')),
    );
    expect(retained).toEqual(manifest);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it.each(RESET_POLICY_CAUSES)(
    'keeps the %s incident until the interrupted fresh schema replaces it with terminal parking',
    async (resetPolicyCause) => {
      const runtime = createRuntime();
      const dbPath = join(makeTempRoot('coral-store-fresh-schema-crash-'), 'store.db');
      let expectedIncidentId: string | null = null;
      if (resetPolicyCause === 'older-incompatible') {
        createVersionedStore(dbPath, `sha256:${'0'.repeat(64)}`, '0.0.0-rc.1');
      } else if (resetPolicyCause === 'corrupt-or-unsupported') {
        createMismatchStore(dbPath);
      } else {
        const interrupted = createInterruptedReset(runtime, dbPath);
        expectedIncidentId = setInterruptedResetCause(interrupted.stagingDirectory, resetPolicyCause).incidentId;
      }

      const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
      let freshPublicationFailed = false;
      const publicationSpy = vi
        .spyOn(runtime.storage, 'writeAtomicDurableSync')
        .mockImplementation((path, data, options) => {
          if (
            String(path).endsWith(join('store-reset-quarantine', '.minted', 'current', 'store.db.format')) &&
            !freshPublicationFailed
          ) {
            freshPublicationFailed = true;
            return false;
          }
          return writeAtomicDurableSync(path, data, options);
        });

      await expect(openReset(runtime, dbPath)).rejects.toThrow('Failed to publish store format sidecar');
      expect(freshPublicationFailed).toBe(true);
      publicationSpy.mockRestore();
      const retainedBeforeRestart = retainedManifest(dbPath);
      expect(retainedBeforeRestart.resetPolicyCause).toBe(resetPolicyCause);
      if (expectedIncidentId !== null) expect(retainedBeforeRestart.incidentId).toBe(expectedIncidentId);

      const settlement = await settleReset(runtime, dbPath);
      settlement.db.close();

      expect(settlement.survivor.kind).toBe('parking');
      expectOneTerminalSurvivor(dbPath);
      expectReturnedSurvivorExists(dbPath, settlement.survivor);
      expect(tableExists(dbPath, 'events')).toBe(true);
    },
  );

  it('fails closed on an interrupted V2 incident and retains its evidence', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-v2-resume-refusal-'), 'store.db');
    const { stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const parsed = parseStoreResetIncidentManifest(readFileSync(join(stagingDirectory, 'reset-manifest.json')));
    const manifest: StoreResetIncidentManifestV2 = {
      schemaVersion: 2,
      incidentId: parsed.incidentId,
      resetAt: parsed.resetAt,
      reason: parsed.reason,
      storedFingerprint: parsed.storedFingerprint,
      expectedFingerprint: parsed.expectedFingerprint,
      build: parsed.build,
      runtime: parsed.runtime,
      handoff: parsed.handoff,
      files: parsed.files,
    };
    writeFileSync(join(stagingDirectory, 'reset-manifest.json'), serializeStoreResetIncidentManifest(manifest));
    const before = readFileSync(join(stagingDirectory, 'store.db'));

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_non_resettable');
    expect(readdirSync(stagingRoot)).toEqual([manifest.incidentId]);
    expect(readFileSync(join(stagingDirectory, 'store.db'))).toEqual(before);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
  });

  it('fails closed on a foreign V3 incident and retains its evidence', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-foreign-v3-resume-refusal-'), 'store.db');
    const { stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const parsed = parseStoreResetIncidentManifest(readFileSync(join(stagingDirectory, 'reset-manifest.json')));
    if (parsed.schemaVersion !== 3) throw new Error('Expected a V3 store-reset incident.');
    const foreign: StoreResetIncidentManifestV3 = {
      ...parsed,
      build: { ...parsed.build, buildSetId: '323e4567-e89b-42d3-a456-426614174000' },
    };
    writeFileSync(join(stagingDirectory, 'reset-manifest.json'), serializeStoreResetIncidentManifest(foreign));

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_authority_mismatch');
    expect(readdirSync(stagingRoot)).toEqual([foreign.incidentId]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
  });

  it('fails closed when a V3 incident targets another canonical store', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-target-v3-resume-refusal-'), 'store.db');
    const { stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const parsed = parseStoreResetIncidentManifest(readFileSync(join(stagingDirectory, 'reset-manifest.json')));
    if (parsed.schemaVersion !== 3) throw new Error('Expected a V3 store-reset incident.');
    const mismatched: StoreResetIncidentManifestV3 = {
      ...parsed,
      target: { ...parsed.target, storeDbPath: `${dbPath}.other` },
    };
    writeFileSync(join(stagingDirectory, 'reset-manifest.json'), serializeStoreResetIncidentManifest(mismatched));

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_authority_mismatch');
    expect(readdirSync(stagingRoot)).toEqual([mismatched.incidentId]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
  });

  it('fails closed on a malformed V3 cause without deleting evidence', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-malformed-v3-resume-refusal-'), 'store.db');
    const { stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const manifestPath = join(stagingDirectory, 'reset-manifest.json');
    const malformed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    malformed.resetPolicyCause = 'operator-override';
    writeFileSync(manifestPath, JSON.stringify(malformed));

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_malformed');
    expect(readdirSync(stagingRoot)).toHaveLength(1);
    expect(existsSync(join(stagingDirectory, 'store.db'))).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
  });

  it('fails closed when the manifest identity does not match its staging directory', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-identity-mismatch-resume-refusal-'), 'store.db');
    const { stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const manifestPath = join(stagingDirectory, 'reset-manifest.json');
    const parsed = parseStoreResetIncidentManifest(readFileSync(manifestPath));
    if (parsed.schemaVersion !== 3) throw new Error('Expected a V3 store-reset incident.');
    writeFileSync(
      manifestPath,
      serializeStoreResetIncidentManifest({
        ...parsed,
        incidentId: '423e4567-e89b-42d3-a456-426614174000',
      }),
    );

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_mismatched');
    expect(readdirSync(stagingRoot)).toHaveLength(1);
    expect(existsSync(join(stagingDirectory, 'store.db'))).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
  });

  it('fails closed on a foreign staging entry and retains it', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-foreign-staging-resume-refusal-'), 'store.db');
    const { stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const foreignDirectory = join(stagingRoot, 'foreign-publication');
    renameFileSync(stagingDirectory, foreignDirectory);

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_foreign');
    expect(readdirSync(stagingRoot)).toEqual(['foreign-publication']);
    expect(existsSync(join(foreignDirectory, 'store.db'))).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
  });

  it('finishes a copy-arm commit after a manifest-write crash and boots', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-duplicate-'), 'store.db');
    const { quarantineRoot, stagingRoot } = createInterruptedCopyReset(runtime, dbPath);
    const db = await openReset(runtime, dbPath);
    db.close();

    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(retainedIncidentNames(quarantineRoot)).toHaveLength(1);
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
  });

  it('refreshes maintenance exclusion while restaging mutable legacy hard links as copies', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-linked-'), 'store.db');
    const { quarantineRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const parkingDirectory = join(quarantineRoot, '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY);
    const stagedDb = join(stagingDirectory, 'store.db');
    const parkedDb = join(parkingDirectory, 'store.db');
    rmSync(stagedDb);
    runtime.storage.linkSync(parkedDb, stagedDb);
    const ledgerPath = join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      pending: { outcome: { kind: string; incident: { preservation: unknown } } };
    };
    ledger.pending.outcome.incident.preservation = { kind: 'linked', coherence: 'coherent' };
    writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
    appendFileSync(parkedDb, 'uncooperative append after publication');
    const openSync = runtime.storage.openSync;
    const renameSync = runtime.storage.renameSync;
    let restaging = false;
    let refreshedDuringRestage = false;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags, mode) => {
      const descriptor = openSync(path, flags, mode);
      if (String(path).endsWith('.restage')) restaging = true;
      return descriptor;
    });
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      renameSync(source, destination);
      if (String(source).endsWith('.restage')) restaging = false;
    });
    const exclusion = {
      kind: 'proven',
      lease: {
        assertOwned: () => undefined,
        maintain: () => {
          if (restaging) refreshedDuringRestage = true;
        },
        release: () => undefined,
      },
    } as unknown as WriterExclusion;

    const db = await openReset(runtime, dbPath, exclusion);
    db.close();

    const manifest = retainedManifest(dbPath);
    const incidentDb = join(quarantineRoot, manifest.incidentId, 'store.db');
    const bytes = readFileSync(incidentDb);
    expect(manifest.files[0]).toMatchObject({
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved?.preservation).toMatchObject({
      kind: 'copied',
      coherence: 'torn',
    });
    expect(refreshedDuringRestage).toBe(true);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('keeps a foreign parked inode even when its bytes match staged evidence', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-resume-foreign-identical-');
    const dbPath = join(root, 'store.db');
    const { quarantineRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const parkingPath = join(quarantineRoot, '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db');
    const replacementPath = join(root, 'identical-foreign-store.db');
    copyFileSync(join(stagingDirectory, 'store.db'), replacementPath);
    rmSync(parkingPath);
    renameFileSync(replacementPath, parkingPath);
    const replacement = statSync(parkingPath, { bigint: true });

    expect(resumeReset(runtime, dbPath)).not.toBeNull();

    const active = statSync(dbPath, { bigint: true });
    expect({ dev: active.dev, ino: active.ino }).toEqual({ dev: replacement.dev, ino: replacement.ino });
  });

  it('records the copy disposition before replacing the first linked staging file', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-resume-restage-disposition-');
    const dbPath = join(root, 'store.db');
    const { quarantineRoot } = createInterruptedReset(runtime, dbPath);
    const openSync = runtime.storage.openSync;
    let interrupted = false;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags, mode) => {
      if (!interrupted && String(path).endsWith('.restage')) {
        interrupted = true;
        throw errno('EIO');
      }
      return openSync(path, flags, mode);
    });

    const error = await captureAsyncError(() =>
      openReset(runtime, dbPath, { kind: 'unproven', reason: 'writer-live', blockers: 'fixture writer' }),
    );

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(interrupted).toBe(true);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.pending).toMatchObject({
      outcome: {
        kind: 'preserve',
        incident: {
          preservation: {
            kind: 'copied',
            cause: { kind: 'exclusion-unproven', reason: 'writer-live' },
          },
        },
      },
    });
  });

  it('records expected identities before legacy resume parks its first active file', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-resume-pre-ledger-identities-');
    const dbPath = join(root, 'store.db');
    const { quarantineRoot } = createInterruptedReset(runtime, dbPath);
    const parkingRoot = join(quarantineRoot, '.parked');
    const parkingDirectory = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
    runtime.storage.linkSync(join(parkingDirectory, 'store.db'), dbPath);
    rmSync(parkingDirectory, { recursive: true });
    rmSync(join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME));
    const original = statSync(dbPath, { bigint: true });
    const renameSync = runtime.storage.renameSync;
    let interrupted = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      renameSync(source, destination);
      if (!interrupted && source === dbPath && dirname(destination) === parkingDirectory) {
        interrupted = true;
        throw errno('EIO');
      }
    });

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(interrupted).toBe(true);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.pending?.identities).toContainEqual({
      name: 'store.db',
      dev: original.dev.toString(),
      ino: original.ino.toString(),
    });
    expect(existsSync(join(parkingDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME))).toBe(true);
  });

  it('discards uncommitted pre-manifest staging before classifying the active store', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-pre-manifest-resume-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const interruptedId = '323e4567-e89b-42d3-a456-426614174000';
    const stagingRoot = join(root, 'store-reset-quarantine', '.staging');
    const stagingDirectory = join(stagingRoot, interruptedId);
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    copyFileSync(dbPath, join(stagingDirectory, 'store.db'));
    writeFileSync(join(stagingDirectory, 'reset-manifest.json.tmp'), 'partial manifest', 'utf-8');

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(existsSync(stagingDirectory)).toBe(false);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    expect(retainedManifest(dbPath).resetPolicyCause).toBe('corrupt-or-unsupported');
  });

  it('resumes a manifest-bearing staging directory with the atomic writer temp file', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-manifest-temp-resume-');
    const dbPath = join(root, 'store.db');
    const { stagingRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const manifestPath = join(stagingDirectory, 'reset-manifest.json');
    writeFileSync(`${manifestPath}.tmp`, readFileSync(manifestPath));

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(readdirSync(stagingRoot)).toEqual([]);
    const retained = retainedManifest(dbPath);
    expect(existsSync(join(root, 'store-reset-quarantine', retained.incidentId, 'reset-manifest.json.tmp'))).toBe(
      false,
    );
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('terminalizes an over-limit unrestorable parking directory before deleting its staging witness', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-pre-manifest-parking-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const interruptedId = '323e4567-e89b-42d3-a456-426614174000';
    const quarantineRoot = join(root, 'store-reset-quarantine');
    const stagingRoot = join(quarantineRoot, '.staging');
    const stagingDirectory = join(stagingRoot, interruptedId);
    const parkingRoot = join(quarantineRoot, '.parked');
    const parkingDirectory = join(parkingRoot, interruptedId);
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(parkingDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(stagingDirectory, 'reset-manifest.json.tmp'), 'partial manifest', 'utf-8');
    renameFileSync(dbPath, join(parkingDirectory, 'store.db'));
    const parkedIdentity = statSync(join(parkingDirectory, 'store.db'), { bigint: true });
    copyFileSync(join(parkingDirectory, 'store.db'), dbPath);
    for (let index = 0; index <= MAX_INCIDENT_DIR_ENTRIES; index += 1) {
      writeFileSync(join(parkingDirectory, `extra-${index}`), 'parking evidence');
    }
    writeStoreResetParkedRecord(runtime.storage, parkingRoot, {
      version: 1,
      parkingId: interruptedId,
      parkedAt: '2026-09-13T00:00:00.000Z',
      phase: 'in-flight',
      cause: 'publication',
      incidentId: interruptedId,
      names: [],
      entries: [],
      transaction: {
        kind: 'publication',
        incidentId: interruptedId,
        identities: [{ name: 'store.db', dev: parkedIdentity.dev.toString(), ino: parkedIdentity.ino.toString() }],
      },
      classification: null,
    });

    const rmSync = runtime.storage.rmSync;
    const stagingRemoval = vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
      if (path === stagingDirectory) throw errno('EIO');
      rmSync(path, options);
    });
    expect(await captureAsyncError(() => openReset(runtime, dbPath))).not.toBeNull();
    expect(readStoreResetParkedRecord(runtime.storage, parkingRoot, interruptedId)).toMatchObject({
      phase: 'terminal',
      incidentId: null,
      names: ['store.db'],
    });
    stagingRemoval.mockRestore();

    const first = await openReset(runtime, dbPath);
    first.close();

    expect(existsSync(stagingDirectory)).toBe(false);
    expect(existsSync(parkingDirectory)).toBe(false);
    expect([
      ...retainedIncidentNames(quarantineRoot),
      ...readdirSync(parkingRoot).filter(isCanonicalStoreResetIncidentId),
    ]).toHaveLength(1);
    const second = await openReset(runtime, dbPath);
    second.close();
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('rejects a symlinked interrupted staging directory before touching active evidence', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-interrupted-symlink-');
    const dbPath = join(root, 'store.db');
    const { stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const outside = join(root, 'outside-staging');
    renameFileSync(stagingDirectory, outside);
    symlinkSync(outside, stagingDirectory, 'dir');

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_foreign');
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(tableExists(join(outside, 'store.db'), 'sentinel_before_reset')).toBe(true);
  });

  it('rejects a symlinked parking operation before reading or removing its target', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-interrupted-parking-symlink-');
    const dbPath = join(root, 'store.db');
    const { quarantineRoot } = createInterruptedReset(runtime, dbPath);
    const parkingPath = join(quarantineRoot, '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY);
    const outside = join(root, 'outside-parking');
    renameFileSync(parkingPath, outside);
    symlinkSync(outside, parkingPath, 'dir');
    const outsideEvidence = readFileSync(join(outside, 'store.db'));

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(join(outside, 'store.db'))).toEqual(outsideEvidence);
    expect(lstatSync(parkingPath).isSymbolicLink()).toBe(true);
  });

  it('rejects a symlinked parking root before reading or removing its target', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-interrupted-parking-root-symlink-');
    const dbPath = join(root, 'store.db');
    const { quarantineRoot } = createInterruptedReset(runtime, dbPath);
    const parkingRoot = join(quarantineRoot, '.parked');
    const outside = join(root, 'outside-parking-root');
    renameFileSync(parkingRoot, outside);
    symlinkSync(outside, parkingRoot, 'dir');
    const incidentId = readdirSync(outside)[0];
    if (incidentId === undefined) throw new Error('Expected the interrupted parking operation.');
    const outsideEvidence = readFileSync(join(outside, incidentId, 'store.db'));

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(join(outside, incidentId, 'store.db'))).toEqual(outsideEvidence);
    expect(lstatSync(parkingRoot).isSymbolicLink()).toBe(true);
  });

  it('rejects an oversized interrupted manifest before opening it', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-oversized-manifest-'), 'store.db');
    const { stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const manifestPath = join(stagingDirectory, 'reset-manifest.json');
    writeFileSync(manifestPath, Buffer.alloc(MAX_RESET_MANIFEST_BYTES + 1));
    const openSync = runtime.storage.openSync;
    let manifestOpenCount = 0;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags) => {
      if (path === manifestPath) manifestOpenCount += 1;
      return openSync(path, flags);
    });

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_malformed');
    expect(manifestOpenCount).toBe(0);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(
      existsSync(
        join(dirname(dbPath), 'store-reset-quarantine', '.parked', STORE_RESET_IN_FLIGHT_DIRECTORY, 'store.db-wal'),
      ),
    ).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects unexpected content in a manifest-bearing staging transaction', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-unexpected-content-'), 'store.db');
    const { stagingDirectory } = createInterruptedReset(runtime, dbPath);
    writeFileSync(join(stagingDirectory, 'unexpected.bin'), 'not retained evidence', 'utf-8');

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_foreign');
    expect(existsSync(join(stagingDirectory, 'unexpected.bin'))).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('bounds interrupted-publication enumeration to one staging transaction', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-interrupted-multiple-'), 'store.db');
    const { stagingRoot } = createInterruptedReset(runtime, dbPath);
    mkdirSync(join(stagingRoot, '323e4567-e89b-42d3-a456-426614174000'), { mode: 0o700 });
    const readDirectoryBoundedSync = runtime.storage.readDirectoryBoundedSync;
    const reads: Array<{ path: string; limit: number }> = [];
    vi.spyOn(runtime.storage, 'readDirectoryBoundedSync').mockImplementation((path, limit) => {
      reads.push({ path, limit });
      return readDirectoryBoundedSync(path, limit);
    });

    const error = await captureAsyncError(() => openReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_interrupted_ambiguous');
    expect(reads).toContainEqual({ path: stagingRoot, limit: 1 });
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('does not remove active evidence when durable manifest publication fails', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-manifest-publication-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const original = readFileSync(dbPath);
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(original);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
    expect(readdirSync(join(dbDir, 'store-reset-quarantine', '.staging'))).toEqual([]);
  });

  it('boots after a committed incident ledger write fails', async () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-ledger-publication-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
    let ledgerWrites = 0;
    const ledgerWrite = vi
      .spyOn(runtime.storage, 'writeAtomicDurableSync')
      .mockImplementation((path, data, options) => {
        if (!path.endsWith(STORE_RESET_RETENTION_LEDGER_FILE_NAME)) {
          return writeAtomicDurableSync(path, data, options);
        }
        ledgerWrites += 1;
        return ledgerWrites === 1 ? writeAtomicDurableSync(path, data, options) : false;
      });
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(retainedIncidentNames(join(dbDir, 'store-reset-quarantine'))).toHaveLength(1);
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store_reset_retention_ledger_write_failed'));
    const quarantineRoot = join(dbDir, 'store-reset-quarantine');
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)).toMatchObject({
      pending: { outcome: { kind: 'preserve' } },
      preserved: null,
    });

    ledgerWrite.mockRestore();
    expect(resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot)).toMatchObject({
      kind: 'held',
      holder: { preservation: { kind: 'copied', coherence: 'coherent' } },
      ledger: { pending: null },
    });
  });

  it('returns an adopted slot when its bookkeeping write fails', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-reset-adoption-ledger-failure-'), 'store.db');
    createMismatchStore(dbPath);
    const publication = publishReset(runtime, dbPath);
    if (publication.kind !== 'preserved') throw new Error('Expected preserved reset evidence.');
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    rmSync(join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME));
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);

    expect(resolveStoreResetRetentionSlot(runtime.storage, quarantineRoot)).toMatchObject({
      kind: 'held',
      holder: { incidentId: publication.incident.incidentId },
    });
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)).toBeNull();
  });

  it('does not remove active evidence when the durable manifest directory sync fails', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-manifest-directory-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const original = readFileSync(dbPath);
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    const stagingRoot = join(dbDir, 'store-reset-quarantine', '.staging');
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) =>
      dirname(path) === stagingRoot ? false : syncDirectoryDurableSync(path),
    );

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(original);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  it('rolls back a pre-manifest parking whose source directory sync failed', async () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-remove-source-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    const syncSpy = vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      if (path === dbDir && !existsSync(dbPath)) return false;
      return syncDirectoryDurableSync(path);
    });

    const firstError = captureError(() => publishReset(runtime, dbPath));
    expectSetupCode(firstError, 'store_reset_quarantine_failed');
    expect(existsSync(dbPath)).toBe(false);
    const stagingRoot = join(dbDir, 'store-reset-quarantine', '.staging');
    expect(existsSync(join(stagingRoot, readdirSync(stagingRoot)[0], 'store.db'))).toBe(true);

    syncSpy.mockRestore();
    expect(resumeReset(runtime, dbPath)).toBeNull();
    const db = await openReset(runtime, dbPath);
    db.close();
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('reopens safely after final publication succeeds but its parent sync reports failure', async () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-final-publication-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const quarantineRoot = join(dbDir, 'store-reset-quarantine');
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    let finalPublished = false;
    const renameSync = runtime.storage.renameSync;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      renameSync(source, destination);
      if (dirname(source) === join(quarantineRoot, '.staging')) finalPublished = true;
    });
    const syncSpy = vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      if (path === quarantineRoot && finalPublished) return false;
      return syncDirectoryDurableSync(path);
    });

    const firstError = captureError(() => publishReset(runtime, dbPath));
    expectSetupCode(firstError, 'store_reset_quarantine_failed');
    expect(existsSync(dbPath)).toBe(false);
    expect(retainedIncidentNames(quarantineRoot)).toHaveLength(1);

    syncSpy.mockRestore();
    const db = await openReset(runtime, dbPath);
    db.close();
    expect(retainedIncidentNames(quarantineRoot)).toHaveLength(1);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('does not remove active evidence when quarantine directory metadata cannot be synchronized', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-directory-sync-failure-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const original = readFileSync(dbPath);
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockReturnValue(false);

    const error = captureError(() => publishReset(runtime, dbPath));

    expectSetupCode(error, 'store_reset_quarantine_failed');
    expect(readFileSync(dbPath)).toEqual(original);
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
  });

  it('refreshes adoption and maintenance leases inside a long synchronous evidence copy', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-copy-heartbeat-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const source = new DatabaseSync(dbPath);
    try {
      source.exec('CREATE TABLE large_evidence (value BLOB NOT NULL)');
      source.prepare('INSERT INTO large_evidence (value) VALUES (zeroblob(?))').run(256 * 1024);
    } finally {
      source.close();
    }

    const wallNow = runtime.time.now.bind(runtime.time);
    let wallOffset = 0;
    vi.spyOn(runtime.time, 'now').mockImplementation(() => wallNow() + wallOffset);
    const readSync = runtime.storage.readSync;
    let copyStarted = false;
    vi.spyOn(runtime.storage, 'readSync').mockImplementation((descriptor, buffer, offset, length, position) => {
      const bytesRead = readSync(descriptor, buffer, offset, length, position);
      if (!copyStarted && length === 64 * 1024 && bytesRead > 0) {
        copyStarted = true;
        wallOffset = 11 * 60 * 1_000;
      }
      return bytesRead;
    });
    const adoptionLock = resolveGenerationBoundaryPaths(runtime).adoptionLock;
    const renameSync = runtime.storage.renameSync;
    let refreshedDuringCopy = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((sourcePath, destinationPath) => {
      if (
        copyStarted &&
        dirname(String(sourcePath)) === adoptionLock &&
        basename(String(sourcePath)).startsWith('owner-') &&
        basename(String(destinationPath)).startsWith('claim-refresh-')
      ) {
        refreshedDuringCopy = true;
      }
      renameSync(sourcePath, destinationPath);
    });
    const maintainMaintenance = vi.fn();
    const exclusion = {
      kind: 'proven',
      lease: {
        assertOwned: () => undefined,
        maintain: maintainMaintenance,
        release: () => undefined,
      },
    } as unknown as WriterExclusion;

    const db = await openReset(runtime, dbPath, exclusion);
    db.close();

    expect(copyStarted).toBe(true);
    expect(refreshedDuringCopy).toBe(true);
    expect(maintainMaintenance).toHaveBeenCalled();
  });

  it('survives the generated Revision 10 authority and retention-rotation state space', async () => {
    const failures: string[] = [];
    const runCell = async (label: string, run: () => Promise<void> | void) => {
      const error = await captureAsyncError(async () => run());
      if (error === null) return;
      const cause = error instanceof Error ? error.message : (JSON.stringify(error) ?? 'non-error thrown');
      failures.push(`${label}: ${cause}`);
    };

    const authorityCells = [
      { elapsedMs: 0, claimant: 'absent', refresh: 'held' },
      { elapsedMs: 31_000, claimant: 'absent', refresh: 'held' },
      { elapsedMs: 31_000, claimant: 'competing', refresh: 'lost' },
    ] as const;
    for (const cell of authorityCells) {
      await runCell(`authority/${cell.elapsedMs}/${cell.claimant}/${cell.refresh}`, async () => {
        const runtime = createRuntime();
        const root = makeTempRoot('coral-store-revision10-authority-');
        const dbPath = join(root, 'store.db');
        createMismatchStore(dbPath);
        const source = new DatabaseSync(dbPath);
        try {
          source.exec('CREATE TABLE authority_sweep_evidence (value BLOB NOT NULL)');
          source.prepare('INSERT INTO authority_sweep_evidence (value) VALUES (zeroblob(?))').run(256 * 1024);
        } finally {
          source.close();
        }

        const wallNow = runtime.time.now.bind(runtime.time);
        let wallOffset = 0;
        vi.spyOn(runtime.time, 'now').mockImplementation(() => wallNow() + wallOffset);
        const resetLockPath = join(root, 'store.db.reset.lock');
        const readSync = runtime.storage.readSync;
        let injected = false;
        let contender: ReturnType<typeof acquireDirectoryLockSync> | null = null;
        vi.spyOn(runtime.storage, 'readSync').mockImplementation((descriptor, buffer, offset, length, position) => {
          const bytesRead = readSync(descriptor, buffer, offset, length, position);
          if (!injected && length === 64 * 1024 && bytesRead > 0) {
            injected = true;
            wallOffset = cell.elapsedMs;
            if (cell.claimant === 'competing') {
              contender = acquireDirectoryLockSync(
                resetLockPath,
                { storage: runtime.storage, time: runtime.time, staleMs: 30_000, heartbeatMs: 10_000 },
                250,
              );
            }
          }
          return bytesRead;
        });

        const error = await captureAsyncError(() => openReset(runtime, dbPath));
        contender?.();
        expect(injected).toBe(true);
        if (cell.refresh === 'held') {
          expect(error).toBeNull();
        } else {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/ownership lost/u);
        }
      });
    }

    await runCell('authority/compatible-clone/unobservable', async () => {
      const runtime = createRuntime();
      const root = makeTempRoot('coral-store-revision10-clone-authority-');
      const dbPath = join(root, 'store.db');
      const aliasPath = join(root, 'store.db.alias');
      createCompatibleSentinelStore(runtime, dbPath);
      runtime.storage.linkSync(dbPath, aliasPath);
      const maintain = vi.fn(() => {
        throw new Error('maintenance lease ownership unobservable');
      });
      const error = await captureAsyncError(() =>
        openReset(runtime, dbPath, {
          kind: 'proven',
          lease: { assertOwned: () => undefined, maintain, release: () => undefined },
        }),
      );
      expect(maintain).toHaveBeenCalled();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('maintenance lease ownership unobservable');
      expect(tableExists(aliasPath, 'sentinel_replacement')).toBe(true);
    });

    for (const replacement of ['regular-file', 'symlink'] as const) {
      await runCell(`retention/replaced-coordinate/${replacement}`, () => {
        const runtime = createRuntime();
        const root = makeTempRoot('coral-store-revision10-retention-');
        const dbPath = join(root, 'store.db');
        createMismatchStore(dbPath);
        const holder = publishReset(runtime, dbPath);
        if (holder.kind !== 'preserved') throw new Error('Expected an initial preserved incident.');
        const quarantineRoot = join(root, 'store-reset-quarantine');
        const holderPath = join(quarantineRoot, holder.incident.incidentId);
        const externalTarget = join(root, 'external-retention-target');
        mkdirSync(externalTarget);
        writeFileSync(join(externalTarget, 'sentinel'), 'external target survives');
        createMismatchStore(dbPath);

        const readDirectoryBoundedSync = runtime.storage.readDirectoryBoundedSync;
        let replaced = false;
        vi.spyOn(runtime.storage, 'readDirectoryBoundedSync').mockImplementation((path, maxEntries) => {
          const read = readDirectoryBoundedSync(path, maxEntries);
          if (
            !replaced &&
            path === quarantineRoot &&
            retainedIncidentNames(quarantineRoot).some((id) => id !== holder.incident.incidentId)
          ) {
            replaced = true;
            rmSync(holderPath, { recursive: true });
            if (replacement === 'regular-file') writeFileSync(holderPath, 'replacement coordinate');
            else symlinkSync(externalTarget, holderPath);
          }
          return read;
        });

        const next = publishReset(runtime, dbPath);
        if (next.kind !== 'preserved') throw new Error('Expected replacement preservation.');
        expect(replaced).toBe(true);
        expect(existsSync(holderPath)).toBe(false);
        expect(existsSync(join(quarantineRoot, next.incident.incidentId))).toBe(true);
        expect(readFileSync(join(externalTarget, 'sentinel'), 'utf8')).toBe('external target survives');
      });
    }

    expect(failures, `${failures.length} generated Revision 10 sweep cells failed`).toEqual([]);
  });

  it('revalidates adoption ownership after opening and before returning the writable handle', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-return-ownership-');
    const dbPath = join(root, 'store.db');
    createCompatibleSentinelStore(runtime, dbPath);
    const adoptionLock = resolveGenerationBoundaryPaths(runtime).adoptionLock;
    const syncDirectoryDurableSync = runtime.storage.syncDirectoryDurableSync;
    let displaced = false;
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      const durable = syncDirectoryDurableSync(path);
      if (!displaced && path === dirname(dbPath) && existsSync(dbPath)) {
        displaced = true;
        rmSync(adoptionLock, { recursive: true });
        mkdirSync(adoptionLock, { mode: 0o700 });
      }
      return durable;
    });

    await expect(openReset(runtime, dbPath)).rejects.toThrow(/ownership lost/u);
    expect(displaced).toBe(true);
  });

  it('does not describe a symlinked active name as incident evidence', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-active-symlink-');
    const dbPath = join(root, 'store.db');
    const target = join(root, 'external-store.db');
    createMismatchStore(target);
    symlinkSync(target, dbPath);

    const publication = publishReset(runtime, dbPath);

    expect(publication.kind).toBe('no-evidence');
    expect(tableExists(target, 'sentinel_before_reset')).toBe(true);
    expect(lstatSync(dbPath).isSymbolicLink()).toBe(true);
  });

  it('never opens a shared-name symlink as a writable store', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-writable-symlink-');
    const dbPath = join(root, 'store.db');
    const external = join(root, 'external-store.db');
    createCompatibleSentinelStore(runtime, external);
    const before = readFileSync(external);
    symlinkSync(external, dbPath);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(readFileSync(external)).toEqual(before);
    expect(lstatSync(dbPath).isSymbolicLink()).toBe(false);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it.each([
    ['private', 'uncontended'],
    ['private', 'replaced'],
    ['externally-linked', 'uncontended'],
    ['externally-linked', 'replaced'],
  ] as const)(
    'opens a fresh %s claim through a private active inode when the pathname is %s',
    async (topology, pathnameState) => {
      const runtime = createRuntime();
      const root = makeTempRoot(`coral-store-writable-${topology}-${pathnameState}-`);
      const dbPath = join(root, 'store.db');
      const externalPath = join(root, 'external-store.db');
      new DatabaseSync(dbPath).close();
      if (topology === 'externally-linked') runtime.storage.linkSync(dbPath, externalPath);
      const before = readFileSync(dbPath);
      const parkedIdentity = statSync(dbPath, { bigint: true });
      expect(parkedIdentity.nlink).toBe(topology === 'private' ? 1n : 2n);
      const linkSync = runtime.storage.linkSync;
      let replacementIdentity: { readonly dev: bigint; readonly ino: bigint } | null = null;
      vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
        if (pathnameState === 'replaced' && replacementIdentity === null && destination === dbPath) {
          createIncompatibleSentinelStore(dbPath, 0);
          const replacement = statSync(dbPath, { bigint: true });
          replacementIdentity = { dev: replacement.dev, ino: replacement.ino };
        }
        linkSync(source, destination);
      });

      const db = await openReset(runtime, dbPath);
      expectReturnedHandleTargetsActiveStore(db, dbPath);
      db.close();

      expect(replacementIdentity === null).toBe(pathnameState === 'uncontended');
      if (replacementIdentity !== null) expect(containsIdentity(root, replacementIdentity)).toBe(true);
      const activeIdentity = statSync(dbPath, { bigint: true });
      if (topology === 'private') {
        const active = { dev: activeIdentity.dev, ino: activeIdentity.ino };
        const initial = { dev: parkedIdentity.dev, ino: parkedIdentity.ino };
        if (pathnameState === 'uncontended') expect(active).toEqual(initial);
        else expect(active).not.toEqual(initial);
        return;
      }
      expect(readFileSync(externalPath)).toEqual(before);
      const externalIdentity = statSync(externalPath, { bigint: true });
      expect({ dev: activeIdentity.dev, ino: activeIdentity.ino }).not.toEqual({
        dev: externalIdentity.dev,
        ino: externalIdentity.ino,
      });
    },
  );

  it.each(['directory', 'unreadable-file'] as const)(
    'resets a shared-name symlink whose %s target cannot be opened as SQLite',
    async (targetKind) => {
      const runtime = createRuntime();
      const root = makeTempRoot(`coral-store-unopenable-symlink-${targetKind}-`);
      const dbPath = join(root, 'store.db');
      const target = join(root, 'external-target');
      if (targetKind === 'directory') mkdirSync(target);
      else {
        writeFileSync(target, 'not a readable SQLite store');
        runtime.storage.chmodSync(target, 0o000);
      }
      symlinkSync(target, dbPath);

      expect(classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT)).toMatchObject({
        kind: 'corrupt-or-unsupported',
        storedProductVersionState: 'unavailable',
      });
      const db = await openReset(runtime, dbPath);
      db.close();

      expect(lstatSync(dbPath).isSymbolicLink()).toBe(false);
      expect(tableExists(dbPath, 'events')).toBe(true);
      expect(lstatSync(target).isDirectory()).toBe(targetKind === 'directory');
    },
  );

  it('never uses a shared-path hard link while preserving an active store', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-active-replacement-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const linkSync = runtime.storage.linkSync;
    const activeSources: string[] = [];
    vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
      if (source === dbPath) activeSources.push(source);
      linkSync(source, destination);
    });

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(activeSources).toEqual([]);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('classifies a compatible replacement that arrives before copy descriptor open', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-copy-active-replacement-');
    const dbPath = join(root, 'store.db');
    const replacement = join(root, 'replacement.db');
    createMismatchStore(dbPath);
    createCompatibleSentinelStore(runtime, replacement);
    const openSync = runtime.storage.openSync;
    let replaced = false;
    vi.spyOn(runtime.storage, 'openSync').mockImplementation((path, flags) => {
      if (path === dbPath && !replaced) {
        replaced = true;
        rmSync(dbPath);
        renameFileSync(replacement, dbPath);
      }
      return openSync(path, flags);
    });

    const db = await openReset(runtime, dbPath, {
      kind: 'unproven',
      reason: 'writer-live',
      blockers: 'fixture writer',
    });
    db.close();

    expect(replaced).toBe(true);
    expect(tableExists(dbPath, 'sentinel_replacement')).toBe(true);
    expect(retainedIncidentNames(join(root, 'store-reset-quarantine'))).toEqual([]);
  });

  it.each(['publication', 'claim'] as const)(
    'records a non-regular occupant parked by the %s arm and still boots',
    async (arm) => {
      const runtime = createRuntime();
      const root = makeTempRoot(`coral-store-${arm}-non-regular-`);
      const dbPath = join(root, 'store.db');
      createMismatchStore(dbPath);
      let injected = false;

      if (arm === 'publication') {
        const renameSync = runtime.storage.renameSync;
        vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
          if (source === dbPath && String(destination).includes(`${join('store-reset-quarantine', '.parked')}`)) {
            rmSync(dbPath);
            mkdirSync(dbPath);
            injected = true;
          }
          renameSync(source, destination);
        });
      } else {
        const linkSync = runtime.storage.linkSync;
        vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
          if (
            !injected &&
            destination === dbPath &&
            String(source).includes(`${join('store-reset-quarantine', '.minted')}`)
          ) {
            mkdirSync(dbPath);
            injected = true;
          }
          linkSync(source, destination);
        });
      }

      const db = await openReset(runtime, dbPath);
      db.close();

      expect(injected).toBe(true);
      const parkingRoot = join(root, 'store-reset-quarantine', '.parked');
      const records = readdirSync(parkingRoot)
        .filter(isCanonicalStoreResetIncidentId)
        .map((parkingId) =>
          JSON.parse(readFileSync(join(parkingRoot, parkingId, STORE_RESET_PARKED_SIDECAR_FILE_NAME), 'utf-8')),
        ) as Array<{ entries?: unknown }>;
      expect(records).toEqual([
        expect.objectContaining({
          entries: [expect.objectContaining({ name: 'store.db', kind: 'directory' })],
        }),
      ]);
    },
  );

  it('resumes a claim transaction interrupted after parking renamed the occupant', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-claim-parking-resume-');
    const dbPath = join(root, 'store.db');
    const externalPath = join(root, 'external-store.db');
    createMismatchStore(dbPath);
    const linkSync = runtime.storage.linkSync;
    let injected = false;
    vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
      if (
        !injected &&
        destination === dbPath &&
        String(source).includes(`${join('store-reset-quarantine', '.minted')}`)
      ) {
        createCompatibleSentinelStore(runtime, dbPath);
        injected = true;
      }
      linkSync(source, destination);
    });
    const renameSync = runtime.storage.renameSync;
    const lstatSync = runtime.storage.lstatSync;
    let parkedPath: string | null = null;
    let interrupted = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      renameSync(source, destination);
      if (
        injected &&
        source === dbPath &&
        String(destination).includes(`${join('store-reset-quarantine', '.parked')}`)
      ) {
        parkedPath = String(destination);
      }
    });
    vi.spyOn(runtime.storage, 'lstatSync').mockImplementation(((path: string, options?: { bigint?: boolean }) => {
      if (!interrupted && options?.bigint === true && path === parkedPath) {
        interrupted = true;
        throw errno('EIO');
      }
      return options?.bigint === true ? lstatSync(path, { bigint: true }) : lstatSync(path);
    }) as Runtime['storage']['lstatSync']);

    expect(await captureAsyncError(() => openReset(runtime, dbPath))).not.toBeNull();
    expect(interrupted).toBe(true);
    vi.restoreAllMocks();
    expect(parkedPath).not.toBeNull();
    runtime.storage.linkSync(parkedPath ?? '', externalPath);
    const externalBytes = readFileSync(externalPath);

    const db = await openReset(runtime, dbPath);
    expectReturnedHandleTargetsActiveStore(db, dbPath);
    db.close();
    expect(readFileSync(externalPath)).toEqual(externalBytes);
    const activeIdentity = statSync(dbPath, { bigint: true });
    const externalIdentity = statSync(externalPath, { bigint: true });
    expect({ dev: activeIdentity.dev, ino: activeIdentity.ino }).not.toEqual({
      dev: externalIdentity.dev,
      ino: externalIdentity.ino,
    });
    const listed = listStoreResetIncidents({
      fs: createStoreResetInspectionFs(),
      quarantineRoot: join(root, 'store-reset-quarantine'),
      expectedBuild: buildIdentity(),
    });
    expect(
      listed.incidents.some((entry) => entry.state === 'parked'),
      JSON.stringify(listed),
    ).toBe(true);
  });

  it('resumes preservation after parking a schema-identical store over the bound', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-discard-parking-resume-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const first = await openReset(runtime, dbPath);
    first.close();
    rmSync(dbPath);
    createVersionedStore(dbPath, STORE_FORMAT.fingerprint, '99.0.0');
    const renameSync = runtime.storage.renameSync;
    const lstatSync = runtime.storage.lstatSync;
    let parkedPath: string | null = null;
    let interrupted = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      renameSync(source, destination);
      if (source === dbPath && String(destination).includes(`${join('store-reset-quarantine', '.parked')}`)) {
        parkedPath = String(destination);
      }
    });
    vi.spyOn(runtime.storage, 'lstatSync').mockImplementation(((path: string, options?: { bigint?: boolean }) => {
      if (!interrupted && options?.bigint === true && path === parkedPath) {
        interrupted = true;
        throw errno('EIO');
      }
      return options?.bigint === true ? lstatSync(path, { bigint: true }) : lstatSync(path);
    }) as Runtime['storage']['lstatSync']);

    expect(await captureAsyncError(() => openReset(runtime, dbPath))).not.toBeNull();
    expect(interrupted).toBe(true);
    vi.restoreAllMocks();

    const db = await openReset(runtime, dbPath);
    expectReturnedHandleTargetsActiveStore(db, dbPath);
    db.close();
    const ledger = readStoreResetRetentionLedger(runtime.storage, join(root, 'store-reset-quarantine'));
    expect(ledger?.pending).toBeNull();
    expect(ledger?.preserved).not.toBeNull();
    expect(retainedIncidentNames(join(root, 'store-reset-quarantine'))).toEqual([ledger?.preserved?.incidentId]);
  });

  it.each([1, 2, 3, 5])('boots after an adversary lands %i incompatible store epochs', async (epochCount) => {
    const runtime = createRuntime();
    const root = makeTempRoot(`coral-store-k-replacement-${epochCount}-`);
    const dbPath = join(root, 'store.db');
    const identities: Array<{ readonly dev: bigint; readonly ino: bigint }> = [];
    createMismatchStore(dbPath);

    const linkSync = runtime.storage.linkSync;
    let nextEpoch = 0;
    vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
      if (
        destination === dbPath &&
        String(source).includes(`${join('store-reset-quarantine', '.minted')}`) &&
        nextEpoch < epochCount
      ) {
        createIncompatibleSentinelStore(dbPath, nextEpoch);
        const replacement = statSync(dbPath, { bigint: true });
        identities.push({ dev: replacement.dev, ino: replacement.ino });
        nextEpoch += 1;
      }
      linkSync(source, destination);
    });

    const settlement = await settleReset(runtime, dbPath);
    settlement.db.close();

    expect(nextEpoch).toBe(epochCount);
    expect(containsIdentity(root, identities.at(-1)!)).toBe(true);
    for (const identity of identities.slice(0, -1)) expect(containsIdentity(root, identity)).toBe(false);
    const quarantineRoot = join(root, 'store-reset-quarantine');
    const parkingRoot = join(quarantineRoot, '.parked');
    const parkingIds = readdirSync(parkingRoot).filter(isCanonicalStoreResetIncidentId);
    expect([...retainedIncidentNames(quarantineRoot), ...parkingIds]).toHaveLength(1);
    expect(parkingIds).toHaveLength(1);
    expect(settlement.survivor).toEqual({ kind: 'parking', parkingId: parkingIds[0] });
    for (const parkingId of parkingIds) {
      const sidecar = JSON.parse(
        readFileSync(join(parkingRoot, parkingId, STORE_RESET_PARKED_SIDECAR_FILE_NAME), 'utf-8'),
      ) as { cause?: unknown; names?: unknown };
      expect(sidecar).toMatchObject({ cause: 'intruder', names: ['store.db'] });
    }
    const listed = listStoreResetIncidents({
      fs: createStoreResetInspectionFs(),
      quarantineRoot: join(root, 'store-reset-quarantine'),
      expectedBuild: buildIdentity(),
    });
    expect(listed.incidents.filter((entry) => entry.state === 'parked')).toHaveLength(1);
    const rendered = formatStoreResetList(listed, 'gen2');
    for (const parkingId of parkingIds) expect(rendered).toContain(parkingId);
  });

  it.each([
    ['equal', 1],
    ['equal', 3],
    ['equal', 5],
    ['regressing', 1],
    ['regressing', 3],
    ['regressing', 5],
  ] as const)(
    'recovers the newest crash-cut replacement when parkedAt is %s across %i replacements',
    async (clockState, replacementCount) => {
      const runtime = createRuntime();
      const root = makeTempRoot(`coral-store-parking-order-${clockState}-${replacementCount}-`);
      const dbPath = join(root, 'store.db');
      const parkingRoot = join(root, 'store-reset-quarantine', '.parked');
      const parkingIds = Array.from(
        { length: replacementCount + 1 },
        (_, index) => `${9 - index}23e4567-e89b-42d3-a456-426614174000`,
      );
      for (const [index, parkingId] of parkingIds.entries()) {
        const evidence = `parking-${index}`;
        const parkingDirectory = join(parkingRoot, parkingId);
        mkdirSync(parkingDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(join(parkingDirectory, 'store.db-wal'), evidence);
        writeStoreResetParkedRecord(runtime.storage, parkingRoot, {
          version: 1,
          parkingId,
          parkedAt:
            clockState === 'equal'
              ? '2026-09-13T00:00:00.000Z'
              : `2026-09-${String(13 - index).padStart(2, '0')}T00:00:00.000Z`,
          parkingOrder: String(index + 1),
          phase: 'terminal',
          cause: 'residual',
          incidentId: null,
          names: ['store.db-wal'],
          entries: [{ name: 'store.db-wal', kind: 'regular-file', sizeBytes: Buffer.byteLength(evidence) }],
          transaction: null,
          classification: null,
        });
      }

      const db = await openReset(runtime, dbPath);
      db.close();

      const expectedId = parkingIds.at(-1)!;
      expect(readdirSync(parkingRoot).filter(isCanonicalStoreResetIncidentId)).toEqual([expectedId]);
      expect(readFileSync(join(parkingRoot, expectedId, 'store.db-wal'), 'utf-8')).toBe(`parking-${replacementCount}`);
    },
  );

  it('fails a shifted replay until the expected semantic key is encountered', () => {
    const expected = { method: 'renameSync', occurrence: 1, phase: 'before' } as const;
    const shiftedTrace: TracePoint[] = [];
    appendTracePoint(shiftedTrace, 'openSync', 'before');
    appendTracePoint(shiftedTrace, 'lstatSync', 'before');

    expect(() =>
      assertMutationDisposition(
        'shifted replay',
        shiftedTrace.some((point) => sameTracePoint(point, expected)) ? { kind: 'applied' } : null,
      ),
    ).toThrow('replay did not encounter the exact semantic key');

    appendTracePoint(shiftedTrace, 'renameSync', 'before');
    expect(() =>
      assertMutationDisposition(
        'matching replay',
        shiftedTrace.some((point) => sameTracePoint(point, expected)) ? { kind: 'applied' } : null,
      ),
    ).not.toThrow();
  });

  it('survives the generated active-evidence mutation and crash-resume cross-product', async () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    const traces = new Map<ActiveEvidenceArm, readonly TracePoint[]>();
    const durableTraces = new Map<ActiveEvidenceArm, readonly TracePoint[]>();
    for (const arm of ACTIVE_EVIDENCE_ARMS) {
      const trace = await exerciseActiveEvidenceArm(arm);
      traces.set(arm, trace.calls);
      durableTraces.set(arm, trace.durableCalls);
    }

    const liveCells = ACTIVE_EVIDENCE_ARMS.flatMap((arm) =>
      ACTIVE_EVIDENCE_MUTATIONS.flatMap((mutation) => (traces.get(arm) ?? []).map((key) => ({ arm, mutation, key }))),
    );
    const crashResumeCells = ACTIVE_EVIDENCE_ARMS.flatMap((arm) =>
      (traces.get(arm) ?? []).flatMap((key) => ACTIVE_EVIDENCE_MUTATIONS.map((mutation) => ({ arm, mutation, key }))),
    );
    const durableCrashCells = ACTIVE_EVIDENCE_ARMS.flatMap((arm) =>
      (durableTraces.get(arm) ?? []).map((key) => ({ arm, key })),
    );
    for (const arm of ACTIVE_EVIDENCE_ARMS) expect(traces.get(arm)?.length ?? 0, arm).toBeGreaterThan(0);
    for (const arm of ACTIVE_EVIDENCE_ARMS) {
      expect(durableTraces.get(arm)?.length ?? 0, `${arm} durable records`).toBeGreaterThan(0);
    }

    const initialTrace = await exerciseActiveEvidenceArm('copy-proven', undefined, undefined, 'immediate');
    const initialClassificationKeys = initialTrace.calls.filter(
      (key) => key.method === 'existsSync' || key.method === 'lstatSync' || key.method === 'openSqliteDatabaseSync',
    );
    expect(initialClassificationKeys.some((key) => key.method === 'existsSync')).toBe(true);
    expect(initialClassificationKeys.some((key) => key.method === 'lstatSync')).toBe(true);
    expect(initialClassificationKeys.some((key) => key.method === 'openSqliteDatabaseSync')).toBe(false);

    const failures: string[] = [];
    const runCell = async (label: string, run: () => Promise<MutationDisposition | null>) => {
      const error = await captureAsyncError(async () => {
        const disposition = await run();
        assertMutationDisposition(label, disposition);
      });
      if (error === null) return;
      const cause = error instanceof Error ? error.message : (JSON.stringify(error) ?? 'non-error thrown');
      failures.push(`${label}: ${cause}`);
    };

    for (const cell of liveCells) {
      const label = `live ${cell.arm}/${cell.mutation} ${formatTracePoint(cell.key)}`;
      await runCell(
        label,
        async () =>
          (await exerciseActiveEvidenceArm(cell.arm, { key: cell.key, kind: cell.mutation })).mutationDisposition,
      );
    }
    for (const mutation of ['deleted', 'symlink-aba'] as const) {
      for (const key of initialClassificationKeys) {
        const label = `initial-path ${mutation} ${formatTracePoint(key)}`;
        await runCell(
          label,
          async () =>
            (await exerciseActiveEvidenceArm('copy-proven', { key, kind: mutation }, undefined, 'immediate'))
              .mutationDisposition,
        );
      }
    }
    for (const cell of crashResumeCells) {
      const label = `crash-resume ${cell.arm}/${cell.mutation} ${formatTracePoint(cell.key)}`;
      await runCell(label, async () => {
        const result = await exerciseActiveEvidenceArm(cell.arm, { key: cell.key, kind: 'crash' }, cell.mutation);
        return result.mutationDisposition;
      });
    }
    for (const cell of durableCrashCells) {
      const label = `durable-crash ${cell.arm} ${formatTracePoint(cell.key)}`;
      await runCell(
        label,
        async () =>
          (
            await exerciseActiveEvidenceArm(cell.arm, {
              key: cell.key,
              kind: 'crash',
              surface: 'durable',
            })
          ).mutationDisposition,
      );
    }

    expect(failures, `${failures.length} generated sweep cells failed`).toEqual([]);
  }, 120_000);

  it('survives the generated Revision 8 state-space extensions', async () => {
    const failures: string[] = [];
    const runCell = async (label: string, run: () => Promise<void> | void) => {
      const error = await captureAsyncError(async () => run());
      if (error === null) return;
      const cause = error instanceof Error ? error.message : (JSON.stringify(error) ?? 'non-error thrown');
      failures.push(`${label}: ${cause}`);
    };

    for (const kind of [
      'absent',
      'fresh',
      'compatible',
      'legacy-adoptable',
      'older-incompatible',
      'newer-incompatible',
      'corrupt-or-unsupported',
    ] as const) {
      await runCell(`classification/initial/${kind}`, async () => {
        const runtime = createRuntime();
        const root = makeTempRoot(`coral-store-revision8-initial-${kind}-`);
        const dbPath = join(root, 'store.db');
        if (kind === 'fresh') new DatabaseSync(dbPath).close();
        if (kind === 'compatible') createCompatibleSentinelStore(runtime, dbPath);
        if (kind === 'legacy-adoptable') createMismatchStore(dbPath, STORE_FORMAT.fingerprint);
        if (kind === 'older-incompatible') createVersionedStore(dbPath, `sha256:${'0'.repeat(64)}`, '0.0.1');
        if (kind === 'newer-incompatible') createVersionedStore(dbPath, STORE_FORMAT.fingerprint, '99.0.0');
        if (kind === 'corrupt-or-unsupported') createMismatchStore(dbPath);
        const before = existsSync(dbPath) ? statSync(dbPath, { bigint: true }) : null;

        const error = await captureAsyncError(async () => {
          const db = await openReset(runtime, dbPath);
          db.close();
        });

        if (kind === 'legacy-adoptable') {
          expectSetupCode(error, 'store_schema_outdated');
          expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(true);
          const after = statSync(dbPath, { bigint: true });
          expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before?.dev, ino: before?.ino });
        } else {
          expect(error).toBeNull();
          if (before !== null && kind !== 'fresh' && kind !== 'compatible') {
            expect(retainedIncidentContainsTable(root, 'sentinel_before_reset')).toBe(true);
          }
        }
      });
    }

    for (const kind of [
      'absent',
      'fresh',
      'compatible',
      'legacy-adoptable',
      'older-incompatible',
      'newer-incompatible',
      'corrupt-or-unsupported',
    ] as const) {
      await runCell(`classification/parked/${kind}`, async () => {
        const runtime = createRuntime();
        const root = makeTempRoot(`coral-store-revision8-parked-${kind}-`);
        const dbPath = join(root, 'store.db');
        createMismatchStore(dbPath);
        const classifyStore = dbModule.classifyStoreFile;
        vi.spyOn(dbModule, 'classifyStoreFile').mockImplementation((path, storage, current) =>
          kind === 'absent' && String(path).includes(`${join('store-reset-quarantine', '.parked')}`)
            ? { kind: 'absent' }
            : classifyStore(path, storage, current),
        );
        const linkSync = runtime.storage.linkSync;
        let occupant: { readonly dev: bigint; readonly ino: bigint } | null = null;
        let injected = false;
        vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
          if (
            !injected &&
            destination === dbPath &&
            String(source).includes(`${join('store-reset-quarantine', '.minted')}`)
          ) {
            if (kind === 'fresh') new DatabaseSync(dbPath).close();
            else if (kind === 'compatible') createCompatibleSentinelStore(runtime, dbPath);
            else if (kind === 'legacy-adoptable') createMismatchStore(dbPath, STORE_FORMAT.fingerprint);
            else if (kind === 'older-incompatible') createVersionedStore(dbPath, `sha256:${'0'.repeat(64)}`, '0.0.1');
            else if (kind === 'newer-incompatible') createVersionedStore(dbPath, STORE_FORMAT.fingerprint, '99.0.0');
            else createMismatchStore(dbPath);
            const observed = statSync(dbPath, { bigint: true });
            occupant = { dev: observed.dev, ino: observed.ino };
            injected = true;
          }
          linkSync(source, destination);
        });

        const error = await captureAsyncError(async () => {
          const db = await openReset(runtime, dbPath);
          db.close();
        });
        vi.restoreAllMocks();

        expect(injected).toBe(true);
        expect(occupant).not.toBeNull();
        if (kind === 'legacy-adoptable') {
          expectSetupCode(error, 'store_schema_outdated');
          expect(containsIdentity(root, occupant!)).toBe(true);
          const active = statSync(dbPath, { bigint: true });
          expect({ dev: active.dev, ino: active.ino }).toEqual(occupant);
        } else {
          expect(error).toBeNull();
          expect(containsIdentity(root, occupant!)).toBe(true);
        }
      });
    }

    for (const state of ['absent', 'sidecar-absent', 'malformed', 'unreadable', 'in-flight', 'terminal'] as const) {
      await runCell(`durable-coordinate/${state}`, async () => {
        const runtime = createRuntime();
        const root = makeTempRoot(`coral-store-revision8-${state}-`);
        const dbPath = join(root, 'store.db');
        createCompatibleSentinelStore(runtime, dbPath);
        const parkingRoot = join(root, 'store-reset-quarantine', '.parked');
        const coordinate = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
        if (state === 'absent') {
          const db = await openReset(runtime, dbPath);
          db.close();
          return;
        }
        mkdirSync(coordinate, { recursive: true, mode: 0o700 });
        const markerPath = join(coordinate, 'pre-existing-marker');
        writeFileSync(markerPath, state);
        const marker = statSync(markerPath, { bigint: true });
        if (state === 'malformed' || state === 'unreadable') {
          writeFileSync(join(coordinate, STORE_RESET_PARKED_SIDECAR_FILE_NAME), '{');
          if (state === 'unreadable') {
            runtime.storage.chmodSync(join(coordinate, STORE_RESET_PARKED_SIDECAR_FILE_NAME), 0o000);
          }
        } else if (state === 'terminal' || state === 'in-flight') {
          writeStoreResetParkedRecord(
            runtime.storage,
            parkingRoot,
            {
              version: 1,
              parkingId: '323e4567-e89b-42d3-a456-426614174000',
              parkedAt: '2026-09-13T00:00:00.000Z',
              phase: state === 'terminal' ? 'terminal' : 'in-flight',
              cause: 'residual',
              incidentId: null,
              names: [],
              entries: [],
              transaction:
                state === 'terminal'
                  ? null
                  : { kind: 'claim', names: ['store.db', 'store.db-wal', 'store.db-shm', 'store.db.format'] },
              classification: null,
            },
            STORE_RESET_IN_FLIGHT_DIRECTORY,
          );
        }

        const first = await captureAsyncError(async () => {
          const db = await openReset(runtime, dbPath);
          db.close();
        });
        expect(first).toBeNull();
        expect(containsIdentity(root, { dev: marker.dev, ino: marker.ino })).toBe(true);
      });
    }

    await runCell('classifier-open/multi-step-aba', async () => {
      const runtime = createRuntime();
      const root = makeTempRoot('coral-store-revision8-classifier-aba-');
      const dbPath = join(root, 'store.db');
      const originalPath = join(root, 'original.db');
      const foreignPath = join(root, 'foreign.db');
      createCompatibleSentinelStore(runtime, dbPath);
      const exists = runtime.storage.existsSync;
      const lstat = runtime.storage.lstatSync;
      let phase: 'waiting' | 'foreign' | 'restored' = 'waiting';
      vi.spyOn(runtime.storage, 'existsSync').mockImplementation((path) => {
        if (phase === 'waiting' && path === dbPath) {
          renameFileSync(dbPath, originalPath);
          createMismatchStore(dbPath);
          phase = 'foreign';
        }
        return exists(path);
      });
      vi.spyOn(runtime.storage, 'lstatSync').mockImplementation(((path: string, options?: { bigint?: boolean }) => {
        if (phase === 'foreign' && path === dbPath) {
          renameFileSync(dbPath, foreignPath);
          renameFileSync(originalPath, dbPath);
          phase = 'restored';
        }
        return options?.bigint === true ? lstat(path, { bigint: true }) : lstat(path);
      }) as Runtime['storage']['lstatSync']);

      const db = await openReset(runtime, dbPath);
      db.close();
      vi.restoreAllMocks();

      expect(phase === 'waiting' || phase === 'restored').toBe(true);
      expect(tableExists(dbPath, 'sentinel_replacement')).toBe(true);
      if (existsSync(foreignPath)) expect(tableExists(foreignPath, 'sentinel_before_reset')).toBe(true);
    });

    for (const parkingState of ['absent', 'unverified'] as const) {
      for (const ledgerWrite of ['written', 'rejected', 'thrown'] as const) {
        await runCell(`operator-release/${parkingState}/${ledgerWrite}`, async () => {
          const runtime = createRuntime();
          const dbPath = runtime.paths.coral.store.dbFile;
          createMismatchStore(dbPath);
          const settlement = await settleReset(runtime, dbPath);
          settlement.db.close();
          const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
          const [incidentId] = retainedIncidentNames(quarantineRoot);
          if (incidentId === undefined) throw new Error('Expected a retained incident for operator release.');
          if (parkingState === 'unverified') {
            const parkingPath = join(quarantineRoot, '.parked', incidentId);
            mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
            writeFileSync(join(parkingPath, 'store.db-wal'), 'unverified release evidence');
            writeFileSync(join(parkingPath, STORE_RESET_PARKED_SIDECAR_FILE_NAME), '{');
          }
          const ledgerPath = join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME);
          const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
          vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, data, options) => {
            if (path !== ledgerPath || ledgerWrite === 'written') {
              return writeAtomicDurableSync(path, data, options);
            }
            if (ledgerWrite === 'thrown') throw errno('EIO');
            return false;
          });

          const result = await releaseStoreReset({ target: 'gen2', runtime, incidentId });
          const rendered = formatStoreResetRelease(result);
          if (ledgerWrite === 'written') {
            expect(result.kind).toBe(parkingState === 'absent' ? 'released' : 'released-with-unverified-parking');
            expect(rendered).toMatch(/^Released /u);
            expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toBeNull();
          } else {
            expect(result).toMatchObject({ kind: 'partially-released' });
            expect(rendered).toMatch(/^Partially released /u);
            expect(rendered).toContain('retry this release command');
            expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved?.incidentId).toBe(
              incidentId,
            );
          }
        });
      }
    }

    await runCell('operator-release/fixed-coordinate-and-extra-tree', () => {
      const runtime = createRuntime();
      const root = makeTempRoot('coral-store-revision8-release-');
      const quarantineRoot = join(root, 'store-reset-quarantine');
      const parkingRoot = join(quarantineRoot, '.parked');
      const coordinate = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
      const nested = join(coordinate, 'extra', 'nested');
      mkdirSync(nested, { recursive: true, mode: 0o700 });
      writeFileSync(join(nested, 'evidence.bin'), 'nested-evidence');

      const listed = listStoreResetIncidents({
        fs: createStoreResetInspectionFs(),
        quarantineRoot,
        expectedBuild: buildIdentity(),
      });
      expect(listed.incidents).toContainEqual(
        expect.objectContaining({
          incidentId: STORE_RESET_IN_FLIGHT_DIRECTORY,
          parkingEvidenceBytes: Buffer.byteLength('nested-evidence'),
          retention: {
            slot: 'unknown',
            parked: expect.arrayContaining([
              { name: 'extra', kind: 'directory', sizeBytes: null },
              { name: join('extra', 'nested'), kind: 'directory', sizeBytes: null },
              {
                name: join('extra', 'nested', 'evidence.bin'),
                kind: 'regular-file',
                sizeBytes: Buffer.byteLength('nested-evidence'),
              },
            ]),
          },
        }),
      );
      expect(releaseStoreResetIncident(runtime.storage, quarantineRoot, STORE_RESET_IN_FLIGHT_DIRECTORY)).toMatchObject(
        {
          kind: 'undeterminable',
        },
      );
      expect(existsSync(coordinate)).toBe(true);
    });

    expect(failures, `${failures.length} extended sweep cells failed`).toEqual([]);
  });

  it('finishes a torn copy publication when an active name disappears before parking', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-copy-active-absent-');
    const dbPath = join(root, 'store.db');
    createMismatchStore(dbPath);
    const renameSync = runtime.storage.renameSync;
    let removed = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      if (source === dbPath && !removed) {
        removed = true;
        rmSync(dbPath);
      }
      renameSync(source, destination);
    });

    expect(
      publishReset(runtime, dbPath, {
        kind: 'unproven',
        reason: 'writer-live',
        blockers: 'fixture writer',
      }),
    ).toMatchObject({
      kind: 'preserved',
      preservation: { kind: 'copied', coherence: 'torn' },
    });
    expect(removed).toBe(true);
    const db = await openReset(runtime, dbPath);
    db.close();
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('commits staged evidence and reclassifies an unmatched active inode', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-active-unmatched-');
    const dbPath = join(root, 'store.db');
    const { quarantineRoot, stagingDirectory } = createInterruptedReset(runtime, dbPath);
    const stagedManifest = parseStoreResetIncidentManifest(readFileSync(join(stagingDirectory, 'reset-manifest.json')));
    createMismatchStore(dbPath, `sha256:${'1'.repeat(64)}`);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(existsSync(join(quarantineRoot, stagedManifest.incidentId))).toBe(false);
    expect(retainedIncidentNames(quarantineRoot)).toHaveLength(1);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('resets a missing-fingerprint store on cold start without handoff authority', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-cold-missing-fingerprint-'), 'store.db');
    createMissingFingerprintStore(dbPath);
    const authority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: false },
      {
        path: dbPath,
        namespace: NAMESPACE,
        storeFormat: STORE_FORMAT,
        build: buildIdentity(),
      },
    );

    const db = await openReset(runtime, dbPath, writerExclusion(), { authority });
    db.close();

    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    expect(retainedManifest(dbPath).resetPolicyCause).toBe('corrupt-or-unsupported');
  });

  it('resets mismatched stores with one retained-incident audit warning', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-mismatch-warning-'), 'store.db');
    createMismatchStore(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(retainedManifest(dbPath).resetPolicyCause).toBe('corrupt-or-unsupported');
  });

  it('retains WAL and SHM siblings inside the automatic reset incident', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-wal-shm-'), 'store.db');
    createMismatchStore(dbPath);
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    writeFileSync(walPath, 'dummy wal', 'utf-8');
    writeFileSync(shmPath, 'dummy shm', 'utf-8');

    const db = await openReset(runtime, dbPath);
    db.close();

    const manifest = retainedManifest(dbPath);
    const incidentPath = join(dirname(dbPath), 'store-reset-quarantine', manifest.incidentId);
    expect(readFileSync(join(incidentPath, 'store.db-wal'), 'utf-8')).toBe('dummy wal');
    const retainedShm = readFileSync(join(incidentPath, 'store.db-shm'));
    expect(retainedShm.length).toBeGreaterThan(0);
    expect(manifest.files.find((file) => file.name === 'store.db-shm')?.sha256).toBe(sha256(retainedShm));
    expect(readFileSync(walPath, 'utf-8')).not.toBe('dummy wal');
    expect(readFileSync(shmPath, 'utf-8')).not.toBe('dummy shm');
    expect(tableExists(dbPath, 'sentinel_before_reset')).toBe(false);
  });

  it.each(['absent', 'compatible'] as const)(
    'opens an %s store without taking a contended reset lock',
    async (kind) => {
      const runtime = createRuntime();
      const dbDir = makeTempRoot(`coral-store-${kind}-lock-contention-`);
      const dbPath = join(dbDir, 'store.db');
      if (kind === 'compatible') createCompatibleSentinelStore(runtime, dbPath);
      const lockDir = join(dbDir, 'store.db.reset.lock');
      mkdirSync(lockDir);

      const db = await openReset(runtime, dbPath);
      db.close();

      expect(existsSync(lockDir)).toBe(true);
      expect(tableExists(dbPath, 'events')).toBe(true);
    },
  );

  it('prevents two openers from publishing or resuming the same reset concurrently', async () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-reset-opener-contention-');
    const dbPath = join(dbDir, 'store.db');
    createVersionedStore(dbPath, `sha256:${'0'.repeat(64)}`, '0.0.0-rc.1');
    const renameSync = runtime.storage.renameSync;
    let contenderError: unknown = null;
    let contenderAttempted = false;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      if (source === dbPath && !contenderAttempted) {
        contenderAttempted = true;
        const files = resolveBackendStoreFileSet(runtime, { path: dbPath, storeFormat: STORE_FORMAT });
        contenderError = captureError(() => acquireBackendStoreResetLock(runtime, files, adoptionLease()));
      }
      renameSync(source, destination);
    });

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(contenderAttempted).toBe(true);
    expectSetupCode(contenderError, 'store_reset_lock_contended');
    expect(retainedIncidentNames(join(dbDir, 'store-reset-quarantine'))).toHaveLength(1);
    expect(tableExists(dbPath, 'events')).toBe(true);
  });

  it('removes a stale reset lock and acquires the reset lock successfully', async () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-stale-lock-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const lockDir = join(dbDir, 'store.db.reset.lock');
    mkdirSync(lockDir);
    const oldDate = new Date(Date.now() - 31_000);
    utimesSync(lockDir, oldDate, oldDate);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(readFormatFingerprint(dbPath)).toBe(STORE_FORMAT.fingerprint);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('quarantines a corrupt store file and boots fresh state', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-corrupt-reset-'), 'store.db');
    createCorruptStore(dbPath);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(retainedManifest(dbPath).resetPolicyCause).toBe('corrupt-or-unsupported');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched authority and does not unlink the existing DB', async () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-store-authority-mismatch-');
    const dbPath = join(dbDir, 'store.db');
    createMismatchStore(dbPath);
    const before = readFileSync(dbPath);

    const differentPath = join(dbDir, 'different-store.db');
    const staleAuthority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: true },
      {
        path: differentPath,
        namespace: NAMESPACE,
        storeFormat: STORE_FORMAT,
        build: buildIdentity(),
      },
    );

    const error = await captureAsyncError(() =>
      openReset(runtime, dbPath, writerExclusion(), { authority: staleAuthority }),
    );

    expectSetupCode(error, 'store_schema_outdated');
    expect(readFileSync(dbPath)).toEqual(before);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('rejects reset authority minted for a different store fingerprint without touching DB siblings', async () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-authority-format-mismatch-'), 'store.db');
    createMismatchStore(dbPath);
    writeFileSync(`${dbPath}-wal`, 'authority wal', 'utf-8');
    writeFileSync(`${dbPath}-shm`, 'authority shm', 'utf-8');
    writeFileSync(`${dbPath}.format`, 'sha256:authority-sidecar\n', 'utf-8');
    const before = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.format`].map((path) => readFileSync(path));
    const otherFormat = {
      ...STORE_FORMAT,
      fingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
    };
    const authority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: true },
      {
        path: dbPath,
        namespace: NAMESPACE,
        storeFormat: STORE_FORMAT,
        build: buildIdentity(),
      },
    );

    const error = await captureAsyncError(() =>
      openReset(runtime, dbPath, writerExclusion(), { authority, storeFormat: otherFormat }),
    );

    expectSetupCode(error, 'store_schema_outdated');
    const serialized = serializeCoralSetupError(error);
    expect(serialized?.context).toMatchObject({ mismatches: ['storeFormatFingerprint'] });
    for (const [index, path] of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.format`].entries()) {
      expect(readFileSync(path)).toEqual(before[index]);
    }
  });

  it('classifies, restores, opens, and identity-verifies a compatible interrupted claim', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-compatible-claim-resume-');
    const dbPath = join(root, 'store.db');
    const parkingId = '323e4567-e89b-42d3-a456-426614174000';
    const parkingRoot = join(root, 'store-reset-quarantine', '.parked');
    const parkingDirectory = join(parkingRoot, parkingId);
    mkdirSync(parkingDirectory, { recursive: true, mode: 0o700 });
    createCompatibleSentinelStore(runtime, join(parkingDirectory, 'store.db'));
    writeStoreResetParkedRecord(runtime.storage, parkingRoot, {
      version: 1,
      parkingId,
      parkedAt: '2026-09-13T00:00:00.000Z',
      phase: 'in-flight',
      cause: 'residual',
      incidentId: null,
      names: [],
      entries: [],
      transaction: { kind: 'claim', names: ['store.db', 'store.db-wal', 'store.db-shm', 'store.db.format'] },
      classification: null,
    });

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(tableExists(dbPath, 'sentinel_replacement')).toBe(true);
    expect(existsSync(join(parkingRoot, parkingId))).toBe(false);
    const second = await openReset(runtime, dbPath);
    second.close();
  });

  it('resumes the fixed in-flight transaction even when terminal parking discovery is truncated', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-fixed-claim-resume-');
    const dbPath = join(root, 'store.db');
    const parkingId = '323e4567-e89b-42d3-a456-426614174000';
    const parkingRoot = join(root, 'store-reset-quarantine', '.parked');
    const parkingDirectory = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
    mkdirSync(parkingDirectory, { recursive: true, mode: 0o700 });
    createCompatibleSentinelStore(runtime, join(parkingDirectory, 'store.db'));
    writeStoreResetParkedRecord(
      runtime.storage,
      parkingRoot,
      {
        version: 1,
        parkingId,
        parkedAt: '2026-09-13T00:00:00.000Z',
        phase: 'in-flight',
        cause: 'residual',
        incidentId: null,
        names: [],
        entries: [],
        transaction: { kind: 'claim', names: ['store.db', 'store.db-wal', 'store.db-shm', 'store.db.format'] },
        classification: null,
      },
      STORE_RESET_IN_FLIGHT_DIRECTORY,
    );
    const readDirectoryBoundedSync = runtime.storage.readDirectoryBoundedSync;
    vi.spyOn(runtime.storage, 'readDirectoryBoundedSync').mockImplementation((path, maxEntries) => {
      const result = readDirectoryBoundedSync(path, maxEntries);
      return path === parkingRoot ? { ...result, overflow: true } : result;
    });
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store_reset_parking_scan_truncated'));
    expect(existsSync(parkingDirectory)).toBe(false);
    expect(tableExists(dbPath, 'sentinel_replacement')).toBe(true);
  });

  it.each(['absent', 'malformed', 'unreadable'] as const)(
    'retires a fixed coordinate with an %s sidecar into releasable terminal evidence',
    async (sidecarState) => {
      const runtime = createRuntime();
      const root = makeTempRoot(`coral-store-fixed-retirement-${sidecarState}-`);
      const dbPath = join(root, 'store.db');
      createCompatibleSentinelStore(runtime, dbPath);
      seedPreExistingTerminalSurvivor(runtime, dbPath);
      const quarantineRoot = join(root, 'store-reset-quarantine');
      const parkingRoot = join(quarantineRoot, '.parked');
      const fixedDirectory = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
      mkdirSync(fixedDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(fixedDirectory, 'store.db-wal'), 'retired evidence');
      const sidecarPath = join(fixedDirectory, STORE_RESET_PARKED_SIDECAR_FILE_NAME);
      if (sidecarState !== 'absent') writeFileSync(sidecarPath, '{');
      if (sidecarState === 'unreadable') runtime.storage.chmodSync(sidecarPath, 0o000);

      const settlement = await settleReset(runtime, dbPath);
      settlement.db.close();

      expect(existsSync(fixedDirectory)).toBe(false);
      expectOneTerminalSurvivor(dbPath);
      expectReturnedSurvivorExists(dbPath, settlement.survivor);
      const parkingIds = readdirSync(parkingRoot).filter(isCanonicalStoreResetIncidentId);
      expect(parkingIds).toHaveLength(1);
      const parkingId = parkingIds[0];
      expect(readStoreResetParkedRecord(runtime.storage, parkingRoot, parkingId)).toMatchObject({
        parkingId,
        phase: 'terminal',
        cause: 'residual',
        names: ['store.db-wal'],
        entries: [{ name: 'store.db-wal', kind: 'regular-file', sizeBytes: Buffer.byteLength('retired evidence') }],
      });
      expect(releaseStoreResetIncident(runtime.storage, quarantineRoot, parkingId)).toMatchObject({
        kind: 'parked',
      });
      expect(existsSync(join(parkingRoot, parkingId))).toBe(false);
    },
  );

  it('retains a non-regular sibling when adopting a compatible claim and reports its parked epoch', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-compatible-claim-sibling-');
    const dbPath = join(root, 'store.db');
    seedPreExistingTerminalSurvivor(runtime, dbPath);
    createMismatchStore(dbPath);
    const linkSync = runtime.storage.linkSync;
    let injected = false;
    vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
      if (
        !injected &&
        destination === dbPath &&
        String(source).includes(`${join('store-reset-quarantine', '.minted')}`)
      ) {
        createCompatibleSentinelStore(runtime, dbPath);
        mkdirSync(`${dbPath}-shm`);
        injected = true;
      }
      linkSync(source, destination);
    });

    const result = await coordinateActiveStoreSelection(runtime, authorityFor(runtime, dbPath), {
      path: dbPath,
      storeFormat: STORE_FORMAT,
      currentSelection: activeSelection(dbPath),
      dependencies: {
        kind: 'startup',
        validateSelectedTarget: () => {
          throw new Error('The active-evidence fixture never selects a foreign target.');
        },
        acquireWriterExclusion: async () => writerExclusion(),
      },
    });
    if (result.kind !== 'opened') throw new Error('The active-evidence fixture unexpectedly handed off.');
    result.db.close();

    expect(injected).toBe(true);
    expect(result.epochs).toContainEqual(
      expect.objectContaining({ kind: 'parked', cause: 'residual', names: expect.arrayContaining(['store.db-shm']) }),
    );
    const parkingRoot = join(root, 'store-reset-quarantine', '.parked');
    const retained = readdirSync(parkingRoot)
      .filter(isCanonicalStoreResetIncidentId)
      .map((id) => readStoreResetParkedRecord(runtime.storage, parkingRoot, id))
      .find((record) => record?.names.includes('store.db-shm'));
    expect(retained).toMatchObject({
      phase: 'terminal',
      entries: expect.arrayContaining([expect.objectContaining({ name: 'store.db-shm', kind: 'directory' })]),
    });
    expectOneTerminalSurvivor(dbPath);
    expectReturnedSurvivorExists(dbPath, result.survivor);
    expect(tableExists(dbPath, 'sentinel_replacement')).toBe(true);
  });

  it('discovers a bounded interrupted minted store and moves it onto the operator surface', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-minted-resume-');
    const dbPath = join(root, 'store.db');
    seedPreExistingTerminalSurvivor(runtime, dbPath);
    const mintedId = '323e4567-e89b-42d3-a456-426614174000';
    const mintedRoot = join(root, 'store-reset-quarantine', '.minted');
    const mintedDirectory = join(mintedRoot, mintedId);
    mkdirSync(mintedDirectory, { recursive: true, mode: 0o700 });
    createCompatibleSentinelStore(runtime, join(mintedDirectory, 'store.db'));
    const interruptedBytes = readFileSync(join(mintedDirectory, 'store.db'));
    runtime.storage.linkSync(join(mintedDirectory, 'store.db'), dbPath);
    const readDirectoryBoundedSync = runtime.storage.readDirectoryBoundedSync;
    const observedBounds: number[] = [];
    vi.spyOn(runtime.storage, 'readDirectoryBoundedSync').mockImplementation((path, maxEntries) => {
      if (path === mintedRoot) observedBounds.push(maxEntries);
      return readDirectoryBoundedSync(path, maxEntries);
    });

    const settlement = await settleReset(runtime, dbPath);
    settlement.db.close();

    expect(observedBounds).toContain(MAX_INCIDENT_ROOT_ENTRIES + 1);
    expect(existsSync(mintedDirectory)).toBe(false);
    const parkingRoot = join(root, 'store-reset-quarantine', '.parked');
    const retained = readdirSync(parkingRoot)
      .filter(isCanonicalStoreResetIncidentId)
      .map((coordinate) => ({
        coordinate,
        record: readStoreResetParkedRecord(runtime.storage, parkingRoot, coordinate),
      }))
      .find((entry) => entry.record?.names.includes('store.db'));
    expect(retained?.record).toMatchObject({
      phase: 'terminal',
      cause: 'intruder',
      incidentId: null,
      names: expect.arrayContaining(['store.db']),
      classification: 'compatible',
    });
    expect(readFileSync(join(parkingRoot, retained?.coordinate ?? '', 'store.db'))).toEqual(interruptedBytes);
    expectOneTerminalSurvivor(dbPath);
    expectReturnedSurvivorExists(dbPath, settlement.survivor);
    expect(tableExists(dbPath, 'events')).toBe(true);
    expect(tableExists(dbPath, 'sentinel_replacement')).toBe(true);
  });

  it.each([STORE_RESET_MINTED_STORE_DIRECTORY, '323e4567-e89b-42d3-a456-426614174000'] as const)(
    'parks an over-limit interrupted minted store at %s and still boots',
    async (mintedId) => {
      const runtime = createRuntime();
      const root = makeTempRoot('coral-store-minted-overflow-');
      const dbPath = join(root, 'store.db');
      const quarantineRoot = join(root, 'store-reset-quarantine');
      const mintedRoot = join(quarantineRoot, '.minted');
      const mintedDirectory = join(mintedRoot, mintedId);
      mkdirSync(mintedDirectory, { recursive: true, mode: 0o700 });
      createCompatibleSentinelStore(runtime, join(mintedDirectory, 'store.db'));
      runtime.storage.linkSync(join(mintedDirectory, 'store.db'), dbPath);
      for (let index = 0; index <= MAX_INCIDENT_DIR_ENTRIES; index += 1) {
        writeFileSync(join(mintedDirectory, `extra-${index}`), 'minted evidence');
      }

      const db = await openReset(runtime, dbPath);
      db.close();

      expect(existsSync(mintedDirectory)).toBe(false);
      const parkingRoot = join(quarantineRoot, '.parked');
      const record = readdirSync(parkingRoot)
        .filter(isCanonicalStoreResetIncidentId)
        .map((parkingId) => readStoreResetParkedRecord(runtime.storage, parkingRoot, parkingId))
        .find((candidate) => candidate?.names.includes('store.db'));
      expect(record).toMatchObject({
        phase: 'terminal',
        cause: 'intruder',
        incidentId: null,
        names: expect.arrayContaining(['store.db']),
        classification: 'compatible',
      });
      expect(tableExists(dbPath, 'events')).toBe(true);
      expect(tableExists(dbPath, 'sentinel_replacement')).toBe(true);
    },
  );

  it('closes the claimed database and defers failed minted cleanup', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-claim-close-');
    const dbPath = join(root, 'store.db');
    const openWritableStoreDatabase = dbModule.openWritableStoreDatabase;
    const claimedDbs: DatabaseSync[] = [];
    vi.spyOn(dbModule, 'openWritableStoreDatabase').mockImplementation((options) => {
      const decision = openWritableStoreDatabase(options);
      if (decision.kind === 'opened') claimedDbs.push(decision.db as DatabaseSync);
      return decision;
    });
    const rmSync = runtime.storage.rmSync;
    vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
      if (String(path).includes(`${join('store-reset-quarantine', '.minted')}`)) {
        throw errno('EIO');
      }
      rmSync(path, options);
    });

    const db = await openReset(runtime, dbPath);
    db.close();

    expect(claimedDbs).not.toHaveLength(0);
    expect(claimedDbs.at(-1)?.isOpen).toBe(false);
  });

  it('closes a minted database when its post-open identity inspection fails', () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-minted-inspection-close-');
    const dbPath = join(root, 'store.db');
    const files = resolveBackendStoreFileSet(runtime, { path: dbPath, storeFormat: STORE_FORMAT });
    const openWritableStoreDatabase = dbModule.openWritableStoreDatabase;
    const openedDbs: DatabaseSync[] = [];
    vi.spyOn(dbModule, 'openWritableStoreDatabase').mockImplementation((options) => {
      const decision = openWritableStoreDatabase(options);
      if (decision.kind === 'opened') openedDbs.push(decision.db as DatabaseSync);
      return decision;
    });
    const lstatSync = runtime.storage.lstatSync;
    vi.spyOn(runtime.storage, 'lstatSync').mockImplementation(((path: string, options?: { bigint?: boolean }) => {
      if (path === join(root, 'store-reset-quarantine', '.minted', STORE_RESET_MINTED_STORE_DIRECTORY, 'store.db')) {
        throw errno('EIO');
      }
      return options?.bigint === true ? lstatSync(path, { bigint: true }) : lstatSync(path);
    }) as Runtime['storage']['lstatSync']);

    expect(() => mintBackendStoreForClaim(runtime, files, { path: dbPath, storeFormat: STORE_FORMAT })).toThrow();
    expect(openedDbs).toHaveLength(1);
    expect(openedDbs[0]?.isOpen).toBe(false);
  });

  it('reuses one fixed minted coordinate across successful store claims', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-fixed-minted-');
    const dbPath = join(root, 'store.db');
    const openWritableStoreDatabase = dbModule.openWritableStoreDatabase;
    const openedPaths: string[] = [];
    vi.spyOn(dbModule, 'openWritableStoreDatabase').mockImplementation((options) => {
      openedPaths.push(options.path);
      return openWritableStoreDatabase(options);
    });

    const first = await openReset(runtime, dbPath);
    first.close();
    const second = await openReset(runtime, dbPath);
    second.close();

    expect(openedPaths.filter((path) => path.includes(`${join('store-reset-quarantine', '.minted')}`))).toEqual([
      join(root, 'store-reset-quarantine', '.minted', STORE_RESET_MINTED_STORE_DIRECTORY, 'store.db'),
      join(root, 'store-reset-quarantine', '.minted', STORE_RESET_MINTED_STORE_DIRECTORY, 'store.db'),
    ]);
  });

  it('closes the claimed database when steady-state configuration fails', async () => {
    const runtime = createRuntime();
    const root = makeTempRoot('coral-store-steady-state-close-');
    const dbPath = join(root, 'store.db');
    createCompatibleSentinelStore(runtime, dbPath);
    const openWritableStoreDatabase = dbModule.openWritableStoreDatabase;
    const openedDbs: DatabaseSync[] = [];
    vi.spyOn(dbModule, 'openWritableStoreDatabase').mockImplementation((options) => {
      const decision = openWritableStoreDatabase(options);
      if (decision.kind === 'opened') {
        openedDbs.push(decision.db as DatabaseSync);
        const exec = decision.db.exec.bind(decision.db);
        vi.spyOn(decision.db, 'exec').mockImplementation((sql) => {
          if (sql.startsWith('PRAGMA busy_timeout =')) throw errno('EIO');
          exec(sql);
        });
      }
      return decision;
    });

    await captureAsyncError(() => openReset(runtime, dbPath));

    expect(openedDbs).not.toHaveLength(0);
    expect(openedDbs.at(-1)?.isOpen).toBe(false);
  });
});

describe('retainTransitionFileInStoreResetQuarantine', () => {
  function retain(runtime: Runtime, dbPath: string, sourcePath: string) {
    const files = resolveBackendStoreFileSet(runtime, { path: dbPath, storeFormat: STORE_FORMAT });
    return retainTransitionFileInStoreResetQuarantine(runtime, files, sourcePath, adoptionLease());
  }

  it('republishes over a truncated file left at the final evidence path instead of wedging', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-retained-transition-torn-');
    const dbPath = join(dbDir, 'store.db');
    const sourcePath = join(dbDir, 'active-store.transition.json');
    writeFileSync(sourcePath, 'complete transition record bytes', 'utf-8');
    const first = retain(runtime, dbPath, sourcePath);

    // A hard kill mid-copy under the old direct-to-final-path publication left exactly this:
    // a shorter file sitting at the path the complete evidence is supposed to occupy.
    writeFileSync(first.evidencePath, 'complete transi', 'utf-8');

    const healed = retain(runtime, dbPath, sourcePath);

    expect(healed.evidencePath).toBe(first.evidencePath);
    expect(healed.evidenceByteLength).toBe(first.evidenceByteLength);
    expect(healed.evidenceSha256).toBe(first.evidenceSha256);
    expect(readFileSync(first.evidencePath, 'utf-8')).toBe('complete transition record bytes');
    expect(readdirSync(dirname(first.evidencePath))).toEqual([basename(first.evidencePath)]);
  });

  it('refuses a retained transition whose source identity changed mid-verification', () => {
    const runtime = createRuntime();
    const dbDir = makeTempRoot('coral-retained-transition-mismatch-');
    const dbPath = join(dbDir, 'store.db');
    const sourcePath = join(dbDir, 'active-store.transition.json');
    writeFileSync(sourcePath, 'original transition record bytes', 'utf-8');
    const first = retain(runtime, dbPath, sourcePath);

    // stablePathStat runs four times while evidencePath already exists: the outer
    // sourceIdentity, describeCandidate's own pathBefore/pathAfter pair, and the outer
    // sourceAfter. Mutate only the last so describeCandidate's internal consistency checks
    // stay satisfied and the outer identity-stability check is the one that trips.
    const statSync = runtime.storage.statSync.bind(runtime.storage);
    let sourceStatCalls = 0;
    vi.spyOn(runtime.storage, 'statSync').mockImplementation((target, options) => {
      const result = statSync(target, options);
      if (target === sourcePath && options?.bigint === true) {
        sourceStatCalls += 1;
        if (sourceStatCalls === 4) {
          return {
            ...result,
            mtimeNs: (result as { mtimeNs: bigint }).mtimeNs + 1n,
            isDirectory: () => result.isDirectory(),
            isFile: () => result.isFile(),
          };
        }
      }
      return result;
    });

    expect(() => retain(runtime, dbPath, sourcePath)).toThrow(/changed identity/);
    expect(readFileSync(first.evidencePath, 'utf-8')).toBe('original transition record bytes');
  });
});

// Distinct from the reset-authority cases above: these callers have no mutation
// capability and must refuse without creating or quarantining any store files.
describe('read-only store access', () => {
  it('surfaces a typed absent-store error without creating the parent or database', () => {
    const runtime = createRuntime();
    const parent = join(makeTempRoot('coral-store-readonly-absent-'), 'missing-parent');
    const dbPath = join(parent, 'store.db');

    const portError = captureError(() =>
      openReadOnlyStoreDatabase(runtime, { storeFormat: STORE_FORMAT, path: dbPath }),
    );
    const sharedError = captureError(() =>
      openStoreDatabase({
        path: dbPath,
        storage: runtime.storage,
        storeFormat: STORE_FORMAT,
        readonly: true,
      }),
    );

    expectSetupCode(portError, 'store_not_initialized');
    expectSetupCode(sharedError, 'store_not_initialized');
    expect(serializeCoralSetupError(portError)?.context).toMatchObject({ path: dbPath });
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('throws store_schema_outdated for missing-fingerprint and mismatched stores without changing the file', () => {
    const runtime = createRuntime();
    const missingPath = join(makeTempRoot('coral-store-readonly-missing-fingerprint-'), 'store.db');
    const mismatchPath = join(makeTempRoot('coral-store-readonly-mismatch-'), 'store.db');
    createMissingFingerprintStore(missingPath);
    createMismatchStore(mismatchPath);
    const missingBefore = readFileSync(missingPath);
    const mismatchBefore = readFileSync(mismatchPath);

    const missingError = captureError(() =>
      openReadOnlyStoreDatabase(runtime, { storeFormat: STORE_FORMAT, path: missingPath }),
    );
    const mismatchError = captureError(() =>
      openReadOnlyStoreDatabase(runtime, { storeFormat: STORE_FORMAT, path: mismatchPath }),
    );

    expectSetupCode(missingError, 'store_schema_outdated');
    expectSetupCode(mismatchError, 'store_schema_outdated');
    expect(readFileSync(missingPath)).toEqual(missingBefore);
    expect(readFileSync(mismatchPath)).toEqual(mismatchBefore);
  });

  it('reports the stored version and flavor through the production store_schema_outdated caller', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-readonly-versioned-mismatch-'), 'store.db');
    createVersionedStore(dbPath, `sha256:${'0'.repeat(64)}`, '0.9.16');

    const error = captureError(() => openReadOnlyStoreDatabase(runtime, { storeFormat: STORE_FORMAT, path: dbPath }));

    expect(serializeCoralSetupError(error)).toMatchObject({
      code: 'store_schema_outdated',
      context: { version: '0.9.16', flavor: runtime.flavor },
      remediation: expect.stringContaining(
        `Use Coral 0.9.16 to read this store, or deliberately destroy its history by running 'coral-cli backend store-reset discard --target gen2 --flavor ${runtime.flavor}'`,
      ),
    });
  });

  it('uses the bundled expansion catalog for an empty home', () => {
    const home = makeTempRoot('coral-expansion-catalog-empty-home-');

    expect(withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () => readDefaultExpansionCatalog())).toEqual(
      BUNDLED_ENGINES,
    );
  });

  it('constructs a query runtime without consulting an incompatible store', () => {
    const runtime = createRuntime();
    createMismatchStore(runtime.paths.coral.store.dbFile);
    const before = readFileSync(runtime.paths.coral.store.dbFile);

    expect(() => createDefaultKbQueryRuntime({ pluginRoot: REPO_ROOT, runtime })).not.toThrow();
    expect(readFileSync(runtime.paths.coral.store.dbFile)).toEqual(before);
  });

  describe('does not mask store_schema_outdated in store-backed read-only callers', () => {
    function makeMismatchHome() {
      const home = makeTempRoot('coral-store-readonly-callers-home-');
      const runtime = createRuntime(home);
      createMismatchStore(runtime.paths.coral.store.dbFile);
      return { home, runtime };
    }

    it('openReadCoralStore', () => {
      const { home, runtime } = makeMismatchHome();
      expectSetupCode(
        withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () =>
          captureError(() => openReadCoralStore(runtime.paths.projectSource('/tmp/project'))),
        ),
        'store_schema_outdated',
      );
    });

    it('readExpansionCatalog', () => {
      const { runtime } = makeMismatchHome();
      expectSetupCode(
        captureError(() => readExpansionCatalog(runtime)),
        'store_schema_outdated',
      );
    });

    it('readDefaultExpansionCatalog', () => {
      const { home } = makeMismatchHome();
      expectSetupCode(
        withEnv({ HOME: home, CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () => captureError(() => readDefaultExpansionCatalog())),
        'store_schema_outdated',
      );
    });

    it('createExpansionManifestCatalog (manifest catalog read)', () => {
      expectSetupCode(
        captureError(() =>
          createExpansionManifestCatalog({
            readDb: {
              prepare() {
                throw documentedCoralSetupError('store_schema_outdated');
              },
            },
          }),
        ),
        'store_schema_outdated',
      );
    });
  });
});

// Distinct from both reset-authority and read-only access: this surface may
// write a compatible store, but it can neither initialize nor reset one.
describe('openWritableStoreDbNoReset', () => {
  it('requires an existing store and opens a current store for catalog writers', () => {
    const runtime = createRuntime();
    const parent = join(makeTempRoot('coral-store-no-reset-current-'), 'missing-parent');
    const dbPath = join(parent, 'store.db');

    const absentError = captureError(() =>
      openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: dbPath }),
    );
    // An absent store is not an outdated one — store_schema_outdated's remediation
    // offers to discard history, which is meaningless and misleading here.
    expectSetupCode(absentError, 'store_not_initialized');
    expect(serializeCoralSetupError(absentError)?.context).toMatchObject({ path: dbPath });
    expect(existsSync(parent)).toBe(false);

    createCurrentStore(runtime, dbPath);
    const marker = readFormatFingerprint(dbPath);
    const current = openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: dbPath });
    current.close();

    expect(marker).toBe(STORE_FORMAT.fingerprint);
    expect(readFormatFingerprint(dbPath)).toBe(marker);
  });

  it('never unlinks missing-fingerprint or mismatched stores and surfaces store_schema_outdated', () => {
    const runtime = createRuntime();
    const missingPath = join(makeTempRoot('coral-store-no-reset-missing-fingerprint-'), 'store.db');
    const mismatchPath = join(makeTempRoot('coral-store-no-reset-mismatch-'), 'store.db');
    createMissingFingerprintStore(missingPath);
    createMismatchStore(mismatchPath);

    expectSetupCode(
      captureError(() => openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: missingPath })),
      'store_schema_outdated',
    );
    expectSetupCode(
      captureError(() => openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: mismatchPath })),
      'store_schema_outdated',
    );

    expect(readFormatFingerprint(missingPath)).toBeNull();
    expect(tableExists(mismatchPath, 'sentinel_before_reset')).toBe(true);
  });

  it('never unlinks corrupt stores and surfaces the original setup failure', () => {
    const runtime = createRuntime();
    const dbPath = join(makeTempRoot('coral-store-no-reset-corrupt-'), 'store.db');
    createCorruptStore(dbPath);
    const before = readFileSync(dbPath, 'utf-8');

    const error = captureError(() => openWritableStoreDbNoReset(runtime, { storeFormat: STORE_FORMAT, path: dbPath }));

    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(dbPath, 'utf-8')).toBe(before);
  });
});

describe('KbQueryRegistry', () => {
  it('reuses runtime-owned read-only DB handles until the registry is closed', () => {
    const runtime = createRuntime();
    createCurrentStore(runtime);

    const registry = new KbQueryRegistry();
    try {
      const first = registry.getRuntimeDb(runtime);
      const second = registry.getRuntimeDb(runtime);

      expect(second).toBe(first);
    } finally {
      registry.close();
    }
  });

  it('constructs a query-only runtime without creating the KB runtime target', () => {
    const runtime = createRuntime();
    createCurrentStore(runtime);
    const kbRuntimeRoot = runtime.paths.coral.kbRuntime.root;
    expect(existsSync(kbRuntimeRoot)).toBe(false);

    const mkdir = vi.spyOn(runtime.storage, 'mkdirSync');
    const remove = vi.spyOn(runtime.storage, 'rmSync');
    const rename = vi.spyOn(runtime.storage, 'renameSync');
    const write = vi.spyOn(runtime.storage, 'writeFileSync');

    createDefaultKbQueryRuntime({ pluginRoot: REPO_ROOT, runtime });

    expect(mkdir).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(kbRuntimeRoot)).toBe(false);
  });

  it('leaves malformed staged projection evidence byte-identical during query construction', () => {
    const runtime = createRuntime();
    createCurrentStore(runtime);
    const commitRecord = join(
      runtime.paths.coral.kbRuntime.root,
      'corpus-projection',
      'commits',
      'malformed',
      'commit.json',
    );
    mkdirSync(dirname(commitRecord), { recursive: true });
    writeFileSync(commitRecord, '{malformed', 'utf-8');
    const before = readFileSync(commitRecord);

    createDefaultKbQueryRuntime({ pluginRoot: REPO_ROOT, runtime });

    expect(readFileSync(commitRecord)).toEqual(before);
  });
});
