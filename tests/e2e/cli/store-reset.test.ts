import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { serializeStoreResetIncidentManifest, type StoreResetIncidentManifestV2 } from '#src/store/reset-incident.js';
import { e2eBundleDir } from '#tests/support/e2e-bundle-dir.js';
import { createTemporaryHomeOwner, type TemporaryHome } from '#tests/support/temporary-home-lifecycle.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const BUNDLE_DIR = e2eBundleDir();
const CLI_BUNDLE = join(BUNDLE_DIR, 'coral-cli.cjs');
const BACKEND_BUNDLE = join(BUNDLE_DIR, 'coral-backend.cjs');
const CLAUDE_APPSERVER_BUNDLE = join(BUNDLE_DIR, 'coral-claude-appserver.cjs');
const DURABLE_WRAPPER_BUNDLE = join(BUNDLE_DIR, 'coral-durable-wrapper.cjs');
const LEGACY_MANIFEST_PATH = join(BUNDLE_DIR, 'manifest.json');
const MANIFEST_PATH = join(BUNDLE_DIR, CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const roots: string[] = [];
const syntheticDiscoveryFiles: string[] = [];
const temporaryHomes = createTemporaryHomeOwner();

type BuildManifest = {
  readonly version: string;
  readonly buildSetId: string;
  readonly bundleHash: string;
  readonly cliBundleHash: string;
  readonly claudeAppserverBundleHash: string;
  readonly durableWrapperBundleHash: string;
  readonly flavor: 'dev' | 'prod';
  readonly storeFormatFingerprint: string;
};

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function temporaryHome(prefix: string): TemporaryHome {
  return temporaryHomes.create(prefix, readBuildManifest().flavor);
}

function readBuildManifest(): BuildManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as BuildManifest;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// The current generation lives under `gen2`; a pre-boundary build's tree is the
// legacy one and is inspection-only. These fixtures are the current generation, so
// every store-reset invocation below passes `--target gen2` — the canonical token
// the CLI echoes back in its guidance, which these tests assert verbatim.
function generationDataRoot(home: string, build: BuildManifest): string {
  return join(home, '.coral', 'gen2', build.flavor === 'dev' ? 'data-dev' : 'data');
}

function quarantineRoot(home: string, build: BuildManifest): string {
  return join(generationDataRoot(home, build), 'store', 'store-reset-quarantine');
}

function activeStorePath(home: string, build: BuildManifest): string {
  return join(generationDataRoot(home, build), 'store', 'store.db');
}

function epochStorePath(home: string, build: BuildManifest, epoch: number): string {
  const storeDir = dirname(activeStorePath(home, build));
  return epoch === 0 ? join(storeDir, 'store.db') : join(storeDir, `epoch-${epoch}`, 'store.db');
}

function storeHasTable(path: string, table: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table) !== undefined;
  } finally {
    db.close();
  }
}

function storeMetadataValue(path: string, key: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } finally {
    db.close();
  }
}

function fileTreeSnapshot(root: string): readonly Readonly<{ path: string; bytes: Buffer }>[] {
  const snapshot: Array<Readonly<{ path: string; bytes: Buffer }>> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else snapshot.push({ path: path.slice(root.length + 1), bytes: readFileSync(path) });
    }
  };
  visit(root);
  return snapshot;
}

function createCrashedWalStore(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const crashed = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec(\"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES ('untouched');\"); process.kill(process.pid, 'SIGKILL');",
      path,
    ],
    { encoding: 'utf-8' },
  );
  expect(crashed.signal).toBe('SIGKILL');
  rmSync(`${path}-shm`, { force: true });
}

