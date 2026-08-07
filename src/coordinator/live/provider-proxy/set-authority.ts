import { z } from 'zod';

import {
  guardianReaperHandoffInstallParamsSchema,
  handoffSecretDigest,
  writeHandoffCapsuleFile,
  type HandoffCapsule,
} from '../../../provider-proxy/handoff-capsule.js';
import type { ProviderOperationKey } from '../../../provider-proxy/ledger.js';
import type { ProviderProxyOperationSnapshot } from '../../services/operation-registry.js';
import {
  PROXY_TEARDOWN_RESERVE_MS,
  resolveProviderProxyDeadlineConfiguration,
} from '../../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  canonicalUuidSchema,
  guardianStopAndReapParamsSchema,
  guardianStopAndReapResultSchema,
  type CoordinatorIdentity,
  type GuardianIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../../provider-proxy/protocol.js';
import type { ControlClient } from '../../../provider-proxy/control-client.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { HeartbeatLoop } from './heartbeat.js';
import type { ProviderProxySetAuthority } from './authority.js';

const handoffInstallAckSchema = z
  .object({ state: z.literal('installed-dormant'), grantId: canonicalUuidSchema })
  .strict();

/** Lets `signal` cut a pending call short without requiring `ControlClient.call` itself to understand
 *  `AbortSignal` — it only ever takes a millisecond budget. If the signal wins the race the pending call is
 *  left to settle on its own; `stopAndReap`'s caller treats a lost race and a rejected call identically
 *  (both become `{ unconfirmed }`), so there is nothing further to do with it either way. */
function raceAgainstAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('the caller deadline elapsed before stop-and-reap confirmed absence'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    pending.then(resolve, reject);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type ProviderProxySetAuthorityDependencies = Readonly<{
  proxyInstanceId: string;
  guardianClient: ControlClient;
  proxyClient: ControlClient;
  reaperClient: ControlClient;
  guardianIdentity: GuardianIdentity;
  reaperIdentity: ReaperIdentity;
  proxyIdentityFields: ProxyIdentity;
  heartbeats: readonly HeartbeatLoop[];
  /** This coordinator's own identity — named on every install call so a peer that checks it (build match
   *  only; see `assertNamedCoordinatorBuild`) can report a disagreement instead of installing blind. */
  coordinatorIdentity: CoordinatorIdentity;
  /** Where `installHandoffGrant` writes this set's one successor capsule. Precomputed by the caller
   *  (`establishControl`), which already resolves `baseDir`/generation/flavor the same way every other
   *  proxy-role path in `acquisition-steps.ts` does. */
  handoffCapsulePath: string;
  /** `ids`/`env`/`storage` for minting the grant and writing its capsule durably. */
  runtime: Pick<Runtime, 'ids' | 'env' | 'storage'>;
  /** `snapshotOperations`' source: this coordinator's own live operations, filtered to this proxy. Also
   *  `stopAndReap`'s source for the provider roots it must name in agreement with what each enforcer
   *  actually recorded (`assertRecordedSetAgreement`) — see `ProviderProxyOperationSnapshot`'s own doc. */
  operationRegistry: ProviderProxyOperationSnapshot;
}>;

/**
 * Builds the `ProviderProxySetAuthority` shutdown sees, from three already-established role sessions. Split
 * out from `establishControl` so it takes clients and identities as plain inputs rather than reaching into
 * that function's closure — the same shape that lets a test drive `stopAndReap`/`installHandoffGrant` with a
 * fake `ControlClient` instead of a real socket handshake.
 */
export function createProviderProxySetAuthority(
  deps: ProviderProxySetAuthorityDependencies,
): ProviderProxySetAuthority {
  const {
    proxyInstanceId,
    guardianClient,
    proxyClient,
    reaperClient,
    guardianIdentity,
    reaperIdentity,
    proxyIdentityFields,
    heartbeats,
    coordinatorIdentity,
    handoffCapsulePath,
    runtime,
    operationRegistry,
  } = deps;

  return {
    proxyInstanceId,
    // Taken once per proxy (shutdown.ts calls this exactly once, then hands the fixed result to
    // `installHandoffGrant`) from this coordinator's own live-operation bookkeeping — the same registry
    // `provider-proxy-operation-activation.ts` writes at `operation.activate.v1` ACK. Byte-sorted here so the
    // contract this method documents holds independent of what `installHandoffGrant` does with it.
    snapshotOperations: async () =>
      [...operationRegistry.operationsFor(proxyInstanceId)]
        .map((identity) => ({ jobId: identity.jobId, operationId: identity.operationId }))
        .sort((left, right) =>
          left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
        ),
    installHandoffGrant: async (operations: readonly ProviderOperationKey[], signal: AbortSignal) => {
      if (operations.length === 0) {
        throw new Error('installHandoffGrant requires at least one operation to install a grant over.');
      }
      signal.throwIfAborted();

      // Byte-sorted by operationId: the wire schema (`handoffOperationSetSchema`) requires it and this is
      // the one place that assembles the set, so sorting happens here rather than being asked of every caller.
      //
      // Not re-confirmed against the proxy's own `operation.status.v1` first. That query used to gate the
      // whole install on every named operation still being live and carrier-eligible, refusing the entire
      // grant — for every operation on this proxy — the instant one had already gone stale. A successor
      // learns the identical fact for free and per-operation the moment it tries to adopt: `operation.adopt.v1`
      // answers `operation_not_found` for exactly this proxy no longer holding it, so the whole-set refusal
      // bought nothing a narrower, later, isolated failure did not already cover — and cost every other
      // operation in the set a handoff it would otherwise have gotten cleanly.
      const handoffOperations = [...operations]
        .sort((left, right) =>
          left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
        )
        .map((key) => ({
          jobId: key.jobId,
          operationId: key.operationId,
          proxyInstanceId,
          buildSetId: guardianIdentity.buildSetId,
        }));

      const deadlineConfig = resolveProviderProxyDeadlineConfiguration(runtime.env);
      const grantId = runtime.ids.uuid();
      const secret = runtime.ids.randomBytes(32).toString('hex');
      const secretSha256 = handoffSecretDigest(secret);

      // The guardian and reaper are paired peers of the same set, so they get the identical message — parsed
      // once, here, against the exact schema `guardian.ts`/`reaper.ts` parse it with on receipt, so a mistake
      // in this payload fails at this sender instead of at one strict receiver and not the other.
      const guardianReaperInstallPayload = guardianReaperHandoffInstallParamsSchema.parse({
        grantId,
        secretSha256,
        successor: coordinatorIdentity,
        operations: handoffOperations,
        orphanTimeoutMs: deadlineConfig.orphanTimeoutMs,
        teardownReserveMs: deadlineConfig.teardownReserveMs,
      });

      // All three authorities install the identical value or none of them do: a caller that reaps this set
      // after any one install fails leaves nothing to unwind, since `GrantRegistry.install` is idempotent for
      // the exact same value and the containment is about to be torn down regardless of how far this got.
      await Promise.all([
        guardianClient.call('guardian.handoff-install.v1', guardianReaperInstallPayload, PROXY_CONTROL_RPC_TIMEOUT_MS),
        reaperClient.call('reaper.handoff-install.v1', guardianReaperInstallPayload, PROXY_CONTROL_RPC_TIMEOUT_MS),
        // The one send here still validated only on receipt. The proxy's `handoff.install.v1` schema cannot
        // move to `protocol.ts` beside the others: it needs the grant-secret and operation-set primitives from
        // `handoff-capsule.ts`, and that module imports `protocol.ts`, so the move would close a cycle
        // `tests/invariants/production-import-graph.test.ts` fails on. Nor may it merge with the guardian and
        // reaper schema used two lines above — that message carries a `successor` and a teardown reserve and
        // this one identifies the set through its grant-set fields, because the proxy learns of a handoff only
        // through the two authorities that already hold one.
        proxyClient.call(
          'handoff.install.v1',
          {
            grantId,
            secretSha256,
            generation: proxyIdentityFields.generation,
            hostFingerprint: proxyIdentityFields.hostFingerprint,
            buildSetId: proxyIdentityFields.buildSetId,
            proxyInstanceId: proxyIdentityFields.proxyInstanceId,
            operations: handoffOperations,
            orphanTimeoutMs: deadlineConfig.orphanTimeoutMs,
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        ),
      ]).then(([guardianAck, reaperAck, proxyAck]) => {
        handoffInstallAckSchema.parse(guardianAck);
        handoffInstallAckSchema.parse(reaperAck);
        handoffInstallAckSchema.parse(proxyAck);
      });
      signal.throwIfAborted();

      // The durable half. A grant installed with no capsule is a secret nobody could ever present, so this
      // is not reachable unless every install above already acknowledged the identical value.
      const capsule: HandoffCapsule = {
        version: 1,
        grantId,
        secret,
        generation: guardianIdentity.generation,
        flavor: guardianIdentity.flavor,
        buildSetId: guardianIdentity.buildSetId,
        hostFingerprint: guardianIdentity.hostFingerprint,
        guardianInstanceId: guardianIdentity.guardianInstanceId,
        reaperInstanceId: reaperIdentity.reaperInstanceId,
        proxyInstanceId: proxyIdentityFields.proxyInstanceId,
        guardianControlEndpoint: guardianIdentity.canonicalControlEndpoint,
        reaperControlEndpoint: reaperIdentity.canonicalControlEndpoint,
        proxyEndpoint: proxyIdentityFields.canonicalEndpoint,
        orphanTimeoutMs: deadlineConfig.orphanTimeoutMs,
        teardownReserveMs: deadlineConfig.teardownReserveMs,
      };
      writeHandoffCapsuleFile(handoffCapsulePath, capsule, {
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
      });
    },
    stopAndReap: async (signal) => {
      try {
        // The coordinator's own half of the set-agreement both enforcers require exactly
        // (`assertRecordedSetAgreement`): every provider root this coordinator's own live operations still
        // hold against this proxy, from the same registry `snapshotOperations` above reads. An empty claim
        // disagrees with any enforcer that has actually staged a root — every activated operation stages one
        // before it is ever reported as executing — so this must name every one still live, not an empty set.
        const providerRoots = operationRegistry.providerRootsFor(proxyInstanceId);
        // Parsed against the exact schema `guardian.ts` parses this request with on receipt, so a mistake
        // here — an empty `providerRoots` claim, say — fails at this sender rather than at the guardian's own
        // `.strict()` refusal.
        const stopAndReapPayload = guardianStopAndReapParamsSchema.parse({
          guardian: guardianIdentity,
          reaper: reaperIdentity,
          proxy: proxyIdentityFields,
          providerRoots,
        });
        const raw = await raceAgainstAbort(
          guardianClient.call(
            'guardian.stop-and-reap.v1',
            stopAndReapPayload,
            // `guardian.stop-and-reap.v1` is declared `budgetMs: 'caller-deadline'` on the server precisely
            // so it is not cut off there: a legitimate reap can spend the SIGTERM grace, the SIGKILL grace,
            // and the disappearance confirmation — an 11s floor inside `PROXY_TEARDOWN_RESERVE_MS`'s 14s,
            // and the SIGTERM grace alone already exceeds `PROXY_CONTROL_RPC_TIMEOUT_MS`. Budgeting this call
            // from the ordinary mutation-RPC timeout — the constant every other `client.call` in this file
            // correctly uses, because the server enforces that same value as its default for those methods —
            // would defeat the server's own carve-out and turn a legitimate hard reap into a guaranteed
            // `{ unconfirmed }`. `PROXY_TEARDOWN_RESERVE_MS` is that floor with margin, so it is the ceiling
            // here instead; the caller's own `signal` (raced below) is what actually bounds this in practice.
            PROXY_TEARDOWN_RESERVE_MS,
          ),
          signal,
        );
        return { disappearanceReceipt: guardianStopAndReapResultSchema.parse(raw).disappearanceReceipt };
      } catch (error: unknown) {
        return { unconfirmed: error instanceof Error ? error.message : 'stop-and-reap did not confirm absence' };
      }
    },
    stopHeartbeats: () => {
      for (const heartbeat of heartbeats) heartbeat.stop();
    },
    initiateControlClose: async () => {
      proxyClient.close();
      guardianClient.close();
      reaperClient.close();
    },
  };
}
