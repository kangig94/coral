import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createNodeStoreResetDiagnosticSupervisor } from '#src/infra/store-reset-diagnostic-supervisor.js';
import { createStoreResetInspectionFs } from '#src/infra/store-reset-inspection-fs.js';
import { createStoreResetIncidentDiagnosticRunner } from '#src/store/reset-incident-diagnostic.js';
import type { StoreResetInspectionStat } from '#src/store/reset-incident-inspection-fs.js';
import { readStoreResetIncidentReport } from '#src/store/reset-incident-reader.js';
import {
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  type StoreResetIncidentManifestV2,
} from '#src/store/reset-incident.js';
import { scriptedStoreResetInspectionFs } from '#tests/helpers/store-reset-inspection-fs.js';

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
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'coral-reset-inspection-'));
  roots.push(value);
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(): {
  quarantineRoot: string;
  incidentPath: string;
  manifestPath: string;
  evidencePath: string;
} {
  const base = root();
  const quarantineRoot = join(base, 'store-reset-quarantine');
  const incidentPath = join(quarantineRoot, INCIDENT_ID);
  const manifestPath = join(incidentPath, 'reset-manifest.json');
  const evidencePath = join(incidentPath, 'store.db');
  mkdirSync(incidentPath, { recursive: true, mode: 0o700 });
  const evidence = 'evidence bytes';
  writeFileSync(evidencePath, evidence, { mode: 0o600 });
  const evidenceStat = createStoreResetInspectionFs().lstat(evidencePath);
  if (evidenceStat === null) throw new Error('fixture evidence missing');
  const manifest: StoreResetIncidentManifestV2 = {
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
      namespace: 'integration',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      processId: process.pid,
    },
    handoff: { acquiredViaHandoff: false },
    files: [
      {
        name: 'store.db',
        sizeBytes: Number(evidenceStat.size),
        mtimeMs: Number(evidenceStat.mtimeNs) / 1_000_000,
        sha256: sha256(evidence),
      },
    ],
  };
  writeFileSync(manifestPath, serializeStoreResetIncidentManifest(manifest), { mode: 0o600 });
  return { quarantineRoot, incidentPath, manifestPath, evidencePath };
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('real store reset inspection filesystem', () => {
  it('reads a contained incident through descriptor identity and bounded partial reads', async () => {
    const paths = fixture();
    const fs = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      maxReadBytes: 1,
    });

    const result = await readStoreResetIncidentReport({
      fs,
      quarantineRoot: paths.quarantineRoot,
      incidentId: INCIDENT_ID,
      expectedBuild: BUILD,
    });

    expect(result).toMatchObject({
      ok: true,
      report: {
        incidentId: INCIDENT_ID,
        files: [{ name: 'store.db', verification: 'match' }],
      },
    });
  });

  it('rejects incident links and unexpected directory entries', async () => {
    const base = root();
    const quarantineRoot = join(base, 'store-reset-quarantine');
    const outside = join(base, 'outside');
    mkdirSync(quarantineRoot);
    mkdirSync(outside);
    symlinkSync(outside, join(quarantineRoot, INCIDENT_ID), process.platform === 'win32' ? 'junction' : 'dir');

    expect(
      await readStoreResetIncidentReport({
        fs: createStoreResetInspectionFs(),
        quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toEqual({ ok: false, state: 'unsafe' });

    rmSync(join(quarantineRoot, INCIDENT_ID), { recursive: true, force: true });
    const paths = fixture();
    writeFileSync(join(paths.incidentPath, 'unexpected.txt'), 'sentinel');
    expect(
      await readStoreResetIncidentReport({
        fs: createStoreResetInspectionFs(),
        quarantineRoot: paths.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toEqual({ ok: false, state: 'unsafe' });

    const manifestLink = fixture();
    const externalManifest = join(dirname(manifestLink.quarantineRoot), 'external-manifest.json');
    writeFileSync(externalManifest, readFileSync(manifestLink.manifestPath));
    rmSync(manifestLink.manifestPath);
    symlinkSync(externalManifest, manifestLink.manifestPath, 'file');
    expect(
      await readStoreResetIncidentReport({
        fs: createStoreResetInspectionFs(),
        quarantineRoot: manifestLink.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toEqual({ ok: false, state: 'unsafe' });

    const evidenceLink = fixture();
    const externalEvidence = join(dirname(evidenceLink.quarantineRoot), 'external-store.db');
    writeFileSync(externalEvidence, readFileSync(evidenceLink.evidencePath));
    rmSync(evidenceLink.evidencePath);
    symlinkSync(externalEvidence, evidenceLink.evidencePath, 'file');
    expect(
      await readStoreResetIncidentReport({
        fs: createStoreResetInspectionFs(),
        quarantineRoot: evidenceLink.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toEqual({ ok: false, state: 'unsafe' });
  });

  it('detects ordinary manifest identity replacement and close failure without leaking errors', async () => {
    const paths = fixture();
    let manifestStats = 0;
    const replacement = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      lstat(path, _call, current) {
        if (path !== paths.manifestPath || current === null) return current;
        manifestStats += 1;
        return manifestStats === 2 ? { ...current, ino: current.ino + 1n } : current;
      },
    });
    expect(
      await readStoreResetIncidentReport({
        fs: replacement,
        quarantineRoot: paths.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toEqual({ ok: false, state: 'unsafe' });

    const closeFailure = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      failFileClose: true,
    });
    expect(
      await readStoreResetIncidentReport({
        fs: closeFailure,
        quarantineRoot: paths.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toEqual({ ok: false, state: 'unavailable' });
  });

  it('reports fixed mismatch, missing, and cumulative-budget states', async () => {
    const tampered = fixture();
    writeFileSync(tampered.evidencePath, 'tampered bytes');
    expect(
      await readStoreResetIncidentReport({
        fs: createStoreResetInspectionFs(),
        quarantineRoot: tampered.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toMatchObject({
      ok: true,
      report: { files: [{ name: 'store.db', verification: 'mismatch' }] },
    });

    rmSync(tampered.evidencePath);
    expect(
      await readStoreResetIncidentReport({
        fs: createStoreResetInspectionFs(),
        quarantineRoot: tampered.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toMatchObject({
      ok: true,
      report: { files: [{ name: 'store.db', verification: 'missing' }] },
    });

    const limited = fixture();
    const oversized = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      lstat(path, _call, current) {
        return path === limited.evidencePath && current !== null
          ? { ...current, size: 1024n * 1024n * 1024n + 1n }
          : current;
      },
    });
    expect(
      await readStoreResetIncidentReport({
        fs: oversized,
        quarantineRoot: limited.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toMatchObject({
      ok: true,
      report: { files: [{ name: 'store.db', verification: 'unavailable_limit' }] },
    });

    const cumulative = fixture();
    const walPath = join(cumulative.incidentPath, 'store.db-wal');
    writeFileSync(walPath, 'small wal');
    const originalManifest = parseStoreResetIncidentManifest(readFileSync(cumulative.manifestPath));
    if (originalManifest.schemaVersion !== 2) throw new Error('Expected a V2 fixture manifest.');
    const perFile = 600 * 1024 * 1024;
    const cumulativeManifest: StoreResetIncidentManifestV2 = {
      ...originalManifest,
      files: [
        { ...originalManifest.files[0], sizeBytes: perFile },
        {
          name: 'store.db-wal',
          sizeBytes: perFile,
          mtimeMs: Date.now(),
          sha256: sha256('small wal'),
        },
      ],
    };
    writeFileSync(cumulative.manifestPath, serializeStoreResetIncidentManifest(cumulativeManifest));
    let walOpens = 0;
    const cumulativeFs = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      open(path) {
        if (path === walPath) walOpens += 1;
      },
    });
    expect(
      await readStoreResetIncidentReport({
        fs: cumulativeFs,
        quarantineRoot: cumulative.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toMatchObject({
      ok: true,
      report: {
        files: [
          { name: 'store.db', verification: 'mismatch' },
          { name: 'store.db-wal', verification: 'unavailable_limit' },
        ],
      },
    });
    expect(walOpens).toBe(0);
  });

  it('stops incident traversal at cap plus one and never diagnoses after an identity race', async () => {
    const overflowing = fixture();
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(overflowing.incidentPath, `unexpected-${index}`), 'x');
    }
    let directoryReads = 0;
    const overflowFs = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      readDirectory(_cursor, _call, current) {
        directoryReads += 1;
        return current;
      },
    });
    expect(
      await readStoreResetIncidentReport({
        fs: overflowFs,
        quarantineRoot: overflowing.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
      }),
    ).toEqual({ ok: false, state: 'unsafe' });
    expect(directoryReads).toBe(6);

    const raced = fixture();
    let evidenceOpened = false;
    const diagnose = vi.fn();
    const racedFs = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      open(path) {
        if (path === raced.evidencePath) evidenceOpened = true;
      },
      fstat(_descriptor, _call, current) {
        return evidenceOpened ? { ...current, ino: current.ino + 1n } : current;
      },
    });
    expect(
      await readStoreResetIncidentReport({
        fs: racedFs,
        quarantineRoot: raced.quarantineRoot,
        incidentId: INCIDENT_ID,
        expectedBuild: BUILD,
        diagnose,
      }),
    ).toEqual({ ok: false, state: 'unsafe' });
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('creates files exclusively and removes only the recorded directory identity', () => {
    const fs = createStoreResetInspectionFs();
    const base = root();
    const staged = fs.mkdtemp(join(base, 'staged-'));
    const output = join(staged, 'store.db');
    const descriptor = fs.open(output, fs.openFlags.createExclusiveWrite, 0o600);
    const bytes = new TextEncoder().encode('copy');
    expect(fs.write(descriptor, bytes, 0, bytes.length, 0)).toBe(bytes.length);
    fs.close(descriptor);
    expect(() => fs.open(output, fs.openFlags.createExclusiveWrite, 0o600)).toThrow();

    const expected = fs.lstat(staged);
    expect(expected?.kind).toBe('directory');
    expect(fs.removeTreeGuarded(staged, expected as StoreResetInspectionStat)).toBe(true);
    expect(fs.lstat(staged)).toBeNull();
  });

  it('diagnoses a real private SQLite copy without changing incident evidence', async () => {
    const paths = fixture();
    rmSync(paths.evidencePath);
    const db = new DatabaseSync(paths.evidencePath);
    db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('private sentinel');");
    db.close();

    const fs = createStoreResetInspectionFs();
    const evidence = readFileSync(paths.evidencePath);
    const evidenceStat = fs.lstat(paths.evidencePath);
    if (evidenceStat === null) throw new Error('SQLite evidence missing');
    const previous = parseStoreResetIncidentManifest(readFileSync(paths.manifestPath));
    if (previous.schemaVersion !== 2) throw new Error('Expected a V2 fixture manifest.');
    const manifest: StoreResetIncidentManifestV2 = {
      ...previous,
      files: [
        {
          name: 'store.db',
          sizeBytes: evidence.length,
          mtimeMs: Number(evidenceStat.mtimeNs) / 1_000_000,
          sha256: sha256(evidence),
        },
      ],
    };
    writeFileSync(paths.manifestPath, serializeStoreResetIncidentManifest(manifest), { mode: 0o600 });
    const diagnosticTempRoot = join(root(), 'diagnostics');
    mkdirSync(diagnosticTempRoot, { mode: 0o700 });

    const result = await readStoreResetIncidentReport({
      fs,
      quarantineRoot: paths.quarantineRoot,
      incidentId: INCIDENT_ID,
      expectedBuild: BUILD,
      diagnose: createStoreResetIncidentDiagnosticRunner({
        tempRoot: diagnosticTempRoot,
        platform: process.platform,
        executable: process.execPath,
        supervisor: createNodeStoreResetDiagnosticSupervisor(),
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      report: {
        diagnostic: {
          integrity: 'ok',
          termination: 'completed',
          cleanup: 'removed',
        },
      },
    });
    expect(sha256(readFileSync(paths.evidencePath))).toBe(sha256(evidence));
    expect(readdirSync(diagnosticTempRoot)).toEqual([]);
  });
});
