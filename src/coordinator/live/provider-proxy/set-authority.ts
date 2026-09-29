import { z } from 'zod';

import {
  guardianReaperHandoffInstallParamsSchema,
  handoffSecretDigest,
  successionOperationRegisterParamsSchema,
  successionOperationRegisterResultSchema,
  CURRENT_HANDOFF_CAPSULE_VERSION,
  currentHandoffCapsulePathBeside,
  handoffCapsuleControllerBuildSetId,
  writeHandoffCapsuleFile,
  type HandoffCapsuleV4,
  type RedeemableHandoffCapsule,
  proxyHandoffInstallParamsSchema,
  canonicalHandoffOperationSet,
} from '../../../provider-proxy/handoff-capsule.js';
import {
  PROVIDER_PROXY_CONTROL_GENERATION,
  controllerTransferParamsSchema,
  controllerTransferResultSchema,
  type ControllerBuild,
} from '../../../provider-proxy/controller-succession.js';
import type { ProviderProxyOperationSnapshot } from '../../services/operation-registry.js';
import { ProviderHostOwnerTornDown } from '../../services/provider-host-administration.js';
import {
  providerProxyAdoptionWindowMs,
  providerProxyHeartbeatHoldBound,
  resolveProviderProxyDeadlineConfiguration,
} from '../../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  canonicalUuidSchema,
  providerHostEvictParamsSchema,
  providerHostEvictResultV2Schema,
  providerHostInspectParamsSchema,
  providerHostInspectResultV1Schema,
  providerHostInspectResultV2Schema,
  providerHostListParamsSchema,
  providerHostListResultV1Schema,
  providerHostListResultV2Schema,
  providerHostTerminalEvictionResultV2Schema,
  type CoordinatorIdentity,
  type GuardianIdentity,
  type OperationIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../../provider-proxy/protocol.js';
