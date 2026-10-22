import { afterEach, describe, expect, it } from 'vitest';
import {
  formatDetachedLaunchStatus,
  formatJobDetail,
  formatJobsList,
  formatLaunch,
  renderJobsList,
} from '#src/cli/format/jobs.js';
import { jobReadSurfaceFixture } from '#tests/helpers/job-read-surface.js';

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
  });

  it.each(['running', 'queued'] as const)('prints only the job id for a %s provider launch', (launchState) => {
    const jobId = '10000000-0000-4000-8000-000000000001';
    const response = { kind: 'provider-session', jobId, launchState, requestedSeq: 2, epochKey: ':memory:' } as const;
    expect(formatLaunch(response)).toBe(
      `Provider job ${jobId} ${launchState === 'running' ? 'launch accepted' : 'queued'}`,
    );
    expect(formatDetachedLaunchStatus(response)).toBe(`Provider job ${jobId} ${launchState}`);
  });
});
