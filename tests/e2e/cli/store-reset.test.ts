import { spawn, spawnSync } from 'node:child_process';
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
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { serializeStoreResetIncidentManifest, type StoreResetIncidentManifestV2 } from '#src/store/reset-incident.js';

const BUNDLE_DIR = process.env.CORAL_E2E_BUNDLE_DIR;
if (!BUNDLE_DIR) throw new Error('CORAL_E2E_BUNDLE_DIR must identify the executing bundle directory.');
const CLI_BUNDLE = join(BUNDLE_DIR, 'coral-cli.cjs');
const BACKEND_BUNDLE = join(BUNDLE_DIR, 'coral-backend.cjs');
const MANIFEST_PATH = join(BUNDLE_DIR, 'manifest.json');
const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const roots: string[] = [];

type BuildManifest = {
  readonly version: string;
  readonly buildSetId: string;
  readonly bundleHash: string;
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
): { readonly stdout: string; readonly stderr: string; readonly status: number } {
  const result = spawnSync(process.execPath, [cliBundle, ...args], {
    encoding: 'utf8',
    timeout: 12_000,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: join(home, 'tmp'),
      CORAL_BACKEND_DISABLE_AUTOSTART: '1',
    },
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
        `${INCIDENT_ID} | 2026-07-23T01:02:03.004Z | mismatch | ready | 1\n`,
      stderr: '',
      status: 0,
    });

    const report = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID]);
    expect(report.status, report.stderr).toBe(0);
    expect(report.stderr).toBe('');
    expect(report.stdout).toContain('# Coral store-reset incident report\n');
    expect(report.stdout).toContain('- Integrity: `ok`');
    expect(report.stdout).not.toContain(home);
    expect(report.stdout).not.toContain('PRIVATE_DB_SENTINEL');
    expect(report.stdout).not.toContain('PRIVATE_NAMESPACE_SENTINEL');
    expect(sha256(readFileSync(fixture.evidencePath))).toBe(fixture.evidenceHash);
  });

  it('reports locally while a real bundled daemon is running', async () => {
    const home = root('coral-store-reset-e2e-running-');
    const temp = join(home, 'tmp');
    mkdirSync(temp);
    writeIncident({ home });
    const build = readBuildManifest();
    const discovery = coordinatorPaths(
      build.flavor,
      { HOME: home, TMPDIR: temp },
      { baseDir: join(home, '.coral') },
    ).infoFile;
    const child = spawn(process.execPath, [BACKEND_BUNDLE], {
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: temp,
      },
    });

    try {
      await waitFor(() => existsSync(discovery));
      const report = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID]);
      expect(report.status, report.stderr).toBe(0);
      expect(report.stdout).toContain('# Coral store-reset incident report\n');
      expect(report.stderr).toBe('');
      runCli(home, ['backend', 'shutdown']);
      await waitFor(() => child.exitCode !== null);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('uses fixed envelopes for invalid IDs, malformed incidents, and wrong-build incidents', () => {
    const home = root('coral-store-reset-e2e-errors-');
    mkdirSync(join(home, 'tmp'));
    const invalid = runCli(home, ['backend', 'store-reset', 'report', '../PRIVATE_ARGUMENT_SENTINEL']);
    expect(invalid).toEqual({
      stdout: '',
      stderr: 'Incident ID must be a canonical lowercase UUID. [code=invalid_store_reset_incident_id]\n',
      status: 2,
    });
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain('PRIVATE_ARGUMENT_SENTINEL');

    writeIncident({ home, malformedManifest: true });
    const malformed = runCli(home, ['backend', 'store-reset', 'report', INCIDENT_ID]);
    expect(malformed).toEqual({
      stdout: '',
      stderr: 'Store-reset reporting failed. [code=store_reset_reporting_failed]\n',
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
        'Store-reset reporting is unavailable because the installed build artifacts do not match. ' +
        '[code=store_reset_build_mismatch]\n',
      status: 70,
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
    const manifest = readBuildManifest();
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
        '[code=store_reset_build_mismatch]\n',
      status: 70,
    });
  });
});
