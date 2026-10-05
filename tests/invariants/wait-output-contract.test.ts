import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { expect, it } from 'vitest';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import { formatLaunch } from '#src/cli/format/jobs.js';
import {
  formatWaitContinuation,
  formatWaitSnapshot,
  formatWaitTerminal,
  formatWaitWaiting,
} from '#src/cli/format/wait.js';
import { formatResultAvailability } from '#src/cli/format/result-availability.js';
import { WAIT_CURSOR_REPLAY_NOTICE } from '#src/jobs/wait/cursor.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { admitted } from '#tests/helpers/wait-session.js';

const root = resolve('.');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const skills = ['analyze', 'bugfix', 'code-simplify', 'plan', 'preplan', 'ralph'];

it('canonicalizes omitted wire capabilities before wait admission and streaming', async () => {
  const spec = rpcCatalog.find((method) => method.name === 'jobs.wait')!;
  const observed: unknown[] = [];
  const result = await executeCatalogRequest(
    spec,
    spec.requestSchema.parse({ jobIds: ['a'], projectRoot: root }),
    {
      identity: { pluginRoot: '/plugin' },
      coralEnvSnapshot: {},
      admin: { isLaunchFenceActive: () => false },
      jobs: {
        admitWait: (request: unknown) => {
          observed.push(request);
          return [admitted('a')];
        },
        validateWait: (request: unknown) => {
          observed.push(request);
          return null;
        },
        waitStream: async function* (request: unknown) {
          observed.push(request);
        },
        waitHandoverSignal: () => new AbortController().signal,
      },
    } as unknown as HttpHandlerPorts,
    testProjectPrincipal(root),
  );
  expect(result.kind).toBe('subscription');
  if (result.kind !== 'subscription') throw new Error('Wait refused');
  await result.notifications[Symbol.asyncIterator]().next();
  expect(observed).toHaveLength(3);
  for (const request of observed)
    expect(request).toMatchObject({
      supportsWaitV2: false,
      supportsWaitV3: false,
      supportsInterrupted: false,
      supportsHandover: false,
    });
});

