import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createStoreResetInspectionFs } from '#src/infra/store-reset-inspection-fs.js';
import { listLegacyStoreResetIncidents } from '#src/store/reset-incident-reader.js';
import {
  serializeStoreResetIncidentManifest,
  STORE_RESET_MANIFEST_FILE_NAME,
  type StoreResetIncidentManifestV2,
} from '#src/store/reset-incident.js';

const roots: string[] = [];
const build: StrictBundleManifest = {
  version: '0.10.9',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  durableWrapperBundleHash: '3456789abcdef012',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'f'.repeat(64)}`,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy store-reset incident listing', () => {
  it('keeps a shipped quarantine incident visible while the legacy root exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-legacy-reset-reader-'));
    roots.push(root);
    const incidentId = '123e4567-e89b-42d3-a456-426614174000';
    const incident = join(root, incidentId);
    const evidence = Buffer.from('legacy evidence');
    mkdirSync(incident);
    writeFileSync(join(incident, 'store.db'), evidence);
    const manifest: StoreResetIncidentManifestV2 = {
      schemaVersion: 2,
      incidentId,
      resetAt: '2026-09-15T00:00:00.000Z',
      reason: 'mismatch',
      storedFingerprint: null,
      expectedFingerprint: build.storeFormatFingerprint,
      build: {
        version: build.version,
        buildSetId: build.buildSetId,
        backendBundleHash: build.bundleHash,
        flavor: build.flavor,
      },
      runtime: {
        namespace: 'test',
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        processId: process.pid,
      },
      handoff: { acquiredViaHandoff: false },
      files: [
        {
          name: 'store.db',
          sizeBytes: evidence.byteLength,
          mtimeMs: 0,
          sha256: createHash('sha256').update(evidence).digest('hex'),
        },
      ],
    };
    writeFileSync(join(incident, STORE_RESET_MANIFEST_FILE_NAME), serializeStoreResetIncidentManifest(manifest));

    const result = listLegacyStoreResetIncidents({
      fs: createStoreResetInspectionFs(),
      quarantineRoot: root,
      expectedBuild: build,
    });

    expect(result).toMatchObject({
      truncated: false,
      incidents: [{ source: 'legacy-quarantine', incidentId, state: 'ready', fileCount: 1 }],
    });
  });

  it('returns an empty list for an absent legacy root', () => {
    expect(
      listLegacyStoreResetIncidents({
        fs: createStoreResetInspectionFs(),
        quarantineRoot: join(tmpdir(), 'coral-absent-legacy-reset-root'),
        expectedBuild: build,
      }),
    ).toEqual({ incidents: [], truncated: false });
  });
});
