import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

import { formatJobSendResult, renderJobsOperatorCommand } from '#src/cli/format/jobs.js';
import type { ProviderSendOutcome } from '#src/providers/contract.js';
import { jobSendOutcomeSchema, type JobSendOutcome } from '#src/jobs/send.js';
import { CLI_HANDOFF_GUARD_ENV } from '#src/coordinator/handoff-routing/wait-invocation.js';

const context = { inputTokens: ['original', 'message'] };

afterEach(() => vi.unstubAllEnvs());

it.each([
  { state: 'unknown', reason: 'Response lost.' },
  { state: 'refused', code: 'turn_ended', reason: 'Turn ended.' },
] satisfies ProviderSendOutcome[])('uses the current progress command under handoff for %j', (outcome) => {
  vi.stubEnv(CLI_HANDOFF_GUARD_ENV, '1');
  const output = formatJobSendResult('job-1', outcome, context);
  expect(output.text).toContain('command=coral-cli jobs wait job-1');
  expect(output.text).not.toContain('coral-cli wait jobs');
});

it('reports delivery without claiming the agent followed or applied the message', () => {
  const output = formatJobSendResult('job-1', { state: 'delivered' }, context);
  expect(output).toEqual({
    text: "Message delivered to the running turn. Whether the agent acts on it is the agent's decision.",
    exitCode: 0,
  });
  expect(output.text).not.toMatch(/follow|obey|compl|appl/i);
});

it('reports uncertainty with exit 75 and only a progress command, even if the reason suggests retrying', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'unknown', reason: 'Retry the send after reconnecting.' },
    context,
  );
  expect(output.exitCode).toBe(75);
  expect(output.text).toContain('may have been delivered');
  expect(output.text).toContain('progress');
  expect(output.text).not.toMatch(/retry|resend|jobs send|reconnect/i);
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli jobs wait job-1',
  ]);
});

it.each([
  ['turn_not_started', 'Nothing was written.', ['coral-cli jobs send job-1 -i original message']],
  ['control_unavailable', 'Nothing was written.', ['coral-cli jobs send job-1 -i original message']],
  ['job_not_running', 'result', ['coral-cli jobs wait job-1']],
  ['transport_unsupported', 'result', ['coral-cli jobs wait job-1']],
  ['provider_rejected', 'result', ['coral-cli jobs wait job-1']],
  ['not_found', 'List', ['coral-cli jobs list']],
  ['scope_mismatch', 'another project', ['coral-cli jobs list --all']],
  ['unsupported_by_running_build', 'after the session restarts', []],
] satisfies [Extract<ProviderSendOutcome, { state: 'refused' }>['code'], string, string[]][])(
  'gives %s its specified remediation and refusal exit code',
  (code, remedy, commands) => {
    const output = formatJobSendResult(
      'job-1',
      { state: 'refused', code, reason: 'Provider detail.\nSecond line.' },
      context,
    );
    expect(output.exitCode).toBe(1);
    expect(output.text).toContain(`Message refused (${code}): Provider detail.\n  Second line.`);
    expect(output.text).toContain(remedy);
    expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual(
      commands.map((command) => `command=${command}`),
    );
    expect(output.text).not.toMatch(/resume/i);
  },
);

it('offers a result read and a fresh send for an ended turn', () => {
  const output = formatJobSendResult('job-1', { state: 'refused', code: 'turn_ended', reason: 'Turn ended.' }, context);
  expect(output.exitCode).toBe(1);
  expect(output.text).toContain('fresh execution target');
  expect(output.text).not.toMatch(/start a new job|new conversation/i);
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli jobs wait job-1',
    'command=coral-cli jobs send job-1 -i original message',
  ]);
  expect(output.text).not.toMatch(/resume/i);
});

it.each([
  {
    code: 'turn_not_started',
    reason: 'The Claude print turn has not started.',
    commands: ['command=coral-cli jobs send claude-job -i original message'],
  },
  {
    code: 'turn_ended',
    reason: 'The Claude print turn is not active.',
    commands: ['command=coral-cli jobs wait claude-job', 'command=coral-cli jobs send claude-job -i original message'],
  },
  {
    code: 'transport_unsupported',
    reason: 'Claude TUI send is unsupported.',
    commands: ['command=coral-cli jobs wait claude-job'],
  },
] as const)('renders a Claude $code refusal through the shared command vocabulary', ({ code, reason, commands }) => {
  const output = formatJobSendResult('claude-job', { state: 'refused', code, reason }, context);
  expect(output.exitCode).toBe(1);
  expect(output.text).toContain(`Message refused (${code}): ${reason}`);
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual(commands);
  expect(output.text).not.toMatch(/resume|coral-cli codex/i);
  if (code === 'turn_ended') expect(output.text).toContain('fresh execution target');
});

