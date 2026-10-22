import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeFs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type * as DispatchMod from '#src/cli/dispatch.js';
import type * as ReadStoreMod from '#src/cli/read-store.js';
import type * as FollowMod from '#src/cli/follow.js';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { assertCommandClassCoverage, classifyCommand } from '#src/cli/classify.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import type { JobsListResponse } from '#src/jobs/records.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { admitted, testSession } from '#tests/helpers/wait-session.js';
import type { JobSendOutcome } from '#src/jobs/send.js';
import type { CliJobSendOutcome } from '#src/cli/dispatch.js';
import { registerProviderCommands } from '#src/cli/commands/provider.js';
import { formatJobSendResult } from '#src/cli/format/jobs.js';
import { followJobs, launchAndFollow } from '#src/cli/follow.js';

const client = vi.hoisted(() => ({
  listJobs: vi.fn<() => Promise<JobsListResponse>>(async () => ({ jobs: [] })),
  abortJobs: vi.fn(async () => ({ aborted: ['a'], notFound: [] })),
  snapshotJobsWait: vi.fn(),
  sendJob: vi.fn<() => Promise<CliJobSendOutcome>>(async () => ({ state: 'delivered' })),
  createSession: vi.fn(async () => ({
    kind: 'provider-session',
    jobId: 'p',
    requestedSeq: 1,
    epochKey: 'epoch',
    launchState: 'running',
  })),
}));
const stdin = vi.hoisted(() => ({ text: '' }));
const readStore = vi.hoisted(() => ({
  jobs: {
    detail: vi.fn(() => ({ status: { jobKind: 'provider' } })),
    conversation: vi.fn<() => { binding: { provider: string }; agent?: string }>(() => ({
      binding: { provider: 'codex' },
      agent: 'coral:architect',
    })),
  },
}));
vi.mock('#src/cli/read-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ReadStoreMod>()),
  getSharedReadCoralStore: () => readStore,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], options?: unknown) =>
      path === 0 ? stdin.text : actual.readFileSync(path, options as BufferEncoding),
    ),
  };
});
vi.mock('#src/cli/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DispatchMod>()),
  makeClient: () => client,
}));
vi.mock('#src/cli/follow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof FollowMod>()),
  followJobs: vi.fn(async () => 0),
  launchAndFollow: vi.fn(async () => 7),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function program(): Command {
  const root = new Command()
    .name('coral-cli')
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSessionCommands(root, createBuiltInProviderRegistry());
  return root;
}

it('prints jobs help without querying or mutating jobs', async () => {
  const root = program();
  let output = '';
  const jobs = root.commands.find((command) => command.name() === 'jobs')!;
  jobs.configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: (text) => {
      output += text;
    },
  });
  await expect(root.parseAsync(['jobs'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.help' });
  expect(output).toContain('Usage: coral-cli jobs');
  expect([...output.matchAll(/^\s+(list|wait|abort|send|detail|release)\b/gm)].map((match) => match[1])).toEqual([
    'list',
    'wait',
    'abort',
    'send',
    'detail',
    'release',
  ]);
  expect(client.listJobs).not.toHaveBeenCalled();
  expect(client.abortJobs).not.toHaveBeenCalled();
  expect(client.sendJob).not.toHaveBeenCalled();
  expect(jobs.options).toEqual([]);
});

it('explains required send input resolution and ended-turn behavior in help', () => {
  const jobs = program().commands.find((command) => command.name() === 'jobs')!;
  const help = jobs.commands
    .find((command) => command.name() === 'send')!
    .helpInformation()
    .replace(/\s+/gu, ' ');
  expect(help).toContain('required');
  expect(help).toContain('Canonical job UUID (required)');
  expect(help).toContain('tokens are joined with single spaces');
  expect(help).toContain('the whole input is read if it names an existing regular file');
  expect(help).toContain('stdin if exactly -');
  expect(help).toContain("continue an ended job's conversation");
  expect(help).toContain('ignored for a steer');
  expect(help).toContain('--detach');
});

it.each([
  [['abort', 'jobs', 'a'], "unknown command 'abort'"],
  [['jobs', '--all'], "unknown option '--all'"],
])('rejects the retired invocation %j', async (argv, message) => {
  await expect(program().parseAsync(argv, { from: 'user' })).rejects.toThrow(message);
  expect(client.listJobs).not.toHaveBeenCalled();
  expect(client.abortJobs).not.toHaveBeenCalled();
});

it('keeps listing options on jobs list and aborts explicit IDs under jobs', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await program().parseAsync(['jobs', 'list', '--mine', '--unwaited', '--json'], { from: 'user' });
  expect(client.listJobs).toHaveBeenCalledWith({ allProjects: true, mine: true, unwaited: true });
  await program().parseAsync(['jobs', 'abort', 'a'], { from: 'user' });
  expect(client.abortJobs).toHaveBeenCalledWith(['a']);
});

it('hides both legacy commands and gives both grammars the same options and action', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  const session = testSession(['a']);
  session.reconcile([admitted('a', [], false)]);
  client.snapshotJobsWait.mockResolvedValue(selectWaitSnapshot(session, 7));
  const root = program();
  const jobs = root.commands.find((command) => command.name() === 'jobs')!;
  const wait = root.commands.find((command) => command.name() === 'wait')!;
  const current = jobs.commands.find((command) => command.name() === 'wait')!;
  const legacy = wait.commands.find((command) => command.name() === 'jobs')!;
  expect(root.helpInformation()).not.toMatch(/^\s+wait\b/m);
  expect(wait.helpInformation()).not.toMatch(/^\s+jobs\b/m);
  expect(current.options.map((option) => option.flags)).toEqual(legacy.options.map((option) => option.flags));
  for (const argv of [
    ['jobs', 'wait'],
    ['wait', 'jobs'],
  ]) {
    await program().parseAsync([...argv, 'a', '--snapshot', '--lines', '7'], { from: 'user' });
    expect(client.snapshotJobsWait).toHaveBeenLastCalledWith({ jobIds: ['a'], projectRoot: process.cwd(), lines: 7 });
    expect(process.exitCode).toBe(75);
  }
  expect(client.snapshotJobsWait).toHaveBeenCalledTimes(2);
  expect(() => assertCommandClassCoverage(root)).not.toThrow();
  for (const [command, commandClass] of [
    [jobs.commands.find((command) => command.name() === 'list')!, 'directRead'],
    [current, 'subscribe'],
    [legacy, 'subscribe'],
    [jobs.commands.find((command) => command.name() === 'abort')!, 'mutate'],
    [jobs.commands.find((command) => command.name() === 'send')!, 'mutate'],
  ] as const)
    expect(classifyCommand(command)).toMatchObject({ kind: 'class', commandClass });
});

