import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { JobAddressing } from '#src/jobs/addressing.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { createRealTimePort } from '#src/infra/time.js';
import { decodeSerializedWaitCursor } from '#src/jobs/wait/cursor.js';
import { type WaitCursor, type WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { jobsWaitRequest } from '#src/transport/rpc/jobs.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { formatWaitTerminal } from '#src/cli/format/wait.js';

const directory = mkdtempSync(join(tmpdir(), 'coral-released-wait-'));
const released = new Map<
  string,
  {
    parseWaitStreamEventValue(value: unknown): unknown;
    advanceWaitRenderCursor(cursor: WaitCursor, event: WaitStreamEvent): { cursor: WaitCursor; shouldRender: boolean };
    jobWaitSchema: { parse(value: unknown): unknown };
    formatWaitTerminal(event: unknown, cursor: string | null, inline: boolean): string;
    errorCodeToExit(code: string): number;
    mapWaitSubscriptionError(error: unknown): Error;
  }
>();
beforeAll(async () => {
  for (const tag of ['v0.10.15', 'v0.10.16', 'v0.10.17']) {
    const root = join(directory, tag);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root);
    execFileSync('tar', ['-x', '-C', root], {
      input: execFileSync('git', ['archive', tag, 'src'], { maxBuffer: 30 * 1024 * 1024 }),
    });
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const entry = join(root, 'released.ts');
    writeFileSync(
      entry,
      `export { parseWaitStreamEventValue, advanceWaitRenderCursor } from './src/jobs/wait-stream-event.ts';\nexport { jobWaitSchema } from './src/transport/rpc/jobs.ts';\nexport { formatWaitTerminal } from './src/cli/format/wait.ts';\nexport { errorCodeToExit } from './src/cli/errors.ts';\nexport { mapWaitSubscriptionError } from './src/cli/wait-stream-error.ts';\n`,
    );
    const outfile = join(root, 'released.mjs');
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      loader: { '.sql': 'text' },
    });
    released.set(tag, await import(pathToFileURL(outfile).href));
  }
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each(['v0.10.16', 'v0.10.17'])(
  '%s gets supported refusals before unrepresentable membership or missing siblings',
  async (tag) => {
    const reader = released.get(tag)!;
    for (const scenario of ['membership', 'missing'] as const) {
      const owner = addressing('available');
      const request =
        scenario === 'membership'
          ? {
              jobIds: ['a', 'b'],
              supportsWaitV2: true,
              cursor: {
                version: 'jobs.wait.v2' as const,
                locations: { a: 'active-epoch' },
                positions: { 'active-epoch': 100 },
              },
            }
          : { jobIds: ['a', 'ghost'], supportsWaitV2: true };
      const code = scenario === 'membership' ? 'wait_cursor_epoch_required' : 'jobs_not_found';
      expect(owner.validateWait(request)).toMatchObject({ code });
      const delivered: WaitStreamEvent[] = [];
      let refusal: unknown;
      try {
        for await (const event of owner.waitStream(request)) {
          reader.parseWaitStreamEventValue(event);
          delivered.push(event);
        }
      } catch (error) {
        refusal = error;
      }
      expect(delivered).toEqual([]);
      expect(refusal).toMatchObject({ code });
      const typed = refusal as { code: string; message: string };
      const mapped = reader.mapWaitSubscriptionError(
        new Error(typed.message, { cause: { code: typed.code, message: typed.message } }),
      );
      expect(mapped.message).toContain(scenario === 'membership' ? 'without its cursor' : 'ghost');
      expect(reader.errorCodeToExit(code)).toBe(1);
    }
  },
);