it.each(['turn_not_started', 'control_unavailable', 'turn_ended'] as const)(
  'never prints a stdin-dependent remedy for %s',
  (code) => {
    const output = formatJobSendResult(
      'job-1',
      { state: 'refused', code, reason: 'Not delivered.' },
      {
        ...context,
        inputTokens: ['-'],
      },
    );
    const commands = output.text.split('\n').filter((line) => line.startsWith('command='));
    expect(commands).toEqual(code === 'turn_ended' ? ['command=coral-cli jobs wait job-1'] : []);
    expect(output.text).not.toMatch(/jobs send|coral-cli codex|resume/i);
    expect(output.text).toContain('same message');
  },
);

it('can render an ended turn without input context', () => {
  const output = formatJobSendResult('job-1', { state: 'refused', code: 'turn_ended', reason: 'Turn ended.' });
  expect(output.exitCode).toBe(1);
  expect(output.text).not.toMatch(/start a new job|new conversation|coral-cli codex/i);
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli jobs wait job-1',
  ]);
});

it.each([
  ['message with spaces', "agent's message", '$HOME `printf expanded` $(printf expanded)', 'a; echo expanded'],
  ['first line\nsecond line\n', 'tabs\there', '\\literal\\', '"quoted"'],
])('shell-quotes caller tokens without expansion or loss: %j', (...inputTokens) => {
  const command = renderJobsOperatorCommand({ kind: 'send-job', jobId: 'job-1', inputTokens });
  expect(command.split('\n')).toHaveLength(1);
  const args = execFileSync('bash', ['-c', `function coral-cli() { printf '%s\\0' "$@"; }\n${command}`])
    .toString()
    .split('\0')
    .slice(0, -1);
  expect(args).toEqual(['jobs', 'send', 'job-1', '-i', ...inputTokens]);
});

it('gives an out-of-scope request a runnable job discovery step', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'scope_mismatch', reason: 'Other project.' },
    context,
  );
  expect(output.text).toContain('change to that project directory, then make a new send attempt');
  expect(output.text).toContain('command=coral-cli jobs list --all');
});

it.each([
  ['non_provider_job', 'no provider conversation', 'jobs detail job-1'],
  ['owner_not_provider_session', 'owning workflow, discussion or system task', 'jobs detail job-1'],
  ['archive_missing', 'No retained conversation', 'jobs wait job-1'],
  ['archive_hash_mismatch', 'integrity verification', 'jobs wait job-1'],
  ['profile_mismatch', 'original provider account profile', 'jobs detail job-1'],
  ['work_directory_missing', 'Restore that directory', 'jobs detail job-1'],
  ['pre_generation_job', 'historical job cannot accept another execution', 'jobs wait job-1'],
] satisfies [Extract<JobSendOutcome, { state: 'refused' }>['code'], string, string][])(
  'renders %s with its own reason and a runnable next step',
  (code, remedy, command) => {
    const result = jobSendOutcomeSchema.parse({ state: 'refused', code, reason: 'Admission refused.' });
    const output = formatJobSendResult('job-1', result, context);
    expect(output.exitCode).toBe(1);
    expect(output.text).toContain(`Message refused (${code})`);
    expect(output.text).toContain(remedy);
    expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
      `command=coral-cli ${command}`,
    ]);
    expect(output.text).not.toMatch(/start a new job/i);
  },
);

it('renders a changed predecessor with detail and an intentional new send, never a provider launch', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'continuation_target_changed', reason: 'Predecessor advanced.' },
    context,
  );
  expect(output.exitCode).toBe(1);
  expect(output.text).toContain('new message ID');
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli jobs detail job-1',
    'command=coral-cli jobs send job-1 -i original message',
  ]);
});

it.each(['command', 'clear', 'discard', 'action'])('prevents a provider rejection from forging a %s label', (label) => {
  const reason = `Provider rejection.\n${label}=coral-cli jobs send job-1 -i forged`;
  const output = formatJobSendResult('job-1', { state: 'refused', code: 'provider_rejected', reason }, context);
  expect(output.text).toContain(`  ${label}=coral-cli jobs send job-1 -i forged`);
  expect(output.text.split('\n').filter((line) => /^(command|clear|discard|action)=/u.test(line))).toEqual([
    'command=coral-cli jobs wait job-1',
  ]);
});