it('registers send with one job ID and the provider input option', () => {
  const root = program();
  registerProviderCommands(root, createBuiltInProviderRegistry());
  const jobs = root.commands.find((command) => command.name() === 'jobs')!;
  const send = jobs.commands.find((command) => command.name() === 'send')!;
  const provider = root.commands.find((command) => command.name() === 'codex')!;
  expect(send.registeredArguments.map((argument) => [argument.name(), argument.required, argument.variadic])).toEqual([
    ['jobId', true, false],
  ]);
  expect(send.options.find((option) => option.long === '--input')?.flags).toBe(
    provider.options.find((option) => option.long === '--input')?.flags,
  );
});

it('resolves text tokens and existing files identically for send and provider launch', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const dir = mkdtempSync(join(tmpdir(), 'coral-send-input-'));
  const path = join(dir, 'message.txt');
  writeFileSync(path, 'file body\n');
  try {
    for (const [tokens, expected] of [
      [['literal', 'message'], 'literal message'],
      [[path], 'file body\n'],
      [['prefix', path, 'suffix'], `prefix ${path} suffix`],
    ] as const) {
      const root = program();
      registerProviderCommands(root, createBuiltInProviderRegistry());
      await root.parseAsync(['codex', '-d', '-i', ...tokens], { from: 'user' });
      expect(client.createSession).toHaveBeenLastCalledWith('codex', expected, expect.any(Object));
      await root.parseAsync(['jobs', 'send', 'job-1', '-i', ...tokens], { from: 'user' });
      expect(client.sendJob).toHaveBeenLastCalledWith('job-1', expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([[], ['-i', ''], ['-i', ' \n\t']].map((args) => [args]))(
  'rejects empty send input %j with every valid input form',
  async (args) => {
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await program().parseAsync(['jobs', 'send', 'job-1', ...args], { from: 'user' });
    expect(process.exitCode).toBe(2);
    const text = output.mock.calls.map(([value]) => String(value)).join('');
    for (const form of ['-i <text>', '-i <file>', '-i -', 'code=invalid_usage']) expect(text).toContain(form);
    expect(client.sendJob).not.toHaveBeenCalled();
  },
);

it('rejects a file containing only whitespace before dispatch', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const dir = mkdtempSync(join(tmpdir(), 'coral-send-empty-'));
  const path = join(dir, 'empty.txt');
  writeFileSync(path, ' \n');
  try {
    await program().parseAsync(['jobs', 'send', 'job-1', '-i', path], { from: 'user' });
    expect(process.exitCode).toBe(2);
    expect(client.sendJob).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['send', 'provider'])('resolves literal stdin for %s through the shared resolver', async (surface) => {
  vi.resetModules();
  stdin.text = 'stdin `literal` $(text) $VAR\n';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const root = new Command();
  const registry = createBuiltInProviderRegistry();
  if (surface === 'send') {
    const { registerSessionCommands: register } = await import('#src/cli/commands/session.js');
    register(root, registry);
    await root.parseAsync(['jobs', 'send', 'job-1', '-i', '-'], { from: 'user' });
    expect(client.sendJob).toHaveBeenCalledExactlyOnceWith('job-1', stdin.text);
  } else {
    const { registerProviderCommands: register } = await import('#src/cli/commands/provider.js');
    register(root, registry);
    await root.parseAsync(['codex', '-d', '-i', '-'], { from: 'user' });
    expect(client.createSession).toHaveBeenCalledExactlyOnceWith('codex', stdin.text, expect.any(Object));
  }
});

it('rejects empty stdin with a usage error naming valid forms', async () => {
  vi.resetModules();
  stdin.text = '';
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const { registerSessionCommands: register } = await import('#src/cli/commands/session.js');
  const root = new Command();
  register(root, createBuiltInProviderRegistry());
  await root.parseAsync(['jobs', 'send', 'job-1', '-i', '-'], { from: 'user' });
  expect(process.exitCode).toBe(2);
  const text = output.mock.calls.map(([value]) => String(value)).join('');
  for (const form of ['-i <text>', '-i <file>', '-i -']) expect(text).toContain(form);
  expect(client.sendJob).not.toHaveBeenCalled();
});

it.each([
  [
    { state: 'delivered' },
    0,
    "Message delivered to the running turn. Whether the agent acts on it is the agent's decision.",
  ],
  [
    { state: 'refused', code: 'turn_ended', reason: 'The turn ended.' },
    1,
    'Message refused (turn_ended): The turn ended.\n' +
      "Read the job's result before requesting another execution of its conversation.\ncommand=coral-cli jobs wait job-1\n" +
      'A new intentional send attempt reads a fresh execution target and uses a new message ID.\n' +
      'command=coral-cli jobs send job-1 -i message',
  ],
  [
    { state: 'unknown', reason: 'No answer.' },
    75,
    "Unknown: message may have been delivered. Check the job's progress for evidence.\ncommand=coral-cli jobs wait job-1\nDo not resend until the wait shows the outcome.",
  ],
] satisfies [JobSendOutcome, number, string][])('renders %j with exit %i', async (result, exitCode, expected) => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  client.sendJob.mockResolvedValueOnce(result);
  await program().parseAsync(['jobs', 'send', 'job-1', '-i', 'message'], { from: 'user' });
  expect(process.exitCode).toBe(exitCode);
  expect(exitCode === 0 ? stdout : stderr).toHaveBeenCalledExactlyOnceWith(expected + '\n');
  expect(exitCode === 0 ? stderr : stdout).not.toHaveBeenCalled();
});

function printedCommands(output: string): string[][] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('command='))
    .map((line) =>
      execFileSync('bash', ['-c', `function coral-cli() { printf '%s\\0' "$@"; }\n${line.slice('command='.length)}`])
        .toString()
        .split('\0')
        .slice(0, -1),
    );
}

it.each(['turn_not_started', 'control_unavailable'] as const)(
  'executes the exact printed %s remedy with the original file and text tokens',
  async (code) => {
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), 'coral-send-remedy-'));
    const path = join(dir, "agent's message.txt");
    writeFileSync(path, 'file body');
    const tokens = ['prefix', '-', path, '$HOME `literal` $(printf literal)'];
    try {
      client.sendJob.mockResolvedValueOnce({ state: 'refused', code, reason: 'Not ready.' });
      await program().parseAsync(['jobs', 'send', 'job-1', '-i', ...tokens], { from: 'user' });
      expect(process.exitCode).toBe(1);
      const commands = printedCommands(output.mock.calls.map(([text]) => String(text)).join(''));
      expect(commands).toEqual([['jobs', 'send', 'job-1', ...tokens.map((token) => `--input=${token}`)]]);
      expect(client.sendJob).toHaveBeenLastCalledWith('job-1', tokens.join(' '));
      await program().parseAsync(commands[0], { from: 'user' });
      expect(client.sendJob).toHaveBeenCalledTimes(2);
      expect(client.sendJob.mock.calls[1]).toEqual(client.sendJob.mock.calls[0]);
      expect(process.exitCode).toBe(0);
      expect(readStore.jobs.detail).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('executes an ended-turn result remedy and sends the original input unchanged on a new attempt', async () => {
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  client.sendJob.mockResolvedValueOnce({ state: 'refused', code: 'turn_ended', reason: 'Ended.' });
  const inputTokens = ['a message', '-', '$HOME', "don't expand"];
  await program().parseAsync(['jobs', 'send', 'job-1', '-i', ...inputTokens], { from: 'user' });
  expect(client.sendJob).toHaveBeenLastCalledWith('job-1', inputTokens.join(' '));
  expect(process.exitCode).toBe(1);
  const commands = printedCommands(output.mock.calls.map(([text]) => String(text)).join(''));
  expect(commands).toEqual([
    ['jobs', 'wait', 'job-1'],
    ['jobs', 'send', 'job-1', ...inputTokens.map((token) => `--input=${token}`)],
  ]);
  const root = program();
  await root.parseAsync(commands[1], { from: 'user' });
  expect(client.sendJob).toHaveBeenCalledTimes(2);
  expect(client.sendJob.mock.calls[1]).toEqual(client.sendJob.mock.calls[0]);
  expect(readStore.jobs.detail).not.toHaveBeenCalled();
  expect(readStore.jobs.conversation).not.toHaveBeenCalled();
  await root.parseAsync(commands[0], { from: 'user' });
  expect(followJobs).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      start: { kind: 'jobs', jobIds: ['job-1'] },
      projectRoot: process.cwd(),
    }),
  );
  expect(process.exitCode).toBe(0);
});
it.each([false, true])('follows a launched continuation by default and detaches=%s', async (detach) => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const launch = {
    kind: 'provider-session' as const,
    jobId: 'job-1',
    execution: 2,
    requestedSeq: 100,
    epochKey: 'epoch',
    launchState: 'queued' as const,
  };
  client.sendJob.mockResolvedValueOnce({ state: 'launched', launch });
  await program().parseAsync(['jobs', 'send', 'job-1', ...(detach ? ['-d'] : []), '-i', 'continue'], { from: 'user' });
  if (detach) {
    expect(launchAndFollow).not.toHaveBeenCalled();
    const text = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(text).toContain('Provider job job-1 execution #2 queued');
    expect(text).toContain('job-1');
    expect(text).toContain('--execution-selection');
    expect(text).toContain('100');
  } else {
    expect(launchAndFollow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ launchResult: launch }));
    expect(process.exitCode).toBe(7);
  }
});

