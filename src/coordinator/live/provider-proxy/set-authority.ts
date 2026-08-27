import { z } from 'zod';

import {
  guardianReaperHandoffInstallParamsSchema,
  handoffSecretDigest,
  successionOperationRegisterParamsSchema,
  successionOperationRegisterResultSchema,
  CURRENT_HANDOFF_CAPSULE_VERSION,
  writeHandoffCapsuleFile,
  type HandoffCapsuleV3,
  proxyHandoffInstallParamsSchema,
} from '../../../provider-proxy/handoff-capsule.js';
import type { ProviderProxyOperationSnapshot } from '../../services/operation-registry.js';
import {
  PROXY_TEARDOWN_RESERVE_MS,
  providerProxyHeartbeatHoldBound,
  resolveProviderProxyDeadlineConfiguration,
} from '../../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  canonicalUuidSchema,
  guardianStopAndReapParamsSchema,
  guardianStopAndReapResultSchema,
  providerHostEvictParamsSchema,
  providerHostEvictResultSchema,
  providerHostInspectParamsSchema,
  providerHostInspectResultSchema,
  providerHostListParamsSchema,
  providerHostListResultSchema,
  reaperStopAndReapParamsSchema,
  reaperStopAndReapResultSchema,
  type CoordinatorIdentity,
  type GuardianIdentity,
  type OperationIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../../provider-proxy/protocol.js';
import type { ControlClient } from '../../../provider-proxy/control-client.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ProviderProxyRoleHeartbeats } from './heartbeat.js';
import type { ProviderProxyAutonomousDeadline, ProviderProxySetRecoveryAuthority } from './authority.js';

const handoffInstallAckSchema = z
  .object({ state: z.literal('installed-dormant'), grantId: canonicalUuidSchema })
  .strict();

function assertHandoffInstallAck(value: unknown, expectedGrantId: string): void {
  const acknowledgement = handoffInstallAckSchema.parse(value);
  if (acknowledgement.grantId !== expectedGrantId) {
    throw new Error('provider_proxy_handoff_install_ack_grant_mismatch');
  }
}

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

type ProviderProxySetAuthorityCommonDependencies = Readonly<{
  proxyInstanceId: string;
  guardianClient: ControlClient;
  proxyClient: ControlClient;
  reaperClient: ControlClient;
  guardianIdentity: GuardianIdentity;
  reaperIdentity: ReaperIdentity;
  proxyIdentityFields: ProxyIdentity;
  heartbeats: ProviderProxyRoleHeartbeats;
  /** This coordinator's own identity — named on every install call so a peer that checks it (build match
   *  only; see `assertNamedCoordinatorBuild`) can report a disagreement instead of installing blind. */
  coordinatorIdentity: CoordinatorIdentity;
  /** Where fresh acquisition writes this set's recovery capsule. Precomputed by the caller
   *  (`establishControl`), which already resolves `baseDir`/generation/flavor the same way every other
   *  proxy-role path in `acquisition-steps.ts` does. */
  handoffCapsulePath: string;
  /** Kept outside SQLite so the credential secret never enters durable domain records. */
  runtime: Pick<Runtime, 'ids' | 'env' | 'storage'>;
  /** `stopAndReap`'s source for provider roots this generation can still name in set agreement. */
  operationRegistry: ProviderProxyOperationSnapshot;
}>;

export type ProviderProxySetAuthorityDependencies = ProviderProxySetAuthorityCommonDependencies &
  (
    | Readonly<{ recoveryCapsule?: never; recoveryOperations?: never }>
    | Readonly<{ recoveryCapsule: HandoffCapsuleV3; recoveryOperations: readonly OperationIdentity[] }>
  );

/**
 * Builds the `ProviderProxySetAuthority` shutdown sees, from three already-established role sessions. Split
 * out from `establishControl` so tests can exercise recovery installation and containment release without a
 * real socket handshake.
 */
