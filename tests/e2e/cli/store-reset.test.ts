import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import {
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  type StoreResetIncidentManifestV2,
} from '#src/store/reset-incident.js';
import { e2eBundleDir } from '#tests/support/e2e-bundle-dir.js';
import { createTemporaryHomeOwner, type TemporaryHome } from '#tests/support/temporary-home-lifecycle.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const BUNDLE_DIR = e2eBundleDir();
const CLI_BUNDLE = join(BUNDLE_DIR, 'coral-cli.cjs');
const BACKEND_BUNDLE = join(BUNDLE_DIR, 'coral-backend.cjs');
const CLAUDE_APPSERVER_BUNDLE = join(BUNDLE_DIR, 'coral-claude-appserver.cjs');
const MANIFEST_PATH = join(BUNDLE_DIR, 'manifest.json');
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
    expect(list).toEqual({
      stdout:
        `Incident ID | Reset at | Schema | Reason | Reset policy | State | Files\n` +
        `${INCIDENT_ID} | 2026-07-23T01:02:03.004Z | V2 | mismatch | legacy-v2 | ready | 1\n\n` +
        'States: ready produces a Markdown report; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.\n' +
        'Next: coral-cli backend store-reset report --target gen2 <ready-incident-id>\n' +
        'For a non-ready incident, run the same report command with its ID and paste the fixed error output into the issue form.\n' +
        'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.\n',
      stderr: '',
      status: 0,
    });

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

  it('automatically resets an unsupported store and retains its incident without operator action', async () => {
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
    const hasPreResetTable = (): boolean => {
      const db = new DatabaseSync(storePath, { readOnly: true });
      try {
        return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'private_pre_reset'").get() !== undefined;
      } finally {
        db.close();
      }
    };
    const automatic = runCli(home, ['abort', '--all'], CLI_BUNDLE, {
      autostart: true,
      timeoutMs: 30_000,
    });
    expect(automatic.status, automatic.stderr).toBe(0);
    expect(`${automatic.stdout}${automatic.stderr}`).not.toContain('store-reset discard');
    expect(hasPreResetTable()).toBe(false);

    const list = runCli(home, ['backend', 'store-reset', 'list', '--target', 'gen2']);
    expect(list.status, list.stderr).toBe(0);
    const incidentIds = list.stdout.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g) ?? [];
    expect(incidentIds).toHaveLength(1);
    const incidentId = incidentIds[0] ?? 'missing';

    const report = runCli(home, ['backend', 'store-reset', 'report', incidentId, '--target', 'gen2']);
    expect(report.status, report.stderr).toBe(0);
    expect(report.stdout).toContain('# Coral store-reset incident report\n');
    expect(report.stdout).toContain(`- Incident ID: \`${incidentId}\``);

    const incidentPath = join(quarantineRoot(home, build), incidentId);
    const manifest = parseStoreResetIncidentManifest(readFileSync(join(incidentPath, 'reset-manifest.json')));
    expect(manifest.schemaVersion).toBe(3);
    if (manifest.schemaVersion !== 3) throw new Error('Automatic reset must publish a V3 incident.');
    expect(manifest.resetPolicyCause).toBe('corrupt-or-unsupported');
    const evidence = manifest.files.find((file) => file.name === 'store.db');
    expect(evidence).toBeDefined();
    expect(sha256(readFileSync(join(incidentPath, 'store.db')))).toBe(evidence?.sha256);

    const publicOutput = `${automatic.stdout}${automatic.stderr}${list.stdout}${list.stderr}${report.stdout}${report.stderr}`;
    expect(publicOutput).not.toContain('PRIVATE_DB_SENTINEL');
    expect(publicOutput).not.toContain('PRIVATE_NAMESPACE_SENTINEL');
    expect(publicOutput).not.toContain(home);

    const shutdown = runCli(home, ['backend', 'shutdown']);
    expect(shutdown.status, shutdown.stderr).toBe(0);
    await waitForCondition(() => !existsSync(discovery));

    const unsupported = new DatabaseSync(storePath);
    unsupported.exec(`
      UPDATE meta SET value = 'sha256:${'0'.repeat(64)}' WHERE key = 'store_format_fingerprint';
      CREATE TABLE private_pre_reset(value TEXT);
      INSERT INTO private_pre_reset VALUES ('PRIVATE_DB_SENTINEL');
    `);
    unsupported.close();

    const discard = runCli(home, ['backend', 'store-reset', 'discard', '--target', 'gen2', '--flavor', build.flavor]);
    expect(discard.status, discard.stderr).toBe(0);
    expect(discard.stdout).toContain('Quarantined store-reset incident');
    expect(hasPreResetTable()).toBe(false);
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
        'Incident ID must be a canonical lowercase UUID. [code=invalid_store_reset_incident_id]\n' +
        'remediation: Run `coral-cli backend store-reset list --target <legacy|gen2>` and use the ID of an incident in the `ready` state.\n',
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
        'Incident ID must be a canonical lowercase UUID. [code=invalid_store_reset_incident_id]\n' +
        'remediation: Run `coral-cli backend store-reset list --target <legacy|gen2>` and use the ID of an incident in the `ready` state.\n',
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
    const manifest = readBuildManifest();
    writeFileSync(join(mixedBundle, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const coherent = runCli(
      home,
      ['backend', 'store-reset', 'list', '--target', 'gen2'],
      join(mixedBundle, 'coral-cli.cjs'),
    );
    expect(coherent.status, coherent.stderr).toBe(0);

    writeFileSync(
      join(mixedBundle, 'manifest.json'),
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