it('detaches a continuation using the ordinal derived by target binding when the launch omits it', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  client.sendJob.mockResolvedValueOnce({
    state: 'launched',
    execution: 2,
    launch: { kind: 'provider-session', jobId: 'job-1', requestedSeq: 100, epochKey: 'epoch', launchState: 'queued' },
  });
  await program().parseAsync(['jobs', 'send', 'job-1', '-d', '-i', 'continue'], { from: 'user' });
  const text = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
  expect(text).toContain('Provider job job-1 execution #2 queued');
  expect(text).toContain('--execution-selection');
  expect(text).toContain('100');
  expect(launchAndFollow).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
});

it.each([false, true])('returns a steer immediately with detach=%s', async (detach) => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await program().parseAsync(['jobs', 'send', 'job-1', ...(detach ? ['-d'] : []), '-i', 'steer'], { from: 'user' });
  expect(launchAndFollow).not.toHaveBeenCalled();
  expect(followJobs).not.toHaveBeenCalled();
});

it('keeps option-looking input tokens as message text in the runnable retry command', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const output = formatJobSendResult(
    'job-1',
    {
      state: 'refused',
      code: 'turn_not_started',
      reason: 'Not ready.',
    },
    { inputTokens: ['-w', 'literal', '--model=example'] },
  );
  const commands = printedCommands(output.text);
  await program().parseAsync(commands[0], { from: 'user' });
  expect(client.sendJob).toHaveBeenCalledExactlyOnceWith('job-1', '-w literal --model=example');
  expect(process.exitCode).toBe(0);
});

