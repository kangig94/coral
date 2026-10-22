import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { JobLocationIndex } from '#src/jobs/location-index.js';
import { appendJobExecutionEnded, appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { initializeCustodyLedger } from '#src/store/custody-ledger.js';
import { recordEpochCustodyCoverage } from '#src/store/epoch/closure.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { readOrCreateEpochKey, encodeResolvedStoreEpoch } from '#src/store/epoch/index.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  executionHarness,
  executionInput,
  openedJob,
  requestedExecution,
  EXECUTION_JOB_ID,
  EXECUTION_NOW,
} from '#tests/helpers/job-executions.js';

export function retainedExecutionsFixture(roots: string[], ended = 2) {
  const root = mkdtempSync(join(tmpdir(), 'coral-retained-executions-'));
  roots.push(root);
  const real = createRealRuntime('prod', { baseDir: join(root, '.coral') });
  const runtime = { ...real, time: { ...real.time, now: () => Date.parse(EXECUTION_NOW) + 20_000 } };
  const journal = executionHarness();
  journal.append(openedJob());
  const requests: number[] = [];
  const ends: number[] = [];
  for (let execution = 1; execution <= ended; execution++) {
    journal.append(requestedExecution(execution));
    requests.push(journal.events().at(-1)!.seq);
    journal.append(
      executionInput('job.execution.progress', {
        execution,
        kind: 'message',
        message: `progress #${execution}`,
        timing: { origin: 'runtime', originAt: EXECUTION_NOW, emittedAt: EXECUTION_NOW, elapsedMs: 0 },
      }),
    );
    journal.commit((c) => {
      const fault =
        execution === 2
          ? c.append(
              executionInput('job.provider_failed', {
                execution,
                provider: 'codex',
                reason: 'request_failed',
                message: 'second execution failed',
              }),
            )
          : null;
      const terminal = appendJobExecutionOutcomeAccepted(c, {
        jobId: EXECUTION_JOB_ID,
        execution,
        terminal: {
          content: `result #${execution}`,
          outcome: fault === null ? { kind: 'completed' } : { kind: 'failed', causeRef: fault },
          durationMs: execution * 10,
        },
        diagnostics: {
          usage: { inputTokens: execution * 100, costUsd: execution / 10 },
          warnings: [`warning #${execution}`],
        },
      });
      appendJobExecutionEnded(c, { jobId: EXECUTION_JOB_ID, execution, causeRef: terminal });
      return undefined;
    });
    ends.push(journal.events().at(-1)!.seq);
  }
  const epoch = {
    storeRoot: runtime.paths.coral.store.dbDir,
    epoch: '1',
    path: join(runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'),
  };
  mkdirSync(dirname(epoch.path), { recursive: true });
  const fingerprint = currentCoralStoreFormat().fingerprint;
  journal.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('store_format_fingerprint', fingerprint);
  journal.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('store_product_version', '0.10.22');
  journal.db.prepare('VACUUM INTO ?').run(epoch.path);
  writeFileSync(`${epoch.path}.format`, `${fingerprint}\n`);
  journal.db.close();
  newRawDatabase(join(dirname(epoch.path), '.lock')).close();
  recordEpochCustodyCoverage(
    runtime,
    dirname(epoch.path),
    initializeCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir),
  );
  const lineage = readOrCreateEpochKey(runtime, epoch);
  const epochKey = encodeResolvedStoreEpoch(runtime, epoch);
  writeFileSync(
    join(dirname(epoch.path), 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'absent' },
      publishedAt: EXECUTION_NOW,
      build: {
        version: '0.10.22',
        buildSetId: '10000000-0000-4000-8000-000000000099',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        storeFormatFingerprint: fingerprint,
      },
    }),
  );
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  return {
    root,
    runtime,
    epoch,
    epochKey,
    lineage,
    fingerprint,
    index,
    requests,
    ends,
    jobId: EXECUTION_JOB_ID,
    jobsRoot: runtime.paths.coral.exports.jobsRoot,
  };
}