function addressing(artifact: 'available' | 'repair-pending' | 'retained-away' | 'failed', historical = false) {
  const a = admitted('a', [[1, 'first\nsecond']], true, historical ? 'old-epoch' : 'active-epoch');
  const availability =
    artifact === 'available'
      ? { kind: 'available' as const, resultPath: '/available/result.md' }
      : artifact === 'repair-pending'
        ? { kind: 'repair-pending' as const, ageUncertain: false }
        : artifact === 'retained-away'
          ? { kind: 'retained-away' as const, retentionDays: 14 }
          : { kind: 'failed' as const, cause: 'repair-failed' as const, retryScheduled: true };
  const location = {
    version: 'v1' as const,
    jobId: 'a',
    epochKey: a.epochKey!,
    subject: { projectRoot: '/tmp', workDir: '/tmp', jobKind: 'provider' as const },
    disposition: 'terminal' as const,
    terminalSeq: 1000,
    resultPath: '/available/result.md',
    detail: { kind: 'recorded' as const, value: a.detail! },
  };
  // A retained terminal must contain every identity field used by the shipped validator.
  a.detail!.status.result = {
    content: a.detail!.exit!.content,
    outcome: a.detail!.exit!.outcome,
    durationMs: a.detail!.exit!.durationMs,
  };
  a.detail!.exit!.endTime = '2026-10-04T00:00:00Z';
  a.detail!.status.updatedAt = a.detail!.exit!.endTime;
  for (const event of a.detail!.events) {
    event.ts = '2026-10-04T00:00:00Z';
    event.sessionId = null;
  }
  return new JobAddressing(
    {
      time: createRealTimePort(),
      read: (id: string) => (historical && id === 'a' ? location : null),
      resultPathFor: () => '/available/result.md',
      unknownLocationHolds: () => [],
    },
    {
      epochKey: () => 'active-epoch',
      detail: (id: string) =>
        id === 'b' ? admitted('b', [[2, 'active sibling']]).detail! : id === 'a' && !historical ? a.detail! : null,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    () => ({ kind: 'read', dispositions: new Map(), locations: new Map([['a', location]]) }),
    () => availability,
  );
}

it.each(['v0.10.15', 'v0.10.16', 'v0.10.17'])(
  'executes %s request, decoder, formatter and error contracts in both cursor directions',
  async (tag) => {
    const reader = released.get(tag)!;
    const flags = tag === 'v0.10.15' ? [] : ['supportsWaitV2'];
    const request = jobsWaitRequest({ jobIds: ['a'], projectRoot: '/tmp' }, flags);
    expect(() => reader.jobWaitSchema.parse(request)).not.toThrow();
    const events: WaitStreamEvent[] = [];
    for await (const event of addressing('available').waitStream(request as never)) {
      expect(() => reader.parseWaitStreamEventValue(event)).not.toThrow();
      events.push(event);
    }
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ message: 'first\nsecond' });
    const terminal = events.find((event) => event.type === 'terminal')!;
    expect(reader.formatWaitTerminal(terminal, null, false)).toContain('Result path: /available/result.md');
    expect(parseWaitStreamEventValue(terminal)).toEqual(terminal);
    expect(formatWaitTerminal(terminal, null, false)).toContain('Unverified result path: /available/result.md');
    const v3Session = new WaitSession(['a']);
    v3Session.reconcile([admitted('a')]);
    let resets = 0;
    const fresh = jobsWaitRequest(
      { jobIds: ['a'], projectRoot: '/tmp', cursor: v3Session.cursor() },
      flags,
      () => resets++,
    );
    expect(fresh).not.toHaveProperty('cursor');
    expect(resets).toBe(1);
    reader.jobWaitSchema.parse(fresh);
    const saved: WaitCursor =
      tag === 'v0.10.15'
        ? { afterSeq: 1, deliveredJobIds: ['a'] }
        : {
            version: 'jobs.wait.v2',
            positions: { 'active-epoch': 1 },
            locations: { a: 'active-epoch' },
            deliveredJobIds: ['a'],
          };
    expect(decodeSerializedWaitCursor(serializeWaitCursor(saved))).toEqual({ kind: 'decoded', cursor: saved });
    expect(() =>
      reader.jobWaitSchema.parse(jobsWaitRequest({ jobIds: ['a'], projectRoot: '/tmp', cursor: saved }, flags)),
    ).not.toThrow();

    if (tag === 'v0.10.15') {
      const a = admitted('a', [[100, 'later sibling progress']], true, 'epoch-E');
      const b = admitted('b', [[1, 'earlier progress']], true, 'epoch-E');
      a.detail!.events.find((event) => event.type === 'terminal')!.seq = 200;
      b.detail!.events.find((event) => event.type === 'terminal')!.seq = 3;
      let legacy: WaitCursor = { afterSeq: 0 };
      const first: WaitStreamEvent[] = [];
      for await (const event of readWaitSession({
        request: { jobIds: ['a', 'b'] },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [a, b],
      })) {
        reader.parseWaitStreamEventValue(event);
        const rendered = reader.advanceWaitRenderCursor(legacy, event);
        expect(rendered.shouldRender).toBe(true);
        legacy = rendered.cursor;
        first.push(event);
      }
      expect(first.filter((event) => event.type === 'progress').map((event) => event.jobId)).toEqual(['b']);
      expect(first.find((event) => event.type === 'terminal')).toMatchObject({ jobId: 'b', remainingJobIds: ['a'] });
      const resumed = readWaitSession({
        request: { jobIds: ['a'], cursor: legacy },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [a],
      });
      const resumedEvents: WaitStreamEvent[] = [];
      for await (const event of resumed) {
        reader.parseWaitStreamEventValue(event);
        resumedEvents.push(event);
      }
      expect(resumedEvents.find((event) => event.type === 'progress')).toMatchObject({ jobId: 'a', seq: 100 });
      expect(resumedEvents.find((event) => event.type === 'terminal')).toMatchObject({ jobId: 'a' });
      legacy = { afterSeq: 0, deliveredJobIds: ['b'] };
      const next: WaitStreamEvent[] = [];
      for await (const event of readWaitSession({
        request: { jobIds: ['a'], cursor: legacy },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [a],
      })) {
        expect(reader.advanceWaitRenderCursor(legacy, event).shouldRender).toBe(true);
        next.push(event);
      }
      expect(next.find((event) => event.type === 'progress')).toMatchObject({
        jobId: 'a',
        message: 'later sibling progress',
      });
    }
    const acknowledged: WaitCursor =
      tag === 'v0.10.15'
        ? { afterSeq: 0, deliveredJobIds: ['a'] }
        : {
            version: 'jobs.wait.v2',
            positions: { 'active-epoch': 0 },
            locations: { a: 'active-epoch' },
            deliveredJobIds: ['a'],
          };
    const collected: WaitStreamEvent[] = [];
    for await (const event of addressing('available').waitStream(
      jobsWaitRequest({ jobIds: ['a'], projectRoot: '/tmp', cursor: acknowledged }, flags) as never,
    )) {
      reader.parseWaitStreamEventValue(event);
      collected.push(event);
    }
    expect(collected.filter((event) => event.type === 'terminal')).toEqual([]);
    expect(collected.filter((event) => event.type === 'progress')).toHaveLength(1);
    for (const ids of [['a'], ['a', 'b']]) {
      const historical = addressing('available', true);
      const historicalRequest = jobsWaitRequest({ jobIds: ids, projectRoot: '/tmp' }, flags);
      if (tag === 'v0.10.15') {
        await expect(async () => {
          for await (const event of historical.waitStream(historicalRequest as never))
            reader.parseWaitStreamEventValue(event);
        }).rejects.toMatchObject({ code: 'wait_epoch_unsupported' });
      } else {
        const seen: WaitStreamEvent[] = [];
        for await (const event of historical.waitStream(historicalRequest as never)) {
          reader.parseWaitStreamEventValue(event);
          seen.push(event);
        }
        expect(seen.find((event) => event.type === 'terminal')).toMatchObject({
          epochKey: 'old-epoch',
          version: 'jobs.wait.v2',
        });
        const terminal = seen.find((event) => event.type === 'terminal')!;
        const again = jobsWaitRequest({ jobIds: ids, projectRoot: '/tmp', cursor: terminal.cursor }, flags);
        expect(again.cursor).toBe(terminal.cursor);
        reader.jobWaitSchema.parse(again);
      }
    }
    const time = new VirtualTime();
    let closed = false;
    const changing = readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 1, supportsWaitV2: tag !== 'v0.10.15' },
      time,
      activeEpochKey: 'active-epoch',
      read: () =>
        closed ? [{ jobId: 'a', disposition: 'outcome-unrecoverable' }] : [admitted('a', [], false, 'old-epoch')],
    });
    const next = changing.next();
    await flushMicrotasks(20);
    closed = true;
    time.tick(250);
    await flushMicrotasks(20);
    await expect(next).rejects.toMatchObject({ code: 'wait_epoch_unsupported' });
    for (const availability of ['repair-pending', 'failed', 'retained-away'] as const) {
      if (availability !== 'repair-pending') {
        const alreadyAcknowledged: WaitStreamEvent[] = [];
        for await (const event of addressing(availability).waitStream(
          jobsWaitRequest(
            { jobIds: ['a'], projectRoot: '/tmp', cursor: acknowledged, timeoutSeconds: 0 },
            flags,
          ) as never,
        )) {
          reader.parseWaitStreamEventValue(event);
          alreadyAcknowledged.push(event);
        }
        expect(alreadyAcknowledged.filter((event) => event.type === 'terminal')).toEqual([]);
        expect(alreadyAcknowledged.filter((event) => event.type === 'waiting')).toEqual([]);
      }
      let refusal: unknown;
      try {
        for await (const event of addressing(availability).waitStream(request as never))
          expect(event.type).not.toBe('terminal');
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ code: 'wait_epoch_unsupported' });
      const typed = refusal as { code: string; message: string };
      const error = reader.mapWaitSubscriptionError(
        new Error(typed.message, { cause: { code: typed.code, message: typed.message } }),
      );
      expect(error.message).toContain('jobs detail a.');
      expect(error.message).not.toContain('--full');
      expect(reader.errorCodeToExit(typed.code)).toBe(1);
    }
  },
);
