import { InvalidArgumentError, type Command } from 'commander';

import {
  decodeProviderProxySetAddress,
  encodeProviderProxySetAddress,
  type ProviderProxySetAddress,
} from '../../provider-proxy/set-address.js';
import {
  HandoffRunError,
  liveHandoffResultObligation,
  consumeHandoffRunResult,
  runHandoff,
  type HandoffPublicationIncident,
  type LiveHandoffResult,
  type NonEmptyReadonlyArray,
} from '../../coordinator/handoff-routing/runner.js';
import {
  parseHandoffRoutingInvocationId,
  type HandoffRepairOperation,
} from '../../coordinator/handoff-routing/repair-operation.js';
import {
  HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY,
  handoffRoutingStatusExitContribution,
  handoffRoutingStatusStoreSchema,
  readHandoffRoutingStatusWithOwnerObservations,
  resolveHandoffRoutingStatus,
  type HandoffRoutingResolveRequest,
  type HandoffRoutingResolveResult,
  type HandoffRoutingStatusReadResult,
} from '../../coordinator/handoff-routing/status.js';
import type {
  HandoffRoutingStatusDiscardResult,
  HandoffRoutingStatusMaintenanceRefusal,
  HandoffRoutingStatusQuarantineClearResult,
} from '../../coordinator/handoff-routing/status-operator.js';
import { resolveBuildFlavor, type BuildFlavor } from '../../infra/build-flavor.js';
import { readBuildFlavor } from '../../infra/bundle-manifest.js';
import { assertNever } from '../../infra/error-format.js';
import { BackendUnreachableError } from '../../infra/http-errors.js';
import { isRecord } from '../../infra/json.js';
import { handoffRoutingStatusPathForRunDir } from '../../infra/path/index.js';
import { isSafeKbCommitId } from '../../kb/commit-quarantine.js';
import {
  decodeRecoveryQuarantineKey,
  encodeRecoveryQuarantineKey,
  RecoveryQuarantineStore,
  type RecoveryQuarantineListEntry,
} from '../../recovery/quarantine.js';
import { unreadableProviderOperationSubject } from '../../recovery/unreadable-provider-operation.js';
import {
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryQuarantineClearRequest,
  type RecoveryQuarantineClearResult,
} from '../../recovery/source-registry.js';
import type { Runtime } from '../../runtime/ports.js';
import { createRealRuntime } from '../../runtime/real.js';
import {
  formatLegacyGenerationIgnoredNotice,
  inspectGenerationReadiness,
  type GenerationReadiness,
} from '../../store/generation-mutation-coordination.js';
import { currentCoralStoreFormat } from '../../store-format.js';
import { classifyStoreFile, type Database } from '../../store/db.js';
import { openReadOnlyStoreDatabase } from '../../store/read-port.js';
import {
  attributeUnreadableProviderOperations,
  readProviderOperations,
} from '../../store/provider-operation-journal.js';
import {
  handoffRoutingStatusGeneration,
  listHandoffRoutingStoreQuarantines,
  MAX_HANDOFF_ROUTING_STATUS_QUARANTINES,
  type HandoffRoutingStatusQuarantineList,
} from '../../store/handoff-routing-status-store/index.js';
import { getBackendStatusFull, type BackendStatusFull } from '../../transport/http/backend/status.js';
import { shutdownBackend, type ShutdownReason } from '../../transport/http/backend/shutdown.js';

import { TOOL_TIMEOUT_MS } from '../../transport/http/sse.js';
import { childPrincipalAuthFromEnv, childPrincipalAuthOptions } from '../../transport/ipc/child-principal-auth.js';
import { IpcRpcError } from '../../transport/ipc/client.js';
import type { IpcClient } from '../../transport/ipc/client.js';
import { ensure } from '../../transport/ipc/ensure.js';
import {
  recoveryQuarantineClearRequestSchema,
  recoveryQuarantineClearResultSchema,
  providerHostEvictResponseSchema,
  providerHostInspectResponseSchema,
  providerHostListRequestSchema,
  providerHostListResponseSchema,
  providerHostSelectorRequestSchema,
  providerProxySetContainRequestSchema,
  providerProxySetContainResponseSchema,
  unreadableProviderOperationDiscardRequestSchema,
  unreadableProviderOperationDiscardResultSchema,
  type ProviderHostEvictResponse,
  type ProviderHostInspectResponse,
  type ProviderHostListResponse,
  type ProviderHostSelectorRequest,
  type ProviderProxySetContainRequest,
  type ProviderProxySetContainResponse,
} from '../../transport/rpc/catalog.js';
import type {
  UnreadableProviderOperationDiscardRequest,
  UnreadableProviderOperationDiscardResult,
} from '../../recovery/unreadable-provider-operation.js';
import { decodeHostRef, encodeHostRef } from '../../providers/host-ref-codec.js';
import { getPluginRoot } from '../dispatch.js';
import { emitError } from '../emit.js';
import { errorCodeToExit } from '../errors.js';
import { renderHandoffNotice, renderHandoffPublicationIncidents } from '../handoff-notice.js';
import {
  formatBackendStatus,
  formatHandoffStartupObservationAborted,
  formatHandoffRoutingResolveResult,
  formatRecoveryQuarantineClear,
  formatRecoveryQuarantineList,
  formatUnreadableProviderOperationDiscard,
  formatProviderProxySetContainResult,
  formatShutdown,
  RECOVERY_REVISION_FINGERPRINT_PREFIX,
  RECOVERY_REVISION_UNTIL_CLEARED,
} from '../format/backend.js';
import { formatStoreResetList, formatStoreResetReport } from '../format/store-reset.js';
import { clearHandoffRoutingStatusQuarantine, discardHandoffRoutingStatus } from '../routing-status-discard.js';

/**
 * What each `backend shutdown` refusal means to a script, as an exit code.
 *
 * `docs/configuration.md` tells operators to run `backend shutdown` before `store-reset discard` and
 * `kb-commit quarantine`, so the question this code answers is "may I proceed to destroy state?" — and there
 * are three answers, not two. Exit `0` is "it is stopping". Exit `1` is a settled refusal: the coordinator
 * answered and declined, or this nested child is not permitted to ask. Exit `75` is the third — this run has
 * no shutdown verdict, so a caller must neither proceed nor read the outcome as failure.
 *
 * `75` rather than `2`: `2` is `invalid_usage` (`docs/cli-errors.md`), so a
 * script could not tell "you called this wrong" from "I could not observe the daemon". `75` is already this
 * CLI's "not concluded" code across `wait jobs` and transient errors. The reason-specific remediation decides
 * whether retrying can change the evidence.
 *
 * A `Record` rather than a set of the undetermined ones. A set answers only for its members and defaults the
 * rest, so a new `ShutdownReason` silently inherits "settled" — the exact shape of the collapse this table
 * exists to prevent. Here it fails to compile until someone decides, which is the same mechanism
 * `formatShutdown`'s `assertNever` provides for the message.
 */
export const SHUTDOWN_REFUSAL_EXIT_CODES: Readonly<Record<ShutdownReason, 1 | 75>> = {
  // Observed: the coordinator answered and declined. It is running, and this run knows it.
  capability_rejected: 1,
  // Observed: this process refused to act, before asking anything. Retrying from the same child repeats it.
  nested_child: 1,
  // Not observed: a refused connection proves nothing was listening on that exact socket at that moment, but
  // the recorded pid was never established absent before this request was sent (an absent pid short-circuits
  // to `recorded_process_absent` first). A coordinator's HTTP listener also closes at the top of its drain
  // while its process, confirmed alive, keeps running.
  socket_refused: 75,
  // Not observed: the record could not be read, the request never completed, or a response arrived but did not
  // resolve the question either way. A coordinator may be serving.
  unreadable_record: 75,
  refused_by_response: 75,
  no_response: 75,
  // Not observed: no record and no current socket do not exclude a v0.10.9 coordinator at an unenumerated
  // fallback that has not published its record yet.
  no_record: 75,
  // Not observed: an absent recorded pid establishes only that record's process is gone. The record may be
  // stale while a different coordinator has bound its socket but not published its own record yet.
  recorded_process_absent: 75,
  // Not observed: the coordinator's own IPC socket file exists with no record written yet, which a coordinator
  // mid-boot and a stale socket a killed one left behind both produce, indistinguishably.
  no_record_socket_present: 75,
};

/**
 * Every daemon status must be assigned an explicit exit contribution.
 *
 * `0` reports only that this read completed and must not authorize mutation. `75` marks evidence that requires
 * operator resolution or another observation before startup can proceed.
 */
export const BACKEND_STATUS_EXIT_CODES: Readonly<Record<BackendStatusFull['status'], 0 | 75>> = {
  ok: 0,
  no_record_no_socket: 0,
  recorded_process_absent: 0,
  foreign_coordinator: 75,
  shutting_down: 0,
  unauthorized: 0,
  recent_failure: 0,
  undecodable_record: 75,
  unreachable: 75,
  no_record_socket_present: 75,
};

type HandoffRoutingResolveKindWithoutPublication = Exclude<
  HandoffRoutingResolveResult['kind'],
  'artifact-refused' | 'not-published' | 'commit-outcome-unknown'