import type { ControlClient, ControlExchange, ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { ProviderProxySetIdentity } from '../../services/provider-proxy-set/identity.js';
import { retireProviderHandoffCapsule } from '../../services/provider-proxy-capsule-discovery.js';
import {
  closeRedeemedProviderProxyControl,
  providerProxyControlRedemptionBundle,
  redeemProviderProxyControl,
  type ProviderProxyControlRedemptionOutcome,
  type RedeemedProviderProxyControl,
} from './control-redemption.js';
import type { ProviderProxyRoleHeartbeats } from './heartbeat.js';
import type { AcquisitionUndo } from './index.js';
import type {
  ContainmentCommitOutcome,
  ProviderProxyAutonomousDeadline,
  ProviderProxySetAuthority,
} from './authority.js';
import { commitProviderProxyGuardianContainment } from './authority.js';

const handoffInstallAckSchema = z
  .object({ state: z.literal('installed-dormant'), grantId: canonicalUuidSchema })
  .strict();

function assertHandoffInstallAck(value: unknown, expectedGrantId: string): void {
  const acknowledgement = handoffInstallAckSchema.parse(value);
  if (acknowledgement.grantId !== expectedGrantId) {
    throw new Error('provider_proxy_handoff_install_ack_grant_mismatch');
  }
}

declare const installedRecoveryCredentialBrand: unique symbol;
type InstalledRecoveryCredentialBrand = Readonly<{ [installedRecoveryCredentialBrand]: true }>;

export type InstalledRecoveryCredential = Readonly<{
  kind: 'installed-recovery-credential';
  grantId: string;
}> &
  InstalledRecoveryCredentialBrand;

type RecoveryCredentialInstallRole = 'guardian' | 'reaper' | 'proxy';
type ControlResponse = Extract<ControlExchange, { kind: 'response' }>;
type ControlRefusalExchange = Readonly<{
  kind: 'response';
  response: Extract<ControlResponse['response'], { kind: 'refusal' }>;
}>;
type ControlInstallIncidentExchange = Exclude<ControlExchange, ControlResponse> | ControlRefusalExchange;

export type RecoveryCredentialInstallIncident = Readonly<{
  role: RecoveryCredentialInstallRole;
  method: 'guardian.handoff-install.v1' | 'reaper.handoff-install.v1' | 'handoff.install.v1';
  exchange: ControlInstallIncidentExchange;
}>;

export type RecoveryCredentialInstallOutcome =
  | Readonly<{ kind: 'installed'; receipt: InstalledRecoveryCredential }>
  | Readonly<{ kind: 'retryable'; incident: RecoveryCredentialInstallIncident }>
  | Readonly<{ kind: 'refused'; incident: RecoveryCredentialInstallIncident }>
  | Readonly<{ kind: 'cancelled' }>;

export type SuccessionOperationRegistrationOutcome =
  | Readonly<{ kind: 'registered' }>
  | Exclude<RecoveryCredentialInstallOutcome, { kind: 'installed' }>;

type ControllerTransferRole = 'guardian' | 'proxy';

export type ControllerTransferIncident = Readonly<{
  role: ControllerTransferRole | RecoveryCredentialInstallRole;
  method: 'guardian.controller-transfer.v1' | 'controller-transfer.v1' | RecoveryCredentialInstallIncident['method'];
  exchange: ControlInstallIncidentExchange;
}>;

/** `legacy-host` cannot change on retry: a role without controller transfer cannot accept a successor. */
export type ControllerTransferOutcome =
  | Readonly<{ kind: 'authorized'; recoveryGrantId: string }>
  | Readonly<{ kind: 'legacy-host'; role: ControllerTransferRole }>
  | Readonly<{ kind: 'retryable'; incident: ControllerTransferIncident }>
  | Readonly<{ kind: 'refused'; incident: ControllerTransferIncident }>
  | Readonly<{ kind: 'cancelled' }>;

export interface ProviderProxySetRecoveryAuthority extends ProviderProxySetAuthority {
  readonly autonomousDeadline: ProviderProxyAutonomousDeadline;
  readonly controlReattachment: ProviderProxySetControlReattachment;
  installRecoveryCredential(signal: AbortSignal): Promise<RecoveryCredentialInstallOutcome>;
  /**
   * Authorizes `successor` to redeem this set's recovery grant for one succession attempt. The grant keeps
   * authorizing this controller's own build, so a successor that fails before it serves can be reclaimed.
   */
  authorizeControllerTransfer(
    transfer: Readonly<{ attemptId: string; successor: ControllerBuild }>,
    signal: AbortSignal,
  ): Promise<ControllerTransferOutcome>;
  registerSuccessionOperation(
    operation: OperationIdentity,
    signal?: AbortSignal,
  ): Promise<SuccessionOperationRegistrationOutcome>;
}

export interface ProviderProxySetControlReattachment {
  redeem(setIdentity: ProviderProxySetIdentity, signal: AbortSignal): Promise<ProviderProxyControlRedemptionOutcome>;
  promote(redemption: RedeemedProviderProxyControl, signal: AbortSignal): Promise<ProviderProxySetRecoveryAuthority>;
}

type RecoveryCredentialInstallState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'installing'; completion: Promise<RecoveryCredentialInstallOutcome> }>
  | Readonly<{ kind: 'installed'; receipt: InstalledRecoveryCredential }>;

function installExchangeOutcome(
  role: RecoveryCredentialInstallRole,
  method: RecoveryCredentialInstallIncident['method'],
  exchange: ControlExchange,
  expectedGrantId: string,
): Exclude<RecoveryCredentialInstallOutcome, { kind: 'installed' | 'cancelled' }> | null {
  if (exchange.kind !== 'response') {
    return { kind: 'retryable', incident: { role, method, exchange } };
  }
  if (exchange.response.kind === 'refusal') {
    return {
      kind: 'refused',
      incident: { role, method, exchange: { kind: 'response', response: exchange.response } },
    };
  }
  assertHandoffInstallAck(exchange.response.value, expectedGrantId);
  return null;
}

