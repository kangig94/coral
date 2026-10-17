import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeFs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type * as DispatchMod from '#src/cli/dispatch.js';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { assertCommandClassCoverage, classifyCommand } from '#src/cli/classify.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import type { JobsListResponse } from '#src/jobs/records.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { admitted, testSession } from '#tests/helpers/wait-session.js';
import type { ProviderSendOutcome } from '#src/providers/contract.js';
import { registerProviderCommands } from '#src/cli/commands/provider.js';

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
  [{ state: 'delivered' }, 0, 'Message delivered.'],
  [
    { state: 'refused', code: 'turn_ended', reason: 'The turn ended.' },
    1,
    'Message refused (turn_ended): The turn ended.',
  ],
  [
    { state: 'unknown', reason: 'No answer.' },
    75,
    'Unknown: message may have been delivered. No answer. command=coral-cli jobs wait job-1',
  ],
] satisfies [ProviderSendOutcome, number, string][])(
  'renders %j with exit %i',
  async (result, exitCode, expected) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    client.sendJob.mockResolvedValueOnce(result);
    await program().parseAsync(['jobs', 'send', 'job-1', '-i', 'message'], { from: 'user' });
    expect(process.exitCode).toBe(exitCode);
    expect(exitCode === 0 ? stdout : stderr).toHaveBeenCalledExactlyOnceWith(expected + '\n');
    expect(exitCode === 0 ? stderr : stdout).not.toHaveBeenCalled();
  },
);

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
