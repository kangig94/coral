import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createBootstrapNonceCredential } from '#src/provider-proxy/bootstrap-capsule.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import {
  activateProviderOperation,
  providerOperationErrorCode,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set-identity.js';
import {
  createControlEndpoint,
  type ControlChallenge,
  type ControlChallengeAuthority,
  type ControlEndpoint,
  type ControlEndpointRole,
  type ControlMethod,
} from '#src/provider-proxy/control-endpoint.js';

const BOOTSTRAP_NONCE = 'a'.repeat(64);

type Client = Readonly<{
  call(
    method: string,
    params: unknown,
  ): Promise<{
    result?: unknown;
    error?: { code: number; message: string; data?: { code?: string; reason?: string } };
  }>;
  socket: Socket;
  close(): void;
}>;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function realTimer() {
  return {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
  };
}

async function startEndpoint(
  options: {
    echo?: (params: unknown) => void;
    pairing?: ControlEndpointRole['pairing'];
    /** When present, the role serves `role.status.v1` under `authority: 'observation'`. */
    observation?: (params: unknown) => unknown;
  } = {},
): Promise<{
  endpoint: ControlEndpoint;
  socketPath: string;
  observer: { onControlLost: ReturnType<typeof vi.fn>; onControlActive: ReturnType<typeof vi.fn> };
  challenges: ControlChallenge[];
  accepted: ControlChallenge[];
  /** Lapses the lease without an EOF, which is how a wedged coordinator loses control. */
  lapseControl(): void;
  /** Simulates the containment retiring: every later admission refuses, including a reattach. */
  latchTeardown(): void;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-ctl-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'c.sock');
  const challenges: ControlChallenge[] = [];
  const accepted: ControlChallenge[] = [];
  let outstanding: ControlChallenge | null = null;
  let controlLive = false;
  let teardownLatched = false;
  let minted = 0;
  // Mirrors the real wiring: an observed EOF is control loss, and the deadline machine is what records it.
  const observer = {
    onControlLost: vi.fn(() => (controlLive = false)),
    onControlActive: vi.fn(),
  };

  const mint = (): ControlChallenge => {
    minted += 1;
    const challenge = `challenge-${minted}`;
    challenges.push(challenge);
    return challenge;
  };

  const bootstrapNonce = createBootstrapNonceCredential(BOOTSTRAP_NONCE);
  // The same-successor memoization a real `GrantRegistry` already provides: a retry presenting the same
  // identity gets back the exact fields it earned, not a freshly computed set. This is what proves the
  // defect lived in the endpoint's own forgotten epoch/challenge, not in this registry-like memoization.
  const redemptions = new Map<string, Record<string, unknown>>();
  let redemptionReceipts = 0;

  // A minimal stand-in for the deadline machine: it owns the outstanding challenge and consumes it on a
  // matching echo, which is the property the endpoint depends on.
  const challengeAuthority: ControlChallengeAuthority = {
    // Control liveness is tracked apart from the outstanding challenge, because the real machine ends
    // control two ways: an observed EOF, and a lease that lapses while the socket is still open.
    controlIsLive: () => controlLive,
    issueFirstChallenge: () => {
      outstanding = mint();
      // Mirrors real evidence: before any round trip, the holder's own recent start is itself evidence, so
      // a freshly bootstrapped tenancy is live immediately.
      controlLive = true;
      return { accepted: true, challenge: outstanding };
    },
    admitSuccessor: () => {
      if (controlLive) return { accepted: false, reason: 'control-active' };
      outstanding = mint();
      // Not yet live: a successor's tenancy proves nothing about itself until its own first echo lands —
      // exactly the window a duplicate redeem's forgotten challenge used to destroy.
      return { accepted: true, challenge: outstanding };
    },
    reattachControl: () => (teardownLatched ? { accepted: false, reason: 'teardown-latched' } : { accepted: true }),
    echoChallenge: (challenge) => {
      if (outstanding === null || challenge !== outstanding) return { accepted: false, reason: 'challenge-mismatch' };
      const nextChallenge = mint();
      outstanding = nextChallenge;
      // Round-trip evidence pushes control loss into the future, so an echo revives a lapsed lease.
      controlLive = true;
      accepted.push(challenge);
      return { accepted: true, nextChallenge };
    },
  };

  const methodEntries: Array<[string, ControlMethod]> = [
    [
      'role.open.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          bootstrapNonce.spend((params as { bootstrapNonce?: unknown } | null)?.bootstrapNonce);
          return { holder: 'incumbent', fields: { role: 'guardian' } };
        },
      },
    ],
    ['role.work.v1', { authority: 'active', handle: () => ({ state: 'worked' }) }],
    // A second opening method with its own credential — the successor's analogue of a handoff grant.
    // `holder` is named by the caller, mirroring how a real grant derives it from `successor.instanceId`.
    [
      'role.redeem.v1',
      {
        authority: 'establishes-control',
        handle: (params) => {
          const named = (params as { successorId?: unknown } | null)?.successorId;
          const holder = typeof named === 'string' ? named : 'successor';
          const existing = redemptions.get(holder);
          if (existing !== undefined) return { holder, fields: existing };
          redemptionReceipts += 1;
          const fields = { role: 'successor', redemptionReceipt: `receipt-${redemptionReceipts}` };
          redemptions.set(holder, fields);
          return { holder, fields };
        },
      },
    ],
    [
      'role.echo.v1',
      {
        authority: 'active',
        handle: (params) => {
          options.echo?.(params);
          return { state: 'worked' };
        },
      },
    ],
    // Throws a raw ZodError, unwrapped — the shape a real role produces from its own `.parse()` calls,
    // which control-endpoint.ts must map to the closed set without knowing anything about zod or roles.
    [
      'role.strict.v1',
      {
        authority: 'active',
        handle: (params) =>
          z
            .object({
              a: z.string(),
              b: z.string(),
              c: z.string(),
              d: z.string(),
              e: z.string(),
              f: z.string(),
              g: z.string(),
              h: z.string(),
            })
            .parse(params),
      },
    ],
  ];
  if (options.observation !== undefined) {
    // Present only when a test opts in, so the roles every other test builds stay exactly what they were —
    // a role with no observation method, for which accept-time refusal is still the whole story.
    methodEntries.push(['role.status.v1', { authority: 'observation', handle: options.observation }]);
  }

  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'role.heartbeat.v1',
      methods: new Map<string, ControlMethod>(methodEntries),
      pairing: options.pairing,
    },
    challenges: challengeAuthority,
    observer,
    timer: realTimer(),
    requestTimeoutMs: 5_000,
  });

  await endpoint.listen();
  cleanups.push(() => endpoint.close());
  return {
    endpoint,
    socketPath,
    observer,
    challenges,
    accepted,
    lapseControl: () => {
      controlLive = false;
    },
    latchTeardown: () => {
      teardownLatched = true;
    },
  };
}

