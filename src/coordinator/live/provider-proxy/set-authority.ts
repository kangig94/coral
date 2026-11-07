import { parseProviderProxyRoleResult, ProviderProxyRoleControlUnavailableError } from './role-control.js';
import type { ProviderProxyRole } from '../../services/provider-proxy-authority-fault.js';
import { z } from 'zod';

import {
  handoffCapsuleV4Schema,
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
import {
  ProviderProxySetInheritanceCorruptionError,
  type ProviderProxySetIdentity,
} from '../../services/provider-proxy-set/identity.js';
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

declare const installedRecoveryCredentialBrand: unique symbol;
type InstalledRecoveryCredentialBrand = Readonly<{ [installedRecoveryCredentialBrand]: true }>;

export type InstalledRecoveryCredential = Readonly<{
  kind: 'installed-recovery-credential';
  grantId: string;
}> &
  InstalledRecoveryCredentialBrand;

type RecoveryCredentialInstallRole = 'guardian' | 'reaper' | 'proxy';
type ControlInstallIncidentExchange = ControlExchange;

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
  if (exchange.kind === 'not-sent' && exchange.cause === 'encode-failed') {
    throw new ProviderProxySetInheritanceCorruptionError(
      'recovery_contract_violation',
      'Recovery credential install parameters could not be encoded.',
      { cause: exchange.error },
    );
  }
  if (exchange.kind !== 'response') {
    return { kind: 'retryable', incident: { role, method, exchange } };
  }
  if (exchange.response.kind === 'refusal') {
    return {
      kind: 'refused',
      incident: { role, method, exchange },
    };
  }
  const acknowledgement = handoffInstallAckSchema.safeParse(exchange.response.value);
  if (!acknowledgement.success) return { kind: 'retryable', incident: { role, method, exchange } };
  if (acknowledgement.data.grantId !== expectedGrantId) {
    throw new ProviderProxySetInheritanceCorruptionError(
      'recovery_credential_identity_disagreement',
      'provider_proxy_handoff_install_ack_grant_mismatch',
    );
  }
  return null;
}