it('executes the exact not-found list remedy under the current program', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const output = formatJobSendResult('missing', { state: 'refused', code: 'not_found', reason: 'Missing.' });
  const commands = printedCommands(output.text);
  expect(commands).toEqual([['jobs', 'list']]);
  await program().parseAsync(commands[0], { from: 'user' });
  expect(client.listJobs).toHaveBeenCalledOnce();
});

it.each(['turn_not_started', 'control_unavailable', 'turn_ended'] as const)(
  'prints a runnable stdin remedy and requires the original input for %s',
  async (code) => {
    vi.resetModules();
    stdin.text = 'stdin body';
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    client.sendJob.mockResolvedValueOnce({ state: 'refused', code, reason: 'Not delivered.' });
    const root = new Command();
    const { registerSessionCommands: register } = await import('#src/cli/commands/session.js');
    register(root, createBuiltInProviderRegistry());
    await root.parseAsync(['jobs', 'send', 'job-1', '-i', '-'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(printedCommands(text)).toEqual([
      ...(code === 'turn_ended' ? [['jobs', 'wait', 'job-1']] : []),
      ['jobs', 'send', 'job-1', '-i', '-'],
    ]);
    expect(text).toContain('Pipe the same original input into the command you run.');
    expect(text).not.toMatch(/resume|coral-cli codex/i);
    expect(readStore.jobs.detail).not.toHaveBeenCalled();
  },
);

it('preserves the refusal and result remedy when launch metadata cannot be read', async () => {
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  client.sendJob.mockResolvedValueOnce({ state: 'refused', code: 'turn_ended', reason: 'Ended.' });
  readStore.jobs.conversation.mockImplementationOnce(() => {
    throw new Error('Session not found.');
  });
  await program().parseAsync(['jobs', 'send', 'job-1', '-i', 'message'], { from: 'user' });
  expect(process.exitCode).toBe(1);
  const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
  expect(text).toContain('fresh execution target');
  expect(text).not.toMatch(/start a new job|new conversation/i);
  expect(printedCommands(text)).toEqual([
    ['jobs', 'wait', 'job-1'],
    ['jobs', 'send', 'job-1', '-i', 'message'],
  ]);
  expect(readStore.jobs.detail).not.toHaveBeenCalled();
});

it.each([
  [['--all'], {}],
  [['--phase', 'running'], { phase: 'running' }],
  [['--provider', 'codex'], { provider: 'codex' }],
  [['--phase', 'queued', '--provider', 'codex'], { phase: 'queued', provider: 'codex' }],
])('aborts live jobs selected by %j using the current-directory selector', async (args, filters) => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const jobs = [{ jobId: 'local' }, { jobId: 'kb' }] as JobsListResponse['jobs'];
  client.listJobs.mockResolvedValueOnce({ jobs });
  await program().parseAsync(['jobs', 'abort', ...args], { from: 'user' });
  expect(client.listJobs).toHaveBeenCalledExactlyOnceWith({ projectRoot: process.cwd(), all: false, ...filters });
  expect(client.abortJobs).toHaveBeenCalledExactlyOnceWith(['local', 'kb']);
});

it('reports an empty abort selection without sending an empty abort request', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  client.listJobs.mockResolvedValueOnce({ jobs: [] });
  await program().parseAsync(['jobs', 'abort', '--all'], { from: 'user' });
  expect(client.listJobs).toHaveBeenCalledOnce();
  expect(client.abortJobs).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalledWith('No jobs aborted\n');
});

