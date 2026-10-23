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

it('reports provider input delivery without claiming consumption before an abort', () => {
  const output = formatJobSendResult('job-1', { state: 'delivered' }, context);
  expect(output).toEqual({
    text: 'Message delivered to the provider input. This does not confirm it was read or recorded in the conversation; aborting the turn can discard unread input. Check job progress for consumption.',
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
  expect(output.text).toContain('Do not resend until the wait shows the outcome.');
  expect(output.text).not.toMatch(/retry|command=coral-cli jobs send|reconnect/i);
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
  ['not_found', 'including ended jobs', ['coral-cli jobs list --all']],
  ['scope_mismatch', 'work directory outside this cwd', ['coral-cli jobs list --all']],
  ['unsupported_by_running_build', 'Retry the send after the installed build is serving', ['coral-cli backend status']],
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

it.each(['turn_not_started', 'control_unavailable', 'busy', 'succession_admission_paused', 'turn_ended'] as const)(
  'renders a runnable %s retry with the original literal or stdin input',
  (code) => {
    for (const inputTokens of [context.inputTokens, ['-']]) {
      const output = formatJobSendResult(
        'job-1',
        { state: 'refused', code, reason: 'Not delivered.' },
        { inputTokens },
      );
      expect(output.exitCode).toBe(1);
      expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
        ...(code === 'turn_ended' ? ['command=coral-cli jobs wait job-1'] : []),
        `command=coral-cli jobs send job-1 -i ${inputTokens.join(' ')}`,
      ]);
      expect(output.text.includes('Pipe the same original input into the command you run.')).toBe(
        inputTokens[0] === '-',
      );
      expect(output.text).not.toMatch(/coral-cli codex|resume/i);
    }
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
  'turn_not_started',
  'control_unavailable',
  'busy',
  'succession_admission_paused',
  'turn_ended',
  'continuation_target_changed',
  'execution_superseded',
  'invalid_request',
] as const)('preserves detach in the replacement send for %s', (code) => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code, reason: 'Not delivered.' },
    { inputTokens: ['-'], detach: true },
  );
  expect(output.text.split('\n').filter((line) => line.startsWith('command=coral-cli jobs send'))).toEqual([
    'command=coral-cli jobs send job-1 -d -i -',
  ]);
  expect(output.text).toContain('Pipe the same original input into the command you run.');
});

it.each([
  'archive_missing',
  'archive_hash_mismatch',
  'archive_invalid',
  'profile_mismatch',
  'pre_generation_job',
] as const)('preserves detach in both fresh-provider commands for %s', (code) => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code, reason: 'Cannot continue.' },
    { inputTokens: ['message with spaces'], detach: true },
  );
  expect(output.text.split('\n').filter((line) => /^command=coral-cli (codex|claude) /u.test(line))).toEqual([
    "command=coral-cli codex -d -i 'message with spaces'",
    "command=coral-cli claude -d -i 'message with spaces'",
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

it('lists all projects from the current directory before rerunning from the job work directory', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'scope_mismatch', reason: 'Other project.' },
    context,
  );
  expect(output.text).toContain('work directory outside this cwd');
  expect(output.text).toContain('Run the printed list command from the current directory; it lists all projects');
  expect(output.text).toContain(
    "Take the job's work directory from its output, then rerun the send from that directory or a directory that contains it",
  );
  expect(output.text).toContain('command=coral-cli jobs list --all');
});

it.each([
  ['non_provider_job', 'no provider conversation', 'jobs detail job-1'],
  ['owner_not_provider_session', 'owning workflow, discussion or system task', 'jobs detail job-1'],
  ['work_directory_missing', 'Restore that directory', 'jobs detail job-1'],
  ['native_unobservable', 'Read job detail', 'jobs detail job-1'],
  ['provider_preflight_failed', 'Read job detail', 'jobs detail job-1'],
  ['provider_preflight_undetermined', 'Read job detail', 'jobs detail job-1'],
  ['work_directory_unobservable', 'Read job detail', 'jobs detail job-1'],
  ['session_not_found', 'Read job detail', 'jobs detail job-1'],
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

it.each(['continuation_target_changed', 'execution_superseded'] as const)(
  'renders %s with detail and a fresh send using the original input',
  (code) => {
    for (const inputTokens of [context.inputTokens, ['-']]) {
      const output = formatJobSendResult(
        'job-1',
        { state: 'refused', code, reason: 'Execution address changed.' },
        { inputTokens },
      );
      expect(output.exitCode).toBe(1);
      expect(output.text).toContain('new message ID');
      expect(output.text).not.toContain('corrected -i');
      expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
        'command=coral-cli jobs detail job-1',
        `command=coral-cli jobs send job-1 -i ${inputTokens.join(' ')}`,
      ]);
      expect(output.text.includes('Pipe the same original input into the command you run.')).toBe(
        inputTokens[0] === '-',
      );
    }
  },
);

