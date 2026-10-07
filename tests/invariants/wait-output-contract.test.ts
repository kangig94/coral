import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { expect, it } from 'vitest';
import { registerSessionCommands } from '#src/cli/commands/session.js';
import {
  formatWaitContinuation,
  formatWaitSnapshot,
  formatWaitTerminal,
  formatWaitWaiting,
} from '#src/cli/format/wait.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { jobsWaitRequest } from '#src/transport/rpc/jobs.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { admitted, savedCursor, testSession } from '#tests/helpers/wait-session.js';

const root = resolve('.');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function waitPorts(observed: unknown[]): HttpHandlerPorts {
  return {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    jobs: {
      admitWait: (request: unknown) => {
        observed.push(request);
        return [admitted('a')];
      },
      waitStream: async function* (request: unknown) {
        observed.push(request);
      },
      waitHandoverSignal: () => new AbortController().signal,
    },
  } as unknown as HttpHandlerPorts;
}

it('canonicalizes a current wait request, which always states its frontier, before admission and streaming', async () => {
  const spec = rpcCatalog.find((method) => method.name === 'jobs.wait')!;
  const observed: unknown[] = [];
  const result = await executeCatalogRequest(
    spec,
    spec.requestSchema.parse(jobsWaitRequest({ jobIds: ['a'], projectRoot: root })),
    waitPorts(observed),
    testProjectPrincipal(root),
  );
  expect(result.kind).toBe('subscription');
  if (result.kind !== 'subscription') throw new Error('Wait refused');
  await result.notifications[Symbol.asyncIterator]().next();
  expect(observed).toHaveLength(2);
  for (const request of observed) {
    expect(request).toMatchObject({ jobIds: ['a'], drainProgress: false });
    expect(request).not.toHaveProperty('cursor');
    expect(Object.keys(request as object).filter((key) => key.startsWith('supports'))).toEqual([]);
  }
});

it.each([
  ['no frontier', {}],
  ['a capability flag', { supportsInterrupted: true, cursor: null }],
  ['a versionless cursor', { cursor: { afterSeq: 4 } }],
  ['a v2 cursor', { cursor: { version: 'jobs.wait.v2', positions: {}, locations: {} } }],
])('refuses a request with %s from another build with restart guidance and admits nothing', async (_shape, fields) => {
  const spec = rpcCatalog.find((method) => method.name === 'jobs.wait')!;
  const observed: unknown[] = [];
  const result = await executeCatalogRequest(
    spec,
    spec.requestSchema.parse({ jobIds: ['a'], projectRoot: root, ...fields }),
    waitPorts(observed),
    testProjectPrincipal(root),
  );
  expect(result).toMatchObject({
    kind: 'unary',
    body: { code: 'wait_build_mismatch', message: expect.stringContaining('Restart the session') },
  });
  expect(observed).toEqual([]);
});

it('refuses an undecodable single-shape cursor softly so the client restarts fresh', async () => {
  const spec = rpcCatalog.find((method) => method.name === 'jobs.wait')!;
  const observed: unknown[] = [];
  const result = await executeCatalogRequest(
    spec,
    spec.requestSchema.parse({ jobIds: ['a'], projectRoot: root, cursor: 'not-a-cursor' }),
    waitPorts(observed),
    testProjectPrincipal(root),
  );
  expect(result).toMatchObject({ kind: 'unary', body: { code: 'wait_cursor_malformed' } });
  expect(observed).toEqual([]);
});

it.each([false, true])(
  'M1 terminal and waiting output contain one runnable cursor-aware command, embed=%s',
  (embed) => {
    const cursor = savedCursor(0);
    const terminal = formatWaitTerminal(
      {
        type: 'terminal',
        jobId: 'a',
        seq: 7,
        resultPath: '/result.md',
        availability: { kind: 'available', resultPath: '/result.md' },
        result: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
        remainingJobIds: ['b', 'u'],
        cursor,
        exitCode: 75,
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
  const session = testSession(['a', 'b']);
  session.reconcile([failed, pending]);
  session.deliverTerminal(failed);
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

it('a snapshot continuation keeps --now and the snapshot cursor', () => {
  const session = testSession(['a'], savedCursor(0));
  session.reconcile([admitted('a', [], false)]);
  const snapshot = selectWaitSnapshot(session, 20);
  expect(snapshot.cursor).not.toBeNull();
  expect(formatWaitSnapshot(snapshot)).toContain(formatWaitContinuation(['a'], snapshot.cursor, true));
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
  for (const state of ['available', 'retained-away', 'pending', 'failed']) expect(text).toContain(`\`${state}\``);
  expect(text).toContain('current provider session');
  expect(text).toContain('historical wait continuity is null');
  expect(text).toContain('terminalAt < cutoff');
  expect(text).not.toContain('explicit continuity snapshot');
  expect(text).not.toContain('object construction is owned by `jobs/store.ts`');
});

it('progress holds name their retry without instructions', () => {
  const session = testSession(['a']);
  session.reconcile([admitted('a', [], false)]);
  const busy = (): never => {
    throw new Error('database is locked');
  };
  session.withProgress(
    (_epoch, read) => ({ kind: 'read', value: read({ frontier: busy, after: busy, newest: busy }) }),
    (sources) => session.select(sources, { lines: 500, bytes: 64 * 1024 }, 20),
  );
  const notice = session.notices.join(' ');
  expect(notice).toContain('retried on the next poll');
  expect(notice).not.toMatch(/retry the continuation|repair|restore/i);
});