function connect(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const pending = new Map<
      number,
      (value: { result?: unknown; error?: { code: number; message: string; data?: { code?: string } } }) => void
    >();
    let buffer = '';
    let nextId = 1;

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as { id: number | null; result?: unknown; error?: never };
        // A frame-level rejection carries id null; hand it to the oldest waiter so the test can assert it.
        const waiterId = message.id ?? [...pending.keys()][0];
        const resolveWaiter = waiterId === undefined ? undefined : pending.get(waiterId);
        if (resolveWaiter !== undefined && waiterId !== undefined) {
          pending.delete(waiterId);
          resolveWaiter(message);
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      const client: Client = {
        socket,
        close: () => socket.destroy(),
        call: (method, params) =>
          new Promise((resolveCall) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, resolveCall);
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          }),
      };
      cleanups.push(() => {
        socket.destroy();
      });
      resolve(client);
    });
  });
}

describe('provider-proxy control endpoint', () => {
  it('opens exactly one tenancy against the bootstrap nonce and spends it', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    const opened = await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    expect(opened.result).toEqual({ role: 'guardian', controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const replayed = await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    expect(replayed.error?.message).toContain('already spent');
  });

  it('refuses an open that does not present the nonce and establishes no tenancy', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    const refused = await client.call('role.open.v1', { bootstrapNonce: 'b'.repeat(64) });

    expect(refused.error?.message).toContain('did not present the bootstrap nonce');
  });

  it('activates on a matching echo, rotates the challenge, and reports round-trip evidence once', async () => {
    const set = await startEndpoint();
    const client = await connect(set.socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const beat = await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    expect(beat.result).toEqual({ state: 'active', nextHeartbeatChallenge: 'challenge-2' });
    expect(set.accepted).toEqual(['challenge-1']);
    expect(set.observer.onControlActive).toHaveBeenCalledExactlyOnceWith(1);

    // The consumed challenge cannot re-earn evidence. "not accepted" is the wrapper text every refusal
    // reason shares, so assert the specific reason this authority actually reported instead.
    const replay = await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });
    expect(replay.error?.message).toContain('challenge-mismatch');
    expect(replay.error?.data?.code).toBe('invalid_request');
    expect(set.accepted).toEqual(['challenge-1']);
    expect(set.observer.onControlActive).toHaveBeenCalledOnce();
  });

  it('rejects a heartbeat carrying a foreign epoch', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const wrongEpoch = await client.call('role.heartbeat.v1', { controlEpoch: 2, heartbeatChallenge: 'challenge-1' });

    expect(wrongEpoch.error?.message).toContain('did not name this control tenancy');
  });

  it('serves role methods only once control is active', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const provisional = await client.call('role.work.v1', {});
    expect(provisional.error?.message).toContain('requires active control');

    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });
    const active = await client.call('role.work.v1', {});
    expect(active.result).toEqual({ state: 'worked' });
  });

  it('revokes active method authority when the lease lapses while its socket stays open', async () => {
    const set = await startEndpoint();
    const client = await connect(set.socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    set.lapseControl();
    const refused = await client.call('role.work.v1', {});

    expect(refused.error?.data?.code).toBe('unauthorized_control');
    expect(refused.error?.message).toContain('requires active control');
  });

  it('strictly rejects unknown heartbeat and pairing parameters', async () => {
    const heartbeatSet = await startEndpoint();
    const control = await connect(heartbeatSet.socketPath);
    await control.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const heartbeat = await control.call('role.heartbeat.v1', {
      controlEpoch: 1,
      heartbeatChallenge: 'challenge-1',
      unexpected: true,
    });
    expect(heartbeat.error?.data?.code).toBe('protocol_violation');

    const pairingSet = await startEndpoint({ pairing: { openMethod: 'role.pair.v1', secret: 'shared-secret' } });
    const peer = await connect(pairingSet.socketPath);
    const pairing = await peer.call('role.pair.v1', { pairingSecret: 'shared-secret', unexpected: true });
    expect(pairing.error?.data?.code).toBe('protocol_violation');
  });

  it('reports an unknown method as method-not-found, with a data.code a caller can branch on', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    const unknown = await client.call('role.absent.v1', {});

    expect(unknown.error?.code).toBe(-32_601);
    // The cross-version fallback mechanism ("try the newer method, fall back when the peer does not have it")
    // depends on a caller being able to tell "this peer's build lacks the method" apart from "this call
    // failed" — every other refusal in this file attaches a `data.code` from the closed set for exactly this
    // reason, and this branch previously did not.
    expect(unknown.error?.data?.code).toBe('method_not_found');
  });

  it('keeps a real older endpoint missing operation.activate.v1 pre-effect and non-faulting', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connectControlClient(socketPath, realTimer(), 5_000);
    cleanups.push(() => client.close());
    const setIdentity: ProviderProxySetIdentity = {
      buildSetId: '11111111-1111-4111-8111-111111111111',
      hostFingerprint: 'b'.repeat(64),
      guardianInstanceId: '22222222-2222-4222-8222-222222222222',
      guardianPid: 101,
      guardianProcessStartedAtSeconds: 1_001,
      guardianControlEndpoint: `${socketPath}.guardian`,
      proxyInstanceId: '33333333-3333-4333-8333-333333333333',
      proxyPid: 102,
      reaperInstanceId: '44444444-4444-4444-8444-444444444444',
      reaperPid: 103,
      reaperProcessStartedAtSeconds: 1_003,
      reaperControlEndpoint: `${socketPath}.reaper`,
      containmentKind: 'posix-group',
      proxyProcessStartedAtSeconds: 1_002,
      proxyProcessGroupId: 102,
      canonicalEndpoint: socketPath,
    };
    const faults: unknown[] = [];
    let semanticStartCalls = 0;
    let returnedCode: string | null = null;

    try {
      await activateProviderOperation(
        {
          proxyClient: client,
          guardianClient: client,
          setIdentity,
          mutationRpcTimeoutMs: 5_000,
          faultAuthority: (fault) => faults.push(fault),
        },
        {
          jobId: '55555555-5555-4555-8555-555555555555',
          operationId: '66666666-6666-4666-8666-666666666666',
          proxyInstanceId: setIdentity.proxyInstanceId,
          buildSetId: setIdentity.buildSetId,
        },
        {
          reservation: '77777777-7777-4777-8777-777777777777',
          jointContainmentReceipt: 'containment-receipt',
          jointActivationReceipt: 'activation-receipt',
        },
      );
      semanticStartCalls += 1;
    } catch (error: unknown) {
      returnedCode = providerOperationErrorCode(error);
    }

    expect({ returnedCode, semanticStartCalls, authorityFaults: faults.length }).toEqual({
      returnedCode: 'method_not_found',
      semanticStartCalls: 0,
      authorityFaults: 0,
    });
  });

  it('refuses a successor whose credential arrives after the incumbent reasserts control', async () => {
    const set = await startEndpoint();
    const incumbent = await connect(set.socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    // The lease lapses, so the successor's connection is admitted rather than refused at accept.
    set.lapseControl();
    const successor = await connect(set.socketPath);
    // ...and then the incumbent's heartbeat lands first, reviving its control before the redeem arrives.
    await incumbent.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const refused = await successor.call('role.redeem.v1', {});

    // A valid credential is not a licence to displace a coordinator that is merely slow. Accept-time
    // refusal cannot cover this race, so admission is where the deadline machine gets the final word. This
    // successor's identity ('successor') also never matches the incumbent's ('incumbent'), so the reattach
    // path is not in play here — the ordinary admission refusal is.
    expect(refused.error?.message).toContain('control-active');
    expect(refused.error?.data?.code).toBe('invalid_state');
    // 'invalid_state' alone cannot tell "retry" from "give up" — the reason has to travel as its own
    // structured field, not only inside the human-readable message, for a caller to act on it.
    expect(refused.error?.data?.reason).toBe('control-active');
  });

  it('lets successor admission win the bootstrap race and prevents the displaced first echo from renewing', async () => {
    const set = await startEndpoint();
    const incumbent = await connect(set.socketPath);
    const opened = await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    set.lapseControl();

    const successor = await connect(set.socketPath);
    const redeemed = await successor.call('role.redeem.v1', {});
    await vi.waitFor(() => expect(incumbent.socket.destroyed).toBe(true));
    incumbent.socket.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'role.heartbeat.v1',
        params: {
          controlEpoch: (opened.result as { controlEpoch: number }).controlEpoch,
          heartbeatChallenge: (opened.result as { heartbeatChallenge: string }).heartbeatChallenge,
        },
      })}\n`,
    );

    expect(redeemed.result).toEqual({
      role: 'successor',
      redemptionReceipt: 'receipt-1',
      controlEpoch: 2,
      heartbeatChallenge: 'challenge-2',
    });
    expect(set.accepted).toEqual([]);
    expect(set.challenges).toEqual(['challenge-1', 'challenge-2']);
  });

  it('hands a successor the next epoch once control has lapsed, without reporting the new tenancy lost', async () => {
    const { socketPath, observer } = await startEndpoint();
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    // Control lapses the way the deadline machine sees it: the outstanding challenge goes unanswered.
    incumbent.close();
    await vi.waitFor(() => expect(observer.onControlLost).toHaveBeenCalledExactlyOnceWith(1));

    const successor = await connect(socketPath);
    const redeemed = await successor.call('role.redeem.v1', {});

    expect(redeemed.result).toEqual({
      role: 'successor',
      redemptionReceipt: 'receipt-1',
      controlEpoch: 2,
      heartbeatChallenge: 'challenge-2',
    });
    const beat = await successor.call('role.heartbeat.v1', { controlEpoch: 2, heartbeatChallenge: 'challenge-2' });
    expect(beat.result).toEqual({ state: 'active', nextHeartbeatChallenge: 'challenge-3' });
    // The predecessor's socket must not be able to report a loss that lands on the successor's tenancy.
    expect(observer.onControlLost).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('destroys the displaced connection without ending the tenancy that replaced it', async () => {
    const set = await startEndpoint();
    const { socketPath, observer } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await incumbent.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });
    // A wedged predecessor: its lease lapses while its socket stays open, so socket liveness and control
    // liveness disagree — the case a successor could never get past when admission read the socket.
    set.lapseControl();

    const successor = await connect(socketPath);
    await successor.call('role.redeem.v1', {});

    await vi.waitFor(() => expect(incumbent.socket.destroyed).toBe(true));
    // Recording the replacement before destroying the predecessor is what keeps its close from being read
    // as a control loss at all: the tenancy it would name is already gone, and reporting one here would
    // hand the deadline machine an EOF that collapses the successor's own control window.
    expect(observer.onControlLost).not.toHaveBeenCalled();
  });

  it('refuses a second tenancy on the connection that already holds one', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    // A different holder ('successor', the default) than the one this very socket already holds
    // ('incumbent') — establishing here would destroy the displaced socket, which is this very connection.
    const second = await client.call('role.redeem.v1', {});

    expect(second.error?.message).toContain('already holds a control tenancy');
    expect(client.socket.destroyed).toBe(false);
  });

  it('replays the identical opening for a same-successor retry on the same connection, not invalid_state', async () => {
    const set = await startEndpoint();
    const { socketPath } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    set.lapseControl();
    const successor = await connect(socketPath);

    const first = await successor.call('role.redeem.v1', { successorId: 'successor-same-socket' });
    // The identical redeem, again, on the identical connection — a caller retrying without ever having
    // learned whether its first request landed.
    const retry = await successor.call('role.redeem.v1', { successorId: 'successor-same-socket' });

    expect(retry.result).toEqual(first.result);
    expect(retry.error).toBeUndefined();
  });

  it('returns the identical opening to a same-successor retry on a new socket, and keeps the first challenge live', async () => {
    const set = await startEndpoint();
    const { socketPath } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    set.lapseControl();

    const first = await connect(socketPath);
    const opened = await first.call('role.redeem.v1', { successorId: 'successor-new-socket' });
    expect(opened.result).toMatchObject({ role: 'successor', redemptionReceipt: expect.any(String) });

    // The reply never reached the successor — network partition, timeout, anything — so it retries on a
    // brand-new connection while the first is still open and its challenge still unechoed.
    const retry = await connect(socketPath);
    const retried = await retry.call('role.redeem.v1', { successorId: 'successor-new-socket' });

    // The severe defect: today this mints a fresh epoch and challenge, destroying the one the successor is
    // still holding — so the fix is proven by every field of the reply being byte-identical, including the
    // registry's own memoized receipt.
    expect(retried.result).toEqual(opened.result);

    // And proof the outstanding challenge itself survived, not just the reply: the exact challenge from the
    // *first* redemption is still the one this tenancy answers to.
    const { controlEpoch, heartbeatChallenge } = opened.result as { controlEpoch: number; heartbeatChallenge: string };
    expect(set.observer.onControlActive).not.toHaveBeenCalled();
    const beat = await retry.call('role.heartbeat.v1', { controlEpoch, heartbeatChallenge });
    expect(beat.result).toMatchObject({ state: 'active' });
    expect(set.observer.onControlActive).toHaveBeenCalledExactlyOnceWith(controlEpoch);

    // The superseded first connection is retired without being read as a loss of the tenancy it opened.
    await vi.waitFor(() => expect(first.socket.destroyed).toBe(true));
    expect(set.observer.onControlLost).not.toHaveBeenCalled();
  });

  it('refuses a genuinely different holder while a tenancy is live, not the reattach shortcut', async () => {
    const set = await startEndpoint();
    const { socketPath } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    // The lease lapses, so the stranger's connection is admitted at accept rather than refused there —
    // exactly the race that lets a live-control refusal (not an accept-time one) be the one under test.
    set.lapseControl();
    const stranger = await connect(socketPath);
    // ...and then the incumbent's heartbeat lands first, reasserting live control before the redeem arrives.
    await incumbent.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const refused = await stranger.call('role.redeem.v1', { successorId: 'someone-else' });

    // A holder that never earned this tenancy is not let in just because *a* tenancy happens to be open.
    expect(refused.error?.data?.code).toBe('invalid_state');
    expect(refused.error?.data?.reason).toBe('control-active');
  });

  it('refuses reattachment once teardown has latched, and the reason reaches error.data', async () => {
    const set = await startEndpoint();
    const { socketPath } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    set.lapseControl();
    const first = await connect(socketPath);
    await first.call('role.redeem.v1', { successorId: 'successor-teardown' });

    set.latchTeardown();
    const retry = await connect(socketPath);
    const refused = await retry.call('role.redeem.v1', { successorId: 'successor-teardown' });

    expect(refused.result).toBeUndefined();
    expect(refused.error?.data?.code).toBe('invalid_state');
    expect(refused.error?.data?.reason).toBe('teardown-latched');
  });

  it('refuses a second concurrent connection instead of queueing it', async () => {
    // Not a blanket invariant: it holds because this role's own `startEndpoint()` fixture serves no
    // `observation` method. `establishControl` already refuses a second control tenancy on its own (see the
    // `control-active` refusals above), so this accept-time refusal is what protects a role that has no
    // tenancy-free method for a third connection to legitimately want — see the next test for the role that
    // does, where the same accept-time refusal would make that method unreachable and is narrowed away.
    const { socketPath } = await startEndpoint();
    const first = await connect(socketPath);
    await first.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    const second = await connect(socketPath);
    const closed = await new Promise<boolean>((resolve) => {
      second.socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 1_000);
    });

    expect(closed).toBe(true);
    expect(first.socket.destroyed).toBe(false);
  });

  it('admits a second connection to serve an observation method while control is held live', async () => {
    const { socketPath } = await startEndpoint({ observation: () => ({ seen: true }) });
    const first = await connect(socketPath);
    await first.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    // Unlike the role above, this one serves a method that claims no slot — so a second connection must not
    // be destroyed at accept time just because control is already held; it must live long enough to ask.
    const second = await connect(socketPath);
    const status = await second.call('role.status.v1', {});

    expect(status.result).toEqual({ seen: true });
    expect(second.socket.destroyed).toBe(false);
    expect(first.socket.destroyed).toBe(false);
  });

  it('does not hang close() on a connection that was accepted but never claimed a slot', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    // Connects and sends nothing: never opens, never pairs. Before every accepted socket was tracked, close()
    // awaited server.close()'s callback, which Node fires only once every existing connection has ended —
    // and this one would never end on its own.
    await connect(socketPath);

    const closed = await Promise.race([
      endpoint.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);

    expect(closed).toBe(true);
  });

  it('refuses establishing control from the socket that already holds pairing', async () => {
    const { socketPath } = await startEndpoint({ pairing: { openMethod: 'role.pair.v1', secret: 'shared-secret' } });
    const client = await connect(socketPath);

    const paired = await client.call('role.pair.v1', { pairingSecret: 'shared-secret' });
    expect(paired.result).toEqual({ state: 'paired' });

    // The mirror of the already-covered "control may not also pair" direction: one connection holding both
    // authorities would collapse the distinction the two-ACK staging rule depends on, whichever order it
    // claims them in.
    const opened = await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    expect(opened.error?.message).toContain('may not also open control');
    expect(opened.error?.data?.code).toBe('unauthorized_control');
  });

  it('reports control loss with the epoch that ended', async () => {
    const { socketPath, observer } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    client.close();
    await vi.waitFor(() => expect(observer.onControlLost).toHaveBeenCalledExactlyOnceWith(1));
  });

  it('destroys a connection whose accumulating frame passes the cap before any newline', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    // No newline, so the reader must bound the pending buffer rather than waiting for a terminator.
    client.socket.write('x'.repeat(17 * 1024 * 1024 + 1));

    const closed = await new Promise<boolean>((resolve) => {
      client.socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });
    expect(closed).toBe(true);
  });

  it('carries a multi-byte payload intact when its frame is split across socket writes', async () => {
    const received: unknown[] = [];
    const set = await startEndpoint({
      echo: (params: unknown) => {
        received.push(params);
      },
    });
    const client = await connect(set.socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    // Split the frame mid-character. Decoding each chunk on its own would replace the straddling bytes with
    // U+FFFD, and the damage would sit inside a JSON string where JSON.parse and strict validation both
    // still succeed — silent corruption rather than a rejected frame.
    const text = '안녕하세요 🌊 provider prompt';
    const frame = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'role.echo.v1', params: { text } })}\n`,
    );
    const cut = frame.indexOf(Buffer.from('안')) + 1;
    client.socket.write(frame.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.socket.write(frame.subarray(cut));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ text });
  });

  it('destroys a connection that sends a frame failing strict JSON-RPC validation', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);

    client.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'role.open.v1', extra: true })}\n`);

    const closed = await new Promise<boolean>((resolve) => {
      client.socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });
    expect(closed).toBe(true);
  });

  it('reports a handler-thrown ZodError under the closed set rather than leaking it raw', async () => {
    const { socketPath } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    // Missing every required field, so the ZodError this throws pretty-prints as a multi-issue JSON dump —
    // exactly the shape that must not reach the wire as the whole payload.
    const failed = await client.call('role.strict.v1', {});

    expect(failed.error?.code).toBe(-32_600);
    expect(failed.error?.data?.code).toBe('protocol_violation');
    // Bounded, not the raw dump verbatim: eight missing-field issues pretty-print to well over this length.
    expect(failed.error?.message.length ?? 0).toBeLessThanOrEqual(203);
  });
});

/** A pre-encoded request frame `pushOnTenancy` can write — the shape any `provider.event.v1` push takes,
 *  though `pushOnTenancy` itself is transport-only and does not inspect `method`. */
function pushFrame(id: number): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method: 'provider.event.v1', params: { hello: 'world' } })}\n`;
}

