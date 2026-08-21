import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator, type ForeignTargetValidator } from '#src/infra/handoff-target.js';
import { sha256Hex } from '#src/infra/hash.js';
import { canonicalContractJson } from '#src/infra/persisted-contract.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  encodeActiveStoreSelection,
  encodeActiveStoreTransition,
  readActiveStoreSelection,
  readActiveStoreTransition,
  resolveActiveStoreRecordPaths,
  type ActiveStoreSelection,
  type ActiveStoreTransition,
} from '#src/store/active-store-selection.js';
import { coordinateActiveStoreSelection } from '#src/store/active-store-selection-coordination.js';
import { createBackendStoreResetAuthority } from '#src/store/backend-store-reset.js';
import * as dbModule from '#src/store/db.js';
import { openStoreDatabase } from '#src/store/db.js';
import type { StoreFormatManifest } from '#src/store/format-fingerprint.js';
import {
  isCanonicalStoreResetIncidentId,
  parseStoreResetIncidentManifest,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_QUARANTINE_DIRECTORY,
} from '#src/store/reset-incident.js';
import { routeOrOpenBackendStoreAtStartup } from '#src/store/startup-store-routing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const priorStoreManifest = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/store-format/approved-prior.manifest.json'), 'utf8'),
) as StoreFormatManifest;
const priorStoreFingerprint = `sha256:${sha256Hex(canonicalContractJson(priorStoreManifest))}`;
const backendBundle = 'selection recovery backend';
const cliBundle = 'selection recovery cli';
const claudeAppserverBundle = 'selection recovery claude appserver';

type StoreEvidence = Record<'store.db' | 'store.db-wal' | 'store.db-shm' | 'store.db.format', Buffer>;

const PRIOR_STORE_SEED_SQL = `
  INSERT INTO events (seq, ts, type, stream_kind, stream_id, body)
  VALUES (1, '2026-08-21T00:00:00.000Z', 'prior.event', 'job', 'prior-job', '{}');
  INSERT INTO projection_jobs (
    job_id, execution_owner, phase, diagnostics, project_root, backend_namespace,
    job_kind, created_at, last_seq
  ) VALUES ('prior-job', '{}', 'terminal', '{}', '/prior', 'prior', 'provider', '2026-08-21T00:00:00.000Z', 1);
  INSERT INTO projection_sessions (session_id, controller, resumable, scope_key, entry, last_seq)
  VALUES ('prior-session', 'provider', 1, 'prior', '{}', 1);
  INSERT INTO projection_discuss (discuss_id, state, last_seq) VALUES ('prior-discuss', '{}', 1);
  INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq)
  VALUES ('prior-workflow', '{}', '{}', 'running', 1);
  UPDATE kb_corpus_state SET
    snapshot_id = 'prior-snapshot', content_seq = 7, metadata_seq = 8,
    content_manifest_hash = 'prior-content', metadata_manifest_hash = 'prior-metadata';
  INSERT INTO consumer_cursors (consumer_id, authority, cursor, registered_at)
  VALUES ('prior-consumer', 'journal', 1, '2026-08-21T00:00:00.000Z');
  INSERT INTO expansion_state (id, version, installed_at)
  VALUES ('prior-expansion', '1.0.0', '2026-08-21T00:00:00.000Z');
  UPDATE kb_curate_scheduler SET
    processed_through_seq = 1, discovery_high_seq = 2, discovery_offset = 1,
    consecutive_claim_failures = 1, consecutive_community_batch_failures = 1, initialized = 1;
  INSERT INTO kb_curate_active_claim (id, through_seq, through_entry_id, through_entry_kind, started_at)
  VALUES (1, 1, 'prior-entry', 'note', '2026-08-21T00:00:00.000Z');
  INSERT INTO kb_curate_retry_queue (entry_id, reason, observed_at, retry_not_before)
  VALUES ('prior-entry', 'prior-reason', '2026-08-21T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
  INSERT INTO kb_curate_conflict_quarantine (entry_id, entry_kind, slug, path, recovery_ref, detected_at)
  VALUES ('prior-conflict', 'note', 'prior', 'notes/prior.md', 'refs/prior', '2026-08-21T00:00:00.000Z');
  INSERT INTO kb_curate_discovery_backlog (entry_id, principle_slug, statement, queued_at)
  VALUES ('prior-discovery', 'prior-principle', 'prior statement', '2026-08-21T00:00:00.000Z');
  INSERT INTO kb_curate_discovery_backlog_notes (backlog_entry_id, note_id)
  VALUES ('prior-discovery', 'prior-note');
  INSERT INTO expansion_manifest_catalog (id, manifest_json, updated_at)
  VALUES ('prior-package', '{}', '2026-08-21T00:00:00.000Z');
  INSERT INTO recovery_quarantine (
    boundary_id, subject_key, state, stage, error_message, disposition_detail, detected_at, updated_at
  ) VALUES (
    'prior-boundary', 'prior-subject', 'active', 'scan', 'prior-error', 'prior-detail',
    '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
  );
  INSERT INTO kb_corpus_authority_baseline_generations (generation_id, committed)
  VALUES ('prior-generation', 1);
  INSERT INTO kb_corpus_authority_baseline_records (generation_id, entry_id, content_hash, metadata_hash)
  VALUES ('prior-generation', 'prior-entry', 'prior-content', 'prior-metadata');
  INSERT INTO kb_corpus_authority_baseline_active (singleton, generation_id)
  VALUES (1, 'prior-generation');
`;

