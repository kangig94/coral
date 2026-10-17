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
import type { ProviderSendOutcome } from '#src/providers/contract.js';
import { registerProviderCommands } from '#src/cli/commands/provider.js';
import { formatJobSendResult } from '#src/cli/format/jobs.js';
import { followJobs } from '#src/cli/follow.js';

const client = vi.hoisted(() => ({
  listJobs: vi.fn<() => Promise<JobsListResponse>>(async () => ({ jobs: [] })),
  abortJobs: vi.fn(async () => ({ aborted: ['a'], notFound: [] })),
  snapshotJobsWait: vi.fn(),
  sendJob: vi.fn<() => Promise<ProviderSendOutcome>>(async () => ({ state: 'delivered' })),
  createSession: vi.fn(async () => ({
    kind: 'provider-session',
    sessionId: 's',
    jobId: 'p',
    launchState: 'running',
  })),
}));
const stdin = vi.hoisted(() => ({ text: '' }));
const readStore = vi.hoisted(() => ({
  jobs: { detail: vi.fn(() => ({ status: { jobKind: 'provider', sessionId: 'session-1' } })) },
  sessions: {
    readEntry: vi.fn<() => { binding: { provider: string }; agentName?: string }>(() => ({
      binding: { provider: 'codex' },
      agentName: 'coral:architect',
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
      [['prefix', path, 'suffix'], 'prefix file body\n suffix'],
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
      "Read the job's result.\ncommand=coral-cli jobs wait job-1\n" +
      'Start a new job with the same message; this starts a new conversation. The original -w, -m and -b options are not reproduced.\n' +
      'command=coral-cli codex coral:architect -i message',
  ],
  [
    { state: 'unknown', reason: 'No answer.' },
    75,
    "Unknown: message may have been delivered. Check the job's progress for evidence.\ncommand=coral-cli jobs wait job-1",
  ],
] satisfies [ProviderSendOutcome, number, string][])('renders %j with exit %i', async (result, exitCode, expected) => {
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
    const tokens = ['prefix', path, '$HOME `literal` $(printf literal)'];
    try {
      client.sendJob.mockResolvedValueOnce({ state: 'refused', code, reason: 'Not ready.' });
      await program().parseAsync(['jobs', 'send', 'job-1', '-i', ...tokens], { from: 'user' });
      expect(process.exitCode).toBe(1);
      const commands = printedCommands(output.mock.calls.map(([text]) => String(text)).join(''));
      expect(commands).toEqual([['jobs', 'send', 'job-1', '-i', ...tokens]]);
      await program().parseAsync(commands[0]!, { from: 'user' });
      expect(client.sendJob).toHaveBeenCalledTimes(2);
      expect(client.sendJob.mock.calls[1]).toEqual(client.sendJob.mock.calls[0]);
      expect(process.exitCode).toBe(0);
      expect(readStore.jobs.detail).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each([
  ['codex', 'coral:architect'],
  ['claude', undefined],
] as const)(
  'executes an ended-turn result remedy and parses a new %s conversation unchanged',
  async (provider, agent) => {
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    readStore.sessions.readEntry.mockReturnValueOnce({
      binding: { provider },
      ...(agent === undefined ? {} : { agentName: agent }),
    });
    client.sendJob.mockResolvedValueOnce({ state: 'refused', code: 'turn_ended', reason: 'Ended.' });
    const inputTokens = ['a message', '$HOME', "don't expand"];
    await program().parseAsync(['jobs', 'send', 'job-1', '-i', ...inputTokens], { from: 'user' });
    expect(process.exitCode).toBe(1);
    const commands = printedCommands(output.mock.calls.map(([text]) => String(text)).join(''));
    expect(commands).toEqual([
      ['jobs', 'wait', 'job-1'],
      [provider, ...(agent === undefined ? [] : [agent]), '-i', ...inputTokens],
    ]);
    const root = program();
    registerProviderCommands(root, createBuiltInProviderRegistry());
    const launch = root.commands.find((command) => command.name() === provider)!;
    const launchAction = vi.fn();
    launch.action(launchAction);
    await root.parseAsync(commands[1]!, { from: 'user' });
    expect(launchAction).toHaveBeenCalledOnce();
    expect(launchAction.mock.calls[0]?.[0]).toBe(agent);
    expect(launch.opts()).toEqual({ input: inputTokens });
    await root.parseAsync(commands[0]!, { from: 'user' });
    expect(followJobs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        start: { kind: 'jobs', jobIds: ['job-1'] },
        projectRoot: process.cwd(),
      }),
    );
    expect(process.exitCode).toBe(0);
  },
);

it('keeps option-looking input tokens as message text in the runnable retry command', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const output = formatJobSendResult(
    'job-1',
    {
      state: 'refused',
      code: 'turn_not_started',
      reason: 'Not ready.',
    },
    { inputTokens: ['-w', 'literal', '--model=example'], launch: null },
  );
  const commands = printedCommands(output.text);
  await program().parseAsync(commands[0]!, { from: 'user' });
  expect(client.sendJob).toHaveBeenCalledExactlyOnceWith('job-1', '-w literal --model=example');
  expect(process.exitCode).toBe(0);
});

it('executes the exact not-found list remedy under the current program', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const output = formatJobSendResult('missing', { state: 'refused', code: 'not_found', reason: 'Missing.' });
  const commands = printedCommands(output.text);
  expect(commands).toEqual([['jobs', 'list']]);
  await program().parseAsync(commands[0]!, { from: 'user' });
  expect(client.listJobs).toHaveBeenCalledOnce();
});

it.each(['turn_not_started', 'control_unavailable', 'turn_ended'] as const)(
  'does not print stdin-dependent commands for %s',
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
    expect(printedCommands(text)).toEqual(code === 'turn_ended' ? [['jobs', 'wait', 'job-1']] : []);
    expect(text).not.toMatch(/resume|jobs send|coral-cli codex/i);
    expect(readStore.jobs.detail).not.toHaveBeenCalled();
  },
);

it('preserves the refusal and result remedy when launch metadata cannot be read', async () => {
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  client.sendJob.mockResolvedValueOnce({ state: 'refused', code: 'turn_ended', reason: 'Ended.' });
  readStore.sessions.readEntry.mockImplementationOnce(() => {
    throw new Error('Session not found.');
  });
  await program().parseAsync(['jobs', 'send', 'job-1', '-i', 'message'], { from: 'user' });
  expect(process.exitCode).toBe(1);
  const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
  expect(text).toContain('launch details are unavailable');
  expect(printedCommands(text)).toEqual([['jobs', 'wait', 'job-1']]);
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