function pushResponse(endpoint: ControlEndpoint, frame: string, timeoutMs: number): Promise<unknown> {
  try {
    return endpoint.pushOnTenancy(frame, timeoutMs).response;
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Answers the next raw frame the far end of `socket` receives as if it were the peer replying to a push —
 *  below `Client.call()`'s own abstraction, since a push is unsolicited from the peer's point of view and
 *  `Client` only ever matches replies to ids it minted itself. */
function respondToPush(socket: Socket, buildResult: (id: number | string) => unknown): void {
  socket.once('data', (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString('utf8').split('\n')[0]) as { id: number | string };
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: buildResult(message.id) })}\n`);
  });
}

describe('provider-proxy control endpoint: pushOnTenancy', () => {
  it('faults only the exact active control epoch and closes admission before reporting loss', async () => {
    const set = await startEndpoint();
    const client = await connect(set.socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    set.endpoint.faultControlTenancy(2);
    expect(client.socket.destroyed).toBe(false);
    expect(set.observer.onControlLost).not.toHaveBeenCalled();

    set.endpoint.faultControlTenancy(1);

    expect(set.observer.onControlLost).toHaveBeenCalledExactlyOnceWith(1);
    expect(() => set.endpoint.pushOnTenancy(pushFrame(1), 200)).toThrowError(
      expect.objectContaining({ code: 'control_endpoint_push_no_tenancy' }),
    );
    await vi.waitFor(() => expect(client.socket.destroyed).toBe(true));
  });

  it('rejects a push when no tenancy has ever opened', async () => {
    const { endpoint } = await startEndpoint();

    await expect(pushResponse(endpoint, pushFrame(1), 200)).rejects.toMatchObject({
      code: 'control_endpoint_push_no_tenancy',
    });
  });

  it('rejects a push before the tenancy’s first heartbeat echo', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });

    await expect(pushResponse(endpoint, pushFrame(1), 200)).rejects.toMatchObject({
      code: 'control_endpoint_push_no_tenancy',
    });
  });

  it('rejects a push after the active tenancy’s lease lapses without an EOF', async () => {
    const set = await startEndpoint();
    const client = await connect(set.socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    set.lapseControl();

    await expect(pushResponse(set.endpoint, pushFrame(1), 200)).rejects.toMatchObject({
      code: 'control_endpoint_push_no_tenancy',
    });
  });

  it('writes the frame on the tenancy’s own socket and resolves with the peer’s result', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const push = endpoint.pushOnTenancy(pushFrame(42), 5_000);
    const pushed = push.response;
    respondToPush(client.socket, () => ({ committed: true }));

    expect(push.controlEpoch).toBe(1);
    await expect(pushed).resolves.toEqual({ committed: true });
  });

  it('rejects a push the peer answers with an error', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const pushed = endpoint.pushOnTenancy(pushFrame(1), 5_000).response;
    client.socket.once('data', (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString('utf8').split('\n')[0]) as { id: number };
      client.socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: 'refused upstream' } })}\n`,
      );
    });

    await expect(pushed).rejects.toMatchObject({ code: 'control_endpoint_push_refused', message: 'refused upstream' });
  });

  it('times out a push nobody answers', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    await expect(pushResponse(endpoint, pushFrame(1), 50)).rejects.toMatchObject({
      code: 'control_endpoint_push_timeout',
    });
  });

  it('rejects a still-outstanding push when its own socket closes before a reply lands', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const pushed = endpoint.pushOnTenancy(pushFrame(1), 5_000).response;
    client.close();

    await expect(pushed).rejects.toMatchObject({ code: 'control_endpoint_push_lost' });
  });

  it('rejects a push outstanding on a predecessor connection rather than letting the successor answer it', async () => {
    const set = await startEndpoint();
    const { socketPath, endpoint } = set;
    const incumbent = await connect(socketPath);
    await incumbent.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await incumbent.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    const pushed = endpoint.pushOnTenancy(pushFrame(1), 5_000).response;
    // Attached in the same tick `pushed` is created: the rejection this test provokes below fires from a
    // socket 'close' callback several ticks later, and Node flags a promise as unhandled by whether a handler
    // was attached *before* that callback runs — not by whether one is attached eventually.
    const rejected = expect(pushed).rejects.toMatchObject({ code: 'control_endpoint_push_lost' });
    // The incumbent never answers; instead its lease lapses and a successor redeems while the push is still
    // outstanding — the epoch rotates, but the pending push was bound to the *socket* it was written on.
    set.lapseControl();
    const successor = await connect(socketPath);
    await successor.call('role.redeem.v1', {});

    // The predecessor's connection is destroyed on redemption, which is what must reject this push — a reply
    // arriving on the successor's own (different) socket could never satisfy it even without this cleanup,
    // but nothing here should leave it hanging either.
    await rejected;
  });

  it('does not block an ordinary inbound request while a push is outstanding', async () => {
    const { socketPath, endpoint } = await startEndpoint();
    const client = await connect(socketPath);
    await client.call('role.open.v1', { bootstrapNonce: BOOTSTRAP_NONCE });
    await client.call('role.heartbeat.v1', { controlEpoch: 1, heartbeatChallenge: 'challenge-1' });

    // Left outstanding for the rest of the test — settled only by `endpoint.close()` in the shared afterEach.
    void endpoint.pushOnTenancy(pushFrame(1), 5_000).response.catch(() => {});

    const worked = await client.call('role.work.v1', {});
    expect(worked.result).toEqual({ state: 'worked' });
  });
});
