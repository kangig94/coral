import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openWritableStoreDatabase } from '#src/store/db.js';
import { initializeCustodyLedger, readCustodyLedger } from '#src/store/custody-ledger.js';
import {
  recordChildRoleCustodyIntent,
  bindCustodyProcessTicket,
  parseCustodyProcessTicket,
} from '#src/infra/custody-process-ticket.js';
import {
  epochDirectory,
  epochPath,
  resolvedStoreEpoch,
  readOrCreateEpochKey,
  protectStoreEpoch,
  recordEpochCustodyCoverage,
} from '#src/store/epoch/index.js';
import { settleSupersededEpochClosures } from '#src/coordinator/services/recovery/epoch-closure.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  { reuse: false, keyed: false, live: false, disposition: 'closed' },
  { reuse: true, keyed: true, live: false, disposition: 'closed' },
  { reuse: true, keyed: false, live: false, disposition: 'unrecoverable-retained' },
  { reuse: true, keyed: true, live: true, disposition: 'unrecoverable-retained' },
])('settles child custody by admitted lineage: %j', async ({ reuse, keyed, live, disposition }) => {
  const root = mkdtempSync(join(tmpdir(), 'coral-child-lineage-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue(live ? 'alive' : 'absent');
  vi.spyOn(runtime.process, 'readProcessIncarnation').mockReturnValue(null);
  const storeRoot = runtime.paths.coral.store.dbDir;
  const runDir = runtime.paths.coral.coordinator.runDir;
  const ledgerId = initializeCustodyLedger(runtime, runDir);
  const format = currentCoralStoreFormat();
  const publish = (epoch: string) => {
    const dir = epochDirectory(storeRoot, epoch);
    mkdirSync(dir, { recursive: true });
    createSharedFileLockSync(join(dir, '.lock'))();
    const opened = openWritableStoreDatabase({
      path: epochPath(storeRoot, epoch),
      storage: runtime.storage,
      storeFormat: format,
    });
    if (opened.kind !== 'opened') throw new Error('Fixture store unavailable.');
    opened.db.close();
    writeFileSync(
      join(dir, 'epoch.json'),
      JSON.stringify({
        supersedes: null,
        classification: { kind: 'absent' },
        build: {
          version: format.productVersion,
          buildSetId: '123e4567-e89b-42d3-a456-426614174000',
          bundleHash: '0123456789abcdef',
          flavor: 'prod',
          storeFormatFingerprint: format.fingerprint,
        },
        publishedAt: new Date().toISOString(),
      }),
    );
    const resolved = resolvedStoreEpoch(storeRoot, epoch);
    const key = readOrCreateEpochKey(runtime, resolved);
    recordEpochCustodyCoverage(runtime, dir, ledgerId);
    return { resolved, key, dir };
  };
  const old = publish('1');
  if (reuse) {
    protectStoreEpoch(runtime, old.resolved);
    publish('1');
  } else publish('2');
  // Descendants inherit the admitted key even when its remembered pathname has been reused.
  const ticket = recordChildRoleCustodyIntent({
    runDir,
    epoch: old.dir,
    ...(keyed ? { epochKey: old.key } : {}),
    owner: 'provider-host',
    operationId: 'set-1:provider',
    capsule: null,
    nowMs: 100,
    bindWithinMs: 10_000,
    processGroupId: null,
  });
  const forwarded = parseCustodyProcessTicket(JSON.stringify(ticket));
  if (keyed)
    expect(() =>
      bindCustodyProcessTicket(
        { ...forwarded, epochKey: 'other-lineage:1' },
        { pid: 987654321, incarnation: 'linux:boot:2' },
        200,
      ),
    ).toThrow(/invalid/u);
  bindCustodyProcessTicket(forwarded, { pid: 987654321, incarnation: 'linux:boot:2' }, 200);
  const entries = readCustodyLedger(runtime, runDir);
  expect(entries[0]).toMatchObject({ kind: 'bound', intent: keyed ? { epochKey: old.key } : { epoch: old.dir } });
  if (keyed) expect(forwarded).toMatchObject({ epochKey: old.key });
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  vi.spyOn(index, 'resultsReleased').mockReturnValue(true);
  vi.spyOn(index, 'unknownLocationHold').mockReturnValue(null);
  for (let attempt = 0; attempt < 2; attempt++) {
    const evidence = await settleSupersededEpochClosures(runtime, index, undefined, old.key);
    expect(evidence[0]).toMatchObject({ disposition, dataOutcome: 'retained' });
  }
});