function requireControlResult<T>(
  method: string,
  exchange: ControlExchange,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  role: ProviderProxyRole = 'proxy',
): T {
  if (exchange.kind === 'response') {
    if (exchange.response.kind === 'result') return parseProviderProxyRoleResult(role, method, schema, exchange);
    throw exchange.response.error;
  }
  if (exchange.kind === 'not-sent' && exchange.cause === 'encode-failed') throw exchange.error;
  throw new ProviderProxyRoleControlUnavailableError(
    { kind: 'role-exchange-unavailable', role, method, exchange },
    { cause: exchange.error },
  );
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
function createProviderProxyHostControl(proxyClient: ControlClient): {
  providerHosts: ProviderProxySetRecoveryAuthority['providerHosts'];
  release: () => void;
} {
  /** Only an unsent call proves the owner was never asked: every answer, refusal, timeout, and lost reply
   *  reached a control that existed at send time and must keep its own failure. */
  const controlState = { released: false };

  const sendOrRefuse = (method: string, params: unknown, timeoutMs: number): Promise<ControlExchange> => {
    if (controlState.released) throw new ProviderHostOwnerTornDown();
    return proxyClient.exchange(method, params, timeoutMs);
  };

  const providerHosts: ProviderProxySetRecoveryAuthority['providerHosts'] = Object.freeze<
    ProviderProxySetRecoveryAuthority['providerHosts']
  >({
    list: async () => {
      const params = providerHostListParamsSchema.parse({});
      const current = controlMethodAvailability(
        await sendOrRefuse('provider-host.list.v2', params, PROXY_STATUS_RPC_TIMEOUT_MS),
      );
      if (current.kind === 'answered') {
        return requireControlResult('provider-host.list.v2', current.exchange, providerHostListResultV2Schema).hosts;
      }
      const legacy = await sendOrRefuse('provider-host.list.v1', params, PROXY_STATUS_RPC_TIMEOUT_MS);
      return requireControlResult('provider-host.list.v1', legacy, providerHostListResultV1Schema).hosts;
    },
    inspect: async (hostRef) => {
      const params = providerHostInspectParamsSchema.parse({ hostRef });
      const current = controlMethodAvailability(
        await sendOrRefuse('provider-host.inspect.v2', params, PROXY_STATUS_RPC_TIMEOUT_MS),
      );
      if (current.kind === 'answered') {
        const result = requireControlResult(
          'provider-host.inspect.v2',
          current.exchange,
          providerHostInspectResultV2Schema,
        );
        return result.state === 'matched' ? result.host : null;
      }
      const legacy = await sendOrRefuse('provider-host.inspect.v1', params, PROXY_STATUS_RPC_TIMEOUT_MS);
      const result = requireControlResult('provider-host.inspect.v1', legacy, providerHostInspectResultV1Schema);
      return result.state === 'matched' ? result.host : null;
    },
    terminalEviction: async (hostRef) => {
      const params = providerHostEvictParamsSchema.parse({ hostRef });
      const current = controlMethodAvailability(
        await sendOrRefuse('provider-host.terminal-eviction.v2', params, PROXY_STATUS_RPC_TIMEOUT_MS),
      );
      if (current.kind === 'method-absent') return null;
      const result = requireControlResult(
        'provider-host.terminal-eviction.v2',
        current.exchange,
        providerHostTerminalEvictionResultV2Schema,
      );
      return result.state === 'matched' ? result.disposition : null;
    },
    evict: async (hostRef) => {
      const params = providerHostEvictParamsSchema.parse({ hostRef });
      return requireControlResult(
        'provider-host.evict.v2',
        await sendOrRefuse('provider-host.evict.v2', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
        providerHostEvictResultV2Schema,
      );
    },
  });
  return {
    providerHosts,
    release: () => {
      controlState.released = true;
    },
  };
}

function createProviderProxyControlReattachment(
  deps: ProviderProxySetAuthorityDependencies,
  mintRecoveryCapsule: () => HandoffCapsuleV4,
): ProviderProxySetControlReattachment {
  const { runtime, coordinatorIdentity, handoffCapsulePath, operationRegistry } = deps;
  return {
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
}

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

function transferExchangeOutcome(
  role: ControllerTransferRole,
  method: 'guardian.controller-transfer.v1' | 'controller-transfer.v1',
  exchange: ControlExchange,
  expected: Readonly<{ grantId: string; attemptId: string }>,
): Exclude<ControllerTransferOutcome, { kind: 'authorized' | 'cancelled' }> | null {
  if (controlMethodAvailability(exchange).kind === 'method-absent') return { kind: 'legacy-host', role };
  if (exchange.kind !== 'response') return { kind: 'retryable', incident: { role, method, exchange } };
  if (exchange.response.kind === 'refusal') {
    return {
      kind: 'refused',
      incident: { role, method, exchange },
    };
  }
  const parsed = controllerTransferResultSchema.safeParse(exchange.response.value);
  if (!parsed.success) return { kind: 'retryable', incident: { role, method, exchange } };
  const acknowledged = parsed.data;
  if (acknowledged.grantId !== expected.grantId || acknowledged.attemptId !== expected.attemptId) {
    throw new Error('provider_proxy_controller_transfer_ack_mismatch');
  }
  return null;
}

function createProviderProxySuccessionMethods(
  deps: ProviderProxySetAuthorityDependencies,
  installRecoveryCredential: ProviderProxySetRecoveryAuthority['installRecoveryCredential'],
): Pick<ProviderProxySetRecoveryAuthority, 'authorizeControllerTransfer' | 'registerSuccessionOperation'> {
  const { guardianClient, proxyClient, reaperClient, proxyInstanceId, guardianIdentity } = deps;
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
    requireControlResult(
      'guardian.succession-register-operation.v1',
      guardianExchange,
      successionOperationRegisterResultSchema,
      'guardian',
    );
    requireControlResult(
      'reaper.succession-register-operation.v1',
      reaperExchange,
      successionOperationRegisterResultSchema,
      'reaper',
    );
    requireControlResult(
      'succession.register-operation.v1',
      proxyExchange,
      successionOperationRegisterResultSchema,
      'proxy',
    );
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

  return { authorizeControllerTransfer, registerSuccessionOperation };
}

function recoveryInstallParams<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ProviderProxySetInheritanceCorruptionError(
      'recovery_contract_violation',
      'Recovery credential install parameters failed internal validation.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function writeRecoveryCapsule(path: string, capsule: HandoffCapsuleV4, runtime: Pick<Runtime, 'storage'>): void {
  const parsed = handoffCapsuleV4Schema.safeParse(capsule);
  if (!parsed.success) {
    throw new ProviderProxySetInheritanceCorruptionError(
      'recovery_contract_violation',
      'Recovery credential capsule failed internal validation.',
      { cause: parsed.error },
    );
  }
  writeHandoffCapsuleFile(path, parsed.data, { storage: runtime.storage, uid: process.getuid?.() ?? 0 });
}

async function performRecoveryCredentialInstall(
  deps: ProviderProxySetAuthorityDependencies,
  mintRecoveryCapsule: () => HandoffCapsuleV4,
): Promise<RecoveryCredentialInstallOutcome> {
  const { coordinatorIdentity, guardianClient, reaperClient, proxyClient, handoffCapsulePath, runtime } = deps;
  const inherited = deps.recoveryCapsule;
  const capsule = inherited ?? mintRecoveryCapsule();
  const operations = inherited === undefined ? [] : canonicalHandoffOperationSet(deps.recoveryOperations);
  const secretSha256 = handoffSecretDigest(capsule.secret);
  const guardianReaperInstallPayload = recoveryInstallParams(guardianReaperHandoffInstallParamsSchema, {
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
      recoveryInstallParams(proxyHandoffInstallParamsSchema, {
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
    writeRecoveryCapsule(handoffCapsulePath, mintRecoveryCapsule(), runtime);
    deps.registerAcquisitionUndo?.({
      kind: 'recovery-capability',
      label: 'handoff capsule',
      run: () => runtime.storage.rmSync(handoffCapsulePath, { force: true }),
    });
  }
  if (inherited !== undefined && handoffCapsuleControllerBuildSetId(inherited) !== coordinatorIdentity.buildSetId) {
    const currentCapsulePath = currentHandoffCapsulePathBeside(handoffCapsulePath, inherited.version);
    writeRecoveryCapsule(
      currentCapsulePath,
      {
        ...inherited,
        version: CURRENT_HANDOFF_CAPSULE_VERSION,
        controllerBuildSetId: coordinatorIdentity.buildSetId,
      },
      runtime,
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
}

function createRecoveryCapsuleMint(
  deps: ProviderProxySetAuthorityDependencies,
  deadlineConfiguration: Readonly<{ orphanTimeoutMs: number; teardownReserveMs: number }>,
): () => HandoffCapsuleV4 {
  const { coordinatorIdentity, runtime, guardianIdentity, reaperIdentity, proxyIdentityFields } = deps;
  // The writer must emit only a V4 shape this build can verify.
  const state: { mintedRecoveryCapsule: HandoffCapsuleV4 | null } = { mintedRecoveryCapsule: null };
  return (): HandoffCapsuleV4 => {
    if (state.mintedRecoveryCapsule !== null) return state.mintedRecoveryCapsule;
    state.mintedRecoveryCapsule = {
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
    return state.mintedRecoveryCapsule;
  };
}

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
    runtime,
  } = deps;

  const deadlineConfiguration = deps.recoveryCapsule ?? resolveProviderProxyDeadlineConfiguration(runtime.env);
  const autonomousDeadline: ProviderProxyAutonomousDeadline = Object.freeze({
    orphanTimeoutMs: deadlineConfiguration.orphanTimeoutMs,
    adoptionWindowMs: providerProxyAdoptionWindowMs(deadlineConfiguration),
    heartbeatHoldBound: providerProxyHeartbeatHoldBound(deadlineConfiguration),
  });

  const mintRecoveryCapsule = createRecoveryCapsuleMint(deps, deadlineConfiguration);
  let recoveryCredentialInstallState: RecoveryCredentialInstallState = { kind: 'idle' };

  const installRecoveryCredential = async (signal: AbortSignal): Promise<RecoveryCredentialInstallOutcome> => {
    if (signal.aborted) return { kind: 'cancelled' };
    if (recoveryCredentialInstallState.kind === 'installed') {
      return { kind: 'installed', receipt: recoveryCredentialInstallState.receipt };
    }
    if (recoveryCredentialInstallState.kind === 'idle') {
      const completion = (async (): Promise<RecoveryCredentialInstallOutcome> => {
        try {
          const outcome = await performRecoveryCredentialInstall(deps, mintRecoveryCapsule);
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

  const { authorizeControllerTransfer, registerSuccessionOperation } = createProviderProxySuccessionMethods(
    deps,
    installRecoveryCredential,
  );

  const controlReattachment = createProviderProxyControlReattachment(deps, mintRecoveryCapsule);

  const { providerHosts, release: releaseHostControl } = createProviderProxyHostControl(proxyClient);

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
    providerHosts,
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
      releaseHostControl();
      proxyClient.close();
      guardianClient.close();
      reaperClient.close();
    },
  };
}