function writeIncident(options: {
  readonly home: string;
  readonly build?: BuildManifest;
  readonly corruptDb?: boolean;
  readonly malformedManifest?: boolean;
}): { readonly incidentPath: string; readonly evidencePath: string; readonly evidenceHash: string } {
  const currentBuild = readBuildManifest();
  const recordedBuild = options.build ?? currentBuild;
  const incidentPath = join(quarantineRoot(options.home, currentBuild), INCIDENT_ID);
  mkdirSync(incidentPath, { recursive: true, mode: 0o700 });
  const evidencePath = join(incidentPath, 'store.db');
  if (options.corruptDb) {
    writeFileSync(evidencePath, 'not a SQLite database PRIVATE_DB_SENTINEL', { mode: 0o600 });
  } else {
    const db = new DatabaseSync(evidencePath);
    db.exec("CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES ('PRIVATE_DB_SENTINEL');");
    db.close();
  }
  const evidence = readFileSync(evidencePath);
  const stat = statSync(evidencePath);
  const manifest: StoreResetIncidentManifestV2 = {
    schemaVersion: 2,
    incidentId: INCIDENT_ID,
    resetAt: '2026-07-23T01:02:03.004Z',
    reason: 'mismatch',
    storedFingerprint: `sha256:${'a'.repeat(64)}`,
    expectedFingerprint: recordedBuild.storeFormatFingerprint,
    build: {
      version: recordedBuild.version,
      buildSetId: recordedBuild.buildSetId,
      backendBundleHash: recordedBuild.bundleHash,
      flavor: recordedBuild.flavor,
    },
    runtime: {
      namespace: 'PRIVATE_NAMESPACE_SENTINEL',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      processId: process.pid,
    },
    handoff: { acquiredViaHandoff: false },
    files: [
      {
        name: 'store.db',
        sizeBytes: evidence.length,
        mtimeMs: stat.mtimeMs,
        sha256: sha256(evidence),
      },
    ],
  };
  writeFileSync(
    join(incidentPath, 'reset-manifest.json'),
    options.malformedManifest
      ? '{"schemaVersion":2,"PRIVATE_UNKNOWN_SENTINEL":"'
      : serializeStoreResetIncidentManifest(manifest),
    { mode: 0o600 },
  );
  return { incidentPath, evidencePath, evidenceHash: sha256(evidence) };
}