it.each([false, true])(
  'M1 terminal and waiting output contain one runnable cursor-aware command, embed=%s',
  (embed) => {
    const cursor = serializeWaitCursor({ afterSeq: 7 });
    const terminal = formatWaitTerminal(
      {
        type: 'terminal',
        jobId: 'a',
        seq: 7,
        resultPath: '/result.md',
        result: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
        remainingJobIds: ['b', 'u'],
      },
      cursor,
      embed,
    );
    const waiting = formatWaitWaiting(
      { type: 'waiting', waitingJobIds: ['b', 'u'], carrierUnknownJobIds: ['u'] },
      cursor,
    );
    for (const output of [terminal, waiting]) {
      expect(output.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
      expect(output).toContain(`Run coral-cli wait jobs b u --cursor ${cursor} to continue waiting.`);
    }
    expect(waiting).toContain('Carrier unconfirmed for: u.');
    expect(formatWaitContinuation([], cursor)).not.toContain('Run');
  },
);

it('M2 help and exit documentation preserve failure precedence even with siblings', () => {
  const program = new Command();
  registerSessionCommands(program, new ProviderRegistry());
  const help = program.commands.find((command) => command.name() === 'wait')?.commands[0];
  let output = '';
  help?.configureOutput({
    writeOut: (text) => {
      output += text;
    },
  });
  help?.outputHelp();
  for (const text of [output, read('docs/cli-errors.md')]) {
    expect(text).toContain('first failed terminal in request order');
    expect(text).toContain('even with pending siblings');
    expect(text).toContain('permanent refusals exit 1');
    expect(text).toContain('remaining collection work exits 75');
    expect(text).toContain('exhausted successful sets exit 0');
    expect(text).toContain('never aborts jobs');
  }
  const failed = admitted('a', [], true, 'epoch-E', true);
  const pending = admitted('b', [], false);
  const session = new WaitSession(['a', 'b']);
  session.reconcile([failed, pending]);
  session.acknowledge(failed);
  expect(session.exitCode()).toBe(42);
  session.reconcile([admitted('a'), pending]);
  expect(session.exitCode()).toBe(75);
  expect(output).toContain('--now');
  expect(output.replace(/\s+/g, ' ')).toContain('continuations keep --now');
  expect(output.replace(/\s+/g, ' ')).toContain('drop it explicitly to switch to a blocking wait');
  expect(output.replace(/\s+/g, ' ')).toContain('first terminal or ~590 s');
  expect(output.replace(/\s+/g, ' ')).toContain('--now returns immediately');
  expect(output.replace(/\s+/g, ' ')).toContain('artifact availability is reported separately');
});

it('M3 scope remediation changes cwd and lists terminal jobs', async () => {
  const spec = rpcCatalog.find((method) => method.name === 'jobs.detail');
  if (!spec) throw new Error('jobs.detail contract missing');
  const result = await executeCatalogRequest(
    spec,
    spec.requestSchema.parse({ jobId: 'a', projectRoot: root }),
    {
      identity: { pluginRoot: '/plugin' },
      coralEnvSnapshot: {},
      admin: { isLaunchFenceActive: () => false },
      jobs: { scopeCheck: () => ({ mismatch: ['a'], missing: [] }) },
    } as unknown as HttpHandlerPorts,
    testProjectPrincipal(root),
  );
  expect(result).toMatchObject({ kind: 'unary', statusCode: 403, body: { code: 'scope_mismatch' } });
  const output = JSON.stringify(result);
  expect(output).toContain('Change cwd');
  expect(output).toContain('coral-cli jobs --all');
  expect(output).toContain('including terminal jobs');
});

it.each(skills)('M3/M4 skill %s follows rendered launch, availability and snapshot contracts', (name) => {
  const text = read(`clients/skills/${name}/SKILL.md`);
  const launch = formatLaunch({
    kind: 'provider-session',
    jobId: '<job>',
    sessionId: '<session>',
    launchState: 'queued',
  });
  expect(text.replace('<launchState>', 'queued')).toContain(launch);
  expect(text).not.toContain('Job <job> <launchState> (session <session>)');
  for (const line of [
    formatResultAvailability({ kind: 'repair-pending', ageUncertain: false }),
    formatResultAvailability({ kind: 'available', resultPath: '<path>' }, true).split('\n')[0],
    'Unverified result path:',
    WAIT_CURSOR_REPLAY_NOTICE,
    '--now --cursor <c>',
    'Snapshot continuations keep `--now`; drop it explicitly only to switch to a blocking wait.',
    'unprefixed line starting with `Still waiting`',
    'Ignore lines prefixed with `> `',
    'Full retained outcome: <command>',
    'Siblings are results still to collect.',
    'Carrier unconfirmed for: <ids>',
    'change cwd',
    'coral-cli jobs --all',
  ])
    expect(text).toContain(line);
  const session = new WaitSession(['a']);
  session.reconcile([admitted('a', [], false)]);
  const snapshot = selectWaitSnapshot(session, 20);
  expect(formatWaitSnapshot(snapshot)).toContain(
    formatWaitContinuation(['a'], serializeWaitCursor(snapshot.cursor), true),
  );
});

it('plan retrieves full retained workflow content when no result path is available', () => {
  const text = read('clients/skills/plan/SKILL.md');
  expect(text).toContain('Full retained outcome: <command>');
  expect(text).toContain('run that exact command from `{work_dir}` for the full workflow content');
});

it.each(['docs/architecture.md', 'docs/core-modules.md'])('F11 and owner contracts are accurate in %s', (path) => {
  const text = read(path);
  for (const owner of [
    'jobs/terminal/recording.ts:appendJobTerminalRecorded',
    'jobs/terminal/export.ts:TerminalResultExportOwner',
    'jobs/location-index.ts:JobLocationView',
    'jobs/wait/session.ts:WaitSession',
    'jobs/wait/cursor.ts',
    'jobs/wait/snapshot.ts',
    'jobs/export-retention.ts:terminalEligibility',
    'JobLocationIndex.resultDurable',
  ])
    expect(text).toContain(owner);
  for (const state of ['available', 'retained-away', 'repair-pending', 'failed'])
    expect(text).toContain(`\`${state}\``);
  expect(text).toContain('current provider session');
  expect(text).toContain('historical wait continuity is null');
  expect(text).toContain('terminalAt < cutoff');
  expect(text).not.toContain('explicit continuity snapshot');
  expect(text).not.toContain('object construction is owned by `jobs/store.ts`');
});

it('progress holds name maintenance cadence and its bound without instructions', () => {
  const a = { ...admitted('a'), sourceRead: 'transient-unknown' as const };
  const session = new WaitSession(['a']);
  session.reconcile([a]);
  const notice = session.notices.join(' ');
  expect(notice).toContain('every 5 s');
  expect(notice).toContain('3 failed probes');
  expect(notice).not.toMatch(/retry the continuation|repair|restore/i);
});