function manifest(version: string, buildSetId: string): StrictBundleManifest {
  return {
    version,
    buildSetId,
    bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
    cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
    claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
    flavor: 'prod',
    storeFormatFingerprint: storeFormat.fingerprint,
  };
}

function selection(expected: StrictBundleManifest, bundleDir: string): ActiveStoreSelection {
  return {
    version: 1,
    manifest: expected,
    bundleDir,
    activeStoreFingerprint: expected.storeFormatFingerprint,
  };
}

function createBundle(parent: string, expected: StrictBundleManifest): string {
  const bundleDir = join(parent, `bundle-${expected.version}-${expected.buildSetId.slice(0, 8)}`);
  mkdirSync(bundleDir, { mode: 0o700 });
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle);
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle);
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle);
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(expected));
  return bundleDir;
}

function harness(): {
  root: string;
  runtime: Runtime;
  currentSelection: ActiveStoreSelection;
  authority: ReturnType<typeof createBackendStoreResetAuthority>;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-active-selection-recovery-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const currentManifest = manifest(storeFormat.productVersion, '123e4567-e89b-42d3-a456-426614174000');
  const currentSelection = selection(currentManifest, createBundle(root, currentManifest));
  const authority = createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: false },
    {
      namespace: 'active-selection-recovery-test',
      storeFormat,
      build: currentManifest,
    },
  );
  return { root, runtime, currentSelection, authority };
}

function publish(runtime: Runtime, record: 'selectionFile' | 'transitionFile', bytes: Uint8Array): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.coordinationRoot, 0o700);
  expect(runtime.storage.writeAtomicDurableSync(paths[record], bytes, { mode: 0o600 })).toBe(true);
}

function createCurrentStore(runtime: Runtime): void {
  openStoreDatabase({
    path: runtime.paths.coral.store.dbFile,
    storage: runtime.storage,
    storeFormat,
    flavor: runtime.flavor,
  }).close();
}

function createNewerStore(runtime: Runtime): void {
  const path = runtime.paths.coral.store.dbFile;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insert.run('store_format_fingerprint', storeFormat.fingerprint);
    insert.run('store_product_version', '99.0.0');
  } finally {
    db.close();
  }
}

function seedPriorFormatStore(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(priorStoreManifest.ddl);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('store_format_fingerprint', priorStoreFingerprint);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('store_product_version', storeFormat.productVersion);
  db.exec(PRIOR_STORE_SEED_SQL);
}

function createPriorFormatStore(runtime: Runtime): StoreEvidence {
  const path = runtime.paths.coral.store.dbFile;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let evidence: StoreEvidence;
  try {
    seedPriorFormatStore(db);
    writeFileSync(`${path}.format`, `${priorStoreFingerprint}\n`);
    evidence = {
      'store.db': readFileSync(path),
      'store.db-wal': readFileSync(`${path}-wal`),
      'store.db-shm': readFileSync(`${path}-shm`),
      'store.db.format': readFileSync(`${path}.format`),
    };
  } finally {
    db.close();
  }
  for (const [name, bytes] of Object.entries(evidence)) {
    writeFileSync(join(dirname(path), name), bytes);
  }
  return evidence;
}

function rowCount(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function tableExists(path: string, table: string): boolean {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  } finally {
    db.close();
  }
}

