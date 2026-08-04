import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import {
  MAX_WAIT_SNAPSHOT_ACKS,
  advanceWaitRenderCursor,
  parseWaitRenderCursor,
  parseWaitStreamEvent,
  serializeWaitRenderCursor,
  type WaitSnapshotAck,
} from '#src/jobs/wait-stream-event.js';
import type * as FollowModule from '#src/cli/follow.js';
import { createDeferred } from '#tools/testing/deferred.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  resolveCliHandoffRouting: vi.fn(),
  runHandoff: vi.fn(),
  renderHandoffNotice: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('#src/coordinator/handoff-runner.js', () => ({
  resolveCliHandoffRouting: mockState.resolveCliHandoffRouting,
  runHandoff: mockState.runHandoff,
}));

vi.mock('#src/cli/handoff-notice.js', () => ({
  renderHandoffNotice: mockState.renderHandoffNotice,
}));

const launchResult = {
  kind: 'provider-session',
  launchState: 'running',
  jobId: 'job-1',
  sessionId: 'session-1',
} satisfies AcceptedLaunchResponse;

const waitTiming = {
  origin: 'runtime',
  originAt: '2026-08-04T08:00:00.000Z',
  emittedAt: '2026-08-04T08:00:01.000Z',
  elapsedMs: 1_000,
} as const;

type FollowOptions = Parameters<typeof FollowModule.launchAndFollow>[0];

function makeOptions(overrides: Partial<FollowOptions> = {}): FollowOptions {
  return {
    launchResult,
    abortJob: vi.fn().mockResolvedValue(undefined),
    pluginRoot: '/plugin/root',
    projectRoot: '/project/root',
    emitError: vi.fn(),
    isTTY: false,
    columns: 100,
    ...overrides,
  };
}

function useCurrentRouting() {
  return { kind: 'use-current', evidence: { source: 'current-build' } } as const;
}

function makeBackend(subscribe = vi.fn()) {
  return {
    socketPath: '/tmp/coordinator.sock',
    instanceId: 'backend-1',
    bundleHash: 'bundle-hash',
    flavor: 'prod' as const,
    namespace: 'namespace',
    host: '127.0.0.1',
    port: 4100,
    token: 'token',
    version: '1.0.0',
    routing: useCurrentRouting(),
    request: vi.fn(),
    subscribe,
    ping: vi.fn(),
    health: vi.fn(),
    shutdown: vi.fn(),
  };
}

