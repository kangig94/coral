import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBackendCommands, type StoreResetCommandOperations } from '#src/cli/commands/backend.js';
import { StoreResetCliError } from '#src/cli/errors.js';
import {
  listStoreResetIncidentsLocal,
  reportStoreResetIncidentLocal,
  type StoreResetCliDependencies,
} from '#src/cli/store-reset.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { socketPathForRunDir } from '#src/infra/path/coordinator.js';
import { createStoreResetInspectionFs } from '#src/infra/store-reset-inspection-fs.js';
import { createKbDaemonWriteRuntimeHost } from '#src/kb-daemon/runtime-host.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createBackendStoreResetAuthority, publishBackendStoreResetIncident } from '#src/store/backend-store-reset.js';
import { classifyStoreFile } from '#src/store/db.js';
import { generationMutationCoordinationSeam } from '#src/store/generation-mutation-coordination.js';
import { discardStoreReset, resolveStoreResetTargetPaths } from '#src/store/operator-store-reset.js';
import {
  projectStoreResetPublicReport,
  serializeStoreResetIncidentManifest,
  type StoreResetIncidentLocalReport,
  type StoreResetIncidentManifestV2,
} from '#src/store/reset-incident.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';

const BUILD: StrictBundleManifest = {
  version: '0.9.16',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'f'.repeat(64)}`,
};
const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
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

function incidentManifest(): StoreResetIncidentManifestV2 {
  return {
    schemaVersion: 2,
    incidentId: INCIDENT_ID,
    resetAt: '2026-07-23T01:02:03.004Z',
    reason: 'mismatch',
    storedFingerprint: `sha256:${'a'.repeat(64)}`,
    expectedFingerprint: BUILD.storeFormatFingerprint,
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

function publicReport() {
  const manifest = incidentManifest();
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
  target: 'gen2',
  flavor: 'prod',
  baseDir: '/coral',
  storeDbPath: '/coral/gen2/data/store/store.db',
  incident: null,
  resumed: false,
});

async function runCommand(args: readonly string[], operations: StoreResetCommandOperations): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBackendCommands(program, operations);
  await program.parseAsync(['node', 'coral-cli', ...args]);
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
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
    const socketEnvironment = {
      platform: runtime.env.platform(),
      tempDirectory: runtime.env.get('TMPDIR') ?? runtime.env.tmpdir(),
    };
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

    expect(result).toEqual({ incidents: [] });
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
    writeFileSync(
      join(incidentPath, 'reset-manifest.json'),
      serializeStoreResetIncidentManifest({
        ...incidentManifest(),
        files: [
          {
            name: 'store.db',
            sizeBytes: evidence.length,
            mtimeMs: evidenceStat.mtimeMs,
            sha256: createHash('sha256').update(evidence).digest('hex'),
          },
        ],
      }),
    );
    const targetedDependencies: StoreResetCliDependencies = {
      ...dependencies(legacyRoot),
      quarantineRoot: (_manifest, target) => resolveStoreResetTargetPaths(runtime, target).quarantineRoot,
    };

    expect(listStoreResetIncidentsLocal('legacy', targetedDependencies).incidents).toMatchObject([
      { incidentId: INCIDENT_ID, state: 'ready' },
    ]);
    expect(listStoreResetIncidentsLocal('gen2', targetedDependencies)).toEqual({ incidents: [] });
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
        list: () => ({ incidents: [] }),
        report: async () => publicReport(),
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
    });

    expect(result).toMatchObject({ target: 'gen2', flavor: 'prod', baseDir, storeDbPath: dbPath, resumed: false });
    expect(result.incident).not.toBeNull();
    expect(classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT).kind).toBe('compatible');
    expect(storeTableExists(dbPath, 'events')).toBe(true);
    expect(storeTableExists(dbPath, 'sentinel_before_reset')).toBe(false);
    expect(
      readdirSync(join(dirname(dbPath), 'store-reset-quarantine')).filter((entry) => entry !== '.staging'),
    ).toEqual([result.incident?.incidentId]);
  });

  it('resumes an interrupted incident through the operator service before initialization', async () => {
    const baseDir = root();
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    createMismatchStore(dbPath);
    writeFileSync(`${dbPath}-wal`, 'interrupted wal evidence');
    const authority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: false },
      {
        path: dbPath,
        namespace: 'fixture',
        storeFormat: STORE_FORMAT,
        build: CURRENT_BUILD,
      },
    );
    const unlinkSync = runtime.storage.unlinkSync;
    let interrupted = false;
    const unlinkSpy = vi.spyOn(runtime.storage, 'unlinkSync').mockImplementation((path) => {
      if (path === `${dbPath}-wal` && !interrupted) {
        interrupted = true;
        throw new Error('fixture interruption');
      }
      unlinkSync(path);
    });
    expect(() =>
      publishBackendStoreResetIncident(runtime, authority, { path: dbPath, storeFormat: STORE_FORMAT }),
    ).toThrow();
    unlinkSpy.mockRestore();
    const stagingRoot = join(dirname(dbPath), 'store-reset-quarantine', '.staging');
    const [incidentId] = readdirSync(stagingRoot);

    const result = await discardStoreReset({
      target: 'gen2',
      runtime,
      build: CURRENT_BUILD,
      storeFormat: STORE_FORMAT,
      acquireSocketGuard: noSocketGuard,
    });

    expect(result).toMatchObject({ resumed: true, incident: { incidentId } });
    expect(readdirSync(stagingRoot)).toEqual([]);
    expect(classifyStoreFile(dbPath, runtime.storage, STORE_FORMAT).kind).toBe('compatible');
  });
});

describe('backend store-reset commands', () => {
  it('identifies the selected target when no incidents are retained', async () => {
    const operations: StoreResetCommandOperations = {
      list: () => ({ incidents: [] }),
      report: async () => publicReport(),
      discard: operationsDiscard,
    };

    await runCommand(['backend', 'store-reset', 'list', '--target', 'legacy'], operations);
    const legacyOutput = stdout;
    stdout = '';
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], operations);

    expect(legacyOutput).toContain('No legacy store-reset incidents.');
    expect(stdout).toContain('No gen2 store-reset incidents.');
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
            fileCount: 0,
          },
        ],
      }),
      report: async () => report,
      discard: async () => ({
        target: 'gen2',
        flavor: 'prod',
        baseDir: '/coral',
        storeDbPath: '/coral/gen2/data/store/store.db',
        incident: null,
        resumed: false,
      }),
    };

    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], operations);
    expect(stdout).toBe(
      `Incident ID | Reset at | Reason | State | Files\n${INCIDENT_ID} | 2026-07-23T01:02:03.004Z | mismatch | ready | 0\n\n` +
        'States: ready produces a Markdown report; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.\n' +
        'Next: coral-cli backend store-reset report --target gen2 <ready-incident-id>\n' +
        'For a non-ready incident, run the same report command with its ID and paste the fixed error output into the issue form.\n' +
        'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.\n',
    );
    expect(stderr).toBe('');

    stdout = '';
    await runCommand(['backend', 'store-reset', 'report', '--target', 'gen2', INCIDENT_ID], operations);
    expect(stdout).toContain('# Coral store-reset incident report\n');
    expect(stdout).toContain(`- Incident ID: \`${INCIDENT_ID}\``);
    expect(stderr).toBe('');
  });

  it('requires and forwards explicit targets for inspection and discard', async () => {
    const list = vi.fn(() => ({ incidents: [] }));
    const report = vi.fn(async () => publicReport());
    const discard = vi.fn(async () => ({
      target: 'gen2' as const,
      flavor: 'dev' as const,
      baseDir: '/coral',
      storeDbPath: '/coral/gen2/data-dev/store/store.db',
      incident: null,
      resumed: false,
    }));
    const operations: StoreResetCommandOperations = { list, report, discard };

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
    expect(stdout).toContain('Initialized gen2 dev store at /coral/gen2/data-dev/store/store.db.');
    expect(stderr).toBe('Quarantined store-reset evidence is diagnostic-only and cannot restore active state.\n');
  });

  it('preserves known errors and collapses unknown exceptions without leaking arguments or details', async () => {
    const sentinel = '../PRIVATE_ARGUMENT_SENTINEL';
    await runCommand(['backend', 'store-reset', 'report', '--target', 'gen2', sentinel], {
      list: () => ({ incidents: [] }),
      report: async () => {
        throw new StoreResetCliError('invalid_store_reset_incident_id');
      },
      discard: operationsDiscard,
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
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], {
      list: () => {
        throw new Error('PRIVATE_CHILD_OR_PATH_SENTINEL');
      },
      report: async () => publicReport(),
      discard: operationsDiscard,
    });
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'Store-reset reporting failed. [code=store_reset_reporting_failed]\n' +
        'remediation: Retry once. If it still fails, file a Store-reset incident issue with this fixed error output; do not move, restore, delete, or attach DB, WAL, SHM, or raw logs.\n',
    );
    expect(stderr).not.toContain('PRIVATE_CHILD_OR_PATH_SENTINEL');
    expect(process.exitCode).toBe(70);
  });

  it('maps retained-entry overflow through the real command envelope', async () => {
    await runCommand(['backend', 'store-reset', 'list', '--target', 'gen2'], {
      list: () => {
        throw new StoreResetCliError('store_reset_incident_limit_exceeded');
      },
      report: async () => publicReport(),
      discard: operationsDiscard,
    });

    expect(stdout).toBe('');
    expect(stderr).toContain('[code=store_reset_incident_limit_exceeded]');
    expect(stderr).toContain('Use an incident ID from the reset warning.');
    expect(process.exitCode).toBe(1);
  });
});