>;
type HandoffRoutingNotPublishedCause = Extract<HandoffRoutingResolveResult, { kind: 'not-published' }>['cause'];

export const HANDOFF_ROUTING_RESOLVE_EXIT_CODES: Readonly<
  Record<HandoffRoutingResolveKindWithoutPublication, 0 | 1 | 75>
> = {
  resolved: 0,
  'acknowledged-capacity-eviction': 0,
  'already-terminal': 0,
  stale: 1,
  'live-owner': 1,
  'unauthorized-unobservable': 75,
  'status-unavailable': 75,
};

export const HANDOFF_ROUTING_NOT_PUBLISHED_EXIT_CODES: Readonly<Record<HandoffRoutingNotPublishedCause, 70 | 75>> = {
  contended: 75,
  'generation-maintenance': 75,
  'capacity-exhausted': 75,
  'io-failed': 75,
  'storage-corrupt': 75,
  'invalid-record': 70,
  'rejected-transition': 75,
  'coordination-unavailable': 75,
};

export const PROVIDER_PROXY_SET_CONTAIN_EXIT_CODES: Readonly<
  Record<ProviderProxySetContainResponse['kind'], 0 | 1 | 75>
> = {
  contained: 0,
  abandoned: 0,
  'unattributable-group-abandoned': 0,
  'set-not-found': 1,
  'not-held': 1,
  'deadline-pending': 75,
  'authorization-stale': 75,
  'enforcer-alive': 75,
  'enforcer-unobservable': 75,
  'recorded-group-unattributable': 75,
  'store-unreadable': 75,
};

export const UNREADABLE_PROVIDER_OPERATION_DISCARD_EXIT_CODES: Readonly<
  Record<UnreadableProviderOperationDiscardResult['kind'], 0 | 1 | 75>
> = {
  discarded: 0,
  absent: 1,
  readable: 1,
  'revision-mismatch': 75,
  'quarantine-not-found': 75,
  owned: 75,
};

function providerProxySetContainExitCode(result: ProviderProxySetContainResponse): 0 | 1 | 75 {
  if (
    (result.kind === 'contained' || result.kind === 'abandoned' || result.kind === 'unattributable-group-abandoned') &&
    result.claimDischarge.kind !== 'completed'
  ) {
    return 75;
  }
  return PROVIDER_PROXY_SET_CONTAIN_EXIT_CODES[result.kind];
}

function formatProviderProxySetContainNoVerdict(
  result: Exclude<ProviderProxySetContainCommandResult, ProviderProxySetContainResponse>,
): string {
  const token = encodeProviderProxySetAddress(result.setIdentity);
  const kind = result.kind;
  switch (kind) {
    case 'unsupported-coordinator':
      return [
        `No containment verdict for ${token}: this coordinator does not support coordinator.provider_proxy_set.contain.`,
        'Observed: the coordinator rejected the method before accepting a containment operation.',
        'Not observed: enforcer state or recorded-target state.',
        'Effect: no process signal was sent and no representation release was started.',
        'Next step: upgrade or restart into this Coral build, then run coral-cli backend status before retrying the exact token.',
      ].join('\n');
    case 'coordinator-draining':
      return [
        `No containment verdict for ${token}: the coordinator is shutting down.`,
        'Observed: the coordinator refused the request before dispatch while draining.',
        'Not observed: enforcer state or recorded-target state.',
        'Effect: no process signal was sent and no representation release was started.',
        'Next step: wait for the successor coordinator, then run coral-cli backend status before retrying the exact token.',
      ].join('\n');
    case 'unsupported-coordinator-result':
      return [
        `No containment verdict for ${token}: this build does not understand the coordinator's containment result.`,
        'Observed: the coordinator returned a response that this CLI could not decode.',
        'Not observed: whether recorded targets were signalled or Coral started representation release.',
        'Effect: unknown; a process signal or representation release may already have happened.',
        'Next step: upgrade this CLI or converge on one Coral build, then run coral-cli backend status before any retry.',
      ].join('\n');
    case 'timeout':
      return [
        `No containment verdict for ${token}: the coordinator did not answer before the deadline.`,
        'Observed: the bounded request deadline expired without a response.',
        'Not observed: whether recorded targets were signalled or Coral started representation release.',
        'Effect: unknown; a process signal or representation release may already have happened.',
        'Next step: run coral-cli backend status before deciding whether to retry the exact token.',
      ].join('\n');
    default:
      return assertNever(kind);
  }
}

function formatUnreadableProviderOperationDiscardNoVerdict(
  result: Exclude<UnreadableProviderOperationDiscardCommandResult, UnreadableProviderOperationDiscardResult>,
): string {
  const coordinate =
    `key=${encodeRecoveryQuarantineKey(result.key)} ` +
    `revision=${JSON.stringify(`${RECOVERY_REVISION_FINGERPRINT_PREFIX}${result.revision}`)}`;
  const kind = result.kind;
  switch (kind) {
    case 'unsupported-coordinator':
      return [
        `No discard verdict for ${coordinate}: this coordinator does not support coordinator.recovery_quarantine.discard_provider_operation.`,
        'Observed: the coordinator rejected the method before accepting a discard operation.',
        'Not observed: raw-row contents or quarantine state.',
        'Effect: no raw row, due pointer, or quarantine evidence was removed.',
        'Next step: upgrade or restart into this Coral build, then run coral-cli backend recovery-quarantine list before retrying only a currently printed command.',
      ].join('\n');
    case 'coordinator-draining':
      return [
        `No discard verdict for ${coordinate}: the coordinator is shutting down.`,
        'Observed: the coordinator refused the request before dispatch while draining.',
        'Not observed: raw-row contents or quarantine state.',
        'Effect: no raw row, due pointer, or quarantine evidence was removed.',
        'Next step: wait for the successor coordinator, then run coral-cli backend recovery-quarantine list before deciding whether to retry.',
      ].join('\n');
    case 'unsupported-coordinator-result':
      return [
        `No discard verdict for ${coordinate}: this CLI does not understand the coordinator's discard response.`,
        'Observed: the coordinator returned a response that this CLI could not decode.',
        'Not observed: whether the exact raw row, due pointers, and quarantine evidence still exist.',
        'Effect: unknown; the destructive discard may already have completed.',
        'Next step: upgrade this CLI or converge on one Coral build, then run coral-cli backend recovery-quarantine list and coral-cli backend status before any retry.',
      ].join('\n');
    case 'timeout':
      return [
        `No discard verdict for ${coordinate}: the coordinator did not answer before the deadline.`,
        'Observed: the bounded request deadline expired without a response.',
        'Not observed: whether the exact raw row, due pointers, and quarantine evidence still exist.',
        'Effect: unknown; the destructive discard may already have completed.',
        'Next step: run coral-cli backend recovery-quarantine list and coral-cli backend status before deciding whether to retry.',
      ].join('\n');
    default:
      return assertNever(kind);
  }
}

function handoffPublicationIncidentExitContribution(incident: HandoffPublicationIncident): 70 | 75 {
  switch (incident.kind) {
    case 'not-published':
      return HANDOFF_ROUTING_NOT_PUBLISHED_EXIT_CODES[incident.cause];
    case 'artifact-refused':
    case 'commit-outcome-unknown':
    case 'refused':
      return 75;
    default:
      return assertNever(incident);
  }
}

function handoffRoutingResolveExitCode(result: HandoffRoutingResolveResult): 0 | 1 | 70 | 75 {
  if (result.kind === 'not-published') return HANDOFF_ROUTING_NOT_PUBLISHED_EXIT_CODES[result.cause];
  if (result.kind === 'artifact-refused' || result.kind === 'commit-outcome-unknown') return 75;
  return HANDOFF_ROUTING_RESOLVE_EXIT_CODES[result.kind];
}

type BackendStatusLocalExitContribution = 0 | 70 | 75;

const BACKEND_STATUS_LOCAL_EXIT_PRECEDENCE: Readonly<Record<BackendStatusLocalExitContribution, number>> = {
  0: 0,
  75: 1,
  70: 2,
};

function combineBackendStatusLocalExitContributions(
  contributions: NonEmptyReadonlyArray<BackendStatusLocalExitContribution>,
): BackendStatusLocalExitContribution {
  return contributions.reduce((selected, candidate) =>
    BACKEND_STATUS_LOCAL_EXIT_PRECEDENCE[candidate] > BACKEND_STATUS_LOCAL_EXIT_PRECEDENCE[selected]
      ? candidate
      : selected,
  );
}

export function handoffPublicationIncidentsExitContribution(
  incidents: readonly HandoffPublicationIncident[],
): 0 | 70 | 75 {
  const contributions: NonEmptyReadonlyArray<BackendStatusLocalExitContribution> = [
    0,
    ...incidents.map(handoffPublicationIncidentExitContribution),
  ];
  return combineBackendStatusLocalExitContributions(contributions);
}

import { quarantineKbCommitLocal } from '../kb-commit-quarantine.js';
import type { StoreResetTarget } from '../../store/operator-store-reset.js';
import {
  boundStoreResetCliError,
  discardStoreResetLocal,
  listStoreResetIncidentsLocal,
  reportStoreResetIncidentLocal,
} from '../store-reset.js';

