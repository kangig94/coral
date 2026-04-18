import { describe, expect, it, vi } from 'vitest';

import type { CallerContext } from '../../shared/request-context.js';
import type { JobTerminalRecord, WaitRequest, WaitStreamEvent } from '../../shared/types.js';
import { executePipeline } from '../executor.js';
import { parseExpression } from '../parser.js';
import type { WorkflowExecutionPort } from '../command.js';

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
  result: Omit<JobTerminalRecord, 'outcome'> & { outcome?: JobTerminalRecord['outcome'] },
): WaitStreamEvent {
  return {
    type: 'terminal',
    jobId,
    remainingJobIds: [],
    resultPath: `/tmp/coral-jobs/${jobId}/result.md`,
    result:
      result.outcome === undefined
        ? { ...result, outcome: { kind: 'completed' } }
        : ({ ...result, outcome: result.outcome } as JobTerminalRecord),
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

    executionSvc.coralDispatch.mockImplementation(async (_provider, _name, input) => {
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

    expect(JSON.stringify({ prompts, result }, null, 2)).toBe(`{
  "prompts": [
    "SHARED\\n\\nseed",
    "SHARED\\n\\nUse A",
    "SHARED\\n\\n<architect>\\nARCH\\n</architect>\\n\\n<step-result>\\nLIT A\\n</step-result>",
    "SHARED\\n\\nUse B\\n\\n<architect>\\nARCH\\n</architect>\\n\\n<step-result>\\nLIT A\\n</step-result>"
  ],
  "result": {
    "finalOutput": "<resolver>\\nFINAL\\n</resolver>\\n\\n<step-result>\\nLIT B\\n</step-result>",
    "stepDetails": [
      {
        "stepIndex": 0,
        "atomIndex": 0,
        "kind": "agent",
        "label": "architect",
        "provider": "codex",
        "tagName": "architect",
        "output": "ARCH"
      },
      {
        "stepIndex": 0,
        "atomIndex": 1,
        "kind": "prompt",
        "label": "prompt#1(Use A)",
        "provider": "codex",
        "tagName": "step-result",
        "output": "LIT A"
      },
      {
        "stepIndex": 1,
        "atomIndex": 0,
        "kind": "agent",
        "label": "resolver",
        "provider": "codex",
        "tagName": "resolver",
        "output": "FINAL"
      },
      {
        "stepIndex": 1,
        "atomIndex": 1,
        "kind": "prompt",
        "label": "prompt#1(Use B)",
        "provider": "codex",
        "tagName": "step-result",
        "output": "LIT B"
      }
    ]
  }
}`);
  });
});