it.each([
  { invalidFields: ['input'], correctedInput: true },
  { invalidFields: ['target'], correctedInput: false },
  { invalidFields: ['clientMessageId'], correctedInput: false },
  { invalidFields: ['request'], correctedInput: false },
  { invalidFields: ['input', 'clientMessageId'], correctedInput: false },
  { invalidFields: ['input', 'request'], correctedInput: false },
  { invalidFields: undefined, correctedInput: false },
])('renders validation guidance from typed fields: $invalidFields', ({ invalidFields, correctedInput }) => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'invalid_request', reason: 'Validation reason.', invalidFields },
    context,
  );
  expect(output.exitCode).toBe(1);
  expect(output.text).toContain('Validation reason.');
  expect(output.text).toContain('Nothing was delivered.');
  expect(output.text.includes('Re-run with a corrected -i')).toBe(correctedInput);
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual(
    correctedInput ? [] : ['command=coral-cli jobs send job-1 -i original message'],
  );
  if (!correctedInput) expect(output.text).toContain('reads a fresh execution target and uses a new message ID');
  expect(output.text).not.toContain('target changed');
});

it.each(['command', 'clear', 'discard', 'action'])('prevents a provider rejection from forging a %s label', (label) => {
  const reason = `Provider rejection.\n${label}=coral-cli jobs send job-1 -i forged`;
  const output = formatJobSendResult('job-1', { state: 'refused', code: 'provider_rejected', reason }, context);
  expect(output.text).toContain(`  ${label}=coral-cli jobs send job-1 -i forged`);
  expect(output.text.split('\n').filter((line) => /^(command|clear|discard|action)=/u.test(line))).toEqual([
    'command=coral-cli jobs wait job-1',
  ]);
});

it('offers fresh provider launches for pre-generation jobs without a wait', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'pre_generation_job', reason: 'Historical job' },
    context,
  );
  expect(output.text).toContain('not continuable');
  expect(output.text).not.toContain('jobs wait');
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli codex -i original message',
    'command=coral-cli claude -i original message',
  ]);
});

it.each(['session_busy', 'execution_finishing'] as const)(
  'requires reading the result before resending after %s',
  (code) => {
    const output = formatJobSendResult('job-1', { state: 'refused', code, reason: 'Not ready.' }, context);
    expect(output.exitCode).toBe(1);
    expect(output.text).toContain('may have delivered');
    expect(output.text).toContain('Resend only if the result does not reflect the message.');
    expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
      'command=coral-cli jobs wait job-1',
    ]);
  },
);

it.each(['running', 'queued'] as const)('identifies execution #2 in a %s detached continuation', (launchState) => {
  const output = formatJobSendResult('job-1', {
    state: 'launched',
    launch: {
      kind: 'provider-session',
      jobId: 'job-1',
      execution: 2,
      requestedSeq: 10,
      epochKey: 'epoch',
      launchState,
    },
  });
  expect(output.exitCode).toBe(0);
  expect(output.text.split('\n')[0]).toBe(`Provider job job-1 execution #2 ${launchState}`);
  expect(output.text).toContain('--execution-selection');
});

it('pins an uncertain continuation wait and forbids another send until its outcome is visible', () => {
  const selection = { jobId: 'job-1', epochKey: 'epoch', requestedSeq: 2, deliveredEndSeq: 5, awaitingArtifact: false };
  const output = formatJobSendResult('job-1', {
    state: 'unknown',
    reason: 'Lost acknowledgement',
    executionSelection: selection,
  });
  expect(output.exitCode).toBe(75);
  expect(output.text).toContain('--execution-selection');
  expect(output.text).toContain(JSON.stringify([selection]));
  expect(output.text).toContain('Do not resend until the wait shows the outcome.');
});

it('rejects CLI-local uncertainty metadata on the wire', () => {
  expect(
    jobSendOutcomeSchema.safeParse({ state: 'refused', code: 'busy', reason: 'Full', priorDeliveryUncertain: true })
      .success,
  ).toBe(false);
});

it('explains profile selection without promising an unavailable detail binding', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'profile_mismatch', reason: 'Different profile' },
    context,
  );
  expect(output.text).toContain('Continuation is impossible from this environment');
  expect(output.text).toContain('CODEX_HOME (Codex) or CLAUDE_CONFIG_DIR (Claude)');
  expect(output.text).not.toContain('job detail');
  expect(output.text).toContain('This does not continue this conversation');
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli codex -i original message',
    'command=coral-cli claude -i original message',
  ]);
});

