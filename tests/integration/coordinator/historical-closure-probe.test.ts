import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeHistoricalJobClosure } from '../../../src/coordinator/composition/index.js';
import { JobAddressing } from '../../../src/jobs/addressing.js';
import { JobLocationIndex } from '../../../src/jobs/location-index.js';
import { createRealRuntime } from '../../../src/runtime/real.js';
import { encodeResolvedStoreEpoch } from '../../../src/store/epoch/index.js';
import { protectStoreEpoch } from '../../../src/store/epoch/index.js';
import { recordEpochClosure } from '../../../src/store/epoch/index.js';
import { newRawDatabase } from '../../helpers/test-db.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('historical job closure probe', () => {
  it('settles a known job without a historical source only after closure is certified', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-historical-closure-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const storeRoot = join(root, 'store');
    const epochDir = join(storeRoot, 'epoch-7');
    mkdirSync(epochDir, { recursive: true });
    newRawDatabase(join(epochDir, '.lock')).close();
    newRawDatabase(join(epochDir, 'store.db')).close();
    const epoch = { storeRoot, epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = encodeResolvedStoreEpoch(runtime, epoch);
    const lineageKey = protectStoreEpoch(runtime, epoch).epochKey;
    const index = new JobLocationIndex(runtime, root);
    index.register('known-live', epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.markUnresolved('known-live');
    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => false,
      (key) => probeHistoricalJobClosure(runtime, key),
    );
    const evidence = {
      version: 'v1' as const,
      epochKey: lineageKey,
      disposition: 'unrecoverable-retained' as const,
      dataOutcome: 'retained' as const,
      executionDischarge: 'undecidable' as const,
      obligations: [],
      reason: 'custody-undecidable',
      observedAtMs: 1,
    };
    recordEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, evidence);
    expect(addressing.detail('known-live')).toMatchObject({ kind: 'unresolved' });
    recordEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, {
      ...evidence,
      disposition: 'closed',
      executionDischarge: 'certified',
      reason: 'custody-certified',
    });
    expect(addressing.detail('known-live')).toMatchObject({ kind: 'outcome-unrecoverable' });
  });

  it('keeps a historical job unresolved when a readable closure says closed but its execution discharge is undecidable', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-red-historical-closure-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const storeRoot = join(root, 'store');
    const epochDir = join(storeRoot, 'epoch-7');
    mkdirSync(epochDir, { recursive: true });
    newRawDatabase(join(epochDir, '.lock')).close();
    newRawDatabase(join(epochDir, 'store.db')).close();
    const epoch = { storeRoot, epoch: '7', path: join(epochDir, 'store.db') };
    const epochKey = encodeResolvedStoreEpoch(runtime, epoch);
    const lineageKey = protectStoreEpoch(runtime, epoch).epochKey;
    const index = new JobLocationIndex(runtime, root);
    index.register('closure-contradiction', epochKey, {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    index.markUnresolved('closure-contradiction');
    recordEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, {
      version: 'v1',
      epochKey: lineageKey,
      disposition: 'closed',
      dataOutcome: 'retained',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'custody-certified',
      observedAtMs: 1,
    });
    const closurePath = join(
      runtime.paths.coral.generation.dataRoot,
      'epoch-closure.v1',
      `${createHash('sha256').update(lineageKey).digest('hex')}.json`,
    );
    writeFileSync(
      closurePath,
      `${JSON.stringify({
        version: 'v1',
        epochKey: lineageKey,
        disposition: 'closed',
        dataOutcome: 'retained',
        executionDischarge: 'undecidable',
        obligations: [],
        reason: 'contradictory-evidence',
        observedAtMs: 2,
      })}\n`,
    );

    const addressing = new JobAddressing(
      index,
      {
        epochKey: () => 'lineage-new:8',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => false,
      (key) => probeHistoricalJobClosure(runtime, key),
    );

    expect(addressing.detail('closure-contradiction')).toEqual({
      kind: 'unresolved',
      jobId: 'closure-contradiction',
      epochKey,
    });
  });
});