function providerProxySetNoVerdictExitContribution(status: BackendStatusFull): 0 | 75 {
  if (status.status !== 'ok') return 0;
  return status.health.skippedProviderProxySetRows > 0 ||
    (status.health.diagnostics?.providerProxySets?.length ?? 0) > 0
    ? 75
    : 0;
}

const OFFLINE_OPERATOR_FLAVOR_HELP =
  'State flavor (prod or dev); required because the daemon that normally supplies it is down';
const STORE_RESET_EVIDENCE_WARNING =
  'Quarantined store-reset evidence is diagnostic-only and cannot restore active state.\n';

export interface StoreResetCommandOperations {
  list(target: StoreResetTarget): ReturnType<typeof listStoreResetIncidentsLocal>;
  report(target: StoreResetTarget, incidentId: string): ReturnType<typeof reportStoreResetIncidentLocal>;
  discard(target: StoreResetTarget, flavor: BuildFlavor): ReturnType<typeof discardStoreResetLocal>;
}

export interface KbCommitCommandOperations {
  quarantine(
    flavor: BuildFlavor,
    commitId: string,
  ): Promise<{ readonly commitId: string; readonly quarantineDir: string }>;
}

export interface BackendStatusCommandOperations {
  inspectReadiness(): GenerationReadiness;
  getStatus(): Promise<BackendStatusFull>;
  getLiveHandoffResult(): LiveHandoffResult | null;
  getRoutingStatus(): Promise<HandoffRoutingStatusReadResult>;
}

export interface HandoffRoutingStatusCommandOperations {
  resolve(request: HandoffRoutingResolveRequest): Promise<HandoffRoutingResolveResult>;
  discard(): HandoffRoutingStatusDiscardResult | Promise<HandoffRoutingStatusDiscardResult>;
}

export interface HandoffRoutingStatusQuarantineCommandOperations {
  list(): HandoffRoutingStatusQuarantineList;
  clear(quarantineId: string): Promise<HandoffRoutingStatusQuarantineClearResult>;
}

export interface RecoveryQuarantineCommandOperations {
  list(): readonly RecoveryQuarantineListEntry[];
  clear(request: RecoveryQuarantineClearRequest): Promise<RecoveryQuarantineClearResult>;
  discardProviderOperation?(
    request: UnreadableProviderOperationDiscardRequest,
  ): Promise<UnreadableProviderOperationDiscardCommandResult>;
}

/** A discard verdict or a requested-coordinate no-verdict from the coordinator boundary. */
export type UnreadableProviderOperationDiscardCommandResult =
  | UnreadableProviderOperationDiscardResult
  | (UnreadableProviderOperationDiscardRequest &
      Readonly<{
        kind: 'unsupported-coordinator' | 'coordinator-draining' | 'unsupported-coordinator-result' | 'timeout';
      }>);

export interface ProviderHostCommandOperations {
  list(): Promise<ProviderHostListResponse>;
  inspect(request: ProviderHostSelectorRequest): Promise<ProviderHostInspectResponse>;
  evict(request: ProviderHostSelectorRequest): Promise<ProviderHostEvictResponse>;
}

type ProviderProxySetContainNoVerdictKind =
  | 'unsupported-coordinator'
  | 'unsupported-coordinator-result'
  | 'coordinator-draining'
  | 'timeout';

const PROVIDER_PROXY_SET_CONTAIN_NO_VERDICT_KINDS: ReadonlySet<string> = new Set([
  'unsupported-coordinator',
  'unsupported-coordinator-result',
  'coordinator-draining',
  'timeout',
] satisfies readonly ProviderProxySetContainNoVerdictKind[]);

/** A decoded containment verdict or a named reason this CLI cannot establish one. */
export type ProviderProxySetContainCommandResult =
  | ProviderProxySetContainResponse
  | Readonly<{ kind: ProviderProxySetContainNoVerdictKind; setIdentity: ProviderProxySetAddress }>;

/** Narrows the CLI-only outcomes, whose shared union discriminant the compiler cannot exclude member-wise. */
function isProviderProxySetContainNoVerdict(
  result: ProviderProxySetContainCommandResult,
): result is Readonly<{ kind: ProviderProxySetContainNoVerdictKind; setIdentity: ProviderProxySetAddress }> {
  return PROVIDER_PROXY_SET_CONTAIN_NO_VERDICT_KINDS.has(result.kind);
}

export interface ProviderProxySetCommandOperations {
  contain(request: ProviderProxySetContainRequest): Promise<ProviderProxySetContainCommandResult>;
}

export type BackendCommandOperations = Readonly<{
  storeReset?: StoreResetCommandOperations;
  kbCommit?: KbCommitCommandOperations;
  backendStatus?: BackendStatusCommandOperations;
  routingStatus?: HandoffRoutingStatusCommandOperations;
  routingStatusQuarantine?: HandoffRoutingStatusQuarantineCommandOperations;
  recoveryQuarantine?: RecoveryQuarantineCommandOperations;
  providerHosts?: ProviderHostCommandOperations;
  providerProxySets?: ProviderProxySetCommandOperations;
}>;

function routingStatusPath(runtime: Runtime): string {
  return handoffRoutingStatusPathForRunDir(
    runtime.paths.coral.coordinator.runDir,
    handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema()),
  );
}

export function createBackendStatusCommandOperations(
  getLiveHandoffResult: BackendStatusCommandOperations['getLiveHandoffResult'] = () => null,
): BackendStatusCommandOperations {
  const runtime = createRealRuntime(resolveBuildFlavor(process.env));
  const statusPath = routingStatusPath(runtime);
  return {
    inspectReadiness: () => inspectGenerationReadiness(runtime, currentCoralStoreFormat()),
    getStatus: () => getBackendStatusFull(getPluginRoot()),
    getLiveHandoffResult,
    getRoutingStatus: () => readHandoffRoutingStatusWithOwnerObservations(runtime, statusPath),
  };
}

export function createHandoffRoutingStatusCommandOperations(): HandoffRoutingStatusCommandOperations {
  const runtime = createRealRuntime(resolveBuildFlavor(process.env));
  const path = routingStatusPath(runtime);
  return {
    resolve: (request) => resolveHandoffRoutingStatus(runtime, path, request),
    discard: () => discardHandoffRoutingStatus(runtime, path),
  };
}

export function createRoutingStatusQuarantineCommandOperations(): HandoffRoutingStatusQuarantineCommandOperations {
  const runtime = createRealRuntime(resolveBuildFlavor(process.env));
  const path = routingStatusPath(runtime);
  return {
    list: () => listHandoffRoutingStoreQuarantines(runtime.storage, path),
    clear: (quarantineId) => clearHandoffRoutingStatusQuarantine(runtime, path, quarantineId),
  };
}

function formatRoutingStatusDiscardEffectSummary(
  result: Extract<
    HandoffRoutingStatusDiscardResult,
    { kind: 'quarantine-storage-failed' | 'quarantine-retention-undeterminable' }
  >,
): string {
  return [
    `moved artifacts: ${result.movedArtifacts.join(', ') || 'none'}`,
    `observed moved artifacts (not durable): ${result.observedMovedArtifacts.join(', ') || 'none'}`,
    `removed artifacts: ${result.removedArtifacts.join(', ') || 'none'}`,
    `observed removed artifacts (not durable): ${result.observedRemovedArtifacts.join(', ') || 'none'}`,
    `synced directories: ${result.syncedDirectories.join(', ') || 'none'}`,
    result.cause === 'artifact-observation-failed' ? `${result.cause} (errcode ${result.errcode})` : result.cause,
  ].join('; ');
}

