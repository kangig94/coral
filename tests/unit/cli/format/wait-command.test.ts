import { afterEach, expect, it, vi } from 'vitest';
import { CLI_HANDOFF_GUARD_ENV } from '#src/coordinator/handoff-routing/wait-invocation.js';
import { waitContinuationCommand } from '#src/cli/format/wait.js';
import { renderJobsOperatorCommand } from '#src/cli/format/jobs.js';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '1'])('uses the current wait command under handoff guard %s', (guard) => {
  vi.stubEnv(CLI_HANDOFF_GUARD_ENV, guard);
  const prefix = 'coral-cli jobs wait';
  expect(waitContinuationCommand(['a', 'b'], '7', 'snapshot')).toBe(`${prefix} a b --snapshot --cursor 7`);
  expect(waitContinuationCommand(['a'], null, 'stream')).toBe(`${prefix} a`);
  expect(waitContinuationCommand(['a'], '8', 'all')).toBe(`${prefix} a --all --cursor 8`);
  expect(renderJobsOperatorCommand({ kind: 'wait-job', jobId: 'a' })).toBe(`${prefix} a`);
});