function requireControlResult(method: string, exchange: ControlExchange): unknown {
  if (exchange.kind === 'response') {
    if (exchange.response.kind === 'result') return exchange.response.value;
    throw exchange.response.error;
  }
  if (exchange.error instanceof Error) throw exchange.error;
  throw new Error(`${method} could not be sent.`, { cause: exchange.error });
}

/** A method-not-found reply must not classify any other exchange. */
type ControlMethodAvailability =
  | Readonly<{ kind: 'answered'; exchange: ControlExchange }>
  | Readonly<{ kind: 'method-absent' }>;

function controlMethodAvailability(exchange: ControlExchange): ControlMethodAvailability {
  return exchange.kind === 'response' &&
    exchange.response.kind === 'refusal' &&
    exchange.response.failure.kind === 'json-rpc-error' &&
    exchange.response.failure.protocolCode === 'method_not_found'
    ? { kind: 'method-absent' }
    : { kind: 'answered', exchange };
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
  /** Every install must name this coordinator’s own identity so a peer can reject a grant for another build. */
  coordinatorIdentity: CoordinatorIdentity;
  /** Where fresh acquisition writes this set's recovery capsule. Precomputed by the caller
   *  (`establishControl`), which already resolves `baseDir`/generation/flavor the same way every other
   *  proxy-role path in `acquisition-steps.ts` does. */
  handoffCapsulePath: string;
  /** Kept outside SQLite so the credential secret never enters durable domain records. */
  runtime: Runtime;
  onProviderEvent?(): ProviderEventHandler;
  operationRegistry: ProviderProxyOperationSnapshot;
  /** Fresh acquisition must transfer cleanup ownership in the same turn that writes the capsule. */
  registerAcquisitionUndo?(undo: AcquisitionUndo): void;
}>;

export type ProviderProxySetAuthorityDependencies = ProviderProxySetAuthorityCommonDependencies &
  (
    | Readonly<{ recoveryCapsule?: never; recoveryOperations?: never }>
    | Readonly<{ recoveryCapsule: RedeemableHandoffCapsule; recoveryOperations: readonly OperationIdentity[] }>
  );

