import { afterEach, describe, expect, it } from 'vitest';
import {
  formatDetachedLaunchStatus,
  formatJobDetail,
  formatJobsList,
  formatLaunch,
  formatLaunchWaitHint,
  formatWorkflowSlot,
  formatAbortResult,
  renderJobsList,
} from '#src/cli/format/jobs.js';
import { jobReadSurfaceFixture } from '#tests/helpers/job-read-surface.js';
import type { ResultAvailability } from '#src/jobs/terminal/export.js';

const fixtures: ReturnType<typeof jobReadSurfaceFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(second: Parameters<typeof jobReadSurfaceFixture>[0] = 'ended') {
  const f = jobReadSurfaceFixture(second);
  fixtures.push(f);
  return f;
}

describe('jobs list and detail formatting', () => {
  it('renders one list row with the latest execution state', () => {
    const f = fixture('queued');
    const rows = formatJobsList({ jobs: f.store.listJobProjections() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: f.jobId, execution: '#2', phase: 'queued' });
    const output = renderJobsList(rows);
    expect(output).toContain('EXECUTION');
    expect(output).toContain('#2');
    expect(output).not.toContain('completed');
  });

  it('renders every execution with its own result, diagnostics and result path', () => {
    const f = fixture();
    const response = f.store.loadJobDetailResponse(f.jobId)!;
    response.executions = response.executions!.map((execution) => ({
      ...execution,
      availability: { kind: 'available', resultPath: execution.resultPath },
    }));
    const output = formatJobDetail(response, undefined, [], true);
    const first = output.slice(output.indexOf('Execution #1'), output.indexOf('Execution #2'));
    const second = output.slice(output.indexOf('Execution #2'));
    expect(output).toContain('Latest execution: #2');
    expect(first).toContain(`Result path: ${f.store.resultPathFor(f.jobId, 1)}`);
    expect(first).toContain('result #1');
    expect(first).toContain('warning #1');
    expect(first).not.toContain('result #2');
    expect(second).toContain(`Result path: ${f.store.resultPathFor(f.jobId, 2)}`);
    expect(second).toContain('result #2');
    expect(second).toContain('provider exited 7');
    expect(second).not.toContain('warning #1');
  });

  it.each([
    [{ kind: 'retained-away', retentionDays: 7 }, 'no longer kept: past the 7-day retention window'],
    [{ kind: 'pending' }, 'Result file pending'],
    [
      { kind: 'failed', reason: 'Retained source is unreadable' },
      'Result file unavailable: Retained source is unreadable',
    ],
  ] satisfies [ResultAvailability, string][])(
    'reports unavailable execution artifacts independently: %j',
    (availability, message) => {
      const f = fixture();
      const response = f.store.loadJobDetailResponse(f.jobId)!;
      response.executions = response.executions!.map((execution) => ({
        ...execution,
        availability:
          execution.execution === 1 ? availability : { kind: 'available', resultPath: execution.resultPath },
      }));
      response.availability = { kind: 'available', resultPath: f.store.resultPathFor(f.jobId, 2) };

      const output = formatJobDetail(response);
      const first = output.slice(output.indexOf('Execution #1'), output.indexOf('Execution #2'));
      const second = output.slice(output.indexOf('Execution #2'));
      expect(first).toContain(message);
      expect(first).toContain(`Result location: ${f.store.resultPathFor(f.jobId, 1)}`);
      expect(first).not.toContain('Result path:');
      expect(second).toContain(`Result path: ${f.store.resultPathFor(f.jobId, 2)}`);
      expect(output.match(/Result path:/g)).toHaveLength(1);
    },
  );

  it('shows finishing without borrowing the prior execution result', () => {
    const f = fixture('finishing');
    const rows = formatJobsList({ jobs: f.store.listJobProjections() });
    expect(rows[0].phase).toBe('running (finishing)');
    const output = formatJobDetail(f.store.loadJobDetailResponse(f.jobId)!);
    const second = output.slice(output.indexOf('Execution #2'));
    expect(second).toContain('Finishing: true');
    expect(second).toContain(`coral-cli jobs wait ${f.jobId}`);
    expect(second).not.toContain('Exit:');
    expect(second).not.toContain('result #1');
    expect(second).not.toContain('Result path:');
  });

  it('pins queued detail and launch wait commands to the same committed execution', () => {
    const f = fixture('queued');
    const detail = f.store.loadJobDetailResponse(f.jobId)!;
    detail.epochKey = 'epoch';
    const second = detail.executions![1];
    const hint = formatLaunchWaitHint({ jobId: f.jobId, epochKey: detail.epochKey, requestedSeq: second.requestedSeq });
    const command = hint.split('\n')[1];
    expect(command).toContain('--execution-selection');
    const output = formatJobDetail(detail).split('Execution #2')[1];
    expect(output).toContain(command);
    expect(output).not.toContain('Result path:');
  });

  it('renders workflow slot lineage and execution ordinals in separate fields', () => {
    const f = fixture('queued');
    const detail = f.store.loadJobDetailResponse(f.jobId)!;
    detail.status.parentWorkflowJobId = 'parent';
    detail.status.workflowSlotId = 'parent:review';
    expect(formatWorkflowSlot(detail.status)).toBe('review');
    const output = renderJobsList(formatJobsList({ jobs: [{ jobId: f.jobId, status: detail.status }] }));
    expect(output).toContain('review');
    expect(output).toContain('#2');
  });

  it('renders a finishing abort refusal with a runnable wait remedy', () => {
    const output = formatAbortResult({
      aborted: [],
      notFound: [],
      refused: [
        {
          jobId: 'job-1',
          reason: 'The execution has accepted its outcome and is finishing.',
          nextStep: { detail: 'Wait for the execution to end.', remedy: { kind: 'wait-job', jobId: 'job-1' } },
        },
      ],
    });
    expect(output).toContain('Abort held for job-1: The execution has accepted its outcome and is finishing.');
    expect(output).toContain('command=coral-cli jobs wait job-1');
    expect(output.match(/coral-cli jobs wait/g)).toHaveLength(1);
  });

  it.each(['running', 'queued'] as const)(
    'omits an unknown execution in a %s foreground provider launch',
    (launchState) => {
      const jobId = '10000000-0000-4000-8000-000000000001';
      const response = { kind: 'provider-session', jobId, launchState, requestedSeq: 2, epochKey: ':memory:' } as const;
      expect(formatLaunch(response)).toBe(
        `Provider job ${jobId} ${launchState === 'running' ? 'launch accepted' : 'queued'}`,
      );
      expect(formatDetachedLaunchStatus(response)).toBe(`Provider job ${jobId} execution #1 ${launchState}`);
    },
  );

  it.each(['running', 'queued'] as const)(
    'identifies the response execution for a %s provider launch',
    (launchState) => {
      const response = {
        kind: 'provider-session',
        jobId: 'job-1',
        execution: 2,
        launchState,
        requestedSeq: 10,
        epochKey: 'epoch',
      } as const;
      expect(formatLaunch(response)).toBe(
        `Provider job job-1 execution #2 ${launchState === 'running' ? 'launch accepted' : 'queued'}`,
      );
      expect(formatDetachedLaunchStatus(response)).toBe(`Provider job job-1 execution #2 ${launchState}`);
    },
  );

  it('identifies the execution in a detached workflow launch', () => {
    expect(
      formatDetachedLaunchStatus({
        kind: 'workflow',
        workflowId: 'workflow-1',
        jobId: 'job-1',
        execution: 1,
        launchState: 'queued',
        requestedSeq: 10,
        epochKey: 'epoch',
      }),
    ).toBe('Workflow workflow-1 queued (job job-1 execution #1)');
  });

  it.each(['running', 'queued'] as const)(
    'identifies only known executions in a %s foreground workflow launch',
    (launchState) => {
      const response = {
        kind: 'workflow',
        workflowId: 'workflow-1',
        jobId: 'job-1',
        launchState,
        requestedSeq: 10,
        epochKey: 'epoch',
      } as const;
      const state = launchState === 'running' ? 'launch accepted' : 'queued';
      expect(formatLaunch({ ...response, execution: 2 })).toBe(`Workflow workflow-1 ${state} (job job-1 execution #2)`);
      expect(formatLaunch(response)).toBe(`Workflow workflow-1 ${state} (job job-1)`);
    },
  );
});

it.each(['live-retry', 'recovery-quarantine'] as const)(
  'renders the durable finishing reason and inspects quarantine only for %s',
  (successor) => {
    const f = fixture('queued');
    const detail = f.store.loadJobDetailResponse(f.jobId)!;
    detail.status.finishingStatus = {
      stage: 'accept',
      kind: 'blocked',
      reason: 'disk unavailable',
      successor,
    };
    const text = formatJobDetail(detail);
    expect(text).toContain('Finishing status: blocked; disk unavailable');
    expect(text.includes('command=coral-cli backend recovery-quarantine list')).toBe(
      successor === 'recovery-quarantine',
    );
    expect(text).toContain(`successor=${successor}`);
    expect(formatJobsList({ jobs: [{ jobId: f.jobId, status: detail.status }] })[0].phase).toContain(
      'finishing blocked: disk unavailable',
    );
  },
);
