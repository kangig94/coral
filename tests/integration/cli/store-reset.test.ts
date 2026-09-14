import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBackendCommands, type StoreResetCommandOperations } from '#src/cli/commands/backend.js';
import { StoreResetCliError } from '#src/cli/errors.js';
import { formatStoreResetRelease, formatStoreResetReport } from '#src/cli/format/store-reset.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-routing/runner.js';
import {
  listStoreResetIncidentsLocal,
  releaseStoreResetLocal,
  reportStoreResetIncidentLocal,
  type StoreResetCliDependencies,
} from '#src/cli/store-reset.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import type { ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import { socketPathForRunDir } from '#src/infra/path/coordinator.js';
import { createStoreResetInspectionFs } from '#src/infra/store-reset-inspection-fs.js';
import { createKbDaemonWriteRuntimeHost } from '#src/kb-daemon/runtime-host.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import { resolveActiveStoreRecordPaths } from '#src/store/active-store-selection.js';
import { classifyStoreFile } from '#src/store/db.js';
import { createSettlementAuthority } from '#src/store/backend-store-reset.js';
import { generationMutationCoordinationSeam } from '#src/store/generation-mutation-coordination.js';
import { discardStoreReset, releaseStoreReset, resolveStoreResetTargetPaths } from '#src/store/operator-store-reset.js';
import {
  projectStoreResetPublicReport,
  isCanonicalStoreResetIncidentId,
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  STORE_RESET_IN_FLIGHT_DIRECTORY,
  type StoreResetIncidentLocalReport,
  type StoreResetIncidentManifestV2,
  type StoreResetIncidentManifestV3,
} from '#src/store/reset-incident.js';
import {
  MAX_RESET_PARKED_SIDECAR_BYTES,
  MAX_RESET_RETENTION_LEDGER_BYTES,
  readStoreResetRetentionLedger,
  recordStoreResetPending,
  STORE_RESET_PARKED_SIDECAR_VERSION,
  STORE_RESET_RETENTION_LEDGER_FILE_NAME,
  writeStoreResetParkedRecord,
} from '#src/store/reset-retention.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';

const mockState = vi.hoisted(() => ({
  runHandoff: vi.fn(),
}));

