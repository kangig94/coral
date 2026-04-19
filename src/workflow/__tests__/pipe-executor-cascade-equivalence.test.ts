import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { CallerContext } from '../../shared/request-context.js';
import type { JobTerminal } from '../../jobs/views.js';
import type { WaitRequest, WaitStreamEvent } from '../../jobs/wait.js';
import { executePipeline } from '../executor.js';
import { parseExpression } from '../parser.js';
import type { WorkflowExecutionPort } from '../command.js';

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/pipe-executor-cascade.golden.json');

const ctx: CallerContext = {
  projectRoot: '/tmp/coral-workflow-project',
  pluginRoot: '/tmp/coral-workflow-plugin',
  coralEnv: {},
};

function running(job: string, session: string) {
  return {
    status: 'running' as const,
    job,
    session,
  };
}

function terminal(
  jobId: string,
  result: Omit<JobTerminal, 'outcome'> & { outcome?: JobTerminal['outcome'] },
): WaitStreamEvent {
  return {
    type: 'terminal',
    jobId,
    remainingJobIds: [],
    resultPath: `/tmp/coral-jobs/${jobId}/result.md`,
    result:
      result.outcome === undefined
        ? { ...result, outcome: { kind: 'completed' } }
        : ({ ...result, outcome: result.outcome } as JobTerminal),
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
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    awaitLaunch: vi.fn(async (): Promise<'ready'> => 'ready'),
    waitStream: vi.fn((req: WaitRequest) => {
      if (req.jobIds.includes('job-1') && req.jobIds.includes('job-2')) {
        return emit([
          terminal('job-1', { content: 'ARCH' }),
          terminal('job-2', { content: 'LIT A' }),
        ]);
      }
      return emit([
        terminal('job-3', { content: 'FINAL' }),
        terminal('job-4', { content: 'LIT B' }),
      ]);
    }),
    waitForJobTerminal: vi.fn(async () => {}),
    cleanupWorkflowSessions: vi.fn(),
  };
}

describe('workflow cascade equivalence golden master (AC4)', () => {
  it('produces the byte-identical cascade prompts and result for the decomposed executor', async () => {
    const executionSvc = createExecutionService();
    const prompts: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    executionSvc.coralDispatch.mockImplementation(async (_provider: string, _name: string, input: { prompt: string }) => {
      prompts.push(String(input.prompt));
      const jobNumber = prompts.length;
      return running(`job-${jobNumber}`, `session-${jobNumber}`);
    });

    const result = await executePipeline(
      parseExpression('(architect, "Use A") -> (resolver, "Use B")'),
      'seed',
      'codex',
      executionSvc,
      ctx,
      { context: 'SHARED' },
    );

    expect({ prompts, result }).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as unknown);
  });
});