function formatRoutingStatusDiscardRefusal(
  result: Exclude<HandoffRoutingStatusDiscardResult, { kind: 'discarded' }>,
): string {
  switch (result.kind) {
    case 'refused':
      switch (result.status.kind) {
        case 'absent':
          return 'Refusing to discard routing status: no journal exists at this address.\nNext step: no action is needed.';
        case 'vacant':
          return 'Refusing to discard routing status: the journal is an empty file consistent with interrupted creation or truncation.\nNext step: no action is needed.';
        case 'uninitialized':
          return 'Refusing to discard routing status: initialization is incomplete and no application objects exist.\nNext step: no action is needed.';
        case 'current':
          return 'Refusing to discard routing status: the journal is current.\nNext step: run coral-cli backend status and follow whatever successor it shows.';
        case 'undeterminable':
          return `Refusing to discard routing status: the journal read was undeterminable (${result.status.cause}, errcode ${result.status.errcode}).\nNext step: retry coral-cli backend status without discarding and repair the reported storage condition if it persists; an ambiguous read cannot authorize quarantine.`;
        default:
          return assertNever(result.status);
      }
    case 'coordinator-running':
      return 'Refusing to discard routing status: the coordinator owns the live socket.\nNext step: run coral-cli backend shutdown, wait for the coordinator to exit, then rerun coral-cli backend routing-status discard.';
    case 'coordinator-socket-unobservable':
      return `Routing-status discard could not determine whether the coordinator socket is available (${result.cause}).\nNext step: run coral-cli backend shutdown, repair the coordinator socket path if it cannot be observed, then rerun coral-cli backend routing-status discard.`;
    case 'coordinator-socket-insecure':
      return 'Refusing to discard routing status: the coordinator socket directory is insecure.\nNext step: repair the reported socket-directory ownership or permissions, run coral-cli backend shutdown, then rerun coral-cli backend routing-status discard.';
    case 'generation-maintenance-unavailable': {
      const cause = result.cause;
      switch (cause) {
        case 'contended':
          return 'Refusing to discard routing status: generation maintenance is unavailable (contended).\nNext step: rerun coral-cli backend routing-status discard after active maintenance finishes. If its holder exited, retry after the maintenance lease has gone ten minutes without a heartbeat; do not delete the lease.';
        case 'writer-observation-unknown':
          return `Refusing to discard routing status: Coral could not determine whether ${result.holder} still owns its writer lease.\nNext step: restore process-identity and liveness observation, then rerun coral-cli backend routing-status discard. If the writer exited, retry after the lease has gone ten minutes without a heartbeat; do not delete the lease.`;
        case 'ownership-lost':
          return 'Refusing to discard routing status: generation maintenance ownership was lost.\nNext step: repair the generation coordination root, rerun coral-cli backend status, then retry coral-cli backend routing-status discard.';
        default:
          return assertNever(cause);
      }
    }
    case 'quarantine-capacity-exhausted':
      return `Refusing to discard routing status: ${result.maximum} quarantine entries are already retained or the quarantine could not be fully enumerated.\nNext step: run coral-cli backend routing-status quarantine list, clear exact entries that are no longer needed, then rerun coral-cli backend routing-status discard.`;
    case 'undeterminable': {
      const observation =
        result.cause === 'artifact-observation-failed'
          ? 'the target quarantine coordinate could not be observed'
          : 'the quarantine could not be enumerated';
      return `Refusing to discard routing status: ${observation} (${result.cause}, errcode ${result.errcode}).\nNext step: repair the reported storage condition, then rerun coral-cli backend routing-status discard; undeterminable quarantine evidence cannot authorize another quarantine.`;
    }
    case 'incomplete-quarantine':
      return `Refusing to discard routing status: quarantine ${result.quarantineId} is incomplete and cannot establish ownership of the current source database.\nNext step: run coral-cli backend routing-status quarantine clear --id ${result.quarantineId}, then rerun coral-cli backend routing-status discard.`;
    case 'quarantine-coordinate-occupied':
      return `Refusing to discard routing status: quarantine coordinate ${result.quarantineId} already retains a ${result.artifact} artifact at ${result.quarantinePath}.\nNext step: preserve the existing evidence and rerun coral-cli backend routing-status discard; if the coordinate repeats, repair the quarantine ID source before retrying.`;
    case 'quarantine-storage-failed': {
      const effects = [
        `retained artifacts: ${result.retainedArtifacts.join(', ') || 'none'}`,
        formatRoutingStatusDiscardEffectSummary(result),
      ].join('; ');
      const hasObservedNamespaceEffect =
        result.observedMovedArtifacts.length > 0 || result.observedRemovedArtifacts.length > 0;
      if (hasObservedNamespaceEffect) {
        const retention =
          result.retainedArtifacts.length === 0
            ? `No durable quarantine artifact is known at ${result.quarantinePath}.`
            : `Evidence is durably retained at ${result.quarantinePath}.`;
        return `Routing-status discard stopped after an uncertain storage effect at quarantine ${result.quarantineId} (${effects}). ${retention}\nNext step: repair the reported storage condition, then run coral-cli backend routing-status quarantine list; if it lists ${result.quarantineId}, run coral-cli backend routing-status quarantine clear --id ${result.quarantineId}, then rerun coral-cli backend routing-status discard.`;
      }
      if (result.retainedArtifacts.length === 0) {
        return `Routing-status discard stopped after a partial storage effect at quarantine ${result.quarantineId} (${effects}). No artifact is retained at ${result.quarantinePath}.\nNext step: repair the reported storage condition, then rerun coral-cli backend routing-status discard.`;
      }
      return `Routing-status discard stopped after a partial storage effect with evidence retained in quarantine ${result.quarantineId} (${effects}).\nNext step: run coral-cli backend routing-status quarantine list, repair the reported storage condition, run coral-cli backend routing-status quarantine clear --id ${result.quarantineId}, then rerun coral-cli backend routing-status discard.`;
    }
    case 'quarantine-retention-undeterminable': {
      const effects = [
        `observed retained artifacts: ${result.observedRetainedArtifacts.join(', ') || 'none'}`,
        formatRoutingStatusDiscardEffectSummary(result),
      ].join('; ');
      const repair =
        result.cause === 'ownership-lost'
          ? 'repair the generation coordination root so maintenance ownership is stable'
          : 'repair the reported storage condition';
      return `Routing-status discard stopped after an ambiguous storage effect at quarantine ${result.quarantineId} (${effects}). Whether evidence was retained at ${result.quarantinePath} could not be determined.\nNext step: ${repair}, then run coral-cli backend routing-status quarantine list; if it lists ${result.quarantineId}, run coral-cli backend routing-status quarantine clear --id ${result.quarantineId}, then rerun coral-cli backend routing-status discard.`;
    }
    default:
      return assertNever(result);
  }
}

function formatRoutingStatusDiscardSuccess(
  result: Extract<HandoffRoutingStatusDiscardResult, { kind: 'discarded' }>,
): string {
  const state = result.quarantineState;
  switch (state) {
    case 'complete':
      return `Quarantined routing status from ${result.artifactPath} at ${result.quarantinePath}.`;
    case 'incomplete':
      return (
        `Discarded routing status: the main database was absent and its detached WAL is retained in incomplete quarantine ${result.quarantineId} at ${result.quarantinePath}.\n` +
        `Next step: inspect it with coral-cli backend routing-status quarantine list; when the evidence is no longer needed, run coral-cli backend routing-status quarantine clear --id ${result.quarantineId}. Another routing-status discard remains blocked until it is cleared.`
      );
    default:
      return assertNever(state);
  }
}

function handoffRoutingStatusDiscardExitContribution(result: HandoffRoutingStatusDiscardResult): 0 | 75 {
  switch (result.kind) {
    case 'discarded':
      return 0;
    case 'refused':
      if (result.status.kind === 'current') return 75;
      return HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY[result.status.kind].statusExit;
  }
  return 75;
}

function commanderInvocationId(value: string, previous: string | undefined): string {
  if (previous !== undefined) throw new InvalidArgumentError('Option --invocation may only be specified once.');
  const invocationId = parseHandoffRoutingInvocationId(value);
  if (invocationId === null) throw new InvalidArgumentError('Invocation must be a canonical lowercase UUID.');
  return invocationId;
}

function commanderRoutingStatusQuarantineId(value: string, previous: string | undefined): string {
  if (previous !== undefined) throw new InvalidArgumentError('Option --id may only be specified once.');
  const quarantineId = parseHandoffRoutingInvocationId(value);
  if (quarantineId === null) throw new InvalidArgumentError('Quarantine ID must be a canonical lowercase UUID.');
  return quarantineId;
}

function formatRoutingStatusQuarantineList(result: HandoffRoutingStatusQuarantineList): string {
  if (result.kind === 'undeterminable') {
    return `Routing-status quarantine could not be enumerated (${result.cause}, errcode ${result.errcode}).\nNext step: repair the reported storage condition, then rerun coral-cli backend routing-status quarantine list.`;
  }
  if (result.entries.length === 0 && !result.overflow) return 'Routing-status quarantine is empty.';
  const lines = [`Routing-status quarantine (${result.entries.length} visible):`];
  for (const entry of result.entries) {
    lines.push(
      `- id=${entry.id} state=${entry.state} artifacts=${entry.artifacts.join(',') || 'none'}`,
      `  path=${entry.quarantinePath}`,
    );
  }
  if (result.overflow) {
    lines.push(
      'The bounded listing did not reach every retained file. Clear visible entries that are no longer needed, then rerun this command.',
    );
  }
  if (result.entries.length > MAX_HANDOFF_ROUTING_STATUS_QUARANTINES) {
    lines.push(
      `Retained quarantine exceeds its ${MAX_HANDOFF_ROUTING_STATUS_QUARANTINES}-entry ceiling. Clear exact entries until it is within bounds.`,
    );
  }
  return lines.join('\n');
}

function formatRoutingStatusQuarantineMaintenanceRefusal(
  result: HandoffRoutingStatusMaintenanceRefusal,
  quarantineId: string,
): string {
  const retry = `coral-cli backend routing-status quarantine clear --id ${quarantineId}`;
  const kind = result.kind;
  switch (kind) {
    case 'coordinator-running':
      return `Refusing to clear routing-status quarantine: the coordinator owns the live socket.\nNext step: run coral-cli backend shutdown, wait for the coordinator to exit, then rerun ${retry}.`;
    case 'coordinator-socket-unobservable':
      return `Routing-status quarantine clear could not determine whether the coordinator socket is available (${result.cause}).\nNext step: repair the coordinator socket path, then rerun ${retry}.`;
    case 'coordinator-socket-insecure':
      return `Refusing to clear routing-status quarantine: the coordinator socket directory is insecure.\nNext step: repair the reported ownership or permissions, then rerun ${retry}.`;
    case 'generation-maintenance-unavailable': {
      const cause = result.cause;
      switch (cause) {
        case 'contended':
          return `Refusing to clear routing-status quarantine: generation maintenance is unavailable (contended).\nNext step: rerun ${retry} after active maintenance finishes. If its holder exited, retry after the maintenance lease has gone ten minutes without a heartbeat; do not delete the lease.`;
        case 'writer-observation-unknown':
          return `Refusing to clear routing-status quarantine: Coral could not determine whether ${result.holder} still owns its writer lease.\nNext step: restore process-identity and liveness observation, then rerun ${retry}. If the writer exited, retry after the lease has gone ten minutes without a heartbeat; do not delete the lease.`;
        case 'ownership-lost':
          return `Refusing to clear routing-status quarantine: generation maintenance ownership was lost.\nNext step: repair the generation coordination root, then rerun ${retry}.`;
        default:
          return assertNever(cause);
      }
    }
    default:
      return assertNever(kind);
  }
}