function runCli(
  home: TemporaryHome,
  args: readonly string[],
  cliBundle = CLI_BUNDLE,
  options: { readonly autostart?: boolean; readonly timeoutMs?: number } = {},
): { readonly stdout: string; readonly stderr: string; readonly status: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...temporaryHomes.environment(home),
    TMPDIR: join(home, 'tmp'),
  };
  delete env.CORAL_CHILD;
  delete env.CORAL_CHILD_PRINCIPAL_HANDLE;
  delete env.CORAL_JOB_ID;
  delete env.CORAL_SESSION_ID;
  if (options.autostart === true) {
    delete env.CORAL_BACKEND_DISABLE_AUTOSTART;
  } else {
    env.CORAL_BACKEND_DISABLE_AUTOSTART = '1';
  }
  const result = spawnSync(process.execPath, [cliBundle, ...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 12_000,
    env,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

afterEach(async () => {
  for (const path of syntheticDiscoveryFiles.splice(0)) {
    rmSync(path, { force: true });
  }
  await temporaryHomes.cleanup();
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('bundled store-reset CLI', () => {
  it('refuses to smoke-open an epoch directory symlinked to the legacy tree', () => {
    const build = readBuildManifest();
    const home = temporaryHome('coral-smoke-symlinked-epoch-');
    mkdirSync(join(home, 'tmp'));
    const dbDir = dirname(activeStorePath(home, build));
    const legacyRoot = root('coral-smoke-symlinked-legacy-');
    const legacyStore = join(legacyRoot, 'store.db');
    mkdirSync(dbDir, { recursive: true });
    const store = new DatabaseSync(legacyStore);
    store.exec(
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('store_format_fingerprint', '${build.storeFormatFingerprint}')`,
    );
    store.close();
    symlinkSync(legacyRoot, join(dbDir, 'epoch-1'));
    const before = readFileSync(legacyStore);

    const result = spawnSync(
      process.execPath,
      [BACKEND_BUNDLE, '--smoke-open-store', '--path', join(dbDir, 'epoch-1', 'store.db')],
      {
        encoding: 'utf-8',
        env: { ...process.env, ...temporaryHomes.environment(home), TMPDIR: join(home, 'tmp') },
      },
    );

    console.log(
      `smoke-symlinked-epoch-cell status=${result.status} legacy-lock=${existsSync(join(legacyRoot, '.lock')) ? 'created' : 'absent'} product-version=${storeMetadataValue(legacyStore, 'store_product_version') ?? 'absent'}`,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(existsSync(join(legacyRoot, '.lock'))).toBe(false);
    expect(storeMetadataValue(legacyStore, 'store_product_version')).toBeNull();
    expect(readFileSync(legacyStore)).toEqual(before);
  });

  it('refuses to smoke-open the legacy flat store through the built backend bundle', () => {
    const build = readBuildManifest();
    const home = temporaryHome('coral-smoke-flat-refusal-');
    mkdirSync(join(home, 'tmp'));
    const storePath = activeStorePath(home, build);
    mkdirSync(dirname(storePath), { recursive: true });
    const store = new DatabaseSync(storePath);
    store.exec(
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('store_format_fingerprint', '${build.storeFormatFingerprint}')`,
    );
    store.close();
    const before = readFileSync(storePath);
    const result = spawnSync(process.execPath, [BACKEND_BUNDLE, '--smoke-open-store', '--path', storePath], {
      encoding: 'utf-8',
      env: { ...process.env, ...temporaryHomes.environment(home), TMPDIR: join(home, 'tmp') },
    });

    console.log(
      `smoke-flat-refusal-cell status=${result.status} product-version=${storeMetadataValue(storePath, 'store_product_version') ?? 'absent'}`,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('path is not a proven canonical positive store epoch');
    expect(storeMetadataValue(storePath, 'store_product_version')).toBeNull();
    expect(readFileSync(storePath)).toEqual(before);
  });

  it.each(['store.db', '.lock'] as const)(
    'refuses to smoke-open an epoch whose required %s has another hard link',
    (artifact) => {
      const build = readBuildManifest();
      const home = temporaryHome(`coral-smoke-hardlinked-${artifact.replace('.', '')}-`);
      mkdirSync(join(home, 'tmp'));
      const discard = runCli(home, ['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', build.flavor]);
      expect(discard.status, discard.stderr).toBe(0);
      const epochPath = epochStorePath(home, build, 1);
      const artifactPath = join(dirname(epochPath), artifact);
      const alias = join(root(`coral-smoke-hardlink-alias-${artifact.replace('.', '')}-`), artifact);
      linkSync(artifactPath, alias);
      const before = readFileSync(artifactPath);

      const result = spawnSync(process.execPath, [BACKEND_BUNDLE, '--smoke-open-store', '--path', epochPath], {
        encoding: 'utf-8',
        env: { ...process.env, ...temporaryHomes.environment(home), TMPDIR: join(home, 'tmp') },
      });

      console.log(
        `smoke-hardlink-cell artifact=${artifact} status=${result.status} nlink=${statSync(artifactPath).nlink} byte-identical=${readFileSync(artifactPath).equals(before)}`,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(readFileSync(artifactPath)).toEqual(before);
    },
  );

  it.each(['residue', 'holder'] as const)(
    'keeps an external crashed WAL tree byte-identical while built list inspects an aliased %s root',
    (kind) => {
      const build = readBuildManifest();
      const home = temporaryHome(`coral-list-aliased-${kind}-`);
      mkdirSync(join(home, 'tmp'));
      const dbDir = dirname(activeStorePath(home, build));
      mkdirSync(dbDir, { recursive: true });
      const external = root(`coral-list-aliased-${kind}-external-`);
      createCrashedWalStore(join(external, '.lock'));
      if (kind === 'residue') {
        symlinkSync(external, join(dbDir, '.reaping-alias'));
      } else {
        symlinkSync(external, join(dbDir, 'epoch-1'));
        writeFileSync(join(dbDir, '.epoch-holder-alias.json'), JSON.stringify({ epoch: '1', pid: process.pid }));
      }
      const before = fileTreeSnapshot(external);

      const list = runCli(home, ['backend', 'store-reset', 'list', '--target', 'gen2']);
      const after = fileTreeSnapshot(external);

      console.log(
        `built-list-alias-cell kind=${kind} status=${list.status} byte-identical=${JSON.stringify(after) === JSON.stringify(before)}`,
      );
      expect(list.status, list.stderr).toBe(0);
      expect(after).toEqual(before);
    },
  );

  it.each(
    (['store-reset-list', 'store-reset-report', 'recovery-quarantine-list'] as const).flatMap((surface) =>
      (['canonical', 'crashed-wal-lock', 'malformed-metadata'] as const).map((state) => ({ surface, state })),
    ),
  )('keeps the complete epoch namespace byte-identical while built $surface inspects $state', ({ surface, state }) => {
    const build = readBuildManifest();
    const home = temporaryHome('coral-rpt-');
    mkdirSync(join(home, 'tmp'));
    const discard = runCli(home, ['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', build.flavor]);
    expect(discard.status, discard.stderr).toBe(0);
    const dbDir = dirname(activeStorePath(home, build));
    if (state === 'crashed-wal-lock') createCrashedWalStore(join(dbDir, 'epoch-1', '.lock'));
    if (state === 'malformed-metadata') writeFileSync(join(dbDir, 'epoch-1', 'epoch.json'), '{');
    const before = fileTreeSnapshot(dbDir);

    const invocation =
      surface === 'store-reset-list'
        ? ['backend', 'store-reset', 'list', '--target', 'gen2']
        : surface === 'store-reset-report'
          ? ['backend', 'store-reset', 'report', '1', '--target', 'gen2']
          : ['backend', 'recovery-quarantine', 'list'];
    const result = runCli(home, invocation);
    const after = fileTreeSnapshot(dbDir);

    console.log(
      `built-reporting-byte-identity-cell surface=${surface} state=${state} status=${result.status} byte-identical=${JSON.stringify(after) === JSON.stringify(before)}`,
    );
    if (surface === 'recovery-quarantine-list' && state === 'malformed-metadata') {
      expect(result.status).not.toBe(0);
    } else {
      expect(result.status, result.stderr).toBe(0);
    }
    expect(after).toEqual(before);
  });

  it.each(['absent-root', 'empty-root'] as const)('initializes epoch one on discard with %s', (state) => {
    const build = readBuildManifest();
    const home = temporaryHome(`coral-store-reset-discard-${state}-`);
    mkdirSync(join(home, 'tmp'));
    if (state === 'empty-root') mkdirSync(dirname(activeStorePath(home, build)), { recursive: true });

    const result = runCli(home, ['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', build.flavor]);

    console.log(
      `discard-no-epoch-cell state=${state} status=${result.status} stdout=${JSON.stringify(result.stdout.trim())} stderr=${JSON.stringify(result.stderr.trim())}`,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Initialized store epoch 1');
    expect(result.stdout).not.toContain('null');
    expect(existsSync(epochStorePath(home, build, 1))).toBe(true);
  });

  it.each(['stopped', 'unhealthy-discovery'])('lists and reports locally with daemon state %s', (daemonState) => {
    const home = temporaryHome('coral-store-reset-e2e-home-');
    mkdirSync(join(home, 'tmp'));
    if (daemonState !== 'stopped') {
      const stateDir = join(home, '.coral', 'runtime');
      mkdirSync(stateDir, { recursive: true });
      const discoveryFile = join(stateDir, 'coordinator.json');
      writeFileSync(discoveryFile, daemonState);
      syntheticDiscoveryFiles.push(discoveryFile);
    }
    const fixture = writeIncident({ home });

    const list = runCli(home, ['backend', 'store-reset', 'list', '--target', 'gen2']);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stderr).toBe('');
    expect(list.stdout).toContain(
      'Epoch | Role | Bytes | Publication reason | Superseded store Coral version | Epoch metadata\n',
    );
    expect(list.stdout).toContain('Legacy incident ID | State | Reset at | Reason | Files | Bytes\n');
    expect(list.stdout).toContain(`${INCIDENT_ID} | ready | 2026-07-23T01:02:03.004Z | mismatch | 1 |`);
    expect(list.stdout).toContain('Legacy ready incidents remain reportable.\n');
    expect(list.stdout).toContain('command=coral-cli backend store-reset report --target gen2 <ready-incident-id>\n');
    expect(list.stdout).toContain(
      'command=coral-cli backend store-reset release --target gen2 --flavor <prod|dev> <epoch>\n',
    );

    const report = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID, '--target', 'gen2']);
    expect(report.status, report.stderr).toBe(0);
    expect(report.stderr).toBe('');
    expect(report.stdout).toContain('# Coral store-reset incident report\n');
    expect(report.stdout).toContain('- Integrity: `ok`');
    expect(report.stdout).toContain('Paste this complete output into the Store-reset incident issue form');
    expect(report.stdout).not.toContain(home);
    expect(report.stdout).not.toContain('PRIVATE_DB_SENTINEL');
    expect(report.stdout).not.toContain('PRIVATE_NAMESPACE_SENTINEL');
    expect(sha256(readFileSync(fixture.evidencePath))).toBe(fixture.evidenceHash);
  });

  it('publishes epochs for automatic replacement, discard, and release without changing the flat store', async () => {
    const build = readBuildManifest();
    const home = temporaryHomes.create('coral-store-reset-e2e-running-', build.flavor);
    const temp = join(home, 'tmp');
    mkdirSync(temp);
    const storePath = activeStorePath(home, build);
    mkdirSync(dirname(storePath), { recursive: true });
    const old = new DatabaseSync(storePath);
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('store_format_fingerprint', 'sha256:${'0'.repeat(64)}');
      CREATE TABLE private_pre_reset(value TEXT);
      INSERT INTO private_pre_reset VALUES ('PRIVATE_DB_SENTINEL');
    `);
    old.close();
    const discovery = coordinatorPaths(build.flavor, { baseDir: join(home, '.coral') }).infoFile;
    const automatic = runCli(home, ['abort', '--all'], CLI_BUNDLE, {
      autostart: true,
      timeoutMs: 30_000,
    });
    expect(automatic.status, automatic.stderr).toBe(0);
    expect(`${automatic.stdout}${automatic.stderr}`).not.toContain('store-reset discard');
    expect(storeHasTable(epochStorePath(home, build, 0), 'private_pre_reset')).toBe(true);
    expect(storeHasTable(epochStorePath(home, build, 1), 'private_pre_reset')).toBe(false);

    const list = runCli(home, ['backend', 'store-reset', 'list', '--target', 'gen2']);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/^1 \| current \|/m);
    expect(list.stdout).not.toMatch(/^0 \|/m);
    expect(list.stdout).not.toContain('Legacy incident ID');

    const publicOutput = `${automatic.stdout}${automatic.stderr}${list.stdout}${list.stderr}`;
    expect(publicOutput).not.toContain('PRIVATE_DB_SENTINEL');
    expect(publicOutput).not.toContain('PRIVATE_NAMESPACE_SENTINEL');
    expect(publicOutput).not.toContain(home);

    const shutdown = runCli(home, ['backend', 'shutdown']);
    expect(shutdown.status, shutdown.stderr).toBe(0);
    await waitForCondition(() => !existsSync(discovery));

    const epochOnePath = epochStorePath(home, build, 1);
    const unsupported = new DatabaseSync(epochOnePath);
    unsupported.exec(`
      UPDATE meta SET value = 'sha256:${'0'.repeat(64)}' WHERE key = 'store_format_fingerprint';
      CREATE TABLE private_pre_reset(value TEXT);
      INSERT INTO private_pre_reset VALUES ('PRIVATE_DB_SENTINEL');
    `);
    unsupported.close();

    const discard = runCli(home, ['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', build.flavor]);
    expect(discard.status, discard.stderr).toBe(0);
    expect(discard.stdout).toContain('Discarded store epoch 1; initialized epoch 2');
    expect(storeHasTable(epochOnePath, 'private_pre_reset')).toBe(true);
    expect(storeHasTable(epochStorePath(home, build, 2), 'private_pre_reset')).toBe(false);
    expect(existsSync(epochStorePath(home, build, 0))).toBe(true);

    const release = runCli(home, [
      'backend',
      'store-reset',
      'release',
      '1',
      '--target',
      'gen2',
      '--flavor',
      build.flavor,
    ]);
    expect(release.status, release.stderr).toBe(0);
    expect(release.stdout).toContain('Released store epoch 1');
    expect(existsSync(epochOnePath)).toBe(false);
    console.log('ordinary-release-cell fabricated-discovery=false target=epoch-1 released=true');
  });

  it('sweeps after discovery publication across clean reset cycles', async () => {
    const build = readBuildManifest();
    const home = temporaryHomes.create('coral-store-reset-e2e-cycles-', build.flavor);
    mkdirSync(join(home, 'tmp'));
    const storePath = activeStorePath(home, build);
    mkdirSync(dirname(storePath), { recursive: true });
    const initial = new DatabaseSync(storePath);
    initial.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('store_format_fingerprint', 'sha256:${'0'.repeat(64)}');
    `);
    initial.close();
    const discovery = coordinatorPaths(build.flavor, { baseDir: join(home, '.coral') }).infoFile;
    const cycles = 4;

    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const start = runCli(home, ['abort', '--all'], CLI_BUNDLE, { autostart: true, timeoutMs: 30_000 });
      expect(start.status, start.stderr).toBe(0);
      const shutdown = runCli(home, ['backend', 'shutdown']);
      expect(shutdown.status, shutdown.stderr).toBe(0);
      await waitForCondition(() => !existsSync(discovery));
      if (cycle < cycles) {
        const current = new DatabaseSync(epochStorePath(home, build, cycle));
        current.exec(`UPDATE meta SET value = 'sha256:${'0'.repeat(64)}' WHERE key = 'store_format_fingerprint'`);
        current.close();
      }
    }

    const epochEntries = readdirSync(dirname(storePath))
      .filter((name) => /^epoch-\d+$/u.test(name))
      .sort();
    expect(epochEntries).toEqual(['epoch-3', 'epoch-4']);
    console.log(`lifecycle-ordering-cell K=${cycles} current=4 preserved=3 garbage=0`);
  });

  it('uses fixed envelopes for invalid IDs, malformed incidents, and wrong-build incidents', () => {
    const home = temporaryHome('coral-store-reset-e2e-errors-');
    mkdirSync(join(home, 'tmp'));
    const invalid = runCli(home, [
      'backend',
      'store-reset',
      'report',
      '../PRIVATE_ARGUMENT_SENTINEL',
      '--target',
      'gen2',
    ]);
    expect(invalid).toEqual({
      stdout: '',
      stderr:
        'Report target must be a positive numeric epoch or canonical lowercase legacy incident UUID. [code=invalid_store_reset_incident_id]\n' +
        'remediation: Run `coral-cli backend store-reset list --target <legacy|gen2>` and use a listed epoch or the ID of a legacy incident in the `ready` state.\n',
      status: 2,
    });
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain('PRIVATE_ARGUMENT_SENTINEL');

    writeIncident({ home, malformedManifest: true });
    const malformed = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID, '--target', 'gen2']);
    expect(malformed).toEqual({
      stdout: '',
      stderr:
        'Store-reset reporting failed. [code=store_reset_reporting_failed]\n' +
        'remediation: Retry once. If it still fails, file a Store-reset incident issue with this fixed error output; do not move, restore, delete, or attach DB, WAL, SHM, or raw logs.\n',
      status: 70,
    });

    rmSync(quarantineRoot(home, readBuildManifest()), { recursive: true, force: true });
    const current = readBuildManifest();
    writeIncident({
      home,
      build: {
        ...current,
        buildSetId: '323e4567-e89b-42d3-a456-426614174000',
      },
    });
    const wrongBuild = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID, '--target', 'gen2']);
    expect(wrongBuild).toEqual({
      stdout: '',
      stderr:
        'The retained incident belongs to a different Coral build set and cannot be reported by this build. ' +
        '[code=store_reset_incident_build_mismatch]\n' +
        'remediation: Keep the incident in place and file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.\n',
      status: 70,
    });
  });

  it('does not treat the hidden identity probe as an ordinary command argument', () => {
    const home = temporaryHome('coral-store-reset-e2e-probe-argument-');
    const result = runCli(home, [
      'backend',
      'store-reset',
      'report',
      '--target',
      'gen2',
      '--',
      '--print-store-reset-build-identity',
    ]);
    expect(result).toEqual({
      stdout: '',
      stderr:
        'Report target must be a positive numeric epoch or canonical lowercase legacy incident UUID. [code=invalid_store_reset_incident_id]\n' +
        'remediation: Run `coral-cli backend store-reset list --target <legacy|gen2>` and use a listed epoch or the ID of a legacy incident in the `ready` state.\n',
      status: 2,
    });
  });

  it('reports corrupt SQLite through fixed diagnostic states without exposing child or database content', () => {
    const home = temporaryHome('coral-store-reset-e2e-corrupt-');
    mkdirSync(join(home, 'tmp'));
    const fixture = writeIncident({ home, corruptDb: true });
    const report = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID, '--target', 'gen2']);

    expect(report.status, report.stderr).toBe(0);
    expect(report.stderr).toBe('');
    expect(report.stdout).toContain('- Integrity: `unavailable`');
    expect(report.stdout).not.toContain('PRIVATE_DB_SENTINEL');
    expect(sha256(readFileSync(fixture.evidencePath))).toBe(fixture.evidenceHash);
  });

  it('fails closed when the executing CLI is paired with a stale adjacent manifest', () => {
    const home = temporaryHome('coral-store-reset-e2e-mixed-home-');
    const mixedBundle = root('coral-store-reset-e2e-mixed-bundle-');
    mkdirSync(join(home, 'tmp'));
    copyFileSync(CLI_BUNDLE, join(mixedBundle, 'coral-cli.cjs'));
    copyFileSync(BACKEND_BUNDLE, join(mixedBundle, 'coral-backend.cjs'));
    copyFileSync(CLAUDE_APPSERVER_BUNDLE, join(mixedBundle, 'coral-claude-appserver.cjs'));
    copyFileSync(DURABLE_WRAPPER_BUNDLE, join(mixedBundle, 'coral-durable-wrapper.cjs'));
    copyFileSync(LEGACY_MANIFEST_PATH, join(mixedBundle, 'manifest.json'));
    const manifest = readBuildManifest();
    writeFileSync(join(mixedBundle, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    const coherent = runCli(
      home,
      ['backend', 'store-reset', 'list', '--target', 'gen2'],
      join(mixedBundle, 'coral-cli.cjs'),
    );
    expect(coherent.status, coherent.stderr).toBe(0);

    writeFileSync(
      join(mixedBundle, CURRENT_STRICT_BUNDLE_MANIFEST_FILE),
      `${JSON.stringify({
        ...manifest,
        buildSetId: '423e4567-e89b-42d3-a456-426614174000',
      })}\n`,
    );

    const result = runCli(
      home,
      ['backend', 'store-reset', 'list', '--target', 'gen2'],
      join(mixedBundle, 'coral-cli.cjs'),
    );
    expect(result).toEqual({
      stdout: '',
      stderr:
        'Store-reset reporting is unavailable because the installed build artifacts do not match. ' +
        '[code=store_reset_build_mismatch]\n' +
        'remediation: Reinstall or update Coral through the same install method without deleting Coral data, then retry. If it persists, file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.\n',
      status: 70,
    });
  });
});