export function createProviderProxySetAuthority(
  deps: ProviderProxySetAuthorityDependencies,
): ProviderProxySetRecoveryAuthority {
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

  const deadlineConfiguration = deps.recoveryCapsule ?? resolveProviderProxyDeadlineConfiguration(runtime.env);
  let autonomousDeadline: ProviderProxyAutonomousDeadline = Object.freeze({
    acceptanceFailure: 'role-acknowledgement-unavailable' as const,
    orphanTimeoutMs: deadlineConfiguration.orphanTimeoutMs,
    heartbeatHoldBound: providerProxyHeartbeatHoldBound(deadlineConfiguration),
  });

  // Distinct from `deps.recoveryCapsule` on purpose: this one is *this* build's, and the writer accepts only
  // V3. Conflating them let a redeemed V1 reach a write that must never emit a shape this build cannot verify.
  let mintedRecoveryCapsule: HandoffCapsuleV3 | null = null;
  const mintRecoveryCapsule = (): HandoffCapsuleV3 => {
    if (mintedRecoveryCapsule !== null) return mintedRecoveryCapsule;
    mintedRecoveryCapsule = {
      version: CURRENT_HANDOFF_CAPSULE_VERSION,
      grantId: runtime.ids.uuid(),
      secret: runtime.ids.randomBytes(32).toString('hex'),
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
      orphanTimeoutMs: deadlineConfiguration.orphanTimeoutMs,
      teardownReserveMs: deadlineConfiguration.teardownReserveMs,
      guardianPid: guardianIdentity.pid,
      guardianIncarnation: guardianIdentity.incarnation,
      proxyPid: proxyIdentityFields.pid,
      reaperPid: reaperIdentity.pid,
      reaperIncarnation: reaperIdentity.incarnation,
      containmentKind: reaperIdentity.containmentKind,
      proxyIncarnation: proxyIdentityFields.incarnation,
      proxyProcessGroupId: proxyIdentityFields.processGroupId,
    };
    return mintedRecoveryCapsule;
  };
  let recoveryCredentialInstalled = deps.recoveryCapsule !== undefined;
  let recoveryCredentialInstall: Promise<void> | null = null;

  const installRecoveryCredential = async (signal: AbortSignal): Promise<void> => {
    if (recoveryCredentialInstalled && autonomousDeadline.owner !== undefined) return;
    signal.throwIfAborted();
    recoveryCredentialInstall ??= (async () => {
      const capsule = deps.recoveryCapsule ?? mintRecoveryCapsule();
      const operations = deps.recoveryCapsule === undefined ? [] : deps.recoveryOperations;
      const secretSha256 = handoffSecretDigest(capsule.secret);
      const guardianReaperInstallPayload = guardianReaperHandoffInstallParamsSchema.parse({
        grantId: capsule.grantId,
        secretSha256,
        successor: coordinatorIdentity,
        operations,
        orphanTimeoutMs: capsule.orphanTimeoutMs,
        teardownReserveMs: capsule.teardownReserveMs,
      });
      const proxyInstall = () =>
        proxyClient.call(
          'handoff.install.v1',
          proxyHandoffInstallParamsSchema.parse({
            grantId: capsule.grantId,
            secretSha256,
            generation: capsule.generation,
            hostFingerprint: capsule.hostFingerprint,
            buildSetId: capsule.buildSetId,
            proxyInstanceId: capsule.proxyInstanceId,
            operations,
            orphanTimeoutMs: capsule.orphanTimeoutMs,
          }),
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        );
      let guardianAck: unknown;
      let reaperAck: unknown;
      let proxyAck: unknown;
      if (deps.recoveryCapsule === undefined) {
        [guardianAck, reaperAck, proxyAck] = await Promise.all([
          guardianClient.call(
            'guardian.handoff-install.v1',
            guardianReaperInstallPayload,
            PROXY_CONTROL_RPC_TIMEOUT_MS,
          ),
          reaperClient.call('reaper.handoff-install.v1', guardianReaperInstallPayload, PROXY_CONTROL_RPC_TIMEOUT_MS),
          proxyInstall(),
        ]);
      } else {
        [guardianAck, reaperAck] = await Promise.all([
          guardianClient.call(
            'guardian.handoff-install.v1',
            guardianReaperInstallPayload,
            PROXY_CONTROL_RPC_TIMEOUT_MS,
          ),
          reaperClient.call('reaper.handoff-install.v1', guardianReaperInstallPayload, PROXY_CONTROL_RPC_TIMEOUT_MS),
        ]);
        assertHandoffInstallAck(guardianAck, capsule.grantId);
        assertHandoffInstallAck(reaperAck, capsule.grantId);
        proxyAck = await proxyInstall();
      }
      assertHandoffInstallAck(guardianAck, capsule.grantId);
      assertHandoffInstallAck(reaperAck, capsule.grantId);
      assertHandoffInstallAck(proxyAck, capsule.grantId);
      if (deps.recoveryCapsule === undefined) {
        writeHandoffCapsuleFile(handoffCapsulePath, capsule, {
          storage: runtime.storage,
          uid: process.getuid?.() ?? 0,
        });
      }
      recoveryCredentialInstalled = true;
      autonomousDeadline = Object.freeze({
        owner: 'guardian-and-reaper' as const,
        orphanTimeoutMs: deadlineConfiguration.orphanTimeoutMs,
        heartbeatHoldBound: providerProxyHeartbeatHoldBound(deadlineConfiguration),
      });
    })();
    await recoveryCredentialInstall;
    signal.throwIfAborted();
  };

  const registerSuccessionOperation = async (
    operation: OperationIdentity,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    await installRecoveryCredential(signal);
    signal.throwIfAborted();
    if (operation.proxyInstanceId !== proxyInstanceId || operation.buildSetId !== guardianIdentity.buildSetId) {
      throw new Error('Succession registration named an operation from another proxy set.');
    }
    const params = successionOperationRegisterParamsSchema.parse({ operation });
    const [guardianResult, reaperResult, proxyResult] = await Promise.all([
      guardianClient.call('guardian.succession-register-operation.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
      reaperClient.call('reaper.succession-register-operation.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
      proxyClient.call('succession.register-operation.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
    ]);
    successionOperationRegisterResultSchema.parse(guardianResult);
    successionOperationRegisterResultSchema.parse(reaperResult);
    successionOperationRegisterResultSchema.parse(proxyResult);
    signal.throwIfAborted();
  };

  return {
    proxyInstanceId,
    get autonomousDeadline() {
      return autonomousDeadline;
    },
    providerHosts: Object.freeze({
      list: async () => {
        const params = providerHostListParamsSchema.parse({});
        const raw = await proxyClient.call('provider-host.list.v1', params, PROXY_STATUS_RPC_TIMEOUT_MS);
        return providerHostListResultSchema.parse(raw).hosts;
      },
      inspect: async (hostRef) => {
        const params = providerHostInspectParamsSchema.parse({ hostRef });
        const raw = await proxyClient.call('provider-host.inspect.v1', params, PROXY_STATUS_RPC_TIMEOUT_MS);
        const result = providerHostInspectResultSchema.parse(raw);
        return result.state === 'matched' ? result.host : null;
      },
      evict: async (hostRef) => {
        const params = providerHostEvictParamsSchema.parse({ hostRef });
        const raw = await proxyClient.call('provider-host.evict.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS);
        return providerHostEvictResultSchema.parse(raw).state === 'evicted';
      },
    }),
    installRecoveryCredential,
    registerSuccessionOperation,
    stopAndReap: async (signal) => {
      try {
        // The coordinator's own half of the set-agreement both enforcers check
        // (`assertRecordedSetAgreement`): every provider root this coordinator's own live operations still
        // hold against this proxy. Claiming fewer
        // than the enforcer recorded is legitimate and expected — an operation that settled released its
        // registry entry and may still be releasing its guardian membership — so the check is a subset test.
        // What it refuses is a root this coordinator names that the enforcer never staged, which means the
        // two are reasoning about different containments.
        const providerRoots = operationRegistry.providerRootsFor(proxyInstanceId);
        // Parsed against the exact schema `guardian.ts` parses this request with on receipt, so a malformed
        // payload fails at this sender rather than at the guardian's own `.strict()` refusal. It does not
        // check the set itself — an undershooting claim is legitimate, and only the enforcer holds what it
        // would have to be checked against.
        const guardianStopAndReapPayload = guardianStopAndReapParamsSchema.parse({
          guardian: guardianIdentity,
          reaper: reaperIdentity,
          proxy: proxyIdentityFields,
          providerRoots,
        });
        const reaperStopAndReapPayload = reaperStopAndReapParamsSchema.parse({
          reaper: reaperIdentity,
          proxy: proxyIdentityFields,
          providerRoots,
        });
        const [rawGuardian, rawReaper] = await Promise.all([
          raceAgainstAbort(
            guardianClient.call(
              'guardian.stop-and-reap.v1',
              guardianStopAndReapPayload,
              // Both role methods are declared `budgetMs: 'caller-deadline'`: a legitimate hard reap can
              // spend the TERM and KILL graces plus disappearance confirmation. The caller signal remains
              // the actual bound on the joined proof.
              PROXY_TEARDOWN_RESERVE_MS,
            ),
            signal,
          ),
          raceAgainstAbort(
            reaperClient.call('reaper.stop-and-reap.v1', reaperStopAndReapPayload, PROXY_TEARDOWN_RESERVE_MS),
            signal,
          ),
        ]);
        const guardianReceipt = guardianStopAndReapResultSchema.parse(rawGuardian).disappearanceReceipt;
        const reaperReceipt = reaperStopAndReapResultSchema.parse(rawReaper).disappearanceReceipt;
        return { disappearanceReceipt: `guardian:${guardianReceipt};reaper:${reaperReceipt}` };
      } catch (error: unknown) {
        return { unconfirmed: error instanceof Error ? error.message : 'stop-and-reap did not confirm absence' };
      }
    },
    stopHeartbeats: () => {
      heartbeats.proxy.stop();
      heartbeats.guardian.stop();
      heartbeats.reaper.stop();
    },
    initiateControlClose: async () => {
      proxyClient.close();
      guardianClient.close();
      reaperClient.close();
    },
  };
}