function formatRoutingStatusQuarantineClearStorageFailure(
  result: Extract<HandoffRoutingStatusQuarantineClearResult, { kind: 'quarantine-clear-storage-failed' }>,
): string {
  const retry = `coral-cli backend routing-status quarantine clear --id ${result.quarantineId}`;
  return `Routing-status quarantine clear stopped after an uncertain storage effect for ${result.quarantineId} (removed artifacts: ${result.removedArtifacts.join(', ') || 'none'}; observed removed artifacts (not durable): ${result.observedRemovedArtifacts.join(', ') || 'none'}; synced directories: ${result.syncedDirectories.join(', ') || 'none'}; ${result.cause}).\nNext step: run coral-cli backend routing-status quarantine list, repair the reported storage condition, then rerun ${retry}.`;
}

type RecoveryQuarantineReadRuntime = Pick<Runtime, 'flavor' | 'paths' | 'storage'>;

function sameRecoveryQuarantineCoordinate(
  entry: RecoveryQuarantineListEntry,
  boundary: string,
  subject: RecoveryQuarantineListEntry['subject'],
): boolean {
  if (entry.boundary !== boundary || entry.subject.key !== subject.key) return false;
  if (entry.subject.revision.kind === 'until-cleared') return subject.revision.kind === 'until-cleared';
  return subject.revision.kind === 'fingerprint' && entry.subject.revision.value === subject.revision.value;
}

function unreadableProviderOperationEntries(
  db: Database,
  stored: readonly RecoveryQuarantineListEntry[],
): RecoveryQuarantineListEntry[] {
  const scan = readProviderOperations(db);
  return attributeUnreadableProviderOperations(db, scan.unreadableKeys).flatMap((row) => {
    const subject = unreadableProviderOperationSubject(row.key, row.revision);
    if (
      stored.some((entry) => sameRecoveryQuarantineCoordinate(entry, UNREADABLE_PROVIDER_OPERATION_BOUNDARY, subject))
    ) {
      return [];
    }
    return [
      {
        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
        subject,
        state: 'active' as const,
        stage: 'hydrate' as const,
        retry: null,
        continuation: null,
        errorMessage: 'Provider operation quarantine status could not be materialized.',
        detail:
          'This coordinate was derived from the durable unreadable provider operation row, but no persisted quarantine subject currently grants operator-discard authority. Repair the row externally, or start or repair the canonical coordinator and rerun this list until it publishes an eligible discard command.',
        detectedAt: null,
        updatedAt: null,
      },
    ];
  });
}

export function listRecoveryQuarantineLocal(
  runtime: RecoveryQuarantineReadRuntime = createRecoveryQuarantineRuntime(),
): readonly RecoveryQuarantineListEntry[] {
  const dbPath = runtime.paths.coral.store.dbFile;
  const classification = classifyStoreFile(dbPath, runtime.storage, currentCoralStoreFormat());
  if (
    classification.kind === 'absent' ||
    classification.kind === 'fresh' ||
    classification.kind === 'older-incompatible'
  ) {
    return [];
  }
  if (classification.kind !== 'compatible') {
    throw new Error(
      `Recovery quarantine cannot be inspected while the local store is ${classification.kind}. Run coral-cli backend status and start or repair the coordinator so it can perform the supported store transition, then retry recovery-quarantine list.`,
    );
  }

  const db = openReadOnlyStoreDatabase(runtime, {
    storeFormat: currentCoralStoreFormat(),
  }) as unknown as Database;
  try {
    const stored = RecoveryQuarantineStore.readOnly(db).list();
    return [...stored, ...unreadableProviderOperationEntries(db, stored)].sort((left, right) => {
      const boundary = left.boundary.localeCompare(right.boundary);
      return boundary === 0 ? left.subject.key.localeCompare(right.subject.key) : boundary;
    });
  } finally {
    db.close();
  }
}

export function createRecoveryQuarantineCommandOperations(signal?: AbortSignal): RecoveryQuarantineCommandOperations {
  return {
    list: () => listRecoveryQuarantineLocal(),
    clear: (request) => clearRecoveryQuarantineWithCoordinator(request, signal),
    discardProviderOperation: (request) => discardUnreadableProviderOperationWithCoordinator(request, signal),
  };
}

export function createProviderHostCommandOperations(
  options: {
    getClient?: () => Promise<Pick<IpcClient, 'request'>>;
  } = {},
): ProviderHostCommandOperations {
  const getClient = options.getClient ?? (async () => ensure(getPluginRoot()));
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const client = await getClient();
    return client.request(method, params, childPrincipalAuthOptions(childPrincipalAuthFromEnv()));
  };
  return {
    list: async () => {
      const params = providerHostListRequestSchema.parse({});
      return providerHostListResponseSchema.parse(await request('coordinator.provider_host.list', params));
    },
    inspect: async (input) => {
      const params = providerHostSelectorRequestSchema.parse(input);
      return providerHostInspectResponseSchema.parse(await request('coordinator.provider_host.inspect', params));
    },
    evict: async (input) => {
      const params = providerHostSelectorRequestSchema.parse(input);
      return providerHostEvictResponseSchema.parse(await request('coordinator.provider_host.evict', params));
    },
  };
}

export function createProviderProxySetCommandOperations(
  options: {
    getClient?: () => Promise<Pick<IpcClient, 'request'>>;
  } = {},
): ProviderProxySetCommandOperations {
  const getClient = options.getClient ?? (async () => ensure(getPluginRoot()));
  return {
    contain: async (input) => {
      const request = providerProxySetContainRequestSchema.parse(input);
      try {
        const client = await getClient();
        const response = await client.request('coordinator.provider_proxy_set.contain', request, {
          timeoutMs: TOOL_TIMEOUT_MS,
          ...childPrincipalAuthOptions(childPrincipalAuthFromEnv()),
        });
        if (isRecord(response) && response.code === 'backend_shutting_down') {
          return { kind: 'coordinator-draining', setIdentity: request.setIdentity };
        }
        const parsed = providerProxySetContainResponseSchema.safeParse(response);
        if (
          parsed.success &&
          parsed.data.setIdentity.buildSetId === request.setIdentity.buildSetId &&
          parsed.data.setIdentity.hostFingerprint === request.setIdentity.hostFingerprint &&
          parsed.data.setIdentity.proxyInstanceId === request.setIdentity.proxyInstanceId
        ) {
          return parsed.data;
        }
        return { kind: 'unsupported-coordinator-result', setIdentity: request.setIdentity };
      } catch (error: unknown) {
        if (error instanceof IpcRpcError && error.rpcCode === -32601) {
          return { kind: 'unsupported-coordinator', setIdentity: request.setIdentity };
        }
        if (isIpcRequestTimeout(error)) {
          return { kind: 'timeout', setIdentity: request.setIdentity };
        }
        throw error;
      }
    },
  };
}