function makeSubscription(events: readonly WaitStreamEvent[]) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('cli follow handoff', () => {
  let sigintHandler: (() => void) | null;

  beforeEach(() => {
    sigintHandler = null;
    process.exitCode = undefined;
    mockState.ensure.mockReset();
    mockState.resolveCliHandoffRouting.mockReset();
    mockState.runHandoff.mockReset();
    mockState.renderHandoffNotice.mockReset();
    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');

    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') sigintHandler = listener as () => void;
      return process;
    }) as typeof process.on);
    vi.spyOn(process, 'off').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT' && sigintHandler === listener) sigintHandler = null;
      return process;
    }) as typeof process.off);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('should wait for the rendered snapshot acknowledgement before executing remaining intent', async () => {
    const target = { target: 'newer-build' } as never;
    const progressAcknowledgement = createDeferred<void>();
    const secondRoutingResolved = createDeferred<void>();
    const progressEvent: WaitStreamEvent = {
      type: 'progress',
      jobId: 'job-1',
      seq: 4,
      message: 'checkpoint-one',
      timing: waitTiming,
    };
    const waitingEvent = {
      type: 'waiting',
      waitingJobIds: ['job-1'],
      snapshotRenderId: 'waiting-snapshot-v1',
    } as WaitStreamEvent;
    const subscribe = vi.fn().mockResolvedValue(makeSubscription([progressEvent, waitingEvent]));

    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      const text = chunk.toString();
      if (text.includes('checkpoint-one')) {
        void progressAcknowledgement.promise.then(() => callback?.());
      } else {
        callback?.();
      }
      return true;
    }) as typeof process.stdout.write);

    mockState.ensure.mockResolvedValueOnce(makeBackend(subscribe)).mockResolvedValueOnce(makeBackend());
    mockState.resolveCliHandoffRouting.mockResolvedValueOnce(useCurrentRouting()).mockImplementationOnce(async () => {
      secondRoutingResolved.resolve();
      return { kind: 'handoff', target, source: 'live-incumbent' };
    });
    mockState.runHandoff.mockResolvedValue({ kind: 'handoff-success', version: '2.0.0' });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const follow = launchAndFollow(makeOptions());
    await secondRoutingResolved.promise;

    expect(mockState.runHandoff).not.toHaveBeenCalled();
    progressAcknowledgement.resolve();
    await expect(follow).resolves.toBe(0);

    expect(mockState.runHandoff).toHaveBeenCalledOnce();
    const handoffOptions = mockState.runHandoff.mock.calls[0]?.[0] as {
      operation: { args: string[] };
    };
    expect(handoffOptions.operation.args.slice(0, 3)).toEqual(['wait', 'jobs', 'job-1']);
    expect(handoffOptions.operation.args[3]).toBe('--cursor');
    expect(parseWaitRenderCursor(handoffOptions.operation.args[4])).toEqual({
      afterSeq: 4,
      snapshotAcks: [{ key: 'waiting:["job-1"]', id: 'waiting-snapshot-v1' }],
    });
    expect(mockState.renderHandoffNotice).toHaveBeenCalledWith({ kind: 'handoff-success', version: '2.0.0' });
  });

  it('should resume a transient retry from the acknowledged cursor while snapshot acknowledgement is pending', async () => {
    const progressAcknowledgementPending = createDeferred<void>();
    const secondRoutingResolved = createDeferred<void>();
    const output: string[] = [];
    let acknowledgeProgress: (() => void) | undefined;
    let routingCalls = 0;
    const progressEvent: WaitStreamEvent = {
      type: 'progress',
      jobId: 'job-1',
      seq: 4,
      message: 'checkpoint-one',
      timing: waitTiming,
    };
    const terminalEvent: WaitStreamEvent = {
      type: 'terminal',
      jobId: 'job-1',
      seq: 5,
      remainingJobIds: [],
      resultPath: '/tmp/result.md',
      result: { content: 'done', durationMs: 1_000, outcome: { kind: 'completed' } },
    };
    const firstSubscribe = vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      async *[Symbol.asyncIterator]() {
        yield progressEvent;
        throw new TypeError('terminated');
      },
    });
    const secondSubscribe = vi.fn().mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      expect(params.cursor).toEqual({ afterSeq: 4 });
      return makeSubscription([progressEvent, terminalEvent]);
    });

    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      const text = chunk.toString();
      output.push(text);
      if (text.includes('checkpoint-one')) {
        acknowledgeProgress = () => callback?.();
        progressAcknowledgementPending.resolve();
      } else {
        callback?.();
      }
      return true;
    }) as typeof process.stdout.write);

    mockState.ensure
      .mockResolvedValueOnce(makeBackend(firstSubscribe))
      .mockResolvedValueOnce(makeBackend(secondSubscribe));
    mockState.resolveCliHandoffRouting.mockImplementation(async () => {
      routingCalls += 1;
      if (routingCalls === 2) secondRoutingResolved.resolve();
      return useCurrentRouting();
    });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const follow = launchAndFollow(makeOptions({ backoffScheduler: vi.fn().mockResolvedValue(undefined) }));
    await progressAcknowledgementPending.promise;
    await secondRoutingResolved.promise;

    expect(secondSubscribe).not.toHaveBeenCalled();
    expect(acknowledgeProgress).toBeTypeOf('function');
    acknowledgeProgress?.();
    await expect(follow).resolves.toBe(0);

    expect(firstSubscribe).toHaveBeenCalledOnce();
    expect(secondSubscribe).toHaveBeenCalledOnce();
    expect(output.filter((chunk) => chunk.includes('checkpoint-one'))).toHaveLength(1);
    expect(output.join('')).toContain('Job job-1 completed');
  });

  it('should preserve double Ctrl-C abort semantics while the delegated wait is active', async () => {
    const target = { target: 'newer-build' } as never;
    const firstHandoff = createDeferred<{ kind: 'handoff-signal'; signal: 'SIGINT' }>();
    const secondHandoff = createDeferred<{ kind: 'handoff-signal'; signal: 'SIGINT' }>();
    const secondRunStarted = createDeferred<void>();
    const abortJob = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue(makeBackend());
    mockState.resolveCliHandoffRouting.mockResolvedValue({ kind: 'handoff', target, source: 'live-incumbent' });
    mockState.runHandoff.mockReturnValueOnce(firstHandoff.promise).mockImplementationOnce(async () => {
      secondRunStarted.resolve();
      return secondHandoff.promise;
    });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const follow = launchAndFollow(makeOptions({ abortJob }));
    await vi.waitFor(() => expect(mockState.runHandoff).toHaveBeenCalledTimes(1));

    sigintHandler?.();
    expect(abortJob).not.toHaveBeenCalled();
    firstHandoff.resolve({ kind: 'handoff-signal', signal: 'SIGINT' });
    await secondRunStarted.promise;

    sigintHandler?.();
    secondHandoff.resolve({ kind: 'handoff-signal', signal: 'SIGINT' });
    await expect(follow).resolves.toBe(1);

    expect(abortJob).toHaveBeenCalledOnce();
    expect(abortJob).toHaveBeenCalledWith('job-1');
    expect(process.stderr.write).toHaveBeenCalledWith('\nPress Ctrl+C again to abort the job.\n');
  });

  it('should accept the acknowledgement bound and reject the first entry beyond it', () => {
    const acknowledgements: WaitSnapshotAck[] = [
      ...Array.from({ length: 128 }, (_, index) => ({
        key: `queued:job-${index}` as const,
        id: `queued-${index}`,
      })),
      ...Array.from({ length: 128 }, (_, index) => ({
        key: `interrupted:job-${index}` as const,
        id: `interrupted-${index}`,
      })),
      { key: 'waiting:["job-1"]', id: 'waiting-1' },
    ];

    expect(MAX_WAIT_SNAPSHOT_ACKS).toBe(257);
    expect(parseWaitRenderCursor(encodeCursor({ afterSeq: 9, snapshotAcks: acknowledgements }))).not.toBeNull();
    expect(
      parseWaitRenderCursor(
        encodeCursor({
          afterSeq: 9,
          snapshotAcks: [...acknowledgements, { key: 'queued:overflow', id: 'overflow' }],
        }),
      ),
    ).toBeNull();

    const replacement = advanceWaitRenderCursor({ afterSeq: 9, snapshotAcks: acknowledgements }, {
      type: 'waiting',
      waitingJobIds: ['job-2'],
      snapshotRenderId: 'waiting-2',
    } as WaitStreamEvent);
    expect(replacement.cursor.snapshotAcks).toHaveLength(MAX_WAIT_SNAPSHOT_ACKS);
    expect(replacement.cursor.snapshotAcks?.filter(({ key }) => key.startsWith('waiting:'))).toEqual([
      { key: 'waiting:["job-2"]', id: 'waiting-2' },
    ]);
  });

  it('should validate and preserve snapshot render identifiers from the wire', () => {
    const parsed = parseWaitStreamEvent(
      'waiting',
      JSON.stringify({
        type: 'waiting',
        waitingJobIds: ['job-1'],
        snapshotRenderId: 'stable-waiting-snapshot',
      }),
    );

    expect(parsed).toEqual({
      type: 'waiting',
      waitingJobIds: ['job-1'],
      snapshotRenderId: 'stable-waiting-snapshot',
    });
    expect(parseWaitRenderCursor(serializeWaitRenderCursor({ afterSeq: 0 }))).toEqual({ afterSeq: 0 });
  });
});