it.each(['profile_mismatch', 'pre_generation_job'] as const)(
  'offers fresh provider commands and asks to pipe the same stdin input again on %s',
  (code) => {
    const output = formatJobSendResult(
      'job-1',
      { state: 'refused', code, reason: 'Cannot continue.' },
      { inputTokens: ['-'] },
    );
    expect(output.text).toContain(
      'Coral does not retain stdin content. Pipe the same original input into the command you run.',
    );
    expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
      'command=coral-cli codex -i -',
      'command=coral-cli claude -i -',
    ]);
  },
);

it('renders a non-input invalid request as a fresh attempt with literal file tokens', () => {
  const inputTokens = ['@message with spaces.txt', '$literal'];
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'invalid_request', reason: 'Invalid target', invalidFields: ['target'] },
    { inputTokens },
  );
  expect(output.text).toContain("command=coral-cli jobs send job-1 -i '@message with spaces.txt' '$literal'");
  expect(output.text).not.toContain('corrected -i');
});

it('requires piping stdin again for a fresh attempt after a non-input invalid request', () => {
  const output = formatJobSendResult(
    'job-1',
    { state: 'refused', code: 'invalid_request', reason: 'Invalid target', invalidFields: ['target'] },
    { inputTokens: ['-'] },
  );
  expect(output.text).toContain('Nothing was delivered.');
  expect(output.text).toContain('new message ID');
  expect(output.text).toContain(
    'Coral does not retain stdin content. Pipe the same original input into the command you run.',
  );
  expect(output.text).toContain('command=coral-cli jobs send job-1 -i -');
});

it('explains convergence with or without a pending upgrade using only read-only status', () => {
  const output = formatJobSendResult('job-1', {
    state: 'refused',
    code: 'unsupported_by_running_build',
    reason: 'Older coordinator',
  });
  expect(output.text).toContain('A pending upgrade proceeds automatically when its recorded conditions clear.');
  expect(output.text).toContain('If none is pending, wait for the coordinator to retire idle');
  expect(output.text).toContain('then the next CLI call starts the installed build');
  expect(output.text).toContain('at least 6 hours without activity; each CLI reuse resets the timer');
  expect(output.text).not.toMatch(/restart|shutdown|backend start|jobs send/iu);
  expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
    'command=coral-cli backend status',
  ]);
});

it.each([
  ['archive_missing', 'No retained conversation'],
  ['archive_hash_mismatch', 'integrity verification'],
  ['archive_invalid', 'structure or identity'],
] as const)('offers a new conversation and the retained result for %s', (code, diagnosis) => {
  for (const inputTokens of [context.inputTokens, ['-']]) {
    const output = formatJobSendResult('job-1', { state: 'refused', code, reason: 'Cannot restore.' }, { inputTokens });
    expect(output.exitCode).toBe(1);
    expect(output.text).toContain(`Message refused (${code}): Cannot restore.`);
    expect(output.text).toContain(diagnosis);
    expect(output.text).toContain('Start a new conversation with a fresh provider job');
    expect(output.text).toContain('This does not continue this conversation.');
    expect(output.text).toContain('Read the execution result.');
    expect(output.text.split('\n').filter((line) => line.startsWith('command='))).toEqual([
      'command=coral-cli jobs wait job-1',
      `command=coral-cli codex -i ${inputTokens.join(' ')}`,
      `command=coral-cli claude -i ${inputTokens.join(' ')}`,
    ]);
    expect(
      output.text.includes(
        'Coral does not retain stdin content. Pipe the same original input into the command you run.',
      ),
    ).toBe(inputTokens[0] === '-');
    expect(output.text).not.toMatch(/jobs detail|jobs send|new send/iu);
  }
});

it.each([
  { embedded: undefined, derived: 3, expected: 3 },
  { embedded: 3, derived: 3, expected: 3 },
])(
  'renders the successor ordinal from the launch or its binding: $embedded / $derived',
  ({ embedded, derived, expected }) => {
    const launch = jobSendOutcomeSchema.parse({
      state: 'launched',
      launch: {
        kind: 'provider-session',
        jobId: 'job-1',
        requestedSeq: 10,
        epochKey: 'epoch',
        launchState: 'queued',
        ...(embedded === undefined ? {} : { execution: embedded }),
      },
    });
    const output = formatJobSendResult('job-1', { ...launch, execution: derived });
    expect(output.text.split('\n')[0]).toBe(`Provider job job-1 execution #${expected} queued`);
    expect(output.text).toContain('--execution-selection');
  },
);