export function registerBackendCommands(program: Command, operations: BackendCommandOperations = {}): void {
  const {
    storeReset = {
      list: listStoreResetIncidentsLocal,
      report: reportStoreResetIncidentLocal,
      discard: discardStoreResetLocal,
    },
    kbCommit = {
      quarantine: quarantineKbCommitLocal,
    },
    backendStatus = createBackendStatusCommandOperations(),
    routingStatus = createHandoffRoutingStatusCommandOperations(),
    routingStatusQuarantine = createRoutingStatusQuarantineCommandOperations(),
    recoveryQuarantine = createRecoveryQuarantineCommandOperations(),
    providerHosts = createProviderHostCommandOperations(),
    providerProxySets = createProviderProxySetCommandOperations(),
  } = operations;
  const backend = program.command('backend').description('Backend administration and local incident inspection');

  const statusCommand = backend.command('status');
  statusCommand.description('Show backend daemon status').action(async () => {
    try {
      const readiness = backendStatus.inspectReadiness();
      switch (readiness.kind) {
        case 'generated-ready':
        case 'no-legacy':
          break;
        case 'legacy-ignored':
          process.stderr.write(`${formatLegacyGenerationIgnoredNotice(readiness)}\n`);
          break;
        default:
          assertNever(readiness);
      }
      const [status, routingStatusRead] = await Promise.all([
        backendStatus.getStatus(),
        backendStatus.getRoutingStatus(),
      ]);
      const liveHandoffResult = backendStatus.getLiveHandoffResult();
      const liveHandoffObligation = liveHandoffResultObligation(liveHandoffResult);
      process.stdout.write(`${formatBackendStatus(status, routingStatusRead, liveHandoffResult)}\n`);
      const localExitContributions: NonEmptyReadonlyArray<BackendStatusLocalExitContribution> = [
        BACKEND_STATUS_EXIT_CODES[status.status],
        liveHandoffObligation.exitContribution,
        handoffRoutingStatusExitContribution(routingStatusRead),
        handoffPublicationIncidentsExitContribution(liveHandoffResult?.publicationIncidents ?? []),
        providerProxySetNoVerdictExitContribution(status),
      ];
      process.exitCode = combineBackendStatusLocalExitContributions(localExitContributions);
    } catch (error) {
      emitError(error);
    }
  });

  const routingStatusCommand = backend.command('routing-status').description('Inspect and repair routing status');
  const resolveRoutingStatusCommand = routingStatusCommand
    .command('resolve')
    .description('Resolve one retained opening or acknowledge one retained capacity eviction')
    .requiredOption('--invocation <id>', 'Canonical invocation ID shown by backend status', commanderInvocationId)
    .option(
      '--force-unobservable',
      'Default: false; requires external owner verification and cannot override deadline-expired',
    );
  let forceUnobservableSeen = false;
  resolveRoutingStatusCommand.on('option:force-unobservable', () => {
    if (forceUnobservableSeen) {
      throw new InvalidArgumentError('Option --force-unobservable may only be specified once.');
    }
    forceUnobservableSeen = true;
  });
  resolveRoutingStatusCommand.action(async (options: { invocation: string; forceUnobservable?: boolean }) => {
    try {
      const request: HandoffRepairOperation = {
        kind: 'routing-status-resolve',
        invocationId: options.invocation,
        forceUnobservable: options.forceUnobservable ?? false,
      };
      const result = await routingStatus.resolve(request);
      const rendered = formatHandoffRoutingResolveResult(result);
      const exitCode = handoffRoutingResolveExitCode(result);
      (exitCode === 0 ? process.stdout : process.stderr).write(`${rendered}\n`);
      process.exitCode = exitCode;
    } catch (error: unknown) {
      emitError(error);
    }
  });
  routingStatusCommand
    .command('discard')
    .description(
      'Quarantine derived routing history so the next publication can replace it; Journal and Corpus authority are unchanged',
    )
    .action(async () => {
      try {
        const result = await routingStatus.discard();
        if (result.kind !== 'discarded') {
          const exitCode = handoffRoutingStatusDiscardExitContribution(result);
          process.stderr.write(`${formatRoutingStatusDiscardRefusal(result)}\n`);
          process.exitCode = exitCode;
          return;
        }
        process.stdout.write(`${formatRoutingStatusDiscardSuccess(result)}\n`);
        process.exitCode = 0;
      } catch (error: unknown) {
        emitError(error);
      }
    });
  const routingStatusQuarantineCommand = routingStatusCommand
    .command('quarantine')
    .description('Inspect and clear retained routing-status journal evidence');
  routingStatusQuarantineCommand
    .command('list')
    .description('List retained complete and incomplete routing-status quarantines')
    .action(() => {
      try {
        const result = routingStatusQuarantine.list();
        if (result.kind === 'undeterminable') {
          process.stderr.write(`${formatRoutingStatusQuarantineList(result)}\n`);
          process.exitCode = 75;
          return;
        }
        process.stdout.write(`${formatRoutingStatusQuarantineList(result)}\n`);
        process.exitCode = result.overflow || result.entries.length > MAX_HANDOFF_ROUTING_STATUS_QUARANTINES ? 75 : 0;
      } catch (error: unknown) {
        emitError(error);
      }
    });
  routingStatusQuarantineCommand
    .command('clear')
    .description('Permanently remove one exact retained routing-status quarantine')
    .requiredOption(
      '--id <id>',
      'Canonical quarantine ID shown by routing-status quarantine list',
      commanderRoutingStatusQuarantineId,
    )
    .action(async (options: { id: string }) => {
      try {
        const result = await routingStatusQuarantine.clear(options.id);
        if (result.kind === 'cleared') {
          process.stdout.write(
            `Cleared routing-status quarantine ${result.entry.id} at ${result.entry.quarantinePath}.\n`,
          );
          process.exitCode = 0;
          return;
        }
        if (result.kind === 'quarantine-not-found') {
          process.stdout.write(`Routing-status quarantine ${result.quarantineId} is already absent.\n`);
          process.exitCode = 0;
          return;
        }
        if (result.kind === 'quarantine-clear-undeterminable') {
          process.stderr.write(
            `Routing-status quarantine clear could not determine whether its ${result.artifact} artifact is present at ${result.quarantinePath} (errcode ${result.errcode}).\nNext step: repair the reported storage condition, then rerun coral-cli backend routing-status quarantine clear --id ${result.quarantineId}.\n`,
          );
          process.exitCode = 75;
          return;
        }
        if (result.kind === 'quarantine-clear-storage-failed') {
          process.stderr.write(`${formatRoutingStatusQuarantineClearStorageFailure(result)}\n`);
          process.exitCode = 75;
          return;
        }
        process.stderr.write(`${formatRoutingStatusQuarantineMaintenanceRefusal(result, options.id)}\n`);
        process.exitCode = 75;
      } catch (error: unknown) {
        emitError(error);
      }
    });

  const shutdownCommand = backend.command('shutdown');
  shutdownCommand.description('Gracefully shut down backend daemon').action(async () => {
    try {
      let preservedSetRead: Readonly<{ tokens: readonly string[]; skippedRows: number }> | null = null;
      try {
        const statusBeforeShutdown = await backendStatus.getStatus();
        if (statusBeforeShutdown.status === 'ok') {
          preservedSetRead = {
            tokens: [
              ...new Set([
                ...(statusBeforeShutdown.health.diagnostics?.providerProxySets ?? []).map((set) => set.setToken),
                ...(statusBeforeShutdown.health.skippedProviderProxySetTokens ?? []),
              ]),
            ],
            skippedRows: statusBeforeShutdown.health.skippedProviderProxySetRows ?? 0,
          };
        }
      } catch {
        // Shutdown remains authoritative for its own result; this read contributes output only.
      }
      const result = await shutdownBackend(getPluginRoot());
      const text = formatShutdown(result);

      if (result.ok) {
        const preserved = (() => {
          if (preservedSetRead === null) {
            return 'Held provider proxy sets could not be inspected before shutdown; run backend status after the successor starts.';
          }
          if (preservedSetRead.tokens.length === 0 && preservedSetRead.skippedRows === 0) {
            return 'No held provider proxy sets were reported before shutdown.';
          }
          const lines = preservedSetRead.tokens.length
            ? [
                'Provider proxy set tokens reported before shutdown:',
                ...preservedSetRead.tokens.map((token) => `  coral-cli backend provider-proxy-set contain ${token}`),
              ]
            : [];
          if (preservedSetRead.skippedRows > 0) {
            lines.push(
              `The pre-shutdown status read could not interpret ${preservedSetRead.skippedRows} provider proxy set row(s), so it could not confirm that every preserved set was named.`,
            );
          }
          return lines.join('\n');
        })();
        process.stdout.write(`${text}\n${preserved}\n`);
        return;
      }

      process.stderr.write(text + '\n');
      process.exitCode = SHUTDOWN_REFUSAL_EXIT_CODES[result.reason];
    } catch (error) {
      emitError(error);
    }
  });

  const recoveryQuarantineCommand = backend
    .command('recovery-quarantine')
    .description('Inspect or retry retained recovery failures');
  recoveryQuarantineCommand
    .command('list')
    .description('List retained recovery failures from the local store')
    .action(() => {
      try {
        process.stdout.write(`${formatRecoveryQuarantineList(recoveryQuarantine.list())}\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });

  const providerHostCommand = backend.command('provider-host').description('Inspect and evict provider hosts');
  providerHostCommand
    .command('list')
    .description('List live, retained-blocked, and reclamation-failed provider hosts')
    .action(async () => {
      try {
        process.stdout.write(`${formatProviderHostList(await providerHosts.list())}\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });
  providerHostCommand
    .command('inspect')
    .description('Inspect one exact live, retained-blocked, or reclamation-failed provider host')
    .argument('[host-ref]', 'Canonical ph1 provider-host reference')
    .option('--work-dir <path>', 'Resolve exactly one provider host by work directory')
    .action(async (hostRef: string | undefined, options: { workDir?: string }) => {
      try {
        const request = parseProviderHostSelector(hostRef, options.workDir);
        process.stdout.write(`${formatProviderHostInspect(await providerHosts.inspect(request))}\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });
  providerHostCommand
    .command('evict')
    .description('Evict one exact provider host; may end work already attached to that host')
    .argument('[host-ref]', 'Canonical ph1 reference copied from `coral-cli backend provider-host list`')
    .option('--work-dir <path>', 'Resolve relative to the current directory; refuses on ambiguity')
    .action(async (hostRef: string | undefined, options: { workDir?: string }) => {
      try {
        const request = parseProviderHostSelector(hostRef, options.workDir);
        const result = await providerHosts.evict(request);
        process.stdout.write(`Evicted ${encodeHostRef(result.hostRef)} from ${result.ownerId}.\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });
  const providerProxySetCommand = backend
    .command('provider-proxy-set')
    .description('Contain or abandon one exact held provider-proxy set');
  const containProviderProxySetCommand = providerProxySetCommand
    .command('contain')
    .description('Resolve one exact held provider-proxy set after its state-specific operator-exit gate')
    .argument('<set-token>', 'Canonical pps1 token copied from `coral-cli backend status`', parseProviderProxySetToken)
    .option(
      '--abandon-without-absence',
      'After external verification, release Coral representation for a live/unobservable enforcer or unattributable recorded group',
    )
    .addHelpText(
      'after',
      [
        '',
        'Default mode requires guardian and reaper absence, then reaps the recorded proxy process group and every recorded provider root.',
        '--abandon-without-absence signals no process and releases Coral representation despite observed life, unknown observation, or an unattributable recorded group.',
        'Neither mode signals the guardian or reaper.',
        'A reattachment hold is gated by its control-adoption deadline; containing and containment-wait are gated by their current containment-attempt deadline.',
      ].join('\n'),
    );
  let abandonWithoutAbsenceSeen = false;
  containProviderProxySetCommand.on('option:abandon-without-absence', () => {
    if (abandonWithoutAbsenceSeen) {
      throw new InvalidArgumentError('Option --abandon-without-absence may only be specified once.');
    }
    abandonWithoutAbsenceSeen = true;
  });
  containProviderProxySetCommand.action(
    async (setIdentity: ProviderProxySetAddress, options: { abandonWithoutAbsence?: boolean }) => {
      try {
        const result = await providerProxySets.contain({
          setIdentity,
          abandonWithoutAbsence: options.abandonWithoutAbsence ?? false,
        });
        if (isProviderProxySetContainNoVerdict(result)) {
          process.stderr.write(`${formatProviderProxySetContainNoVerdict(result)}\n`);
          process.exitCode = 75;
          return;
        }
        const exitCode = providerProxySetContainExitCode(result);
        (exitCode === 0 ? process.stdout : process.stderr).write(`${formatProviderProxySetContainResult(result)}\n`);
        process.exitCode = exitCode;
      } catch (error: unknown) {
        emitError(error);
      }
    },
  );
  recoveryQuarantineCommand
    .command('clear')
    .description('Retry one exact retained recovery failure through the canonical coordinator')
    .requiredOption('--boundary <boundary>', 'Recovery boundary shown by recovery-quarantine list')
    .requiredOption('--key <key>', 'Recovery subject key shown by recovery-quarantine list')
    .requiredOption('--revision <revision>', "Exact revision shown by list, including 'until-cleared'")
    .action(async (options: { boundary: string; key: string; revision: string }) => {
      try {
        const request = parseRecoveryQuarantineClearOptions(options, recoveryQuarantine.list());
        const result = await recoveryQuarantine.clear(request);
        process.stdout.write(`${formatRecoveryQuarantineClear(result)}\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });
  recoveryQuarantineCommand
    .command('discard-provider-operation')
    .description('Permanently discard one exact still-unreadable raw provider-operation row')
    .requiredOption('--key <key>', 'Exact unreadable provider-operation key shown by recovery-quarantine list')
    .requiredOption('--revision <revision>', 'Exact fingerprint revision shown by recovery-quarantine list')
    .addHelpText(
      'after',
      '\nThis permanently removes the raw operation record, its due pointers, and its exact persisted quarantine evidence without settling or signalling its work. The command refuses if recovery owns the evidence or the row is readable, absent, or at a different revision.',
    )
    .action(async (options: { key: string; revision: string }) => {
      try {
        if (recoveryQuarantine.discardProviderOperation === undefined) {
          throw new Error('This Coral build does not provide unreadable provider-operation discard.');
        }
        const request = parseUnreadableProviderOperationDiscardOptions(options, recoveryQuarantine.list());
        const result = await recoveryQuarantine.discardProviderOperation(request);
        switch (result.kind) {
          case 'unsupported-coordinator':
          case 'coordinator-draining':
          case 'unsupported-coordinator-result':
          case 'timeout':
            process.stderr.write(`${formatUnreadableProviderOperationDiscardNoVerdict(result)}\n`);
            process.exitCode = 75;
            return;
          default: {
            const exitCode = UNREADABLE_PROVIDER_OPERATION_DISCARD_EXIT_CODES[result.kind];
            (exitCode === 0 ? process.stdout : process.stderr).write(
              `${formatUnreadableProviderOperationDiscard(result)}\n`,
            );
            process.exitCode = exitCode;
          }
        }
      } catch (error: unknown) {
        emitError(error);
      }
    });

  const storeResetCommand = backend.command('store-reset').description('Inspect retained store-reset incidents');
  storeResetCommand
    .command('list')
    .description('List retained store-reset incidents and reportability')
    .requiredOption(
      '--target <target>',
      'Store generation to inspect (legacy or current; gen2 also accepted)',
      parseStoreResetTarget,
    )
    .action((options: { target: StoreResetTarget }) => {
      try {
        process.stdout.write(`${formatStoreResetList(storeReset.list(options.target), options.target)}\n`);
      } catch (error: unknown) {
        emitError(boundStoreResetCliError(error));
      }
    });
  storeResetCommand
    .command('report')
    .description('Generate a public-safe store-reset incident report')
    .argument('<incident-id>', 'Canonical lowercase UUID shown by backend store-reset list')
    .requiredOption(
      '--target <target>',
      'Store generation to inspect (legacy or current; gen2 also accepted)',
      parseStoreResetTarget,
    )
    .action(async (incidentId: string, options: { target: StoreResetTarget }) => {
      try {
        process.stdout.write(formatStoreResetReport(await storeReset.report(options.target, incidentId)));
      } catch (error: unknown) {
        emitError(boundStoreResetCliError(error));
      }
    });
  storeResetCommand
    .command('discard')
    .description(
      'Quarantine and replace an incompatible generated store; if a newer local Coral build is already selected ' +
        'to own this store, the command runs there instead of here',
    )
    .requiredOption(
      '--target <target>',
      'Store generation to discard (current; gen2 also accepted, legacy is inspection-only)',
      parseStoreResetTarget,
    )
    .requiredOption('--flavor <flavor>', OFFLINE_OPERATOR_FLAVOR_HELP, parseFlavor)
    .action(async (options: { target: StoreResetTarget; flavor: BuildFlavor }) => {
      try {
        const result = await storeReset.discard(options.target, options.flavor);
        if (result.kind === 'handoff') {
          // The selection decision precedes every destructive step. Replaying the original argv lets the
          // validated owner perform the requested reset without asking the operator to run another command.
          const handoffResult = await runHandoff(
            { kind: 'cli-invocation', argv: ['node', 'coral-cli', ...program.args] },
            {
              pluginRoot: getPluginRoot(),
              activeSelectionTarget: result.target,
              onSelectionPublicationIncident: (incident) => renderHandoffPublicationIncidents([incident]),
            },
          );
          const continuation = consumeHandoffRunResult(handoffResult, (incidents) =>
            renderHandoffPublicationIncidents(incidents.filter((incident) => incident.phase === 'terminal')),
          );
          if (continuation.kind === 'run-current') {
            process.stderr.write(
              'This Coral process could not finish draining stdout, so store-reset delegation was abandoned before any destructive step. Nothing was changed. Retry the command.\n',
            );
            process.exitCode = errorCodeToExit('transient');
            return;
          }
          switch (continuation.outcome.kind) {
            case 'handoff-success':
              renderHandoffNotice(continuation.outcome);
              return;
            case 'handoff-startup-observation-aborted':
              process.stderr.write(`${formatHandoffStartupObservationAborted(continuation.outcome)}\n`);
              process.exitCode = errorCodeToExit('transient');
              return;
            case 'handoff-exit':
              process.stderr.write(`Coral ${continuation.version} ran the delegated store-reset command.\n`);
              process.exitCode = continuation.outcome.exitCode;
              return;
            case 'handoff-signal':
              process.stderr.write(`Coral ${continuation.version} ran the delegated store-reset command.\n`);
              process.kill(process.pid, continuation.outcome.signal);
              return;
            default:
              return assertNever(continuation.outcome);
          }
        }
        process.stderr.write(STORE_RESET_EVIDENCE_WARNING);
        if (result.incident === null) {
          process.stdout.write(`Initialized ${result.target} ${result.flavor} store at ${result.storeDbPath}.\n`);
          return;
        }
        const action = result.resumed ? 'Resumed' : 'Quarantined';
        process.stdout.write(
          `${action} store-reset incident '${result.incident.incidentId}' and initialized ${result.target} ${result.flavor} store at ${result.storeDbPath}.\n`,
        );
      } catch (error: unknown) {
        if (error instanceof HandoffRunError) {
          renderHandoffPublicationIncidents(error.incidents.filter((incident) => incident.phase === 'terminal'));
          emitError(error.originalError);
          return;
        }
        emitError(error);
      }
    });

  const kbCommitCommand = backend.command('kb-commit').description('Operate on retained blocking KB commit evidence');
  kbCommitCommand.configureOutput({ writeErr: () => undefined });
  kbCommitCommand
    .command('quarantine')
    .description('Durably quarantine one blocking KB commit and its matching runtime evidence')
    .requiredOption('--flavor <flavor>', OFFLINE_OPERATOR_FLAVOR_HELP, parseFlavor)
    .requiredOption('--commit <id>', 'Blocking KB commit ID', parseKbCommitId)
    .action(async (options: { flavor: BuildFlavor; commit: string }) => {
      try {
        const result = await kbCommit.quarantine(options.flavor, options.commit);
        process.stdout.write(`Quarantined KB commit '${result.commitId}' at ${result.quarantineDir}.\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });
}

export function parseProviderProxySetToken(token: string): ProviderProxySetAddress {
  try {
    return decodeProviderProxySetAddress(token);
  } catch (error: unknown) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : 'Invalid provider-proxy set token.');
  }
}

export function parseProviderHostSelector(
  hostRef: string | undefined,
  workDir: string | undefined,
): ProviderHostSelectorRequest {
  if ((hostRef === undefined) === (workDir === undefined)) {
    throw new InvalidArgumentError('Provide exactly one selector: either <host-ref> or --work-dir <path>.');
  }
  if (hostRef !== undefined) {
    try {
      return { hostRef: decodeHostRef(hostRef) };
    } catch (error: unknown) {
      throw new InvalidArgumentError(error instanceof Error ? error.message : 'Invalid provider-host reference.');
    }
  }
  return { workDir: workDir as string, projectRoot: process.cwd() };
}

export function formatProviderHostList(response: ProviderHostListResponse): string {
  if (response.hosts.length === 0) return 'No provider hosts.';
  const rows = response.hosts.map((host) =>
    [encodeHostRef(host.ref), host.status, host.ownerId, host.ref.provider, host.spec.cwd ?? '-'].join('\t'),
  );
  return ['HOST_REF\tSTATUS\tOWNER\tPROVIDER\tWORK_DIR', ...rows].join('\n');
}

export function formatProviderHostInspect(response: ProviderHostInspectResponse): string {
  const { ref, ...host } = response.host;
  return JSON.stringify({ hostRef: encodeHostRef(ref), ...host }, null, 2);
}

function parseFlavor(value: string): BuildFlavor {
  if (value === 'prod' || value === 'dev') return value;
  throw new InvalidArgumentError("Flavor must be 'prod' or 'dev'.");
}

function parseStoreResetTarget(value: string): StoreResetTarget {
  if (value === 'legacy' || value === 'gen2') return value;
  if (value === 'current') return 'gen2';
  throw new InvalidArgumentError("Target must be 'legacy', 'current', or 'gen2'.");
}

function parseKbCommitId(value: string): string {
  if (isSafeKbCommitId(value)) return value;
  throw new InvalidArgumentError('KB commit ID must be one safe filesystem path segment.');
}

function unquoteRecoveryCoordinate(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
    return value;
  }
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === 'string' ? decoded : value;
  } catch {
    return value;
  }
}

function parseRecoveryQuarantineClearOptions(
  options: {
    readonly boundary: string;
    readonly key: string;
    readonly revision: string;
  },
  storedEntries: readonly RecoveryQuarantineListEntry[],
): RecoveryQuarantineClearRequest {
  const revision = unquoteRecoveryCoordinate(options.revision);
  const plainKey = unquoteRecoveryCoordinate(options.key);
  if (plainKey.includes('\u0000')) {
    throw new InvalidArgumentError(
      'Recovery subject keys containing NUL must use the encoded key printed by recovery-quarantine list.',
    );
  }
  const storedKey = storedEntries.find((entry) => entry.subject.key === plainKey)?.subject.key;
  const decodedKey = decodeRecoveryQuarantineKey(options.key);
  const key = storedKey ?? (decodedKey.kind === 'decoded' ? decodedKey.key : plainKey);
  const parsed = recoveryQuarantineClearRequestSchema.safeParse({
    boundary: unquoteRecoveryCoordinate(options.boundary),
    key,
    revision:
      revision === RECOVERY_REVISION_UNTIL_CLEARED
        ? null
        : revision.startsWith(RECOVERY_REVISION_FINGERPRINT_PREFIX)
          ? revision.slice(RECOVERY_REVISION_FINGERPRINT_PREFIX.length)
          : revision,
  });
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const message = issue?.message ?? 'Invalid recovery quarantine coordinate';
  throw new InvalidArgumentError(
    `${message}. Run coral-cli backend recovery-quarantine list and copy the exact boundary, key, and revision.`,
  );
}

function parseUnreadableProviderOperationDiscardOptions(
  options: Readonly<{ key: string; revision: string }>,
  storedEntries: readonly RecoveryQuarantineListEntry[],
): UnreadableProviderOperationDiscardRequest {
  const plainKey = unquoteRecoveryCoordinate(options.key);
  const storedKey = storedEntries.find(
    (entry) => entry.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY && entry.subject.key === plainKey,
  )?.subject.key;
  const decodedKey = decodeRecoveryQuarantineKey(options.key);
  const key = storedKey ?? (decodedKey.kind === 'decoded' ? decodedKey.key : plainKey);
  const shownRevision = unquoteRecoveryCoordinate(options.revision);
  const revision = shownRevision.startsWith(RECOVERY_REVISION_FINGERPRINT_PREFIX)
    ? shownRevision.slice(RECOVERY_REVISION_FINGERPRINT_PREFIX.length)
    : shownRevision;
  const parsed = unreadableProviderOperationDiscardRequestSchema.safeParse({ key, revision });
  if (parsed.success) return parsed.data;
  throw new InvalidArgumentError(
    'Invalid unreadable provider-operation coordinate. Run coral-cli backend recovery-quarantine list and copy the exact key and fingerprint revision.',
  );
}

function createRecoveryQuarantineRuntime(): Runtime {
  return createRealRuntime(readBuildFlavor(getPluginRoot()));
}

async function clearRecoveryQuarantineWithCoordinator(
  request: RecoveryQuarantineClearRequest,
  signal?: AbortSignal,
): Promise<RecoveryQuarantineClearResult> {
  const parsedRequest = recoveryQuarantineClearRequestSchema.parse(request);
  signal?.throwIfAborted();
  try {
    const auth = childPrincipalAuthOptions(childPrincipalAuthFromEnv());
    const client = await ensure(getPluginRoot());
    const response = await client.request<unknown>('coordinator.recovery_quarantine.clear', parsedRequest, {
      timeoutMs: TOOL_TIMEOUT_MS,
      ...auth,
    });
    const result = recoveryQuarantineClearResultSchema.safeParse(response);
    if (!result.success) {
      throw new RecoveryQuarantineContractError(
        'Coordinator returned an invalid recovery quarantine retry result. Run coral-cli backend status, then retry the exact clear.',
      );
    }
    return result.data;
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    if (error instanceof IpcRpcError || error instanceof RecoveryQuarantineContractError) {
      throw error;
    }
    if (isIpcRequestTimeout(error)) {
      throw new Error(
        'Recovery quarantine clear timed out before the coordinator returned a result. Run coral-cli backend status, then retry the exact clear.',
        { cause: error },
      );
    }
    throw recoveryCoordinatorRequiredError();
  }
}

async function discardUnreadableProviderOperationWithCoordinator(
  request: UnreadableProviderOperationDiscardRequest,
  signal?: AbortSignal,
): Promise<UnreadableProviderOperationDiscardCommandResult> {
  const parsedRequest = unreadableProviderOperationDiscardRequestSchema.parse(request);
  signal?.throwIfAborted();
  try {
    const auth = childPrincipalAuthOptions(childPrincipalAuthFromEnv());
    const client = await ensure(getPluginRoot());
    const response = await client.request<unknown>(
      'coordinator.recovery_quarantine.discard_provider_operation',
      parsedRequest,
      { timeoutMs: TOOL_TIMEOUT_MS, ...auth },
    );
    if (isRecord(response) && response.code === 'backend_shutting_down') {
      return { ...parsedRequest, kind: 'coordinator-draining' };
    }
    const result = unreadableProviderOperationDiscardResultSchema.safeParse(response);
    if (result.success && result.data.key === parsedRequest.key && result.data.revision === parsedRequest.revision) {
      return result.data;
    }
    return { ...parsedRequest, kind: 'unsupported-coordinator-result' };
  } catch (error: unknown) {
    if (signal?.aborted === true) throw signal.reason;
    if (error instanceof IpcRpcError && error.rpcCode === -32601) {
      return { ...parsedRequest, kind: 'unsupported-coordinator' };
    }
    if (isIpcRequestTimeout(error)) {
      return { ...parsedRequest, kind: 'timeout' };
    }
    if (error instanceof IpcRpcError || error instanceof RecoveryQuarantineContractError) throw error;
    throw recoveryCoordinatorRequiredError();
  }
}

class RecoveryQuarantineContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryQuarantineContractError';
  }
}

function isIpcRequestTimeout(error: unknown): boolean {
  const timeoutPattern = /timed out|deadline (?:already )?exceeded/iu;
  if (error instanceof Error && timeoutPattern.test(error.message)) return true;
  return (
    isRecord(error) &&
    isRecord(error.context) &&
    typeof error.context.cause === 'string' &&
    timeoutPattern.test(error.context.cause)
  );
}

function recoveryCoordinatorRequiredError(): BackendUnreachableError {
  return new BackendUnreachableError(
    'Recovery quarantine mutation requires the canonical coordinator, but it is not reachable. Run coral-cli backend status, start or repair the coordinator, then retry the exact command.',
  );
}