vi.mock('#src/coordinator/handoff-routing/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

const BUILD: StrictBundleManifest = {
  version: '0.9.16',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  durableWrapperBundleHash: '3456789abcdef012',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'f'.repeat(64)}`,
};
const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const PUBLICATION_INVOCATION_ID = '323e4567-e89b-42d3-a456-426614174000';
const STORE_FORMAT = currentCoralStoreFormat();
const CURRENT_BUILD: StrictBundleManifest = {
  ...BUILD,
  version: STORE_FORMAT.productVersion,
  storeFormatFingerprint: STORE_FORMAT.fingerprint,
};
const roots: string[] = [];
let stdout = '';
let stderr = '';

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'coral-store-reset-cli-'));
  roots.push(value);
  return value;
}

function fixtureHeld(storage: StoragePort) {
  return createSettlementAuthority(
    storage,
    { maintain: () => undefined, assertOwned: () => undefined },
    undefined,
    null,
  );
}

function writeTerminalParkingSidecar(
  runtime: ReturnType<typeof createRealRuntime>,
  parkingRoot: string,
  incidentId: string,
): void {
  const parkingPath = join(parkingRoot, incidentId);
  const parkedWal = join(parkingPath, 'store.db-wal');
  writeStoreResetParkedRecord(
    runtime.storage,
    parkingRoot,
    {
      version: STORE_RESET_PARKED_SIDECAR_VERSION,
      parkingId: incidentId,
      parkedAt: '2026-09-13T00:00:00.000Z',
      phase: 'terminal',
      cause: 'intruder',
      incidentId,
      names: ['store.db-wal'],
      entries: [{ name: 'store.db-wal', kind: 'regular-file', sizeBytes: statSync(parkedWal).size }],
      transaction: null,
      classification: null,
    },
    fixtureHeld(runtime.storage),
  );
}

function dependencies(quarantineRoot: string): StoreResetCliDependencies {
  return {
    resolveIdentity: () => ({ ok: true, manifest: BUILD }),
    createInspectionFs: createStoreResetInspectionFs,
    createDiagnosticRunner: () => async () => ({
      integrity: 'unavailable',
      termination: 'not_started',
      cleanup: 'not_required',
    }),
    quarantineRoot: () => quarantineRoot,
  };
}

function incidentManifest(): StoreResetIncidentManifestV3 {
  return {
    schemaVersion: 3,
    incidentId: INCIDENT_ID,
    resetAt: '2026-07-23T01:02:03.004Z',
    reason: 'mismatch',
    storedFingerprint: `sha256:${'a'.repeat(64)}`,
    expectedFingerprint: BUILD.storeFormatFingerprint,
    resetPolicyCause: 'older-incompatible',
    resetPolicyEvidence: null,
    target: { storeDbPath: '/coral/store.db', flavor: BUILD.flavor },
    build: {
      version: BUILD.version,
      buildSetId: BUILD.buildSetId,
      backendBundleHash: BUILD.bundleHash,
      flavor: BUILD.flavor,
    },
    runtime: {
      namespace: 'unit',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      processId: process.pid,
    },
    handoff: { acquiredViaHandoff: false },
    files: [],
  };
}

function newerTargetIncidentManifest(): StoreResetIncidentManifestV3 {
  return {
    ...incidentManifest(),
    resetPolicyCause: 'newer-incompatible-invalid-target',
    resetPolicyEvidence: {
      validationFailure: { code: 'target_hash_mismatch' },
      observedTarget: {
        version: '99.0.0',
        buildSetId: '323e4567-e89b-42d3-a456-426614174000',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
        storeFormatFingerprint: `sha256:${'e'.repeat(64)}`,
      },
    },
  };
}

function manifestWithPlaceholderEvidence(manifest: StoreResetIncidentManifestV3): StoreResetIncidentManifestV3 {
  return {
    ...manifest,
    files: [
      {
        name: 'store.db',
        sizeBytes: 1,
        mtimeMs: 1_754_000_000_000,
        sha256: 'a'.repeat(64),
      },
    ],
  };
}

function publicReport(manifest = incidentManifest()) {
  const local: StoreResetIncidentLocalReport = {
    manifest,
    fileVerification: [],
    diagnostic: {
      integrity: 'unavailable',
      termination: 'not_started',
      cleanup: 'not_required',
    },
  };
  return projectStoreResetPublicReport(local);
}

function createMismatchStore(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'store_format_fingerprint',
      `sha256:${'0'.repeat(64)}`,
    );
    db.exec('CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY)');
  } finally {
    db.close();
  }
}

function snapshotTree(rootPath: string): { readonly paths: readonly string[]; readonly sha256: string } {
  const hash = createHash('sha256');
  const paths: string[] = [];

  const visit = (path: string): void => {
    const relativePath = relative(rootPath, path) || '.';
    const stat = lstatSync(path, { bigint: true });
    let kind = 'unknown';
    if (stat.isDirectory()) kind = 'directory';
    else if (stat.isFile()) kind = 'file';
    else if (stat.isSymbolicLink()) kind = 'symlink';
    else if (stat.isSocket()) kind = 'socket';
    else if (stat.isFIFO()) kind = 'fifo';
    else if (stat.isBlockDevice()) kind = 'block-device';
    else if (stat.isCharacterDevice()) kind = 'character-device';

    paths.push(relativePath);
    hash.update(`${relativePath}\0${kind}\0${stat.mode}\0${stat.ino}\0${stat.size}\0${stat.mtimeNs}\0`);

    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort((left, right) => left.localeCompare(right))) {
        visit(join(path, name));
      }
    } else if (stat.isFile()) {
      hash.update(readFileSync(path));
    } else if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(path));
    }
  };

  visit(rootPath);
  return { paths, sha256: hash.digest('hex') };
}

function storeTableExists(path: string, table: string): boolean {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== undefined;
  } finally {
    db.close();
  }
}

function noSocketGuard() {
  return Promise.resolve({ release: () => Promise.resolve() });
}

const operationsDiscard: StoreResetCommandOperations['discard'] = async () => ({
  kind: 'discarded',
  target: 'gen2',
  flavor: 'prod',
  baseDir: '/coral',
  storeDbPath: '/coral/gen2/data/store/store.db',
  incident: null,
  resumed: false,
  resumedIncident: null,
  epochs: [{ kind: 'claimed' }],
});
const operationsRelease: StoreResetCommandOperations['release'] = async (_target, flavor, incidentId) => ({
  kind: 'absent',
  target: 'gen2',
  flavor,
  incidentId,
});
async function runCommand(args: readonly string[], operations: StoreResetCommandOperations): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBackendCommands(program, { storeReset: operations });
  await program.parseAsync(['node', 'coral-cli', ...args]);
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  mockState.runHandoff.mockReset();
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('local store-reset operations', () => {
  it.each(['prod', 'dev'] as const)('uses one socket path rule for %s generated and legacy roots', (flavor) => {
    const baseDir = join(tmpdir(), 'coral-store-reset-socket-path', 'a'.repeat(110));
    const runtime = createRealRuntime(flavor, { baseDir });
    const socketEnvironment = { platform: runtime.env.platform() };
    const generated = runtime.paths.coral.coordinator;
    const legacy = resolveStoreResetTargetPaths(runtime, 'legacy');
    const legacyRunDir = join(baseDir, basename(generated.runDir));

    expect(generated.socketPath).toBe(socketPathForRunDir(generated.runDir, flavor, socketEnvironment));
    expect(legacy.socketPath).toBe(socketPathForRunDir(legacyRunDir, flavor, socketEnvironment));
  });

  it('lists a missing quarantine root as an empty local success', () => {
    const base = root();
    const createDiagnosticRunner = vi.fn(dependencies(base).createDiagnosticRunner);
    const result = listStoreResetIncidentsLocal('gen2', {
      ...dependencies(join(base, 'missing')),
      createDiagnosticRunner,
    });

    expect(result).toEqual({ incidents: [], truncated: false, parkingRootState: 'absent' });
    expect(createDiagnosticRunner).not.toHaveBeenCalled();
  });

  it('validates the incident ID before build identity or filesystem access', async () => {
    const resolveIdentity = vi.fn(() => ({ ok: true as const, manifest: BUILD }));
    await expect(
      reportStoreResetIncidentLocal('gen2', '../PRIVATE_SENTINEL', {
        ...dependencies(root()),
        resolveIdentity,
      }),
    ).rejects.toMatchObject({ code: 'invalid_store_reset_incident_id' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('maps missing reports and mixed build identity to closed errors', async () => {
    await expect(
      reportStoreResetIncidentLocal('gen2', INCIDENT_ID, dependencies(join(root(), 'missing'))),
    ).rejects.toMatchObject({ code: 'store_reset_incident_not_found' });
    await expect(
      reportStoreResetIncidentLocal('gen2', INCIDENT_ID, {
        ...dependencies(root()),
        resolveIdentity: () => ({ ok: false }),
      }),
    ).rejects.toMatchObject({ code: 'store_reset_build_mismatch' });

    const quarantineRoot = root();
    const incidentPath = join(quarantineRoot, INCIDENT_ID);
    mkdirSync(incidentPath);
    const report = publicReport();
    const mismatchedManifest: StoreResetIncidentManifestV2 = {
      schemaVersion: 2,
      incidentId: report.incidentId,
      resetAt: report.resetAt,
      reason: report.reason,
      storedFingerprint: report.storedFingerprint,
      expectedFingerprint: report.expectedFingerprint,
      build: {
        version: report.build.version,
        buildSetId: '323e4567-e89b-42d3-a456-426614174000',
        backendBundleHash: report.build.backendBundleHash,
        flavor: report.build.flavor,
      },
      runtime: {
        namespace: 'unit',
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        processId: process.pid,
      },
      handoff: report.handoff,
      files: [
        {
          name: 'store.db',
          sizeBytes: 1,
          mtimeMs: 1_754_000_000_000,
          sha256: 'a'.repeat(64),
        },
      ],
    };
    writeFileSync(join(incidentPath, 'reset-manifest.json'), serializeStoreResetIncidentManifest(mismatchedManifest));
    await expect(
      reportStoreResetIncidentLocal('gen2', INCIDENT_ID, dependencies(quarantineRoot)),
    ).rejects.toMatchObject({
      code: 'store_reset_incident_build_mismatch',
    });
  });

  it('rejects unknown V3 manifest fields while leaving the incident visible', async () => {
    const quarantineRoot = root();
    const incidentPath = join(quarantineRoot, INCIDENT_ID);
    mkdirSync(incidentPath);
    const evidencePath = join(incidentPath, 'store.db');
    writeFileSync(evidencePath, 'strict V3 evidence');
    const evidence = readFileSync(evidencePath);
    const evidenceStat = statSync(evidencePath);
    const manifest: StoreResetIncidentManifestV3 = {
      ...incidentManifest(),
      files: [
        {
          name: 'store.db',
          sizeBytes: evidence.length,
          mtimeMs: evidenceStat.mtimeMs,
          sha256: createHash('sha256').update(evidence).digest('hex'),
        },
      ],
    };
    const encoded = JSON.parse(serializeStoreResetIncidentManifest(manifest)) as Record<string, unknown>;
    encoded.unvalidatedExecutablePath = '/private/target';
    writeFileSync(join(incidentPath, 'reset-manifest.json'), JSON.stringify(encoded));

    expect(listStoreResetIncidentsLocal('gen2', dependencies(quarantineRoot)).incidents).toEqual([
      {
        incidentId: INCIDENT_ID,
        state: 'unsupported',
        resetAt: null,
        reason: null,
        schemaVersion: null,
        resetPolicyCause: null,
        fileCount: null,
        evidenceBytes: evidence.length,
        parkingEvidenceBytes: 0,
        retention: { slot: 'unknown' },
        storedProductVersion: 'unknown',
      },
    ]);
    await expect(
      reportStoreResetIncidentLocal('gen2', INCIDENT_ID, dependencies(quarantineRoot)),
    ).rejects.toMatchObject({ code: 'store_reset_reporting_failed' });
    expect(readFileSync(join(incidentPath, 'reset-manifest.json'), 'utf-8')).toContain('/private/target');
  });

  it.each([
    {
      label: 'older cause with newer-target evidence',
      mutate: (manifest: Record<string, unknown>) => {
        manifest.resetPolicyEvidence = newerTargetIncidentManifest().resetPolicyEvidence;
      },
    },
    {
      label: 'corrupt cause with newer-target evidence',
      mutate: (manifest: Record<string, unknown>) => {
        manifest.resetPolicyCause = 'corrupt-or-unsupported';
        manifest.resetPolicyEvidence = newerTargetIncidentManifest().resetPolicyEvidence;
      },
    },
    {
      label: 'newer-target cause without evidence',
      mutate: (manifest: Record<string, unknown>) => {
        manifest.resetPolicyCause = 'newer-incompatible-invalid-target';
      },
    },
    {
      label: 'newer-target cause without a mismatched stored fingerprint',
      mutate: (manifest: Record<string, unknown>) => {
        manifest.resetPolicyCause = 'newer-incompatible-invalid-target';
        manifest.resetPolicyEvidence = newerTargetIncidentManifest().resetPolicyEvidence;
        manifest.reason = 'missing';
        manifest.storedFingerprint = null;
      },
    },
  ])('rejects a V3 $label pair while preserving it for an operator', ({ mutate }) => {
    const quarantineRoot = root();
    const incidentPath = join(quarantineRoot, INCIDENT_ID);
    mkdirSync(incidentPath);
    const encoded = JSON.parse(
      serializeStoreResetIncidentManifest(manifestWithPlaceholderEvidence(incidentManifest())),
    ) as Record<string, unknown>;
    mutate(encoded);
    const manifestPath = join(incidentPath, 'reset-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(encoded));

    expect(listStoreResetIncidentsLocal('gen2', dependencies(quarantineRoot)).incidents).toMatchObject([
      { incidentId: INCIDENT_ID, state: 'unsupported' },
    ]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it('reads bounded newer-target evidence without projecting the target path', async () => {
    const quarantineRoot = root();
    const incidentPath = join(quarantineRoot, INCIDENT_ID);
    mkdirSync(incidentPath);
    writeFileSync(
      join(incidentPath, 'reset-manifest.json'),
      serializeStoreResetIncidentManifest(manifestWithPlaceholderEvidence(newerTargetIncidentManifest())),
    );

    const report = await reportStoreResetIncidentLocal('gen2', INCIDENT_ID, dependencies(quarantineRoot));

    expect(report.resetPolicyCause).toBe('newer-incompatible-invalid-target');
    expect(report.resetPolicyEvidence).toEqual(newerTargetIncidentManifest().resetPolicyEvidence);
    expect(report).not.toHaveProperty('target');
    expect(formatStoreResetReport(report)).toContain('- Validation failure: `target_hash_mismatch`');
    expect(formatStoreResetReport(report)).not.toContain('/coral/store.db');
  });

  it('resolves pre-boundary incidents only for an explicit legacy target', async () => {
    const base = root();
    const runtime = createRealRuntime('prod', { baseDir: base });
    const legacyRoot = resolveStoreResetTargetPaths(runtime, 'legacy').quarantineRoot;
    const incidentPath = join(legacyRoot, INCIDENT_ID);
    mkdirSync(incidentPath, { recursive: true });
    const evidencePath = join(incidentPath, 'store.db');
    writeFileSync(evidencePath, 'pre-boundary evidence');
    const evidence = readFileSync(evidencePath);
    const evidenceStat = statSync(evidencePath);
    const current = incidentManifest();
    const legacyManifest: StoreResetIncidentManifestV2 = {
      schemaVersion: 2,
      incidentId: current.incidentId,
      resetAt: current.resetAt,
      reason: current.reason,
      storedFingerprint: current.storedFingerprint,
      expectedFingerprint: current.expectedFingerprint,
      build: current.build,
      runtime: current.runtime,
      handoff: current.handoff,
      files: [
        {
          name: 'store.db',
          sizeBytes: evidence.length,
          mtimeMs: evidenceStat.mtimeMs,
          sha256: createHash('sha256').update(evidence).digest('hex'),
        },
      ],
    };
    writeFileSync(join(incidentPath, 'reset-manifest.json'), serializeStoreResetIncidentManifest(legacyManifest));
    const targetedDependencies: StoreResetCliDependencies = {
      ...dependencies(legacyRoot),
      quarantineRoot: (_manifest, target) => resolveStoreResetTargetPaths(runtime, target).quarantineRoot,
    };

    expect(listStoreResetIncidentsLocal('legacy', targetedDependencies).incidents).toMatchObject([
      { incidentId: INCIDENT_ID, state: 'ready', schemaVersion: 2, resetPolicyCause: null },
    ]);
    expect(listStoreResetIncidentsLocal('gen2', targetedDependencies)).toEqual({
      incidents: [],
      truncated: false,
      parkingRootState: 'absent',
    });
    await expect(reportStoreResetIncidentLocal('legacy', INCIDENT_ID, targetedDependencies)).resolves.toMatchObject({
      incidentId: INCIDENT_ID,
    });
  });
});

describe('operator store-reset discard', () => {
  it.each(['absent', 'compatible', 'foreign', 'corrupt'] as const)(
    'refuses a black-box --target legacy discard for an %s store without changing the tree',
    async (state) => {
      const baseDir = root();
      const runtime = createRealRuntime('prod', { baseDir });
      const paths = resolveStoreResetTargetPaths(runtime, 'legacy');
      if (state === 'compatible') {
        mkdirSync(dirname(paths.storeDbPath), { recursive: true });
        openTestStoreDb(runtime, paths.storeDbPath).close();
      } else if (state === 'foreign') {
        createMismatchStore(paths.storeDbPath);
      } else if (state === 'corrupt') {
        mkdirSync(dirname(paths.storeDbPath), { recursive: true });
        writeFileSync(paths.storeDbPath, 'not a sqlite database');
      }
      const before = snapshotTree(baseDir);
      const operations: StoreResetCommandOperations = {
        list: () => ({ incidents: [], truncated: false }),
        report: async () => publicReport(),
        release: operationsRelease,
        discard: async (target) => {
          if (target === 'legacy') return discardStoreReset({ target, runtime });
          throw new Error('unexpected generated target');
        },
      };

      await runCommand(['backend', 'store-reset', 'discard', '--target', 'legacy', '--flavor', 'prod'], operations);

      expect(stdout).toBe('');
      expect(stderr).toContain('[code=legacy_foreign_generation]');
      expect(process.exitCode).toBe(1);
      const after = snapshotTree(baseDir);
      expect(after.paths).toEqual(before.paths);
      expect(after.sha256).toBe(before.sha256);
    },
  );

  it('refuses while a live installer writer lease cannot drain and leaves the store byte-identical', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const before = readFileSync(dbPath);
    const writer = await generationMutationCoordinationSeam.acquireWriterLease(runtime, {
      kind: 'install',
      name: 'kiwi',
    });

    try {
      await expect(
        discardStoreReset({
          target: 'gen2',
          runtime,
          build: CURRENT_BUILD,
          storeFormat: STORE_FORMAT,
          acquireSocketGuard: noSocketGuard,
          maintenanceTimeoutMs: 25,
          currentBundleDir: baseDir,
          validateSelectedTarget: () => {
            throw new Error('no selected target is expected in this case');
          },
        }),
      ).rejects.toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: { operation: 'store-reset', flavor: 'prod', baseDir },
      });
      expect(readFileSync(dbPath)).toEqual(before);
      expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
    } finally {
      writer.release();
    }
  });

  it('reports an unsafe selection entry as a typed operator refusal with accurate remediation', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const before = readFileSync(dbPath);
    const selectionPaths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(selectionPaths.coordinationRoot, { recursive: true, mode: 0o700 });
    mkdirSync(selectionPaths.selectionFile, { mode: 0o700 });
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      release: operationsRelease,
      discard: async () =>
        discardStoreReset({
          target: 'gen2',
          runtime,
          build: CURRENT_BUILD,
          storeFormat: STORE_FORMAT,
          acquireSocketGuard: noSocketGuard,
          currentBundleDir: baseDir,
          validateSelectedTarget: () => {
            throw new Error('no selected target is expected in this case');
          },
        }),
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(stdout).toBe('');
    expect(stderr).toContain('active-store selection record.');
    expect(stderr).toContain('[code=active_store_coordination_invalid]');
    expect(stderr).toContain('remediation:');
    expect(stderr).not.toContain('(record_not_regular)');
    expect(stderr).not.toContain('build that owns this coordination state');
    expect(stderr).not.toContain('[code=internal]');
    expect(process.exitCode).toBe(1);
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it('supersedes a malformed transition and completes the operator reset', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const selectionPaths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(selectionPaths.coordinationRoot, { recursive: true, mode: 0o700 });
    const malformedBytes = Buffer.from('{}');
    writeFileSync(selectionPaths.transitionFile, malformedBytes, { mode: 0o600 });
    chmodSync(selectionPaths.transitionFile, 0o600);
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      release: operationsRelease,
      discard: async () =>
        discardStoreReset({
          target: 'gen2',
          runtime,
          build: CURRENT_BUILD,
          storeFormat: STORE_FORMAT,
          acquireSocketGuard: noSocketGuard,
          currentBundleDir: baseDir,
          validateSelectedTarget: () => {
            throw new Error('no selected target is expected in this case');
          },
        }),
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(stdout).toContain(`initialized gen2 prod store at ${dbPath}.`);
    expect(stderr).not.toContain('[code=active_store_coordination_invalid]');
    expect(process.exitCode).toBeUndefined();
    expect(classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT).kind).toBe('compatible');
    expect(existsSync(selectionPaths.transitionFile)).toBe(false);
    const evidenceRoot = join(dirname(dbPath), 'store-reset-quarantine', 'retained-active-store-transitions');
    const evidenceFiles = readdirSync(evidenceRoot);
    expect(evidenceFiles).toHaveLength(1);
    expect(readFileSync(join(evidenceRoot, evidenceFiles[0]))).toEqual(malformedBytes);
  });

  it('refuses while the KB child holds its writer lease and leaves the store byte-identical', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const before = readFileSync(dbPath);
    const childDb = openTestStoreDb(runtime, ':memory:');
    const child = createKbDaemonWriteRuntimeHost({
      pluginRoot: join(baseDir, 'plugin'),
      backendNamespace: 'store-reset-kb-child-test',
      bundleHash: 'store-reset-kb-child-test',
      curateUsageBudget: { isExhausted: async () => false },
      runtime,
      db: childDb,
    });

    try {
      await child.withKb(() => undefined);

      await expect(
        discardStoreReset({
          target: 'gen2',
          runtime,
          build: CURRENT_BUILD,
          storeFormat: STORE_FORMAT,
          acquireSocketGuard: noSocketGuard,
          maintenanceTimeoutMs: 25,
          currentBundleDir: baseDir,
          validateSelectedTarget: () => {
            throw new Error('no selected target is expected in this case');
          },
        }),
      ).rejects.toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: {
          operation: 'store-reset',
          holder: expect.stringContaining('kb-child:write-runtime'),
          flavor: 'prod',
          baseDir,
        },
      });
      expect(readFileSync(dbPath)).toEqual(before);
      expect(existsSync(join(dirname(dbPath), 'store-reset-quarantine'))).toBe(false);
    } finally {
      await child.dispose();
      childDb.close();
    }
  });

  it('quarantines an incompatible generated store and initializes a fresh store', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);

    const result = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });

    expect(result).toMatchObject({ target: 'gen2', flavor: 'prod', baseDir, storeDbPath: dbPath, resumed: false });
    if (result.kind !== 'discarded') throw new Error(`Expected a discard, received ${result.kind}`);
    expect(result.incident).not.toBeNull();
    expect(classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT).kind).toBe('compatible');
    expect(storeTableExists(dbPath, 'events')).toBe(true);
    expect(storeTableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    expect(
      readdirSync(join(dirname(dbPath), 'store-reset-quarantine')).filter(isCanonicalStoreResetIncidentId),
    ).toEqual([result.incident?.incidentId]);
  });

  it('reports only the final parking survivor after a later claim replaces the published incident', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const linkSync = runtime.storage.linkSync;
    let replaced = false;
    vi.spyOn(runtime.storage, 'linkSync').mockImplementation((source, destination) => {
      if (!replaced && destination === dbPath && String(source).includes(join('store-reset-quarantine', '.minted'))) {
        createMismatchStore(dbPath);
        replaced = true;
      }
      linkSync(source, destination);
    });

    const result = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });

    expect(replaced).toBe(true);
    expect(result).toMatchObject({ kind: 'discarded', incident: null, resumed: false, resumedIncident: null });
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    expect(readdirSync(quarantineRoot).filter(isCanonicalStoreResetIncidentId)).toEqual([]);
    expect(readdirSync(join(quarantineRoot, '.parked')).filter(isCanonicalStoreResetIncidentId)).toHaveLength(1);
  });

  it('releases the exact committed holder and clears its preserved slot', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }

    const result = await releaseStoreReset({
      target: 'current',
      runtime,
      incidentId: discarded.incident.incidentId,
    });

    expect(result).toMatchObject({
      kind: 'released',
      target: 'gen2',
      flavor: 'prod',
      incidentId: discarded.incident.incidentId,
    });
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    expect(existsSync(join(quarantineRoot, discarded.incident.incidentId))).toBe(false);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toBeNull();
  });

  it('releases the incident and its parked namespace while reporting unproven directory durability', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const parkingPath = join(quarantineRoot, '.parked', discarded.incident.incidentId);
    mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(parkingPath, 'store.db-wal'), 'kept replacement');
    writeTerminalParkingSidecar(runtime, join(quarantineRoot, '.parked'), discarded.incident.incidentId);
    const incidentPath = join(quarantineRoot, discarded.incident.incidentId);
    const nestedEvidence = 'extra nested incident evidence';
    const nestedDirectory = join(incidentPath, 'extra', 'nested');
    mkdirSync(nestedDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(nestedDirectory, 'evidence.bin'), nestedEvidence);
    const manifest = parseStoreResetIncidentManifest(readFileSync(join(incidentPath, 'reset-manifest.json')));
    const expectedIncidentBytes =
      manifest.files.reduce((total, file) => total + file.sizeBytes, 0) + Buffer.byteLength(nestedEvidence);
    const listed = listStoreResetIncidentsLocal('gen2', {
      ...dependencies(quarantineRoot),
      resolveIdentity: () => ({ ok: true, manifest: CURRENT_BUILD }),
    });
    expect(listed.incidents).toContainEqual(
      expect.objectContaining({
        incidentId: discarded.incident.incidentId,
        evidenceBytes: expectedIncidentBytes,
      }),
    );
    const events: string[] = [];
    const rm = runtime.storage.rmSync;
    vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
      events.push(`remove:${path}`);
      rm(path, options);
    });
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      events.push(`sync:${path}`);
      return false;
    });

    const result = await releaseStoreReset({
      target: 'gen2',
      runtime,
      incidentId: discarded.incident.incidentId,
    });

    expect(result).toMatchObject({
      kind: 'released',
      incidentEvidenceBytes: expectedIncidentBytes,
      parkingEvidenceBytes: Buffer.byteLength('kept replacement'),
      durability: 'unproven',
    });
    expect(existsSync(join(quarantineRoot, discarded.incident.incidentId))).toBe(false);
    expect(existsSync(parkingPath)).toBe(false);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toBeNull();
    expect(events.indexOf(`remove:${parkingPath}`)).toBeLessThan(
      events.indexOf(`sync:${join(quarantineRoot, '.parked')}`),
    );
    expect(events.indexOf(`sync:${join(quarantineRoot, '.parked')}`)).toBeLessThan(
      events.indexOf(`remove:${incidentPath}`),
    );
  });

  it('reports the destructive partial state when parking is removed but incident removal fails', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const incidentPath = join(quarantineRoot, discarded.incident.incidentId);
    const parkingPath = join(quarantineRoot, '.parked', discarded.incident.incidentId);
    mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(parkingPath, 'store.db-wal'), 'kept replacement');
    writeTerminalParkingSidecar(runtime, join(quarantineRoot, '.parked'), discarded.incident.incidentId);
    const rm = runtime.storage.rmSync;
    vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
      if (path === incidentPath) throw Object.assign(new Error('incident remove failed'), { code: 'EIO' });
      rm(path, options);
    });

    const result = await releaseStoreReset({
      target: 'gen2',
      runtime,
      incidentId: discarded.incident.incidentId,
    });

    expect(result).toMatchObject({
      kind: 'partially-released',
      parkingState: 'absent',
      incidentState: 'present',
      parkingDeletionDurability: 'proven',
      incidentDeletionDurability: 'unproven',
      cause: 'incident remove failed',
    });
    expect(existsSync(parkingPath)).toBe(false);
    expect(existsSync(incidentPath)).toBe(true);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved?.incidentId).toBe(
      discarded.incident.incidentId,
    );
  });

  it('reports possible recursive-delete effects when parking removal fails', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const incidentPath = join(quarantineRoot, discarded.incident.incidentId);
    const parkingPath = join(quarantineRoot, '.parked', discarded.incident.incidentId);
    const parkedWal = join(parkingPath, 'store.db-wal');
    mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
    writeFileSync(parkedWal, 'partially removed evidence');
    writeTerminalParkingSidecar(runtime, join(quarantineRoot, '.parked'), discarded.incident.incidentId);
    const rm = runtime.storage.rmSync;
    vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
      if (path === parkingPath) {
        rm(parkedWal);
        throw Object.assign(new Error('parking remove failed'), { code: 'EIO' });
      }
      rm(path, options);
    });

    const result = await releaseStoreReset({
      target: 'gen2',
      runtime,
      incidentId: discarded.incident.incidentId,
    });

    expect(result).toMatchObject({
      kind: 'partially-released',
      parkingState: 'present',
      incidentState: 'present',
      parkingDeletionDurability: 'unproven',
      incidentDeletionDurability: 'not-attempted',
      cause: 'parking remove failed',
    });
    expect(existsSync(parkedWal)).toBe(false);
    expect(existsSync(incidentPath)).toBe(true);
  });

  it('reports an incident-only recursive-delete failure as partially released', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const incidentPath = join(quarantineRoot, discarded.incident.incidentId);
    const rm = runtime.storage.rmSync;
    vi.spyOn(runtime.storage, 'rmSync').mockImplementation((path, options) => {
      if (path === incidentPath) throw Object.assign(new Error('incident-only remove failed'), { code: 'EIO' });
      rm(path, options);
    });

    const result = await releaseStoreReset({
      target: 'gen2',
      runtime,
      incidentId: discarded.incident.incidentId,
    });

    expect(result).toMatchObject({
      kind: 'partially-released',
      parkingState: 'absent',
      incidentState: 'present',
      parkingDeletionDurability: 'not-required',
      incidentDeletionDurability: 'unproven',
      cause: 'incident-only remove failed',
    });
  });

  it('reports unproven durability when the final quarantine sync throws after deletion', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const sync = runtime.storage.syncDirectoryDurableSync;
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) => {
      if (path === quarantineRoot) throw Object.assign(new Error('final sync failed'), { code: 'EIO' });
      return sync(path);
    });

    const result = await releaseStoreReset({
      target: 'gen2',
      runtime,
      incidentId: discarded.incident.incidentId,
    });

    expect(result).toMatchObject({ kind: 'released', durability: 'unproven' });
    expect(existsSync(join(quarantineRoot, discarded.incident.incidentId))).toBe(false);
  });

  it('refuses to release an in-flight parking transaction', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const { quarantineRoot } = resolveStoreResetTargetPaths(runtime, 'gen2');
    const parkingRoot = join(quarantineRoot, '.parked');
    const parkingPath = join(parkingRoot, INCIDENT_ID);
    mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
    writeStoreResetParkedRecord(
      runtime.storage,
      parkingRoot,
      {
        version: STORE_RESET_PARKED_SIDECAR_VERSION,
        parkingId: INCIDENT_ID,
        parkedAt: '2026-09-13T00:00:00.000Z',
        phase: 'in-flight',
        cause: 'residual',
        incidentId: null,
        names: [],
        entries: [],
        transaction: { kind: 'claim', names: ['store.db', 'store.db-wal', 'store.db-shm'] },
        classification: null,
      },
      fixtureHeld(runtime.storage),
    );

    const listed = listStoreResetIncidentsLocal('gen2', dependencies(quarantineRoot));
    expect(listed.incidents).toContainEqual(expect.objectContaining({ incidentId: INCIDENT_ID, state: 'in-flight' }));
    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: INCIDENT_ID })).resolves.toMatchObject({
      kind: 'in-flight',
      target: 'gen2',
    });
    expect(existsSync(parkingPath)).toBe(true);
  });

  it('requires a canonical parking ID instead of treating .in-flight as deletion authority', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const { quarantineRoot } = resolveStoreResetTargetPaths(runtime, 'gen2');
    const parkingRoot = join(quarantineRoot, '.parked');
    const fixedPath = join(parkingRoot, STORE_RESET_IN_FLIGHT_DIRECTORY);
    mkdirSync(fixedPath, { recursive: true, mode: 0o700 });
    writeStoreResetParkedRecord(
      runtime.storage,
      parkingRoot,
      {
        version: STORE_RESET_PARKED_SIDECAR_VERSION,
        parkingId: INCIDENT_ID,
        parkedAt: '2026-09-13T00:00:00.000Z',
        phase: 'terminal',
        cause: 'residual',
        incidentId: null,
        names: [],
        entries: [],
        transaction: null,
        classification: null,
      },
      fixtureHeld(runtime.storage),
      STORE_RESET_IN_FLIGHT_DIRECTORY,
    );

    expect(() => releaseStoreResetLocal('gen2', 'prod', STORE_RESET_IN_FLIGHT_DIRECTORY)).toThrow(StoreResetCliError);
    await expect(
      releaseStoreReset({ target: 'gen2', runtime, incidentId: STORE_RESET_IN_FLIGHT_DIRECTORY }),
    ).resolves.toMatchObject({ kind: 'undeterminable' });
    expect(existsSync(fixedPath)).toBe(true);
  });

  it.each(['valid-holder', 'valid-non-holder', 'absent', 'malformed', 'oversized', 'symlinked', 'unreadable'] as const)(
    'crosses retention-ledger state %s with operator release',
    async (ledgerState) => {
      const baseDir = root();
      const runtime = createRealRuntime('prod', { baseDir });
      const dbPath = runtime.paths.coral.store.dbFile;
      createMismatchStore(dbPath);
      const discarded = await discardStoreReset({
        target: 'gen2',
        runtime,
        build: CURRENT_BUILD,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: noSocketGuard,
        currentBundleDir: baseDir,
        validateSelectedTarget: () => {
          throw new Error('no selected target is expected in this case');
        },
      });
      if (discarded.kind !== 'discarded' || discarded.incident === null) {
        throw new Error('Expected a committed store-reset incident.');
      }
      const incidentId = discarded.incident.incidentId;
      const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
      const incidentPath = join(quarantineRoot, incidentId);
      const ledgerPath = join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME);
      const validLedger = readFileSync(ledgerPath, 'utf-8');

      if (ledgerState === 'valid-non-holder') {
        const ledger = JSON.parse(validLedger) as { preserved: { incidentId: string } };
        ledger.preserved.incidentId = INCIDENT_ID;
        writeFileSync(ledgerPath, JSON.stringify(ledger));
      } else if (ledgerState === 'absent') {
        rmSync(ledgerPath);
      } else if (ledgerState === 'malformed') {
        writeFileSync(ledgerPath, '{');
      } else if (ledgerState === 'oversized') {
        writeFileSync(ledgerPath, Buffer.alloc(MAX_RESET_RETENTION_LEDGER_BYTES + 1));
      } else if (ledgerState === 'symlinked') {
        const outside = join(baseDir, 'outside-retention-ledger');
        writeFileSync(outside, validLedger);
        rmSync(ledgerPath);
        symlinkSync(outside, ledgerPath);
      } else if (ledgerState === 'unreadable') {
        const readFile = runtime.storage.readFileSync;
        vi.spyOn(runtime.storage, 'readFileSync').mockImplementation((path, encoding) => {
          if (path === ledgerPath) throw Object.assign(new Error('ledger unreadable'), { code: 'EACCES' });
          return readFile(path, encoding);
        });
      }

      const result = await releaseStoreReset({ target: 'gen2', runtime, incidentId });

      if (ledgerState === 'valid-holder') {
        expect(result).toMatchObject({ kind: 'released' });
        expect(existsSync(incidentPath)).toBe(false);
      } else if (ledgerState === 'valid-non-holder' || ledgerState === 'absent') {
        expect(result).toMatchObject({ kind: 'not-holder' });
        expect(existsSync(incidentPath)).toBe(false);
      } else {
        expect(result).toMatchObject({ kind: 'undeterminable' });
        expect(formatStoreResetRelease(result)).toContain(
          'could not be verified as committed; no evidence was released and the preserved slot is unchanged',
        );
        expect(existsSync(incidentPath)).toBe(true);
      }
    },
  );

  it.each(['rejected', 'thrown'] as const)(
    'reports a partial release when the retention-ledger update is %s',
    async (writeFailure) => {
      const baseDir = root();
      const runtime = createRealRuntime('prod', { baseDir });
      const dbPath = runtime.paths.coral.store.dbFile;
      createMismatchStore(dbPath);
      const discarded = await discardStoreReset({
        target: 'gen2',
        runtime,
        build: CURRENT_BUILD,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: noSocketGuard,
        currentBundleDir: baseDir,
        validateSelectedTarget: () => {
          throw new Error('no selected target is expected in this case');
        },
      });
      if (discarded.kind !== 'discarded' || discarded.incident === null) {
        throw new Error('Expected a committed store-reset incident.');
      }
      const incidentId = discarded.incident.incidentId;
      const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
      const incidentPath = join(quarantineRoot, incidentId);
      const ledgerPath = join(quarantineRoot, STORE_RESET_RETENTION_LEDGER_FILE_NAME);
      const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync;
      vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, data, options) => {
        if (path !== ledgerPath) return writeAtomicDurableSync(path, data, options);
        if (writeFailure === 'thrown') throw Object.assign(new Error('ledger write failed'), { code: 'EIO' });
        return false;
      });

      const result = await releaseStoreReset({ target: 'gen2', runtime, incidentId });

      expect(result).toMatchObject({
        kind: 'partially-released',
        parkingState: 'absent',
        incidentState: 'absent',
        parkingDeletionDurability: 'not-required',
        incidentDeletionDurability: 'proven',
        cause: 'Store-reset retention ledger could not be updated durably.',
      });
      expect(formatStoreResetRelease(result)).toContain(`Partially released store-reset incident '${incidentId}'`);
      expect(formatStoreResetRelease(result)).toContain('retry this release command');
      expect(existsSync(incidentPath)).toBe(false);
      expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved?.incidentId).toBe(incidentId);
    },
  );

  it.each(['invalid', 'oversized', 'symlinked', 'unreadable'] as const)(
    'releases terminal UUID parking whose sidecar is %s with unknown byte accounting',
    async (sidecarState) => {
      const baseDir = root();
      const runtime = createRealRuntime('prod', { baseDir });
      const dbPath = runtime.paths.coral.store.dbFile;
      createMismatchStore(dbPath);
      const discarded = await discardStoreReset({
        target: 'gen2',
        runtime,
        build: CURRENT_BUILD,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: noSocketGuard,
        currentBundleDir: baseDir,
        validateSelectedTarget: () => {
          throw new Error('no selected target is expected in this case');
        },
      });
      if (discarded.kind !== 'discarded' || discarded.incident === null) {
        throw new Error('Expected a committed store-reset incident.');
      }
      const incidentId = discarded.incident.incidentId;
      const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
      const incidentPath = join(quarantineRoot, incidentId);
      const parkingPath = join(quarantineRoot, '.parked', incidentId);
      const sidecarPath = join(parkingPath, 'parked.v1.json');
      const incidentEvidenceBytes = parseStoreResetIncidentManifest(
        readFileSync(join(incidentPath, 'reset-manifest.json')),
      ).files.reduce((total, file) => total + file.sizeBytes, 0);
      mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
      writeFileSync(join(parkingPath, 'store.db-wal'), 'unverified parking witness');
      if (sidecarState === 'invalid') writeFileSync(sidecarPath, '{');
      if (sidecarState === 'oversized') writeFileSync(sidecarPath, Buffer.alloc(MAX_RESET_PARKED_SIDECAR_BYTES + 1));
      if (sidecarState === 'symlinked') {
        const target = join(baseDir, 'outside-sidecar');
        writeFileSync(target, '{}');
        symlinkSync(target, sidecarPath);
      }
      if (sidecarState === 'unreadable') {
        writeFileSync(sidecarPath, '{}');
        const lstat = runtime.storage.lstatSync;
        vi.spyOn(runtime.storage, 'lstatSync').mockImplementation(((path: string, options?: { bigint?: boolean }) => {
          if (path === sidecarPath) throw Object.assign(new Error('parking sidecar unreadable'), { code: 'EACCES' });
          return options?.bigint === true ? lstat(path, { bigint: true }) : lstat(path);
        }) as typeof runtime.storage.lstatSync);
      }

      const result = await releaseStoreReset({ target: 'gen2', runtime, incidentId });
      expect(result).toMatchObject({
        kind: 'released-with-unverified-parking',
        incidentEvidenceBytes,
        parkingEvidenceBytes: null,
      });
      const rendered = formatStoreResetRelease(result);
      expect(rendered).toContain(`preserved store-reset incident '${incidentId}' and its same-ID parking`);
      expect(rendered).not.toContain('terminal parking');
      expect(rendered).toContain(`incident: ${incidentEvidenceBytes} bytes; parking: unknown`);
      expect(rendered).toContain('without a verified parking sidecar');
      expect(existsSync(incidentPath)).toBe(false);
      expect(existsSync(parkingPath)).toBe(false);
      expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toBeNull();
    },
  );

  it('separates parking-only deletion with an unverifiable sidecar', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const { quarantineRoot } = resolveStoreResetTargetPaths(runtime, 'gen2');
    const parkingPath = join(quarantineRoot, '.parked', INCIDENT_ID);
    mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(parkingPath, 'store.db-wal'), 'parking-only evidence');
    writeFileSync(join(parkingPath, 'parked.v1.json'), '{');

    const result = await releaseStoreReset({ target: 'gen2', runtime, incidentId: INCIDENT_ID });

    expect(result).toMatchObject({
      kind: 'parked-unverified',
      incidentEvidenceBytes: null,
      parkingEvidenceBytes: null,
      durability: 'proven',
    });
    expect(formatStoreResetRelease(result)).toContain(`store-reset parking '${INCIDENT_ID}'`);
    expect(formatStoreResetRelease(result)).not.toContain('terminal store-reset parking');
    expect(existsSync(parkingPath)).toBe(false);
  });

  it('separates a non-holder incident deleted with unverifiable same-ID parking', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const preservedBefore = readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved;
    const incidentPath = join(quarantineRoot, INCIDENT_ID);
    const incidentEvidence = 'non-holder evidence';
    mkdirSync(incidentPath);
    writeFileSync(join(incidentPath, 'store.db'), incidentEvidence);
    writeFileSync(
      join(incidentPath, 'reset-manifest.json'),
      serializeStoreResetIncidentManifest(manifestWithPlaceholderEvidence(incidentManifest())),
    );
    const parkingPath = join(quarantineRoot, '.parked', INCIDENT_ID);
    mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(parkingPath, 'store.db-wal'), 'unverified parking');
    writeFileSync(join(parkingPath, 'parked.v1.json'), '{');

    const result = await releaseStoreReset({ target: 'gen2', runtime, incidentId: INCIDENT_ID });

    expect(result).toMatchObject({
      kind: 'not-holder-with-unverified-parking',
      incidentEvidenceBytes: Buffer.byteLength(incidentEvidence),
      parkingEvidenceBytes: null,
    });
    expect(formatStoreResetRelease(result)).toContain(
      `non-holder store-reset incident '${INCIDENT_ID}' and its same-ID parking`,
    );
    expect(formatStoreResetRelease(result)).not.toContain('terminal parking');
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toEqual(preservedBefore);
    expect(existsSync(incidentPath)).toBe(false);
    expect(existsSync(parkingPath)).toBe(false);
  });

  it.each(
    (['valid', 'malformed', 'unreadable'] as const).flatMap((manifestState) =>
      (['manifest-only', 'nested-evidence'] as const).map((contentState) => ({ manifestState, contentState })),
    ),
  )(
    'accounts recursive bytes while listing and releasing a $manifestState incident with $contentState',
    async ({ manifestState, contentState }) => {
      const baseDir = root();
      const runtime = createRealRuntime('prod', { baseDir });
      const dbPath = runtime.paths.coral.store.dbFile;
      createMismatchStore(dbPath);
      const discarded = await discardStoreReset({
        target: 'gen2',
        runtime,
        build: CURRENT_BUILD,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: noSocketGuard,
        currentBundleDir: baseDir,
        validateSelectedTarget: () => {
          throw new Error('no selected target is expected in this case');
        },
      });
      if (discarded.kind !== 'discarded' || discarded.incident === null) {
        throw new Error('Expected a committed store-reset incident.');
      }
      const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
      const incidentPath = join(quarantineRoot, discarded.incident.incidentId);
      const manifestPath = join(incidentPath, 'reset-manifest.json');
      const manifestEvidenceBytes = parseStoreResetIncidentManifest(readFileSync(manifestPath)).files.reduce(
        (total, file) => total + file.sizeBytes,
        0,
      );
      const nestedEvidence = contentState === 'nested-evidence' ? 'extra nested evidence' : '';
      if (contentState === 'nested-evidence') {
        const nestedDirectory = join(incidentPath, 'extra', 'nested');
        mkdirSync(nestedDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(join(nestedDirectory, 'evidence.bin'), nestedEvidence);
      }
      if (manifestState === 'malformed') writeFileSync(manifestPath, '{');

      const inspection = createStoreResetInspectionFs();
      const listed = listStoreResetIncidentsLocal('gen2', {
        ...dependencies(quarantineRoot),
        createInspectionFs: () =>
          manifestState === 'unreadable'
            ? {
                ...inspection,
                open(path, flags, mode) {
                  if (path === manifestPath) throw Object.assign(new Error('manifest unreadable'), { code: 'EACCES' });
                  return inspection.open(path, flags, mode);
                },
              }
            : inspection,
        resolveIdentity: () => ({ ok: true, manifest: CURRENT_BUILD }),
      });

      if (manifestState === 'unreadable') {
        const readFile = runtime.storage.readFileSync;
        vi.spyOn(runtime.storage, 'readFileSync').mockImplementation((path, encoding) => {
          if (path === manifestPath) throw Object.assign(new Error('manifest unreadable'), { code: 'EACCES' });
          return readFile(path, encoding);
        });
      }
      const released = await releaseStoreReset({
        target: 'current',
        runtime,
        incidentId: discarded.incident.incidentId,
      });
      const expectedEvidenceBytes = manifestEvidenceBytes + Buffer.byteLength(nestedEvidence);

      expect({
        listedEvidenceBytes: listed.incidents[0]?.evidenceBytes,
        releasedEvidenceBytes: 'incidentEvidenceBytes' in released ? released.incidentEvidenceBytes : undefined,
      }).toEqual({
        listedEvidenceBytes: expectedEvidenceBytes,
        releasedEvidenceBytes: expectedEvidenceBytes,
      });
      expect(released).toMatchObject({ kind: 'released', target: 'gen2', durability: 'proven' });
      expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toBeNull();
      expect(existsSync(incidentPath)).toBe(false);
    },
  );

  it('releases only the requested target while coordinator recovery remains pending', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const olderId = discarded.incident.incidentId;
    const olderPath = join(quarantineRoot, olderId);
    const pendingId = '423e4567-e89b-42d3-a456-426614174000';
    const pendingPath = join(quarantineRoot, pendingId);
    const manifest = JSON.parse(
      readFileSync(join(olderPath, 'reset-manifest.json'), 'utf-8'),
    ) as StoreResetIncidentManifestV3;
    const pendingManifest = { ...manifest, incidentId: pendingId };
    cpSync(olderPath, pendingPath, { recursive: true });
    writeFileSync(join(pendingPath, 'reset-manifest.json'), serializeStoreResetIncidentManifest(pendingManifest));
    const ledger = readStoreResetRetentionLedger(runtime.storage, quarantineRoot);
    if (ledger === null) throw new Error('Expected a retention ledger.');
    recordStoreResetPending(
      runtime.storage,
      quarantineRoot,
      ledger,
      {
        resetAt: pendingManifest.resetAt,
        identities: [],
        outcome: {
          kind: 'preserve',
          incident: {
            incidentId: pendingId,
            resetAt: pendingManifest.resetAt,
            evidenceBytes: pendingManifest.files.reduce((total, file) => total + file.sizeBytes, 0),
            resumeLeftActive: false,
          },
        },
      },
      fixtureHeld(runtime.storage),
    );
    const parkingRoot = join(quarantineRoot, '.parked');
    const parkingPath = join(parkingRoot, pendingId);
    const parkedEvidence = 'durable pending parking';
    mkdirSync(parkingPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(parkingPath, 'store.db-wal'), parkedEvidence);
    writeStoreResetParkedRecord(
      runtime.storage,
      parkingRoot,
      {
        version: STORE_RESET_PARKED_SIDECAR_VERSION,
        parkingId: pendingId,
        parkedAt: pendingManifest.resetAt,
        phase: 'terminal',
        cause: 'residual',
        incidentId: pendingId,
        names: ['store.db-wal'],
        entries: [{ name: 'store.db-wal', kind: 'regular-file', sizeBytes: Buffer.byteLength(parkedEvidence) }],
        transaction: null,
        classification: null,
      },
      fixtureHeld(runtime.storage),
    );
    const pendingLedger = readStoreResetRetentionLedger(runtime.storage, quarantineRoot);
    const unrelatedId = '623e4567-e89b-42d3-a456-426614174000';

    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: unrelatedId })).resolves.toMatchObject({
      kind: 'absent',
    });
    expect(existsSync(olderPath)).toBe(true);
    expect(existsSync(pendingPath)).toBe(true);
    expect(existsSync(parkingPath)).toBe(true);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)).toEqual(pendingLedger);

    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: olderId })).resolves.toMatchObject({
      kind: 'released',
    });
    expect(existsSync(olderPath)).toBe(false);
    expect(existsSync(pendingPath)).toBe(true);
    expect(existsSync(parkingPath)).toBe(true);
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)).toMatchObject({
      preserved: null,
      pending: { outcome: { incident: { incidentId: pendingId } } },
    });
  });

  it('reports absent, staged, non-holder, and indeterminate release outcomes from real storage', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    const discarded = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });
    if (discarded.kind !== 'discarded' || discarded.incident === null) {
      throw new Error('Expected a committed store-reset incident.');
    }
    const quarantineRoot = join(dirname(dbPath), 'store-reset-quarantine');
    const holderId = discarded.incident.incidentId;
    const holderPath = join(quarantineRoot, holderId);
    const preservedBefore = readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved;

    await expect(
      releaseStoreReset({ target: 'gen2', runtime, incidentId: PUBLICATION_INVOCATION_ID }),
    ).resolves.toMatchObject({ kind: 'absent', target: 'gen2' });

    const stagedId = '423e4567-e89b-42d3-a456-426614174000';
    mkdirSync(join(quarantineRoot, '.staging', stagedId), { recursive: true });
    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: stagedId })).resolves.toMatchObject({
      kind: 'staged',
      target: 'gen2',
    });

    const nonHolderId = '523e4567-e89b-42d3-a456-426614174000';
    const nonHolderPath = join(quarantineRoot, nonHolderId);
    mkdirSync(nonHolderPath);
    const holderManifest = JSON.parse(
      readFileSync(join(holderPath, 'reset-manifest.json'), 'utf-8'),
    ) as StoreResetIncidentManifestV3;
    writeFileSync(
      join(nonHolderPath, 'reset-manifest.json'),
      serializeStoreResetIncidentManifest({ ...holderManifest, incidentId: nonHolderId }),
    );
    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: nonHolderId })).resolves.toMatchObject({
      kind: 'not-holder',
      target: 'gen2',
    });
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toEqual(preservedBefore);

    const lstatSync = runtime.storage.lstatSync;
    const lstatSpy = vi.spyOn(runtime.storage, 'lstatSync').mockImplementation((path) => {
      if (path === holderPath) {
        throw Object.assign(new Error('fixture observation failure'), { code: 'EACCES' });
      }
      return lstatSync(path, { bigint: true });
    });
    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: holderId })).resolves.toMatchObject({
      kind: 'undeterminable',
      target: 'gen2',
    });
    lstatSpy.mockRestore();
    expect(readStoreResetRetentionLedger(runtime.storage, quarantineRoot)?.preserved).toEqual(preservedBefore);
    expect(existsSync(holderPath)).toBe(true);
  });

  it('refuses symlinked quarantine roots and incident children without deleting their targets', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const { quarantineRoot } = resolveStoreResetTargetPaths(runtime, 'gen2');
    const outsideRoot = join(baseDir, 'outside-quarantine');
    const outsideIncident = join(baseDir, 'outside-incident');
    mkdirSync(outsideRoot, { recursive: true });
    mkdirSync(outsideIncident);
    writeFileSync(join(outsideRoot, 'sentinel'), 'root target');
    writeFileSync(join(outsideIncident, 'sentinel'), 'incident target');
    mkdirSync(dirname(quarantineRoot), { recursive: true });
    symlinkSync(outsideRoot, quarantineRoot, 'dir');

    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: INCIDENT_ID })).resolves.toMatchObject({
      kind: 'unsafe',
      target: 'gen2',
    });
    expect(readFileSync(join(outsideRoot, 'sentinel'), 'utf-8')).toBe('root target');

    rmSync(quarantineRoot);
    mkdirSync(quarantineRoot);
    symlinkSync(outsideIncident, join(quarantineRoot, INCIDENT_ID), 'dir');
    await expect(releaseStoreReset({ target: 'gen2', runtime, incidentId: INCIDENT_ID })).resolves.toMatchObject({
      kind: 'unsafe',
      target: 'gen2',
    });
    expect(readFileSync(join(outsideIncident, 'sentinel'), 'utf-8')).toBe('incident target');
  });

  it('resumes an interrupted incident through the operator service before initialization', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    writeFileSync(`${dbPath}-wal`, 'interrupted wal evidence');
    const renameSync = runtime.storage.renameSync;
    let interrupted = false;
    const renameSpy = vi.spyOn(runtime.storage, 'renameSync').mockImplementation((source, destination) => {
      if (dirname(source) === join(dirname(dbPath), 'store-reset-quarantine', '.staging') && !interrupted) {
        interrupted = true;
        throw new Error('fixture interruption');
      }
      renameSync(source, destination);
    });
    await expect(
      discardStoreReset({
        target: 'gen2',
        runtime,
        build: CURRENT_BUILD,
        storeFormat: STORE_FORMAT,
        acquireSocketGuard: noSocketGuard,
        currentBundleDir: baseDir,
        validateSelectedTarget: () => {
          throw new Error('no selected target is expected in this case');
        },
      }),
    ).rejects.toThrow();
    renameSpy.mockRestore();
    const stagingRoot = join(dirname(dbPath), 'store-reset-quarantine', '.staging');
    const [incidentId] = readdirSync(stagingRoot);

    const result = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
      currentBundleDir: baseDir,
      validateSelectedTarget: () => {
        throw new Error('no selected target is expected in this case');
      },
    });

    expect(result).toMatchObject({ resumed: true, incident: { incidentId } });
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT).kind).toBe('compatible');
  });

  it('uses the documented startup refusal when the executing bundle directory cannot be resolved', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const originalEntrypoint = process.argv[1];
    process.argv[1] = join(baseDir, 'plugin', 'bridge', 'coral-cli.cjs');

    try {
      await expect(
        discardStoreReset({
          target: 'gen2',
          runtime,
          build: CURRENT_BUILD,
          storeFormat: STORE_FORMAT,
          acquireSocketGuard: noSocketGuard,
          validateSelectedTarget: () => {
            throw new Error('selection validation must not run without a bundle directory');
          },
        }),
      ).rejects.toMatchObject({
        code: 'startup_bundle_unresolvable',
        context: { pluginRoot: join(baseDir, 'plugin') },
      });
    } finally {
      if (originalEntrypoint === undefined) process.argv.splice(1, 1);
      else process.argv[1] = originalEntrypoint;
    }
  });
});

describe('backend store-reset commands', () => {
  it('forwards release without a legacy target or coordinator operation', async () => {
    const release = vi.fn(async (_target: 'current' | 'gen2', flavor: BuildFlavor, incidentId: string) => ({
      kind: 'not-holder' as const,
      target: 'gen2' as const,
      flavor,
      incidentId,
      incidentEvidenceBytes: 42,
      parkingEvidenceBytes: 0,
      durability: 'proven' as const,
    }));
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release,
    };

    await runCommand(
      ['backend', 'store-reset', 'release', INCIDENT_ID, '--target', 'current', '--flavor', 'dev'],
      operations,
    );

    expect(release).toHaveBeenCalledWith('current', 'dev', INCIDENT_ID);
    expect(stdout).toContain(
      `Released non-holder store-reset incident '${INCIDENT_ID}' and its same-ID parking (incident: 42 bytes; parking: 0 bytes) from gen2 dev`,
    );
    expect(stdout).not.toContain('from current');
    expect(stderr).toBe('');
  });

  it('reports an unproven release on stderr with a transient exit', async () => {
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: async (_target, flavor, incidentId) => ({
        kind: 'parked',
        target: 'gen2',
        flavor,
        incidentId,
        incidentEvidenceBytes: 0,
        parkingEvidenceBytes: 42,
        durability: 'unproven',
      }),
    };

    await runCommand(
      ['backend', 'store-reset', 'release', INCIDENT_ID, '--target', 'gen2', '--flavor', 'prod'],
      operations,
    );

    expect(stdout).toBe('');
    expect(stderr).toContain(`Released store-reset incident '${INCIDENT_ID}' and its same-ID parking`);
    expect(stderr).toContain('deletion durability unproven');
    expect(process.exitCode).toBe(75);
  });

  it('reports a durable unverified terminal release as completed with unknown accounting', async () => {
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: async (_target, flavor, incidentId) => ({
        kind: 'parked-unverified',
        target: 'gen2',
        flavor,
        incidentId,
        incidentEvidenceBytes: null,
        parkingEvidenceBytes: null,
        clearedPreservedSlot: false,
        durability: 'proven',
      }),
    };

    await runCommand(
      ['backend', 'store-reset', 'release', INCIDENT_ID, '--target', 'gen2', '--flavor', 'prod'],
      operations,
    );

    expect(stdout).toContain(`Released store-reset parking '${INCIDENT_ID}'`);
    expect(stdout).not.toContain('terminal store-reset parking');
    expect(stdout).toContain('without a verified sidecar; parking byte accounting is unknown');
    expect(stderr).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a partial release as destructive and retryable', async () => {
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: async (_target, flavor, incidentId) => ({
        kind: 'partially-released',
        target: 'gen2',
        flavor,
        incidentId,
        incidentEvidenceBytes: 42,
        parkingEvidenceBytes: 0,
        parkingState: 'absent',
        incidentState: 'present',
        parkingDeletionDurability: 'proven',
        incidentDeletionDurability: 'unproven',
        cause: 'incident remove failed',
      }),
    };

    await runCommand(
      ['backend', 'store-reset', 'release', INCIDENT_ID, '--target', 'gen2', '--flavor', 'prod'],
      operations,
    );

    expect(stdout).toBe('');
    expect(stderr).toContain(`Partially released store-reset incident '${INCIDENT_ID}'`);
    expect(stderr).toContain('parking is absent, incident is present');
    expect(stderr).toContain('parking deletion durability is proven; incident deletion durability is unproven');
    expect(stderr).toContain('retry this release command');
    expect(stderr).toContain(
      `command=coral-cli backend store-reset release --target gen2 --flavor prod ${INCIDENT_ID}`,
    );
    expect(process.exitCode).toBe(75);
  });

  it('renders every discard epoch disposition in order', async () => {
    const resumedIncident = {
      incidentId: INCIDENT_ID,
      resetAt: '2026-09-13T00:00:00.000Z',
      reason: 'mismatch' as const,
      schemaVersion: 3 as const,
      resetPolicyCause: 'older-incompatible' as const,
      fileCount: 1,
    };
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      release: operationsRelease,
      discard: async () => ({
        kind: 'discarded',
        target: 'gen2',
        flavor: 'prod',
        baseDir: '/coral',
        storeDbPath: '/coral/gen2/data/store/store.db',
        incident: resumedIncident,
        resumed: true,
        resumedIncident,
        epochs: [
          {
            kind: 'described',
            publication: {
              kind: 'preserved',
              incident: resumedIncident,
              preservation: { kind: 'linked', coherence: 'coherent' },
              rotation: {
                kind: 'incomplete',
                survivor: { kind: 'incident', id: resumedIncident.incidentId },
                cause: 'superseded coordinate changed before pruning',
              },
              classification: {
                kind: 'older-incompatible',
                currentFingerprint: STORE_FORMAT.fingerprint,
                currentProductVersion: STORE_FORMAT.productVersion,
                storedFingerprint: `sha256:${'0'.repeat(64)}`,
                storedProductVersion: '0.0.0-rc.1',
              },
              leftActive: [],
            },
          },
          {
            kind: 'parked',
            parkingId: '323e4567-e89b-42d3-a456-426614174000',
            cause: 'intruder',
            names: ['store.db'],
            classification: null,
            rotation: {
              kind: 'complete',
              survivor: { kind: 'parking', id: '323e4567-e89b-42d3-a456-426614174000' },
            },
          },
          { kind: 'claimed' },
        ],
      }),
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(stdout).toContain(`Resumed store-reset incident '${INCIDENT_ID}'.`);
    expect(stdout).toContain(`Preserved store-reset incident '${INCIDENT_ID}'.`);
    expect(stdout).toContain(
      `Retention rotation is incomplete; incident '${INCIDENT_ID}' remains on disk (superseded coordinate changed before pruning).`,
    );
    expect(stdout).toContain(
      "Parked intruder epoch '323e4567-e89b-42d3-a456-426614174000' (store.db; classification none).",
    );
    expect(stdout).toContain('Claimed the active store name with fresh state.');
  });

  it.each([
    ['complete', 'incident'],
    ['complete', 'parking'],
    ['incomplete', 'incident'],
    ['incomplete', 'parking'],
  ] as const)('renders a %s rotation with an %s survivor from a parked epoch', async (rotationKind, survivorKind) => {
    const parkingId = '323e4567-e89b-42d3-a456-426614174000';
    const survivorId = survivorKind === 'incident' ? INCIDENT_ID : parkingId;
    const cause = 'superseded coordinate changed before pruning';
    const rotation =
      rotationKind === 'complete'
        ? { kind: rotationKind, survivor: { kind: survivorKind, id: survivorId } }
        : { kind: rotationKind, survivor: { kind: survivorKind, id: survivorId }, cause };
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      release: operationsRelease,
      discard: async () => ({
        kind: 'discarded',
        target: 'gen2',
        flavor: 'prod',
        baseDir: '/coral',
        storeDbPath: '/coral/gen2/data/store/store.db',
        incident: null,
        resumed: false,
        resumedIncident: null,
        epochs: [
          {
            kind: 'parked',
            parkingId,
            cause: 'intruder',
            names: ['store.db'],
            classification: null,
            rotation,
          },
          { kind: 'claimed' },
        ],
      }),
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(stdout).toContain(`Parked intruder epoch '${parkingId}'`);
    if (rotationKind === 'incomplete') {
      expect(stdout).toContain(
        `Retention rotation is incomplete; ${survivorKind} '${survivorId}' remains on disk (${cause}).`,
      );
    } else {
      expect(stdout).not.toContain('Retention rotation is incomplete');
    }
  });

  it('constrains all stored strings at renderer ingress', async () => {
    const injected = 'EIO\nFORGED | ROW `CELL`';
    const operations: StoreResetCommandOperations = {
      list: () => ({
        incidents: [
          {
            incidentId: INCIDENT_ID,
            state: 'ready',
            resetAt: '2026-09-13T00:00:00.000Z',
            reason: 'mismatch',
            schemaVersion: 3,
            resetPolicyCause: 'older-incompatible',
            fileCount: 1,
            evidenceBytes: 42,
            parkingEvidenceBytes: 0,
            retention: {
              slot: 'claimed',
              preservation: {
                kind: 'copied',
                cause: { kind: 'link-unsupported', errno: 'other', code: injected },
                coherence: 'coherent',
              },
              resumeLeftActive: false,
              parked: [],
            },
            storedProductVersion: '0.9.15',
          },
        ],
        truncated: false,
      }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: operationsRelease,
    };

    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], operations);

    expect(stdout).not.toContain('\nFORGED');
    expect(stdout).toContain('EIO\\nFORGED \\u007c ROW \\u0060CELL\\u0060');
  });

  it.each([
    {
      kind: 'absent' as const,
      expected: 'command=coral-cli backend store-reset list --target gen2',
    },
    {
      kind: 'staged' as const,
      expected: 'Start Coral and let crash recovery finish, then retry.',
    },
    {
      kind: 'undeterminable' as const,
      expected: 'Retry; if it persists, report this complete output.',
    },
    {
      kind: 'unsafe' as const,
      expected: 'behind an unsafe quarantine path',
    },
  ])('gives the $kind release failure a reversible next step', async ({ kind, expected }) => {
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: async (_target, flavor, incidentId) => ({ kind, target: 'gen2', flavor, incidentId }),
    };

    await runCommand(
      ['backend', 'store-reset', 'release', INCIDENT_ID, '--target', 'current', '--flavor', 'prod'],
      operations,
    );

    expect(stderr).toContain(expected);
    expect(stderr).not.toContain('store-reset release');
  });

  it('uses release-specific guidance for an invalid incident id', async () => {
    await runCommand(['backend', 'store-reset', 'release', 'NOT-A-UUID', '--target', 'current', '--flavor', 'prod'], {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: releaseStoreResetLocal,
    });

    expect(stderr).toContain('[code=invalid_store_reset_release_incident_id]');
    expect(stderr).toContain('--target <current|gen2>');
    expect(stderr).toContain('regardless of its state');
    expect(stderr).not.toContain('ready state');
  });

  it('describes discard as running on a newer build when one already owns the store', () => {
    const program = new Command();
    registerBackendCommands(program, {
      storeReset: {
        list: () => ({ incidents: [], truncated: false }),
        report: async () => publicReport(),
        discard: operationsDiscard,
        release: operationsRelease,
      },
    });

    const discard = program.commands
      .find((command) => command.name() === 'backend')
      ?.commands.find((command) => command.name() === 'store-reset')
      ?.commands.find((command) => command.name() === 'discard');

    expect(discard?.description()).toBe(
      'Quarantine and replace an incompatible generated store; if a newer local Coral build is already selected ' +
        'to own this store, the command runs there instead of here',
    );
  });

  it('delegates the original discard command to the validated newer owner and reports its version', async () => {
    const target = Object.freeze({}) as ValidatedHandoffTarget;
    const discard = vi.fn(async () => ({ kind: 'handoff' as const, target, source: 'active-selection' as const }));
    mockState.runHandoff.mockResolvedValue({
      kind: 'recorded',
      continuation: {
        kind: 'delegated',
        version: '2.0.0',
        outcome: { kind: 'handoff-success', version: '2.0.0' },
      },
      publicationIncidents: [],
    });
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard,
      release: operationsRelease,
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(discard).toHaveBeenCalledWith('gen2', 'prod');
    expect(mockState.runHandoff).toHaveBeenCalledWith(
      {
        kind: 'cli-invocation',
        argv: ['node', 'coral-cli', 'backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'],
      },
      expect.objectContaining({ activeSelectionTarget: target }),
    );
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'handed off to 2.0.0; this repeats on every run until the installed plugin is upgraded to 2.0.0 or newer\n',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('reports both publication phases without replacing the delegated discard exit', async () => {
    const target = Object.freeze({}) as ValidatedHandoffTarget;
    mockState.runHandoff.mockImplementationOnce(async (_operation, options) => {
      options.onSelectionPublicationIncident({
        phase: 'selection',
        invocationId: PUBLICATION_INVOCATION_ID,
        kind: 'not-published',
        cause: 'contended',
      });
      return {
        kind: 'recording-incidents',
        observedWork: {
          kind: 'delegated',
          version: '2.0.0',
          outcome: { kind: 'handoff-exit', exitCode: 23 },
        },
        publicationIncidents: [
          {
            phase: 'selection',
            invocationId: PUBLICATION_INVOCATION_ID,
            kind: 'not-published',
            cause: 'contended',
          },
          {
            phase: 'terminal',
            invocationId: PUBLICATION_INVOCATION_ID,
            terminalDisposition: { kind: 'delegated-exit', version: '2.0.0', exitCode: 23 },
            kind: 'commit-outcome-unknown',
            cause: 'io-failed',
            errcode: 5,
          },
        ],
      };
    });
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: async () => ({ kind: 'handoff', target, source: 'active-selection' }),
      release: operationsRelease,
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(stderr).toBe(
      `Handoff routing-status selection publication for invocation ${PUBLICATION_INVOCATION_ID} was not published (contended).\n` +
        `Next step: rerun coral-cli backend status, then retry the operation if routing invocation ${PUBLICATION_INVOCATION_ID} is still unresolved.\n` +
        `Handoff routing-status terminal publication for invocation ${PUBLICATION_INVOCATION_ID} could not be determined (io-failed, errcode 5).\n` +
        `Next step: repair the reported storage condition if it persists, then rerun coral-cli backend status; if routing invocation ${PUBLICATION_INVOCATION_ID} is still unresolved, run coral-cli backend routing-status resolve --invocation ${PUBLICATION_INVOCATION_ID}. The delegated child exited with code 23; follow the child's own diagnosis. This attempt could not determine whether it committed.\n` +
        'Coral 2.0.0 ran the delegated store-reset command.\n',
    );
    expect(process.exitCode).toBe(23);
  });

  it('exits transiently when this process cannot finish preparing the discard handoff', async () => {
    const target = Object.freeze({}) as ValidatedHandoffTarget;
    mockState.runHandoff.mockResolvedValue({
      kind: 'recorded',
      continuation: {
        kind: 'run-current',
        reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
      },
      publicationIncidents: [],
    });
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: async () => ({ kind: 'handoff', target, source: 'active-selection' }),
      release: operationsRelease,
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(stdout).toBe('');
    expect(stderr).toBe(
      'This Coral process could not finish draining stdout, so store-reset delegation was abandoned before any destructive step. Nothing was changed. Retry the command.\n',
    );
    expect(process.exitCode).toBe(75);
  });

  it.each([
    {
      label: 'exit',
      outcome: { kind: 'handoff-exit' as const, exitCode: 23 },
    },
    {
      label: 'signal',
      outcome: { kind: 'handoff-signal' as const, signal: 'SIGTERM' as const },
    },
  ])('names the newer build before mirroring a delegated discard $label', async ({ outcome }) => {
    const target = Object.freeze({}) as ValidatedHandoffTarget;
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    mockState.runHandoff.mockResolvedValue({
      kind: 'recorded',
      continuation: { kind: 'delegated', version: '2.0.0', outcome },
      publicationIncidents: [],
    });
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: async () => ({ kind: 'handoff', target, source: 'active-selection' }),
      release: operationsRelease,
    };

    await runCommand(['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', 'prod'], operations);

    expect(stdout).toBe('');
    expect(stderr).toBe('Coral 2.0.0 ran the delegated store-reset command.\n');
    if (outcome.kind === 'handoff-exit') {
      expect(process.exitCode).toBe(23);
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(process.exitCode).toBeUndefined();
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    }
  });

  it('identifies the selected target when no incidents are retained', async () => {
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: operationsRelease,
    };

    await runCommand(['backend', 'store-reset', 'list', '--target', 'legacy'], operations);
    const legacyOutput = stdout;
    stdout = '';
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], operations);

    expect(legacyOutput).toContain('No legacy store-reset incidents.');
    expect(legacyOutput).not.toContain('store-reset release');
    expect(stdout).toContain('No gen2 store-reset incidents.');
    expect(stdout).toContain('store-reset release --target gen2');
    expect(stdout).not.toContain('unexpected reset warning');
    expect(stdout).not.toBe(legacyOutput);
  });

  it('renders deterministic local list and report output', async () => {
    const report = publicReport();
    const operations: StoreResetCommandOperations = {
      list: () => ({
        incidents: [
          {
            incidentId: INCIDENT_ID,
            state: 'ready',
            resetAt: '2026-07-23T01:02:03.004Z',
            reason: 'mismatch',
            schemaVersion: 3,
            resetPolicyCause: 'older-incompatible',
            fileCount: 0,
            evidenceBytes: 42,
            parkingEvidenceBytes: 12,
            retention: {
              slot: 'claimed',
              preservation: { kind: 'linked', coherence: 'coherent' },
              parked: [{ name: 'store.db-wal', kind: 'regular-file', sizeBytes: 12 }],
              resumeLeftActive: false,
            },
            storedProductVersion: '0.9.15',
          },
        ],
        truncated: false,
      }),
      report: async () => report,
      release: operationsRelease,
      discard: async () => ({
        kind: 'discarded',
        target: 'gen2',
        flavor: 'prod',
        baseDir: '/coral',
        storeDbPath: '/coral/gen2/data/store/store.db',
        incident: null,
        resumed: false,
        resumedIncident: null,
        epochs: [{ kind: 'claimed' }],
      }),
    };

    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], operations);
    expect(stdout).toBe(
      `Incident ID | Reset at | Schema | Reason | Reset policy | State | Files | Incident bytes | Parking bytes | Preservation | Parked | Resume left active | Stored Coral version\n${INCIDENT_ID} | 2026-07-23T01:02:03.004Z | V3 | mismatch | older-incompatible | ready | 0 | 42 | 12 | linked (coherent) | store.db-wal (regular-file) | no | 0.9.15\n\n` +
        'States: ready produces a Markdown report; parked is owned evidence awaiting release; in-flight is a crash-recovery transaction; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.\n' +
        'Next: report the ready incident.\n' +
        'command=coral-cli backend store-reset report --target gen2 <ready-incident-id>\n' +
        'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.\n' +
        'When a stored Coral version is known, install that version to inspect the preserved store with a compatible build.\n' +
        'To permanently remove a listed incident or parked record:\n' +
        'command=coral-cli backend store-reset release --target gen2 --flavor <prod|dev> <incident-id>\n',
    );
    expect(stderr).toBe('');

    stdout = '';
    await runCommand(['backend', 'store-reset', 'report', '--target', 'gen2', INCIDENT_ID], operations);
    expect(stdout).toContain('# Coral store-reset incident report\n');
    expect(stdout).toContain(`- Incident ID: \`${INCIDENT_ID}\``);
    expect(stdout).toContain('- Manifest schema: `V3`');
    expect(stdout).toContain('- Reset policy cause: `older-incompatible`');
    expect(stdout).not.toContain('/coral/store.db');
    expect(stderr).toBe('');
  });

  it('requires and forwards explicit targets for inspection and discard', async () => {
    const list = vi.fn(() => ({ incidents: [], truncated: false }));
    const report = vi.fn(async () => publicReport());
    const discard = vi.fn(async () => ({
      kind: 'discarded' as const,
      target: 'gen2' as const,
      flavor: 'dev' as const,
      baseDir: '/coral',
      storeDbPath: '/coral/gen2/data-dev/store/store.db',
      incident: null,
      resumed: false,
      resumedIncident: null,
      epochs: [{ kind: 'claimed' as const }],
    }));
    const operations: StoreResetCommandOperations = { list, report, discard, release: operationsRelease };

    await expect(runCommand(['backend', 'store-reset', 'list'], operations)).rejects.toMatchObject({
      code: 'commander.missingMandatoryOptionValue',
    });
    stderr = '';
    await runCommand(['backend', 'store-reset', 'list', '--target', 'legacy'], operations);
    await runCommand(['backend', 'store-reset', 'report', '--target', 'legacy', INCIDENT_ID], operations);
    await runCommand(['backend', 'store-reset', 'discard', '--target', 'current', '--flavor', 'dev'], operations);

    expect(list).toHaveBeenCalledWith('legacy');
    expect(report).toHaveBeenCalledWith('legacy', INCIDENT_ID);
    expect(discard).toHaveBeenCalledWith('gen2', 'dev');
    expect(stdout).toContain('initialized gen2 dev store at /coral/gen2/data-dev/store/store.db.');
    expect(stderr).toBe('Quarantined store-reset evidence is diagnostic-only and cannot restore active state.\n');
  });

  it('preserves known errors and collapses unknown exceptions without leaking arguments or details', async () => {
    const sentinel = '../PRIVATE_ARGUMENT_SENTINEL';
    await runCommand(['backend', 'store-reset', 'report', '--target', 'gen2', sentinel], {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => {
        throw new StoreResetCliError('invalid_store_reset_incident_id');
      },
      discard: operationsDiscard,
      release: operationsRelease,
    });
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'Incident ID must be a canonical lowercase UUID. [code=invalid_store_reset_incident_id]\n' +
        'remediation: Run `coral-cli backend store-reset list --target <legacy|gen2>` and use the ID of an incident in the `ready` state.\n',
    );
    expect(`${stdout}${stderr}`).not.toContain(sentinel);
    expect(process.exitCode).toBe(2);

    stderr = '';
    process.exitCode = undefined;
    await runCommand(['backend', 'store-reset', 'release', INCIDENT_ID, '--target', 'gen2', '--flavor', 'prod'], {
      list: () => ({ incidents: [], truncated: false }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: async () => {
        throw documentedCoralSetupError({
          code: 'store_reset_lock_contended',
          target: 'gen2',
          flavor: 'prod',
          baseDir: '/coral',
          holder: 'another store-reset command',
        });
      },
    });
    expect(stdout).toBe('');
    expect(stderr).toContain('[code=store_reset_lock_contended]');
    expect(stderr).not.toContain('store_reset_reporting_failed');

    stderr = '';
    process.exitCode = undefined;
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], {
      list: () => {
        throw new Error('PRIVATE_CHILD_OR_PATH_SENTINEL');
      },
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: operationsRelease,
    });
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'Store-reset reporting failed. [code=store_reset_reporting_failed]\n' +
        'remediation: Retry once. If it still fails, file a Store-reset incident issue with this fixed error output; do not move, restore, delete, or attach DB, WAL, SHM, or raw logs.\n',
    );
    expect(stderr).not.toContain('PRIVATE_CHILD_OR_PATH_SENTINEL');
    expect(process.exitCode).toBe(70);
  });

  it('renders a bounded partial listing as a drainable result', async () => {
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], {
      list: () => ({ incidents: [], truncated: true }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: operationsRelease,
    });

    expect(stdout).toContain(
      'Listing truncated at the incident-root safety bound; release a listed incident, then list again.',
    );
    expect(stdout).toContain('store-reset release --target gen2');
    expect(stderr).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not direct a parking-only row to the committed-incident report command', async () => {
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], {
      list: () => ({
        incidents: [
          {
            incidentId: INCIDENT_ID,
            state: 'parked',
            resetAt: null,
            reason: null,
            schemaVersion: null,
            resetPolicyCause: null,
            fileCount: null,
            retention: {
              slot: 'parked',
              parked: [{ name: 'store.db', kind: 'directory', sizeBytes: 0 }],
              cause: 'intruder',
              classification: null,
              phase: 'terminal',
            },
            storedProductVersion: 'unknown',
            evidenceBytes: 'unknown',
            parkingEvidenceBytes: 0,
          },
        ],
        truncated: false,
        parkingRootState: 'ready',
      }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: operationsRelease,
    });

    expect(stdout).toContain('store.db (directory)');
    expect(stdout).not.toContain('store-reset report');
    expect(stdout).toContain('store-reset release');
  });

  it('renders an unsafe parking root instead of an empty parking result', async () => {
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], {
      list: () => ({
        incidents: [],
        truncated: false,
        parkingRootState: 'unsafe',
      }),
      report: async () => publicReport(),
      discard: operationsDiscard,
      release: operationsRelease,
    });

    expect(stdout).toContain('Parking root: unsafe; parked evidence could not be listed.');
    expect(stdout).not.toBe('No gen2 store-reset incidents.');
  });
});