function newestIncidentManifest(runtime: Runtime) {
  const quarantine = join(runtime.paths.coral.store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const incident = readdirSync(quarantine).filter(isCanonicalStoreResetIncidentId).sort().at(-1);
  if (incident === undefined) throw new Error('Expected a store-reset incident.');
  return parseStoreResetIncidentManifest(readFileSync(join(quarantine, incident, STORE_RESET_MANIFEST_FILE_NAME)));
}

function retainedTransitionEvidencePaths(runtime: Runtime): string[] {
  const root = join(
    runtime.paths.coral.store.dbDir,
    STORE_RESET_QUARANTINE_DIRECTORY,
    'retained-active-store-transitions',
  );
  return readdirSync(root)
    .sort()
    .map((entry) => join(root, entry));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('active-store selection recovery', () => {
  it('should return the shared handoff arm for a valid newer selection without touching the store', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selected = selection(selectedManifest, createBundle(root, selectedManifest));
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
      },
    });

    expect(result.kind).toBe('handoff');
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: selected });
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
  });

  it('should supersede an interrupted transition from an older build and preserve its bytes', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const olderManifest = manifest('0.0.0-rc.1', '223e4567-e89b-42d3-a456-426614174000');
    const olderSelection = selection(olderManifest, createBundle(root, olderManifest));
    const staleTransition: ActiveStoreTransition = {
      version: 1,
      transitionId: '323e4567-e89b-42d3-a456-426614174000',
      kind: 'selection-recovery',
      evidence: { kind: 'selection-absent', storeEvidence: { kind: 'pending-classification' } },
      currentManifest: olderManifest,
      currentBundleDir: olderSelection.bundleDir,
    };
    const staleBytes = encodeActiveStoreTransition(staleTransition);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(olderSelection));
    publish(runtime, 'transitionFile', staleBytes);
    createCurrentStore(runtime);

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
      },
    });

    expect(result.kind).toBe('open');
    if (result.kind === 'open') result.db.close();
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(retainedTransitionEvidencePaths(runtime).map((path) => readFileSync(path))).toContainEqual(
      Buffer.from(staleBytes),
    );
  });

  it('should supersede a newer-build transition before handing off from an older build', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const newerManifest = manifest('99.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const newerSelection = selection(newerManifest, createBundle(root, newerManifest));
    const staleTransition: ActiveStoreTransition = {
      version: 1,
      transitionId: '423e4567-e89b-42d3-a456-426614174000',
      kind: 'selection-recovery',
      evidence: { kind: 'selection-absent', storeEvidence: { kind: 'pending-classification' } },
      currentManifest: newerManifest,
      currentBundleDir: newerSelection.bundleDir,
    };
    const staleBytes = encodeActiveStoreTransition(staleTransition);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(newerSelection));
    publish(runtime, 'transitionFile', staleBytes);
    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
      },
    });

    expect(result.kind).toBe('handoff');
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(retainedTransitionEvidencePaths(runtime).map((path) => readFileSync(path))).toContainEqual(
      Buffer.from(staleBytes),
    );
  });

  it('should supersede a malformed transition instead of refusing startup', async () => {
    const { runtime, currentSelection, authority } = harness();
    const malformedBytes = new TextEncoder().encode('{}');
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', malformedBytes);
    createCurrentStore(runtime);

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
      },
    });

    expect(result.kind).toBe('open');
    if (result.kind === 'open') result.db.close();
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(retainedTransitionEvidencePaths(runtime).map((path) => readFileSync(path))).toContainEqual(
      Buffer.from(malformedBytes),
    );
  });

  it.each(['pruned artifact', 'tampered artifact'] as const)(
    'should recover a %s from a readable store without reset',
    async (failure) => {
      const { root, runtime, currentSelection, authority } = harness();
      const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
      const selectedBundleDir = createBundle(root, selectedManifest);
      const selected = selection(selectedManifest, selectedBundleDir);
      publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));
      if (failure === 'pruned artifact') {
        unlinkSync(join(selectedBundleDir, 'coral-cli.cjs'));
      } else {
        writeFileSync(join(selectedBundleDir, 'coral-backend.cjs'), 'tampered backend');
      }
      createCurrentStore(runtime);

      const result = await routeOrOpenBackendStoreAtStartup({
        runtime,
        authority,
        validateForeignTarget: createForeignTargetValidator(),
        options: {
          storeFormat,
          currentSelection,
        },
      });

      expect(result).toMatchObject({
        kind: 'reset-newer-invalid',
        evidence: { failure: 'adjacent-bundle-mismatch' },
      });
      if (result.kind === 'reset-newer-invalid') result.db.close();
      const retained = retainedTransitionEvidencePaths(runtime).map((path) => JSON.parse(readFileSync(path, 'utf8')));
      expect(retained).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ evidence: expect.objectContaining({ kind: 'valid-target-invalid' }) }),
        ]),
      );
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
      expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    },
  );

  it('should retain the selected manifest when the selected bundle directory was pruned', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selectedBundleDir = createBundle(root, selectedManifest);
    const selected = selection(selectedManifest, selectedBundleDir);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));
    rmSync(selectedBundleDir, { recursive: true, force: true });
    createNewerStore(runtime);

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: { storeFormat, currentSelection },
    });

    expect(result).toMatchObject({
      kind: 'reset-newer-invalid',
      evidence: { failure: 'bundle-dir-unavailable' },
    });
    if (result.kind === 'reset-newer-invalid') result.db.close();
    expect(newestIncidentManifest(runtime)).toMatchObject({
      schemaVersion: 3,
      resetPolicyCause: 'newer-incompatible-invalid-target',
      resetPolicyEvidence: {
        validationFailure: { code: 'bundle-dir-unavailable' },
        observedTarget: {
          version: selectedManifest.version,
          buildSetId: selectedManifest.buildSetId,
          bundleHash: selectedManifest.bundleHash,
          flavor: selectedManifest.flavor,
          storeFormatFingerprint: selectedManifest.storeFormatFingerprint,
        },
      },
    });
  });

  it('should audit a malformed selection and open a readable store', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', new TextEncoder().encode('{malformed'));
    createCurrentStore(runtime);
    const validateForeignTarget: ForeignTargetValidator = vi.fn(() => {
      throw new Error('validator should not run');
    });

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget,
      options: {
        storeFormat,
        currentSelection,
      },
    });

    expect(result.kind).toBe('open');
    if (result.kind === 'open') result.db.close();
    expect(validateForeignTarget).not.toHaveBeenCalled();
    const retained = retainedTransitionEvidencePaths(runtime).map((path) => JSON.parse(readFileSync(path, 'utf8')));
    expect(retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidence: expect.objectContaining({ kind: 'selection-malformed' }) }),
      ]),
    );
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });

  it('should wrap an unreadable store classification in the documented protocol error', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    const failure = Object.assign(new Error('EACCES: permission denied while opening store.db'), { code: 'EACCES' });
    vi.spyOn(dbModule, 'classifyStoreFile').mockImplementation(() => {
      throw failure;
    });

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat,
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'store_corrupt_or_unsupported',
      context: {
        path: runtime.paths.coral.store.dbFile,
        flavor: runtime.flavor,
        cause: failure.message,
      },
    });
  });

  it.each([
    ['absent', 'selection-absent'],
    ['exact', 'current-selection-newer-store'],
  ] as const)('should recover a newer store for an %s selection', async (selectionState, failureCode) => {
    const { runtime, currentSelection, authority } = harness();
    if (selectionState === 'exact') {
      publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    }
    createNewerStore(runtime);

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: { storeFormat, currentSelection },
    });

    expect(result.kind).toBe('open');
    if (result.kind !== 'open') return;
    result.db.close();
    expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(false);
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(newestIncidentManifest(runtime)).toMatchObject({
      schemaVersion: 3,
      resetPolicyCause: 'newer-incompatible-invalid-target',
      resetPolicyEvidence: { validationFailure: { code: failureCode } },
    });
  });

  it('should quarantine the approved prior format, reset every SQL subsystem, and retain orphaned exports', async () => {
    const { runtime, currentSelection, authority } = harness();
    const evidence = createPriorFormatStore(runtime);
    const dbPath = runtime.paths.coral.store.dbFile;
    const originalUnlinkSync = runtime.storage.unlinkSync.bind(runtime.storage);
    let shmAtQuarantine: Buffer | undefined;
    vi.spyOn(runtime.storage, 'unlinkSync').mockImplementation((path) => {
      if (path === `${dbPath}-shm`) shmAtQuarantine = readFileSync(path);
      originalUnlinkSync(path);
    });
    const exportPath = join(runtime.paths.coral.exports.jobsRoot, 'prior-job', 'result.md');
    mkdirSync(dirname(exportPath), { recursive: true });
    writeFileSync(exportPath, 'prior exported result', 'utf8');
    const validateForeignTarget: ForeignTargetValidator = vi.fn(() => {
      throw new Error('startup reset must not require an operator callback');
    });

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget,
      options: { storeFormat, currentSelection },
    });

    expect(result.kind).toBe('open');
    if (result.kind !== 'open') return;
    const db = result.db as DatabaseSync;
    try {
      expect(validateForeignTarget).not.toHaveBeenCalled();
      expect(db.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint'").get()).toEqual({
        value: storeFormat.fingerprint,
      });
      expect(db.prepare("SELECT name FROM pragma_table_info('projection_jobs') WHERE name = 'work_dir'").get()).toEqual(
        { name: 'work_dir' },
      );
      for (const table of [
        'events',
        'projection_jobs',
        'projection_sessions',
        'projection_discuss',
        'projection_workflows',
        'consumer_cursors',
        'expansion_state',
        'expansion_manifest_catalog',
        'kb_curate_active_claim',
        'kb_curate_retry_queue',
        'kb_curate_conflict_quarantine',
        'kb_curate_discovery_backlog',
        'kb_curate_discovery_backlog_notes',
        'recovery_quarantine',
        'kb_corpus_authority_baseline_generations',
        'kb_corpus_authority_baseline_records',
        'kb_corpus_authority_baseline_active',
      ]) {
        expect(rowCount(db, table), table).toBe(0);
      }
      expect(
        db
          .prepare(
            `SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
               FROM kb_corpus_state`,
          )
          .get(),
      ).toEqual({
        snapshot_id: null,
        content_seq: 0,
        metadata_seq: 0,
        content_manifest_hash: null,
        metadata_manifest_hash: null,
      });
      expect(
        db
          .prepare(
            `SELECT processed_through_seq, discovery_high_seq, discovery_offset,
                    consecutive_claim_failures, consecutive_community_batch_failures, initialized
               FROM kb_curate_scheduler`,
          )
          .get(),
      ).toEqual({
        processed_through_seq: null,
        discovery_high_seq: 0,
        discovery_offset: 0,
        consecutive_claim_failures: 0,
        consecutive_community_batch_failures: 0,
        initialized: 0,
      });
    } finally {
      db.close();
    }

    const manifest = newestIncidentManifest(runtime);
    expect(manifest.schemaVersion).toBe(3);
    if (manifest.schemaVersion !== 3) throw new Error('Expected a V3 store-reset incident.');
    expect(manifest.resetPolicyCause).toBe('corrupt-or-unsupported');
    const incidentPath = join(runtime.paths.coral.store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY, manifest.incidentId);
    for (const [name, bytes] of Object.entries(evidence)) {
      const retained = readFileSync(join(incidentPath, name));
      if (name === 'store.db-shm') {
        expect(shmAtQuarantine).toBeDefined();
        expect(retained).toEqual(shmAtQuarantine);
      } else {
        expect(retained, name).toEqual(bytes);
      }
      expect(manifest.files.find((file) => file.name === name)?.sha256).toBe(
        createHash('sha256').update(retained).digest('hex'),
      );
    }
    expect(readFileSync(exportPath, 'utf8')).toBe('prior exported result');
  });

  it('should resume an invalid-target transition before treating the current selection as exact', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const priorSelection = selection(selectedManifest, createBundle(root, selectedManifest));
    unlinkSync(join(priorSelection.bundleDir, 'coral-cli.cjs'));
    const transition: ActiveStoreTransition = {
      version: 1,
      transitionId: '323e4567-e89b-42d3-a456-426614174000',
      kind: 'selection-recovery',
      evidence: {
        kind: 'valid-target-invalid',
        priorSelection,
        invalidTargetEvidence: {
          bundleDir: priorSelection.bundleDir,
          expectedManifest: priorSelection.manifest,
          failure: 'adjacent-bundle-mismatch',
        },
        storeEvidence: { kind: 'pending-classification' },
      },
      currentManifest: currentSelection.manifest,
      currentBundleDir: currentSelection.bundleDir,
    };
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(transition));
    createCurrentStore(runtime);
    const validateForeignTarget: ForeignTargetValidator = vi.fn(() => {
      throw new Error('validator should not run');
    });

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget,
      options: {
        storeFormat,
        currentSelection,
      },
    });

    expect(result).toMatchObject({
      kind: 'reset-newer-invalid',
      evidence: { failure: 'adjacent-bundle-mismatch' },
    });
    if (result.kind === 'reset-newer-invalid') result.db.close();
    expect(validateForeignTarget).not.toHaveBeenCalled();
    expect(retainedTransitionEvidencePaths(runtime)).toHaveLength(1);
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });
});
