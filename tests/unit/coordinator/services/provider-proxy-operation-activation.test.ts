import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { readProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import type { OperationIdentity, ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import {
  activateProviderOperation,
  type OperationControlClient,
  type ProviderProxyOperationActivationDeps,
  type ProviderProxySetIdentity,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';

function testDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

const SET_IDENTITY: ProviderProxySetIdentity = {
  buildSetId: randomUUID(),
  hostFingerprint: 'a'.repeat(64),
  guardianInstanceId: randomUUID(),
  guardianPid: 100,
  guardianProcessStartedAtSeconds: 1,
  guardianControlEndpoint: '/tmp/guardian.sock',
  proxyInstanceId: randomUUID(),
  proxyPid: 200,
  reaperInstanceId: randomUUID(),
  reaperPid: 300,
  reaperProcessStartedAtSeconds: 2,
  reaperControlEndpoint: '/tmp/reaper.sock',
  containmentKind: 'detached-group',
  proxyProcessStartedAtSeconds: 3,
  proxyProcessGroupId: 200,
  canonicalEndpoint: '/tmp/proxy.sock',
};

const OPERATION: OperationIdentity = {
  jobId: randomUUID(),
  operationId: randomUUID(),
  proxyInstanceId: SET_IDENTITY.proxyInstanceId,
  buildSetId: SET_IDENTITY.buildSetId,
};

const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: '/project',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

const PREPARE_PENDING = {
  state: 'pending-activation' as const,
  reservationId: randomUUID(),
  activationNonce: randomUUID(),
  leaseExpiresInMs: 15_000,
  providerRoot: { pid: 7_001, processStartedAtSeconds: 800 },
  jointContainmentReceipt: 'joint-1',
};

/** Records every call made to it, in order, and answers each from a scripted queue — one fake per role, since
 *  `activateProviderOperation` talks to the proxy and the guardian on two separate connections. */
function scriptedClient(answers: Record<string, unknown[]>): { client: OperationControlClient; calls: string[] } {
  const calls: string[] = [];
  const cursor = new Map<string, number>();
  const client: OperationControlClient = {
    call: async (method, _params, _timeoutMs) => {
      calls.push(method);
      const queue = answers[method];
      if (queue === undefined) throw new Error(`unscripted call to ${method}`);
      const index = cursor.get(method) ?? 0;
      cursor.set(method, index + 1);
      const answer = queue[Math.min(index, queue.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { client, calls };
}

function deps(
  db: Database,
  proxy: OperationControlClient,
  guardian: OperationControlClient,
): ProviderProxyOperationActivationDeps {
  return { db, proxyClient: proxy, guardianClient: guardian, setIdentity: SET_IDENTITY, mutationRpcTimeoutMs: 5_000 };
}

describe('activateProviderOperation', () => {
  it('runs the closed publication order and commits the runtime-meta locator before activation', async () => {
    const db = testDb();
    const proxy = scriptedClient({
      'operation.prepare.v1': [PREPARE_PENDING],
      'operation.activate.v1': [{ state: 'executing', committedThroughProviderSeq: 0 }],
    });
    // Read from *inside* the guardian client's `call`, at the instant `guardian.operation-activate.v1` fires
    // — the only way to prove the meta commit happens-before activation rather than merely observe a result
    // consistent with it. A final call-order array plus a post-hoc DB read would pass identically if the
    // write moved to just before the function's own final `return`, after both RPCs; this would not, per
    // `active-store-selection-locking.test.ts`'s "observe state from inside a dependency callback before it
    // resolves" technique.
    const guardianCalls: string[] = [];
    let metaDuringGuardianActivate: unknown;
    const guardian: OperationControlClient = {
      call: async (method) => {
        guardianCalls.push(method);
        metaDuringGuardianActivate = readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId);
        return { state: 'activation-authorized', jointActivationReceipt: 'joint-activation-1' };
      },
    };

    const result = await activateProviderOperation(deps(db, proxy.client, guardian), OPERATION, PREPARED);

    if (result.kind !== 'executing') throw new Error(`expected 'executing', got '${result.kind}'`);
    expect(result.committedThroughProviderSeq).toBe(0);
    // Message-exact order: prepare, then the meta commit is durable (checked below) before either activation
    // call, then guardian activation, then proxy activation.
    expect(proxy.calls).toEqual(['operation.prepare.v1', 'operation.activate.v1']);
    expect(guardianCalls).toEqual(['guardian.operation-activate.v1']);

    // The load-bearing assertion: the row was already durable when the guardian activation RPC fired, not
    // merely present by the time this whole call resolved.
    expect(metaDuringGuardianActivate).toMatchObject({
      jobId: OPERATION.jobId,
      operationId: OPERATION.operationId,
      buildSetId: SET_IDENTITY.buildSetId,
      reservationId: PREPARE_PENDING.reservationId,
      activationNonce: PREPARE_PENDING.activationNonce,
      providerRootPid: 7_001,
      providerRootProcessStartedAtSeconds: 800,
      jointContainmentReceipt: 'joint-1',
    });

    const meta = readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId);
    expect(meta).toEqual(metaDuringGuardianActivate);
    // `result.meta` is the exact row `LocalOperationRegistry.activate()` gets handed — not a copy re-derived
    // from anything, the same row this test just read back independently.
    expect(result.meta).toEqual(meta);
  });

  it('returns a control capability that sends operation.stop.v1 for exactly this operation', async () => {
    const db = testDb();
    const proxy = scriptedClient({
      'operation.prepare.v1': [PREPARE_PENDING],
      'operation.activate.v1': [{ state: 'executing', committedThroughProviderSeq: 0 }],
      'operation.stop.v1': [{ state: 'terminal-awaiting-journal-ack', committedThroughProviderSeq: 0 }],
    });
    const guardian = scriptedClient({
      'guardian.operation-activate.v1': [
        { state: 'activation-authorized', jointActivationReceipt: 'joint-activation-1' },
      ],
    });

    const result = await activateProviderOperation(deps(db, proxy.client, guardian.client), OPERATION, PREPARED);
    if (result.kind !== 'executing') throw new Error(`expected 'executing', got '${result.kind}'`);

    await result.control.stop('user_abort');

    expect(proxy.calls).toEqual(['operation.prepare.v1', 'operation.activate.v1', 'operation.stop.v1']);
  });

  it('reports capacity and writes nothing when the proxy ledger is full', async () => {
    const db = testDb();
    const proxy = scriptedClient({
      'operation.prepare.v1': [{ state: 'capacity', retryable: true, reason: 'operation-ledgers' }],
    });
    const guardian = scriptedClient({});

    const result = await activateProviderOperation(deps(db, proxy.client, guardian.client), OPERATION, PREPARED);

    expect(result).toEqual({ kind: 'capacity', retryable: true, reason: 'operation-ledgers' });
    expect(readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId)).toBeNull();
    expect(guardian.calls).toEqual([]);
  });

  it('compensates in the exact order — delete meta, then cancel-pending, then guardian release — and never starts the kernel, when guardian activation fails', async () => {
    const db = testDb();
    const proxy = scriptedClient({
      'operation.prepare.v1': [PREPARE_PENDING],
      'operation.cancel-pending.v1': [{ state: 'released' }],
    });
    // Read from inside the failing call, before it throws — proves the row genuinely existed and was then
    // deleted by compensation, not that it was simply never written. A post-hoc `null` read alone cannot
    // distinguish "written then deleted" from "never written".
    let metaBeforeFailure: unknown;
    const guardianCalls: string[] = [];
    const guardian: OperationControlClient = {
      call: async (method) => {
        guardianCalls.push(method);
        if (method === 'guardian.operation-activate.v1') {
          metaBeforeFailure = readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId);
          throw new Error('reservation_expired');
        }
        return { state: 'membership-released' };
      },
    };

    const result = await activateProviderOperation(deps(db, proxy.client, guardian), OPERATION, PREPARED);

    expect(result).toEqual({ kind: 'activation-failed', step: 'guardian-activate', reason: 'reservation_expired' });
    // The kernel is never started on this path: `operation.activate.v1` never appears in the proxy's calls.
    expect(proxy.calls).toEqual(['operation.prepare.v1', 'operation.cancel-pending.v1']);
    expect(guardianCalls).toEqual(['guardian.operation-activate.v1', 'guardian.operation-release.v1']);
    expect(metaBeforeFailure).toMatchObject({ jobId: OPERATION.jobId, operationId: OPERATION.operationId });
    // The meta was committed by prepare's step 2, then deleted by compensation before either release call —
    // if it were still present, a locator would outlive its own reservation.
    expect(readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId)).toBeNull();
  });

  it('compensates the same way when the proxy itself refuses activation', async () => {
    const db = testDb();
    // Read from inside the failing call, before it throws — proves this path also writes-then-deletes rather
    // than never writing, the same ambiguity the guardian-side compensation test above closes.
    let metaBeforeFailure: unknown;
    const proxyCalls: string[] = [];
    const proxy: OperationControlClient = {
      call: async (method) => {
        proxyCalls.push(method);
        if (method === 'operation.prepare.v1') return PREPARE_PENDING;
        if (method === 'operation.activate.v1') {
          metaBeforeFailure = readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId);
          throw new Error('reservation_expired');
        }
        return { state: 'released' };
      },
    };
    const guardian = scriptedClient({
      'guardian.operation-activate.v1': [
        { state: 'activation-authorized', jointActivationReceipt: 'joint-activation-1' },
      ],
      'guardian.operation-release.v1': [{ state: 'membership-released' }],
    });

    const result = await activateProviderOperation(deps(db, proxy, guardian.client), OPERATION, PREPARED);

    expect(result).toEqual({ kind: 'activation-failed', step: 'proxy-activate', reason: 'reservation_expired' });
    expect(proxyCalls).toEqual(['operation.prepare.v1', 'operation.activate.v1', 'operation.cancel-pending.v1']);
    expect(metaBeforeFailure).toMatchObject({ jobId: OPERATION.jobId, operationId: OPERATION.operationId });
    expect(readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId)).toBeNull();
    expect(guardian.calls).toEqual(['guardian.operation-activate.v1', 'guardian.operation-release.v1']);
  });

  it('refuses a malformed prepare reply rather than committing meta from an unvalidated shape', async () => {
    const db = testDb();
    const proxy = scriptedClient({ 'operation.prepare.v1': [{ state: 'pending-activation' }] });
    const guardian = scriptedClient({});

    await expect(
      activateProviderOperation(deps(db, proxy.client, guardian.client), OPERATION, PREPARED),
    ).rejects.toThrow();

    expect(readProviderOperationRuntimeMeta(db, OPERATION.jobId, OPERATION.operationId)).toBeNull();
  });
});