it.each(
  [
    [],
    ['a', '--all'],
    ['a', '--phase', 'running'],
    ['a', '--provider', 'codex'],
    ['--all', '--phase', 'running'],
    ['--all', '--provider', 'codex'],
  ].map((args) => [args]),
)('refuses ambiguous or missing abort targets %j with all valid forms', async (args) => {
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await program().parseAsync(['jobs', 'abort', ...args], { from: 'user' });
  expect(process.exitCode).toBe(2);
  const text = output.mock.calls.map(([text]) => String(text)).join('');
  expect(text).toContain('coral-cli jobs abort <jobIds...>');
  expect(text).toContain('coral-cli jobs abort --all\n');
  expect(text).toContain('coral-cli jobs abort [--phase <phase>] [--provider <name>]');
  expect(text).toContain('--phase and --provider may be combined');
  expect(client.listJobs).not.toHaveBeenCalled();
  expect(client.abortJobs).not.toHaveBeenCalled();
});

it('shows the discrete abort forms and combinable filters in help', () => {
  const jobs = program().commands.find((command) => command.name() === 'jobs')!;
  const abort = jobs.commands.find((command) => command.name() === 'abort')!;
  let output = '';
  abort.configureOutput({
    writeOut: (text) => {
      output += text;
    },
  });
  abort.outputHelp();
  expect(output).toContain('coral-cli jobs abort <jobIds...>');
  expect(output).toContain('coral-cli jobs abort --all\n');
  expect(output).toContain('coral-cli jobs abort [--phase <phase>] [--provider <name>]');
  expect(output).toContain('--phase and --provider may be combined');
});

