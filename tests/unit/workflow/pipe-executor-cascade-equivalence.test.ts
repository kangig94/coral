import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobTerminal } from '#src/jobs/records.js';
import type { WaitRequest, WaitStreamEvent } from '#src/jobs/wait.js';
import { executePipeline } from '#src/workflow/executor.js';
import { parseExpression } from '#src/workflow/parser.js';
import type { WorkflowExecutionPort } from '#src/workflow/execution-contract.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/pipe-executor-cascade.golden.json');

const ctx: InvocationContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
  principal: testProjectPrincipal('/tmp/coral-workflow-project'),
};

// Monotonic deterministic clock — internal workflow logic compares against
// absolute deadlines, so fixed time would stall; `Date.now()` would leak
// wall-clock dependence.
function makeMonotonicTime() {
  let clock = new Date('2026-04-27T00:00:00.000Z').getTime();
  return {
    now: () => {
      clock += 100;
      return clock;
    },
  };
}

function running(jobId: string, sessionId: string) {
  return {
    kind: 'provider-session' as const,
    status: 'running' as const,
    jobId,
    sessionId,
  };
}

function terminal(
  jobId: string,
  result: Omit<JobTerminal, 'outcome' | 'durationMs'> & { outcome?: JobTerminal['outcome'] },
): WaitStreamEvent {
  return {
    type: 'terminal',
    jobId,
    seq: 0,
    remainingJobIds: [],
    resultPath: `/tmp/coral-exports/jobs/${jobId}/result.md`,
    result:
      result.outcome === undefined
        ? { ...result, outcome: { kind: 'completed' }, durationMs: 0 }
        : ({ ...result, outcome: result.outcome, durationMs: 0 } as JobTerminal),
  };
}

async function* emit(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createExecutionService(): WorkflowExecutionPort & {
  coralDispatch: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
} {
  let launches = 0;
  return {
    coralDispatch: vi.fn(async () => {
      launches += 1;
      return running(`job-${launches}`, `session-${launches}`);
    }),
    resume: vi.fn(async () => running('job-resumed', 'session-resumed')),
    recordContinuationLease: vi.fn(async () => {}),
    clearContinuationLease: vi.fn(async () => true),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    awaitLaunch: vi.fn(async (): Promise<'ready'> => 'ready'),
    waitStream: vi.fn((req: WaitRequest) => {
      if (req.jobIds.includes('job-1') && req.jobIds.includes('job-2')) {
        return emit([terminal('job-1', { content: 'ARCH' }), terminal('job-2', { content: 'LIT A' })]);
      }
      return emit([terminal('job-3', { content: 'FINAL' }), terminal('job-4', { content: 'LIT B' })]);
    }),
    waitForJobTerminal: vi.fn(async () => {}),
  };
}

describe('workflow cascade equivalence golden master', () => {
  it('produces the byte-identical cascade prompts and result for the decomposed executor', async () => {
    const executionSvc = createExecutionService();
    const prompts: string[] = [];

    executionSvc.coralDispatch.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      async (_provider: string, _name: string, input: { prompt: string }) => {
        prompts.push(String(input.prompt));
        const jobNumber = prompts.length;
        return running(`job-${jobNumber}`, `session-${jobNumber}`);
      },
    );

    const result = await executePipeline(
      parseExpression('(architect, "Use A") -> (resolver, "Use B")'),
      'seed',
      'codex',
      executionSvc,
      ctx,
      {
        context: 'SHARED',
        workflowJobId: 'workflow-test-uuid',
        time: makeMonotonicTime(),
      },
    );

    expect({ prompts, result }).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as unknown);
  });
});
