import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

import { formatJobSendResult, renderJobsOperatorCommand } from '#src/cli/format/jobs.js';
import type { ProviderSendOutcome } from '#src/providers/contract.js';
import { CLI_HANDOFF_GUARD_ENV } from '#src/coordinator/handoff-routing/wait-invocation.js';

const context = { inputTokens: ['original', 'message'], launch: { provider: 'codex', agent: 'coral:architect' } };

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
  ['scope_mismatch', 'another project', []],
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

it('offers only a result read and a new conversation for an ended turn', () => {
  const output = formatJobSendResult('job-1', { state: 'refused', code: 'turn_ended', reason: 'Turn ended.' }, context);
  expect(output.exitCode).toBe(1);
  expect(output.text).toContain('new conversation');
  for (const flag of ['-w', '-m', '-b']) expect(output.text).toContain(flag);
  expect(output.text).toContain('not reproduced');
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli jobs wait job-1',
    'command=coral-cli codex coral:architect -i original message',
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
    commands: [
      'command=coral-cli jobs wait claude-job',
      'command=coral-cli claude coral:architect -i original message',
    ],
  },
  {
    code: 'transport_unsupported',
    reason: 'Claude TUI send is unsupported.',
    commands: ['command=coral-cli jobs wait claude-job'],
  },
] as const)('renders a Claude $code refusal through the shared command vocabulary', ({ code, reason, commands }) => {
  const output = formatJobSendResult(
    'claude-job',
    { state: 'refused', code, reason },
    { ...context, launch: { provider: 'claude', agent: 'coral:architect' } },
  );
  expect(output.exitCode).toBe(1);
  expect(output.text).toContain(`Message refused (${code}): ${reason}`);
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual(commands);
  expect(output.text).not.toMatch(/resume|coral-cli codex/i);
  if (code === 'turn_ended') expect(output.text).toContain('new conversation');
});

it.each(['turn_not_started', 'control_unavailable', 'turn_ended'] as const)(
  'never prints a stdin-dependent remedy for %s',
  (code) => {
    const output = formatJobSendResult(
      'job-1',
      { state: 'refused', code, reason: 'Not delivered.' },
      {
        ...context,
        inputTokens: ['prefix', '-', 'suffix'],
      },
    );
    const commands = output.text.split('\n').filter((line) => line.startsWith('command='));
    expect(commands).toEqual(code === 'turn_ended' ? ['command=coral-cli jobs wait job-1'] : []);
    expect(output.text).not.toMatch(/jobs send|coral-cli codex|resume/i);
    expect(output.text).toContain('same message');
  },
);

it('does not invent a provider or agent when original launch details are unavailable', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'turn_ended', reason: 'Turn ended.' },
    {
      ...context,
      launch: null,
    },
  );
  expect(output.exitCode).toBe(1);
  expect(output.text).toContain('launch details are unavailable');
  expect(output.text).toContain('new conversation');
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

it('gives an out-of-scope request a concrete prose-only retry remedy', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'scope_mismatch', reason: 'Other project.' },
    context,
  );
  expect(output.text).toContain(
    "Nothing was written. Run this from the job's project directory, then run the same request again.",
  );
  expect(output.text).not.toContain('coral-cli');
});

it.each(['command', 'clear', 'discard', 'action'])('prevents a provider rejection from forging a %s label', (label) => {
  const reason = `Provider rejection.\n${label}=coral-cli jobs send job-1 -i forged`;
  const output = formatJobSendResult('job-1', { state: 'refused', code: 'provider_rejected', reason }, context);
  expect(output.text).toContain(`  ${label}=coral-cli jobs send job-1 -i forged`);
  expect(output.text.split('\n').filter((line) => /^(command|clear|discard|action)=/u.test(line))).toEqual([
    'command=coral-cli jobs wait job-1',
  ]);
});