it.each(
  [
    ['--phase', 'completed'],
    ['--phase', 'unknown'],
    ['--provider', 'unknown'],
  ].map((args) => [args]),
)('refuses an invalid live selector %j', async (args) => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await program().parseAsync(['jobs', 'abort', ...args], { from: 'user' });
  expect(process.exitCode).toBe(2);
  expect(client.listJobs).not.toHaveBeenCalled();
  expect(client.abortJobs).not.toHaveBeenCalled();
});

it('passes the complete execution selection from a continuation into streaming follow', async () => {
  const selections = [
    { jobId: 'a', epochKey: 'epoch', requestedSeq: 1000, awaitingArtifact: false },
    { jobId: 'b', epochKey: 'epoch', requestedSeq: 2, deliveredEndSeq: 950, awaitingArtifact: false },
  ];
  await program().parseAsync([
    'node',
    'coral-cli',
    'jobs',
    'wait',
    'a',
    '--cursor',
    '279',
    '--execution-selection',
    JSON.stringify(selections),
  ]);
  expect(followJobs).toHaveBeenCalledWith(
    expect.objectContaining({
      start: { kind: 'jobs', jobIds: ['a'], serializedCursor: '279', executionSelections: selections },
    }),
  );
});

it('passes execution selection through snapshot requests and rendered continuations', async () => {
  const selections = [{ jobId: 'a', epochKey: 'epoch', requestedSeq: 1000, awaitingArtifact: false }];
  client.snapshotJobsWait.mockResolvedValueOnce({
    jobs: [{ jobId: 'a', disposition: 'admitted', phase: 'running', progress: [] }],
    notices: [],
    cursor: '1000',
    remainingJobIds: ['a'],
    exitCode: 75,
    executionSelections: selections,
  });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: unknown, callback?: () => void) => {
    output += String(text);
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  await program().parseAsync([
    'node',
    'coral-cli',
    'jobs',
    'wait',
    'a',
    '--snapshot',
    '--cursor',
    '279',
    '--execution-selection',
    JSON.stringify(selections),
  ]);
  expect(client.snapshotJobsWait).toHaveBeenCalledWith(
    expect.objectContaining({ cursor: '279', executionSelections: selections }),
  );
  expect(output).toContain(`--execution-selection '${JSON.stringify(selections)}'`);
  expect(output).toContain('--snapshot --cursor 1000');
});

it.each([[], ['--snapshot'], ['--unbounded']].map((args) => [args]))(
  'rejects malformed execution selections with a runnable recovery %j',
  async (mode) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await program().parseAsync([
      'node',
      'coral-cli',
      'jobs',
      'wait',
      'a',
      'b',
      ...mode,
      '--execution-selection',
      '{bad',
    ]);
    expect(process.exitCode).toBe(2);
    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain('Rerun the printed continuation exactly as printed');
    expect(output).toContain('coral-cli jobs wait a b');
    expect(followJobs).not.toHaveBeenCalled();
    expect(client.snapshotJobsWait).not.toHaveBeenCalled();
  },
);

it('renders a snapshot admission refusal with one snapshot-mode fresh-wait remedy', async () => {
  client.snapshotJobsWait.mockRejectedValueOnce(
    new Error('wire', {
      cause: {
        code: 'wait_selection_invalid',
        message: 'Malformed selection.',
        remedy: { kind: 'fresh-wait', jobIds: ['a'] },
      },
    }),
  );
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await program().parseAsync(['node', 'coral-cli', 'jobs', 'wait', 'a', '--snapshot']);
  const output = stderr.mock.calls.map(([text]) => String(text)).join('');
  expect(output.match(/coral-cli jobs wait/g)).toHaveLength(1);
  expect(output).toContain('coral-cli jobs wait a --snapshot');
  expect(output).toContain('Already-delivered results may print again.');
  expect(process.exitCode).toBe(1);
});
