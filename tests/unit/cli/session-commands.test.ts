import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import type * as DispatchMod from '#src/cli/dispatch.js';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { assertCommandClassCoverage, classifyCommand } from '#src/cli/classify.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import type { JobsListResponse } from '#src/jobs/records.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { admitted, testSession } from '#tests/helpers/wait-session.js';

const client = vi.hoisted(() => ({
  listJobs: vi.fn<() => Promise<JobsListResponse>>(async () => ({ jobs: [] })),
  abortJobs: vi.fn(async () => ({ aborted: ['a'], notFound: [] })),
  snapshotJobsWait: vi.fn(),
}));
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
  expect([...output.matchAll(/^\s+(list|wait|abort|detail|release)\b/gm)].map((match) => match[1])).toEqual([
    'list',
    'wait',
    'abort',
    'detail',
    'release',
  ]);
  expect(client.listJobs).not.toHaveBeenCalled();
  expect(client.abortJobs).not.toHaveBeenCalled();
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
  ] as const)
    expect(classifyCommand(command)).toMatchObject({ kind: 'class', commandClass });
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
