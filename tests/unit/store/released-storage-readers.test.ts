import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { buildReleasedStorageReader } from '#tests/helpers/released-storage-reader.js';
import {
  bindCustodyIdentity,
  dischargeCustodyEntry,
  pruneCustodyLedger,
  readCustodyLedger,
  recordCustodyIntent,
} from '#src/store/custody-ledger.js';
import { processIncarnationSchema } from '#src/infra/node-process.js';
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

it.each(['v0.10.16', 'v0.10.17'])(
  'certifies bounded terminals and tolerates whole custody retirement with the shipped %s reader',
  async (tag) => {
    const f = createRetentionFixture();
    fixtures.push(f);
    const outfile = join(f.baseDir, 'reader.mjs');
    await buildReleasedStorageReader(tag, outfile);
    const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    initTestJob(f.store, {
      jobId: 'job',
      sessionId: 'session',
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'test',
    });
    f.store.appendProgress('job', 'session', 'progress');
    commitJobTerminal(f.store, 'job', 'session', { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 });
    recoverJobLocations(index, 'epoch', f.store);
    const runDir = f.runtime.paths.coral.coordinator.runDir;
    for (const operationId of ['finished', 'live']) {
      const intent = recordCustodyIntent(f.runtime, runDir, {
        effect: 'process-spawn',
        owner: 'provider-host',
        epoch: 'epoch-1',
        operationId,
        capsule: null,
        nowMs: 100,
        bindWithinMs: 1000,
      });
      bindCustodyIdentity(f.runtime, runDir, intent, {
        process: {
          pid: operationId === 'live' ? 5002 : 5001,
          incarnation: processIncarnationSchema.parse('linux:boot:1'),
          processGroupId: operationId === 'live' ? 5002 : 5001,
        },
        capsule: null,
        observedAtMs: 200,
      });
      if (operationId === 'finished') {
        const entry = readCustodyLedger(f.runtime, runDir).find(
          (entry) => entry.kind !== 'unreadable' && entry.intent.id === intent.id,
        )!;
        if (entry.kind !== 'bound') throw new Error('bound fixture expected');
        dischargeCustodyEntry(f.runtime, runDir, entry, 1000, 'exact discharge', (operation) => operation());
      }
    }
    const read = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
    import fs from 'node:fs';
    const {JobLocationIndex,hasReadableTerminalDetail,readCustodyLedger}=await import(${JSON.stringify(pathToFileURL(outfile).href)});
    const index=new JobLocationIndex({storage:fs,time:{}},${JSON.stringify(f.runtime.paths.coral.generation.dataRoot)});
    const location=index.read('job');
    const empty={...location,detail:{kind:'recorded',value:{...location.detail.value,events:[]}}};
    console.log(JSON.stringify({terminal:hasReadableTerminalDetail(location),empty:hasReadableTerminalDetail(empty),events:location.detail.value.events.length,
      live:readCustodyLedger({storage:fs},${JSON.stringify(runDir)}).filter(e=>e.kind==='bound'&&e.intent.operationId==='live').map(e=>e.binding),
      states:readCustodyLedger({storage:fs},${JSON.stringify(runDir)}).map(e=>e.kind)}));
  `,
          ],
          { encoding: 'utf8' },
        ),
      );
    const before = read();
    expect(before).toMatchObject({ terminal: true, empty: false, events: 1, states: ['bound', 'bound'] });

    await pruneCustodyLedger({
      runtime: f.runtime,
      runDir,
      cutoff: 1001,
      afterId: '',
      budget: {
        canContinue: () =>
          !readdirSync(join(runDir, 'custody.v1')).some((name) =>
            /^\.stage\.retention\.[0-9a-f-]{36}\.[0-9a-f-]{36}$/u.test(name),
          ),
        record: () => {},
      },
      mutate: (operation) => operation(),
    });
    // A partially cleaned private stage is invisible to both shipped readers.
    const staged = read();
    expect(staged.live).toEqual(before.live);
    expect(staged.states).toEqual(['bound']);
    await pruneCustodyLedger({
      runtime: f.runtime,
      runDir,
      cutoff: 1001,
      afterId: '',
      budget: f.budget,
      mutate: (operation) => operation(),
    });
    const after = read();
    expect(after.live).toEqual(before.live);
    expect(after.states).toEqual(['bound']);
  },
);
