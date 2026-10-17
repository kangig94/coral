import { afterEach, expect, it, vi } from 'vitest';
import { CLI_HANDOFF_GUARD_ENV } from '#src/coordinator/handoff-routing/wait-invocation.js';
import { waitContinuationCommand } from '#src/cli/format/wait.js';
import { renderJobsOperatorCommand } from '#src/cli/format/jobs.js';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '', '0', 'true', '1'])(
  'chooses continuation grammar only from the exact handoff guard %s',
  (guard) => {
    vi.stubEnv(CLI_HANDOFF_GUARD_ENV, guard);
    const prefix = guard === '1' ? 'coral-cli wait jobs' : 'coral-cli jobs wait';
    expect(waitContinuationCommand(['a', 'b'], '7', 'snapshot')).toBe(`${prefix} a b --snapshot --cursor 7`);
    expect(waitContinuationCommand(['a'], null, 'bounded')).toBe(`${prefix} a`);
    expect(waitContinuationCommand(['a'], '8', 'unbounded')).toBe(`${prefix} a --unbounded --cursor 8`);
    expect(renderJobsOperatorCommand({ kind: 'wait-job', jobId: 'a' })).toBe(`${prefix} a`);
  },
);
