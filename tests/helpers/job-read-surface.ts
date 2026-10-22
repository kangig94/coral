import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { appendJobExecutionEnded, appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import {
  executionHarness,
  executionInput,
  openedJob,
  requestedExecution,
  EXECUTION_JOB_ID as jobId,
  EXECUTION_NOW,
} from '#tests/helpers/job-executions.js';

export function jobReadSurfaceFixture(second: 'ended' | 'queued' | 'finishing' = 'ended') {
  const root = mkdtempSync(join(tmpdir(), 'coral-job-read-surface-'));
  const projectRoot = canonicalizeWorkDir(root, root);
  const h = executionHarness();
  const runtime = createRealRuntime('prod', { baseDir: join(root, '.coral') });
  const store = new JobStore('tests', runtime, h.ctx.bodyCodec, {
    db: h.db,
    providers: h.ctx.providers,
    reducers: h.ctx.reducers,
  });
  const opened = openedJob();
  if (opened.body.jobKind !== 'provider') throw new Error('Expected a provider fixture');
  opened.body.projectRoot = projectRoot;
  opened.body.conversation.cwd = projectRoot;
  h.append(opened, requestedExecution(1, { coralEnv: { CORAL_OWNER: 'caller' } }));
  const accept = (execution: number, end: boolean) =>
    h.commit((c) => {
      const cause = appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution,
        terminal: {
          content: `result #${execution}`,
          durationMs: execution * 10,
          outcome: execution === 1 ? { kind: 'completed' } : { kind: 'provider_exit', code: 7 },
        },
        diagnostics: { warnings: [`warning #${execution}`], usage: { inputTokens: execution * 100 } },
      });
      if (end) appendJobExecutionEnded(c, { jobId, execution, causeRef: cause });
      return undefined;
    });
  accept(1, true);
  h.append(requestedExecution(2, { coralEnv: { CORAL_OWNER: 'caller' }, backendNamespace: 'second-build' }));
  if (second === 'queued') {
    h.append(executionInput('job.execution.queued', { execution: 2, queuePosition: 1, runningJobIds: [] }));
  } else {
    h.append(
      executionInput('job.execution.started', {
        execution: 2,
        transport: 'app-server',
        startedAt: EXECUTION_NOW,
        providerMeta: { provider: 'codex', leaseState: 'waiting' },
      }),
    );
    accept(2, second === 'ended');
  }
  return {
    h,
    runtime,
    store,
    root,
    projectRoot,
    jobId,
    close: () => {
      h.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
