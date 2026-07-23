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
import { serializeStoreResetIncidentManifest, type StoreResetIncidentManifestV2 } from '#src/store/reset-incident.js';

const BUNDLE_DIR = process.env.CORAL_E2E_BUNDLE_DIR;
if (!BUNDLE_DIR) throw new Error('CORAL_E2E_BUNDLE_DIR must identify the executing bundle directory.');
const CLI_BUNDLE = join(BUNDLE_DIR, 'coral-cli.cjs');
const BACKEND_BUNDLE = join(BUNDLE_DIR, 'coral-backend.cjs');
const CLAUDE_APPSERVER_BUNDLE = join(BUNDLE_DIR, 'coral-claude-appserver.cjs');
const MANIFEST_PATH = join(BUNDLE_DIR, 'manifest.json');
const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const roots: string[] = [];

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

function readBuildManifest(): BuildManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as BuildManifest;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function quarantineRoot(home: string, build: BuildManifest): string {
  return join(home, '.coral', build.flavor === 'dev' ? 'data-dev' : 'data', 'store', 'store-reset-quarantine');
}

function activeStorePath(home: string, build: BuildManifest): string {
  return join(home, '.coral', build.flavor === 'dev' ? 'data-dev' : 'data', 'store', 'store.db');
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
  home: string,
  args: readonly string[],
  cliBundle = CLI_BUNDLE,
  options: { readonly autostart?: boolean; readonly timeoutMs?: number } = {},
): { readonly stdout: string; readonly stderr: string; readonly status: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: join(home, 'tmp'),
  };
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

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('bundled store-reset CLI', () => {
  it.each(['stopped', 'unhealthy-discovery'])('lists and reports locally with daemon state %s', (daemonState) => {
    const home = root('coral-store-reset-e2e-home-');
    mkdirSync(join(home, 'tmp'));
    if (daemonState !== 'stopped') {
      const stateDir = join(home, '.coral', 'runtime');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'coordinator.json'), daemonState);
    }
    const fixture = writeIncident({ home });

    const list = runCli(home, ['backend', 'store-reset', 'list']);
    expect(list).toEqual({
      stdout:
        `Incident ID | Reset at | Reason | State | Files\n` +
        `${INCIDENT_ID} | 2026-07-23T01:02:03.004Z | mismatch | ready | 1\n\n` +
        'States: ready produces a Markdown report; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.\n' +
        'Next: coral-cli backend store-reset report <ready-incident-id>\n' +
        'For a non-ready incident, run the same report command with its ID and paste the fixed error output into the issue form.\n' +
        'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.\n',
      stderr: '',
      status: 0,
    });

    const report = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID]);
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

  it('surfaces a real reset through the ordinary lazy CLI startup, then lists and reports it', async () => {
    const home = root('coral-store-reset-e2e-running-');
    const temp = join(home, 'tmp');
    mkdirSync(temp);
    const build = readBuildManifest();
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
    const discovery = coordinatorPaths(
      build.flavor,
      { HOME: home, TMPDIR: temp },
      { baseDir: join(home, '.coral') },
    ).infoFile;
    try {
      const trigger = runCli(home, ['abort', '--all'], CLI_BUNDLE, {
        autostart: true,
        timeoutMs: 30_000,
      });
      expect(trigger.status, trigger.stderr).toBe(0);
      expect(trigger.stdout).toBe('No jobs aborted\n');
      expect(trigger.stderr).toContain('Coral startup notice: Backend store format reset required');
      await waitFor(() => existsSync(discovery));
      const list = runCli(home, ['backend', 'store-reset', 'list']);
      expect(list.status, list.stderr).toBe(0);
      const incidentId = list.stdout.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)?.[0];
      expect(incidentId).toBeDefined();
      expect(trigger.stderr).toContain(`coral-cli backend store-reset report ${incidentId}`);

      const report = runCli(home, ['backend', 'store-reset', 'report', incidentId ?? 'missing']);
      expect(report.status, report.stderr).toBe(0);
      expect(report.stdout).toContain('# Coral store-reset incident report\n');
      expect(report.stdout).toContain(`- Incident ID: \`${incidentId}\``);
      expect(report.stderr).toBe('');
      const shutdown = runCli(home, ['backend', 'shutdown']);
      expect(shutdown.status, shutdown.stderr).toBe(0);
      await waitFor(() => !existsSync(discovery));
      const current = new DatabaseSync(storePath, { readOnly: true });
      try {
        expect(current.prepare("SELECT 1 FROM sqlite_master WHERE name = 'private_pre_reset'").get()).toBeUndefined();
      } finally {
        current.close();
      }
    } finally {
      if (existsSync(discovery)) {
        runCli(home, ['backend', 'shutdown']);
        await waitFor(() => !existsSync(discovery));
      }
    }
  });

  it('uses fixed envelopes for invalid IDs, malformed incidents, and wrong-build incidents', () => {
    const home = root('coral-store-reset-e2e-errors-');
    mkdirSync(join(home, 'tmp'));
    const invalid = runCli(home, ['backend', 'store-reset', 'report', '../PRIVATE_ARGUMENT_SENTINEL']);
    expect(invalid).toEqual({
      stdout: '',
      stderr:
        'Incident ID must be a canonical lowercase UUID. [code=invalid_store_reset_incident_id]\n' +
        'remediation: Run `coral-cli backend store-reset list` and use the ID of an incident in the `ready` state.\n',
      status: 2,
    });
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain('PRIVATE_ARGUMENT_SENTINEL');

    writeIncident({ home, malformedManifest: true });
    const malformed = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID]);
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
    const wrongBuild = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID]);
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
    const home = root('coral-store-reset-e2e-probe-argument-');
    const result = runCli(home, ['backend', 'store-reset', 'report', '--', '--print-store-reset-build-identity']);
    expect(result).toEqual({
      stdout: '',
      stderr:
        'Incident ID must be a canonical lowercase UUID. [code=invalid_store_reset_incident_id]\n' +
        'remediation: Run `coral-cli backend store-reset list` and use the ID of an incident in the `ready` state.\n',
      status: 2,
    });
  });

  it('reports corrupt SQLite through fixed diagnostic states without exposing child or database content', () => {
    const home = root('coral-store-reset-e2e-corrupt-');
    mkdirSync(join(home, 'tmp'));
    const fixture = writeIncident({ home, corruptDb: true });
    const report = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID]);

    expect(report.status, report.stderr).toBe(0);
    expect(report.stderr).toBe('');
    expect(report.stdout).toContain('- Integrity: `unavailable`');
    expect(report.stdout).not.toContain('PRIVATE_DB_SENTINEL');
    expect(sha256(readFileSync(fixture.evidencePath))).toBe(fixture.evidenceHash);
  });

  it('fails closed when the executing CLI is paired with a stale adjacent manifest', () => {
    const home = root('coral-store-reset-e2e-mixed-home-');
    const mixedBundle = root('coral-store-reset-e2e-mixed-bundle-');
    mkdirSync(join(home, 'tmp'));
    copyFileSync(CLI_BUNDLE, join(mixedBundle, 'coral-cli.cjs'));
    copyFileSync(BACKEND_BUNDLE, join(mixedBundle, 'coral-backend.cjs'));
    copyFileSync(CLAUDE_APPSERVER_BUNDLE, join(mixedBundle, 'coral-claude-appserver.cjs'));
    const manifest = readBuildManifest();
    writeFileSync(join(mixedBundle, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const coherent = runCli(home, ['backend', 'store-reset', 'list'], join(mixedBundle, 'coral-cli.cjs'));
    expect(coherent.status, coherent.stderr).toBe(0);

    writeFileSync(
      join(mixedBundle, 'manifest.json'),
      `${JSON.stringify({
        ...manifest,
        buildSetId: '423e4567-e89b-42d3-a456-426614174000',
      })}\n`,
    );

    const result = runCli(home, ['backend', 'store-reset', 'list'], join(mixedBundle, 'coral-cli.cjs'));
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