/**
 * Builds the `ProviderProxySetAuthority` shutdown sees, from three already-established role sessions. Split
 * out from `establishControl` so tests can exercise recovery installation and containment without a
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
  const autonomousDeadline: ProviderProxyAutonomousDeadline = Object.freeze({
    orphanTimeoutMs: deadlineConfiguration.orphanTimeoutMs,
    adoptionWindowMs: providerProxyAdoptionWindowMs(deadlineConfiguration),
    heartbeatHoldBound: providerProxyHeartbeatHoldBound(deadlineConfiguration),
  });

  // The writer must emit only a V4 shape this build can verify.
  let mintedRecoveryCapsule: HandoffCapsuleV4 | null = null;
  const mintRecoveryCapsule = (): HandoffCapsuleV4 => {
    if (mintedRecoveryCapsule !== null) return mintedRecoveryCapsule;
    mintedRecoveryCapsule = {
      version: CURRENT_HANDOFF_CAPSULE_VERSION,
      controllerBuildSetId: coordinatorIdentity.buildSetId,
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
  let recoveryCredentialInstallState: RecoveryCredentialInstallState = { kind: 'idle' };

  const performRecoveryCredentialInstall = async (): Promise<RecoveryCredentialInstallOutcome> => {
    const inherited = deps.recoveryCapsule;
    const capsule = inherited ?? mintRecoveryCapsule();
    const operations = inherited === undefined ? [] : canonicalHandoffOperationSet(deps.recoveryOperations);
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
      proxyClient.exchange(
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
    let guardianExchange: ControlExchange;
    let reaperExchange: ControlExchange;
    let proxyExchange: ControlExchange;
    if (deps.recoveryCapsule === undefined) {
      [guardianExchange, reaperExchange, proxyExchange] = await Promise.all([
        guardianClient.exchange(
          'guardian.handoff-install.v1',
          guardianReaperInstallPayload,
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        ),
        reaperClient.exchange('reaper.handoff-install.v1', guardianReaperInstallPayload, PROXY_CONTROL_RPC_TIMEOUT_MS),
        proxyInstall(),
      ]);
    } else {
      [guardianExchange, reaperExchange] = await Promise.all([
        guardianClient.exchange(
          'guardian.handoff-install.v1',
          guardianReaperInstallPayload,
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        ),
        reaperClient.exchange('reaper.handoff-install.v1', guardianReaperInstallPayload, PROXY_CONTROL_RPC_TIMEOUT_MS),
      ]);
      const guardianOutcome = installExchangeOutcome(
        'guardian',
        'guardian.handoff-install.v1',
        guardianExchange,
        capsule.grantId,
      );
      const reaperOutcome = installExchangeOutcome(
        'reaper',
        'reaper.handoff-install.v1',
        reaperExchange,
        capsule.grantId,
      );
      if (guardianOutcome?.kind === 'refused') return guardianOutcome;
      if (reaperOutcome?.kind === 'refused') return reaperOutcome;
      if (guardianOutcome !== null) return guardianOutcome;
      if (reaperOutcome !== null) return reaperOutcome;
      proxyExchange = await proxyInstall();
    }
    const outcomes = [
      installExchangeOutcome('guardian', 'guardian.handoff-install.v1', guardianExchange, capsule.grantId),
      installExchangeOutcome('reaper', 'reaper.handoff-install.v1', reaperExchange, capsule.grantId),
      installExchangeOutcome('proxy', 'handoff.install.v1', proxyExchange, capsule.grantId),
    ];
    const refusal = outcomes.find((outcome) => outcome?.kind === 'refused');
    if (refusal !== undefined && refusal !== null) return refusal;
    const retryable = outcomes.find((outcome) => outcome?.kind === 'retryable');
    if (retryable !== undefined && retryable !== null) return retryable;
    if (inherited === undefined) {
      writeHandoffCapsuleFile(handoffCapsulePath, mintRecoveryCapsule(), {
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
      });
      deps.registerAcquisitionUndo?.({
        kind: 'recovery-capability',
        label: 'handoff capsule',
        run: () => runtime.storage.rmSync(handoffCapsulePath, { force: true }),
      });
    }
    if (inherited !== undefined && !capsuleNamesThisController(inherited)) {
      // The roles now authorize only this controller's build, so the durable half must say the same before
      // a later coordinator of this build decides whether it may dial the set.
      const currentCapsulePath = currentHandoffCapsulePathBeside(handoffCapsulePath, inherited.version);
      writeHandoffCapsuleFile(
        currentCapsulePath,
        {
          ...inherited,
          version: CURRENT_HANDOFF_CAPSULE_VERSION,
          controllerBuildSetId: coordinatorIdentity.buildSetId,
        },
        { storage: runtime.storage, uid: process.getuid?.() ?? 0 },
      );
      if (currentCapsulePath !== handoffCapsulePath) {
        const retirement = retireProviderHandoffCapsule(runtime.storage, handoffCapsulePath);
        if (retirement.kind !== 'retired') throw new Error('provider_proxy_capsule_migration_retirement_unavailable');
      }
    }
    const receipt = Object.freeze({
      kind: 'installed-recovery-credential',
      grantId: capsule.grantId,
    }) as InstalledRecoveryCredential;
    return { kind: 'installed', receipt };
  };

  const capsuleNamesThisController = (capsule: RedeemableHandoffCapsule): boolean =>
    handoffCapsuleControllerBuildSetId(capsule) === coordinatorIdentity.buildSetId;

  const untilAbort = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T | null> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return resolve(null);
      const abort = () => resolve(null);
      signal.addEventListener('abort', abort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
        },
      );
    });

  const installRecoveryCredential = async (signal: AbortSignal): Promise<RecoveryCredentialInstallOutcome> => {
    if (signal.aborted) return { kind: 'cancelled' };
    if (recoveryCredentialInstallState.kind === 'installed') {
      return { kind: 'installed', receipt: recoveryCredentialInstallState.receipt };
    }
    if (recoveryCredentialInstallState.kind === 'idle') {
      const completion = (async (): Promise<RecoveryCredentialInstallOutcome> => {
        try {
          const outcome = await performRecoveryCredentialInstall();
          recoveryCredentialInstallState =
            outcome.kind === 'installed' ? { kind: 'installed', receipt: outcome.receipt } : { kind: 'idle' };
          return outcome;
        } catch (error: unknown) {
          recoveryCredentialInstallState = { kind: 'idle' };
          throw error;
        }
      })();
      recoveryCredentialInstallState = { kind: 'installing', completion };
    }
    const completion = recoveryCredentialInstallState.completion;
    const outcome = await untilAbort(completion, signal);
    return outcome ?? { kind: 'cancelled' };
  };

  const transferExchangeOutcome = (
    role: ControllerTransferRole,
    method: 'guardian.controller-transfer.v1' | 'controller-transfer.v1',
    exchange: ControlExchange,
    expected: Readonly<{ grantId: string; attemptId: string }>,
  ): Exclude<ControllerTransferOutcome, { kind: 'authorized' | 'cancelled' }> | null => {
    if (controlMethodAvailability(exchange).kind === 'method-absent') return { kind: 'legacy-host', role };
    if (exchange.kind !== 'response') return { kind: 'retryable', incident: { role, method, exchange } };
    if (exchange.response.kind === 'refusal') {
      return {
        kind: 'refused',
        incident: { role, method, exchange: { kind: 'response', response: exchange.response } },
      };
    }
    const acknowledged = controllerTransferResultSchema.parse(exchange.response.value);
    if (acknowledged.grantId !== expected.grantId || acknowledged.attemptId !== expected.attemptId) {
      throw new Error('provider_proxy_controller_transfer_ack_mismatch');
    }
    return null;
  };

  const authorizeControllerTransfer = async (
    transfer: Readonly<{ attemptId: string; successor: ControllerBuild }>,
    signal: AbortSignal,
  ): Promise<ControllerTransferOutcome> => {
    const installation = await installRecoveryCredential(signal);
    if (installation.kind === 'cancelled') return installation;
    if (installation.kind !== 'installed') return installation;
    if (signal.aborted) return { kind: 'cancelled' };
    const params = controllerTransferParamsSchema.parse({
      grantId: installation.receipt.grantId,
      attemptId: transfer.attemptId,
      successor: transfer.successor,
      controlGeneration: PROVIDER_PROXY_CONTROL_GENERATION,
    });
    const exchanges = await untilAbort(
      Promise.all([
        guardianClient.exchange('guardian.controller-transfer.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
        proxyClient.exchange('controller-transfer.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
      ]),
      signal,
    );
    if (exchanges === null) return { kind: 'cancelled' };
    const [guardianExchange, proxyExchange] = exchanges;
    const outcomes = [
      transferExchangeOutcome('guardian', 'guardian.controller-transfer.v1', guardianExchange, params),
      transferExchangeOutcome('proxy', 'controller-transfer.v1', proxyExchange, params),
    ];
    const decisive =
      outcomes.find((outcome) => outcome?.kind === 'legacy-host') ??
      outcomes.find((outcome) => outcome?.kind === 'refused') ??
      outcomes.find((outcome) => outcome?.kind === 'retryable');
    if (decisive !== undefined && decisive !== null) return decisive;
    return { kind: 'authorized', recoveryGrantId: installation.receipt.grantId };
  };

  const registerInstalledSuccessionOperation = async (
    _credential: InstalledRecoveryCredential,
    operation: OperationIdentity,
    signal: AbortSignal,
  ): Promise<Extract<SuccessionOperationRegistrationOutcome, { kind: 'registered' | 'cancelled' }>> => {
    if (operation.proxyInstanceId !== proxyInstanceId || operation.buildSetId !== guardianIdentity.buildSetId) {
      throw new Error('Succession registration named an operation from another proxy set.');
    }
    const params = successionOperationRegisterParamsSchema.parse({ operation });
    const [guardianExchange, reaperExchange, proxyExchange] = await Promise.all([
      guardianClient.exchange('guardian.succession-register-operation.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
      reaperClient.exchange('reaper.succession-register-operation.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
      proxyClient.exchange('succession.register-operation.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
    ]);
    const guardianResult = requireControlResult('guardian.succession-register-operation.v1', guardianExchange);
    const reaperResult = requireControlResult('reaper.succession-register-operation.v1', reaperExchange);
    const proxyResult = requireControlResult('succession.register-operation.v1', proxyExchange);
    successionOperationRegisterResultSchema.parse(guardianResult);
    successionOperationRegisterResultSchema.parse(reaperResult);
    successionOperationRegisterResultSchema.parse(proxyResult);
    if (signal.aborted) return { kind: 'cancelled' };
    return { kind: 'registered' };
  };

  const registerSuccessionOperation = async (
    operation: OperationIdentity,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SuccessionOperationRegistrationOutcome> => {
    const installation = await installRecoveryCredential(signal);
    if (installation.kind !== 'installed') return installation;
    if (signal.aborted) return { kind: 'cancelled' };
    return registerInstalledSuccessionOperation(installation.receipt, operation, signal);
  };

  const controlReattachment: ProviderProxySetControlReattachment = {
    redeem: (setIdentity, signal) =>
      redeemProviderProxyControl(
        deps.recoveryCapsule ?? mintRecoveryCapsule(),
        setIdentity,
        {
          runtime,
          coordinatorIdentity,
          ...(deps.onProviderEvent === undefined ? {} : { onProviderEvent: deps.onProviderEvent }),
        },
        signal,
      ),
    promote: async (redemption, signal) => {
      const bundle = providerProxyControlRedemptionBundle(redemption);
      try {
        const promoted = createProviderProxySetAuthority({
          proxyInstanceId: bundle.proxyIdentity.proxyInstanceId,
          guardianClient: bundle.clients.guardian,
          proxyClient: bundle.clients.proxy,
          reaperClient: bundle.clients.reaper,
          guardianIdentity: bundle.guardianIdentity,
          reaperIdentity: bundle.reaperIdentity,
          proxyIdentityFields: bundle.proxyIdentity,
          heartbeats: bundle.heartbeats,
          coordinatorIdentity,
          handoffCapsulePath,
          runtime,
          recoveryCapsule: deps.recoveryCapsule ?? mintRecoveryCapsule(),
          recoveryOperations: bundle.recoveryOperations,
          operationRegistry,
          ...(deps.onProviderEvent === undefined ? {} : { onProviderEvent: deps.onProviderEvent }),
        });
        const installation = await promoted.installRecoveryCredential(signal);
        if (installation.kind === 'cancelled') {
          signal.throwIfAborted();
          throw new Error('provider_proxy_recovery_credential_install_cancelled');
        }
        return promoted;
      } catch (error: unknown) {
        closeRedeemedProviderProxyControl(redemption);
        throw error;
      }
    },
  };

  /** Only an unsent call proves the owner was never asked: every answer, refusal, timeout, and lost reply
   *  reached a control that existed at send time and must keep its own failure. */
  let controlReleased = false;

  const sendOrRefuse = (method: string, params: unknown, timeoutMs: number): Promise<ControlExchange> => {
    if (controlReleased) throw new ProviderHostOwnerTornDown();
    return proxyClient.exchange(method, params, timeoutMs);
  };

  const commitContainment = (signal: AbortSignal): Promise<ContainmentCommitOutcome> => {
    // Containment roots must come from the guardian's cumulative enforcer state, never coordinator claims.
    return commitProviderProxyGuardianContainment(
      {
        client: guardianClient,
        guardian: guardianIdentity,
        reaper: reaperIdentity,
        proxy: proxyIdentityFields,
      },
      signal,
    );
  };

  return {
    proxyInstanceId,
    get autonomousDeadline() {
      return autonomousDeadline;
    },
    controlReattachment,
    providerHosts: Object.freeze({
      list: async () => {
        const params = providerHostListParamsSchema.parse({});
        const current = controlMethodAvailability(
          await sendOrRefuse('provider-host.list.v2', params, PROXY_STATUS_RPC_TIMEOUT_MS),
        );
        if (current.kind === 'answered') {
          return providerHostListResultV2Schema.parse(requireControlResult('provider-host.list.v2', current.exchange))
            .hosts;
        }
        const legacy = await sendOrRefuse('provider-host.list.v1', params, PROXY_STATUS_RPC_TIMEOUT_MS);
        return providerHostListResultV1Schema.parse(requireControlResult('provider-host.list.v1', legacy)).hosts;
      },
      inspect: async (hostRef) => {
        const params = providerHostInspectParamsSchema.parse({ hostRef });
        const current = controlMethodAvailability(
          await sendOrRefuse('provider-host.inspect.v2', params, PROXY_STATUS_RPC_TIMEOUT_MS),
        );
        if (current.kind === 'answered') {
          const result = providerHostInspectResultV2Schema.parse(
            requireControlResult('provider-host.inspect.v2', current.exchange),
          );
          return result.state === 'matched' ? result.host : null;
        }
        const legacy = await sendOrRefuse('provider-host.inspect.v1', params, PROXY_STATUS_RPC_TIMEOUT_MS);
        const result = providerHostInspectResultV1Schema.parse(
          requireControlResult('provider-host.inspect.v1', legacy),
        );
        return result.state === 'matched' ? result.host : null;
      },
      terminalEviction: async (hostRef) => {
        const params = providerHostEvictParamsSchema.parse({ hostRef });
        const current = controlMethodAvailability(
          await sendOrRefuse('provider-host.terminal-eviction.v2', params, PROXY_STATUS_RPC_TIMEOUT_MS),
        );
        if (current.kind === 'method-absent') return null;
        const result = providerHostTerminalEvictionResultV2Schema.parse(
          requireControlResult('provider-host.terminal-eviction.v2', current.exchange),
        );
        return result.state === 'matched' ? result.disposition : null;
      },
      evict: async (hostRef) => {
        const params = providerHostEvictParamsSchema.parse({ hostRef });
        return providerHostEvictResultV2Schema.parse(
          requireControlResult(
            'provider-host.evict.v2',
            await sendOrRefuse('provider-host.evict.v2', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
          ),
        );
      },
    }),
    installRecoveryCredential,
    authorizeControllerTransfer,
    registerSuccessionOperation,
    commitContainment,
    // The coarse compatibility result must not translate either unresolved outcome into completion.
    stopAndReap: async (signal) => {
      const outcome = await commitContainment(signal);
      return outcome.kind === 'containment-absent'
        ? { disappearanceReceipt: outcome.disappearanceReceipt }
        : { unconfirmed: outcome.error };
    },
    stopHeartbeats: () => {
      heartbeats.proxy.stop();
      heartbeats.guardian.stop();
      heartbeats.reaper.stop();
    },
    initiateControlClose: async () => {
      controlReleased = true;
      proxyClient.close();
      guardianClient.close();
      reaperClient.close();
    },
  };
}
