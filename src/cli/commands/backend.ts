import { InvalidArgumentError, type Command } from 'commander';

import {
  HandoffRunError,
  liveHandoffResultObligation,
  projectHandoffRunResult,
  runHandoff,
  type HandoffPublicationIncident,
  type LiveHandoffResult,
  type NonEmptyReadonlyArray,
} from '../../coordinator/handoff-runner.js';
import {
  parseHandoffRoutingInvocationId,
  type HandoffRepairOperation,
} from '../../coordinator/handoff-repair-operation.js';
import {
  HANDOFF_ROUTING_STATUS_GENERATION,
  handoffRoutingStatusExitContribution,
  readHandoffRoutingStatusWithOwnerObservations,
  resolveHandoffRoutingStatus,
  type HandoffRoutingResolveRequest,
  type HandoffRoutingResolveResult,
  type HandoffRoutingStatusReadResult,
} from '../../coordinator/handoff-routing-status.js';
import { resolveBuildFlavor, type BuildFlavor } from '../../infra/build-flavor.js';
import { readBuildFlavor } from '../../infra/bundle-manifest.js';
import { assertNever } from '../../infra/error-format.js';
import { BackendUnreachableError } from '../../infra/http-errors.js';
import { handoffRoutingStatusPathForRunDir } from '../../infra/path/index.js';
import { isSafeKbCommitId } from '../../kb/commit-quarantine.js';
import { RecoveryQuarantineStore, type RecoveryQuarantineEntry } from '../../recovery/quarantine.js';
import type { RecoveryQuarantineClearRequest, RecoveryQuarantineClearResult } from '../../recovery/source-registry.js';
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
  type ProviderHostEvictResponse,
  type ProviderHostInspectResponse,
  type ProviderHostListResponse,
  type ProviderHostSelectorRequest,
} from '../../transport/rpc/catalog.js';
import { decodeHostRef, encodeHostRef } from '../../providers/host-ref-codec.js';
import { getPluginRoot } from '../dispatch.js';
import { emitError } from '../emit.js';
import { errorCodeToExit } from '../errors.js';
import { renderHandoffNotice, renderHandoffPublicationIncidents } from '../handoff-notice.js';
import {
  formatBackendStatus,
  formatHandoffRoutingResolveResult,
  formatRecoveryQuarantineClear,
  formatRecoveryQuarantineList,
  formatShutdown,
  RECOVERY_REVISION_FINGERPRINT_PREFIX,
  RECOVERY_REVISION_UNTIL_CLEARED,
} from '../format/backend.js';
import { formatStoreResetList, formatStoreResetReport } from '../format/store-reset.js';
import { discardHandoffRoutingStatus, type HandoffRoutingStatusDiscardResult } from '../routing-status-discard.js';

/**
 * What each `backend shutdown` refusal means to a script, as an exit code.
 *
 * `docs/configuration.md` tells operators to run `backend shutdown` before `store-reset discard` and
 * `kb-commit quarantine`, so the question this code answers is "may I proceed to destroy state?" — and there
 * are three answers, not two. Exit `0` is "it is stopping". Exit `1` is a refusal this run *observed*: the
 * daemon was seen to be absent, or seen to be alive and unwilling. Exit `75` is the third — this run could not
 * tell, so a caller must neither proceed nor read the outcome as failure.
 *
 * `75` rather than `2`: `2` is `invalid_usage` (`docs/cli-errors.md`), so a
 * script could not tell "you called this wrong" from "I could not observe the daemon". `75` is already this
 * CLI's "not concluded, resume or retry" across `wait jobs` and every transient code, which is what both
 * members below are.
 *
 * A `Record` rather than a set of the undetermined ones. A set answers only for its members and defaults the
 * rest, so a new `ShutdownReason` silently inherits "observed" — the exact shape of the collapse this table
 * exists to prevent. Here it fails to compile until someone decides, which is the same mechanism
 * `formatShutdown`'s `assertNever` provides for the message.
 */
export const SHUTDOWN_REFUSAL_EXIT_CODES: Readonly<Record<ShutdownReason, 1 | 75>> = {
  // Observed: nothing recorded itself, or the recorded process is decisively gone.
  no_record: 1,
  recorded_process_absent: 1,
  // Observed: the coordinator answered and declined. It is running, and this run knows it.
  capability_rejected: 1,
  // Observed: this process refused to act, before asking anything. Retrying from the same child repeats it.
  nested_child: 1,
  // Not observed: a refused connection proves nothing was listening on that exact socket at that moment, but
  // the recorded pid was never established absent before this request was sent (an absent pid short-circuits
  // to `recorded_process_absent` first) — so this is not the same "observed absence" as the two rows above.
  // The deterministic window it must not claim: a coordinator's HTTP listener closes at the top of its drain
  // while its process, confirmed alive, keeps running.
  socket_refused: 75,
  // Not observed: the record could not be read, the request never completed, or a response arrived but did not
  // resolve the question either way. A coordinator may be serving.
  unreadable_record: 75,
  refused_by_response: 75,
  no_response: 75,
  // Not observed: the coordinator's own IPC socket file exists with no record written yet, which a coordinator
  // mid-boot and a stale socket a killed one left behind both produce, indistinguishably.
  no_record_socket_present: 75,
};

/**
 * Every new daemon status must be assigned an explicit exit contribution.
 *
 * `75`, not `1`, for the statuses that did not settle: this command is a read-only inspection, so none of them
 * is an observed refusal the way `backend shutdown`'s are — they mean only "ask again".
 */
export const BACKEND_STATUS_EXIT_CODES: Readonly<Record<BackendStatusFull['status'], 0 | 75>> = {
  ok: 0,
  not_running: 0,
  shutting_down: 0,
  unauthorized: 0,
  recent_failure: 0,
  undecodable_record: 75,
  unreachable: 75,
  no_record_socket_present: 75,
};

type HandoffRoutingResolveKindWithoutPublication = Exclude<HandoffRoutingResolveResult['kind'], 'not-published'>;
type HandoffRoutingNotPublishedCause = Extract<
  Extract<HandoffRoutingResolveResult, { kind: 'not-published' }>['outcome'],
  { kind: 'not-published' }
>['cause'];

export const HANDOFF_ROUTING_RESOLVE_EXIT_CODES: Readonly<
  Record<HandoffRoutingResolveKindWithoutPublication, 0 | 1 | 75>
> = {
  resolved: 0,
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
  unreadable: 75,
  'unsupported-generation': 75,
  'invalid-record': 70,
  'rejected-transition': 75,
  'coordination-unavailable': 75,
};

function handoffPublicationIncidentExitContribution(incident: HandoffPublicationIncident): 70 | 75 {
  switch (incident.kind) {
    case 'not-published':
      return HANDOFF_ROUTING_NOT_PUBLISHED_EXIT_CODES[incident.cause];
    case 'undeterminable':
    case 'refused':
      return 75;
    default:
      return assertNever(incident);
  }
}

function handoffRoutingResolveExitCode(result: HandoffRoutingResolveResult): 0 | 1 | 70 | 75 {
  if (result.kind !== 'not-published') return HANDOFF_ROUTING_RESOLVE_EXIT_CODES[result.kind];
  return result.outcome.kind === 'undeterminable' ? 75 : HANDOFF_ROUTING_NOT_PUBLISHED_EXIT_CODES[result.outcome.cause];
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
import { quarantineKbCommitLocal } from '../kb-commit-quarantine.js';
import type { StoreResetTarget } from '../../store/operator-store-reset.js';
import {
  boundStoreResetCliError,
  discardStoreResetLocal,
  listStoreResetIncidentsLocal,
  reportStoreResetIncidentLocal,
} from '../store-reset.js';

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

export interface RecoveryQuarantineCommandOperations {
  list(): readonly RecoveryQuarantineEntry[];
  clear(request: RecoveryQuarantineClearRequest): Promise<RecoveryQuarantineClearResult>;
}

export interface ProviderHostCommandOperations {
  list(): Promise<ProviderHostListResponse>;
  inspect(request: ProviderHostSelectorRequest): Promise<ProviderHostInspectResponse>;
  evict(request: ProviderHostSelectorRequest): Promise<ProviderHostEvictResponse>;
}

export type BackendCommandOperations = Readonly<{
  storeReset?: StoreResetCommandOperations;
  kbCommit?: KbCommitCommandOperations;
  backendStatus?: BackendStatusCommandOperations;
  routingStatus?: HandoffRoutingStatusCommandOperations;
  recoveryQuarantine?: RecoveryQuarantineCommandOperations;
  providerHosts?: ProviderHostCommandOperations;
}>;

export function createBackendStatusCommandOperations(
  getLiveHandoffResult: BackendStatusCommandOperations['getLiveHandoffResult'] = () => null,
): BackendStatusCommandOperations {
  const runtime = createRealRuntime(resolveBuildFlavor(process.env));
  const routingStatusPath = handoffRoutingStatusPathForRunDir(
    runtime.paths.coral.coordinator.runDir,
    HANDOFF_ROUTING_STATUS_GENERATION,
  );
  return {
    inspectReadiness: () => inspectGenerationReadiness(runtime, currentCoralStoreFormat()),
    getStatus: () => getBackendStatusFull(getPluginRoot()),
    getLiveHandoffResult,
    getRoutingStatus: () => readHandoffRoutingStatusWithOwnerObservations(runtime, routingStatusPath),
  };
}

export function createHandoffRoutingStatusCommandOperations(): HandoffRoutingStatusCommandOperations {
  const runtime = createRealRuntime(resolveBuildFlavor(process.env));
  const path = handoffRoutingStatusPathForRunDir(
    runtime.paths.coral.coordinator.runDir,
    HANDOFF_ROUTING_STATUS_GENERATION,
  );
  return {
    resolve: (request) => resolveHandoffRoutingStatus(runtime, path, request),
    discard: () => discardHandoffRoutingStatus(runtime, path),
  };
}

function formatRoutingStatusDiscardRefusal(
  status: Extract<HandoffRoutingStatusDiscardResult, { kind: 'refused' }>,
): string {
  switch (status.status.kind) {
    case 'absent':
      return 'Refusing to discard routing status: no journal exists at this address.\nNext step: no action is needed.';
    case 'current':
      return 'Refusing to discard routing status: the journal is current.\nNext step: run coral-cli backend status and follow whatever successor it shows.';
    case 'undeterminable':
      return `Refusing to discard routing status: the journal read was undeterminable (${status.status.cause}, errcode ${status.status.errcode}).\nNext step: retry coral-cli backend status without discarding and repair the reported storage condition if it persists; an ambiguous read cannot authorize quarantine.`;
    default:
      return assertNever(status.status);
  }
}

function commanderInvocationId(value: string, previous: string | undefined): string {
  if (previous !== undefined) throw new InvalidArgumentError('Option --invocation may only be specified once.');
  const invocationId = parseHandoffRoutingInvocationId(value);
  if (invocationId === null) throw new InvalidArgumentError('Invocation must be a canonical lowercase UUID.');
  return invocationId;
}

type RecoveryQuarantineReadRuntime = Pick<Runtime, 'flavor' | 'paths' | 'storage'>;

export function listRecoveryQuarantineLocal(
  runtime: RecoveryQuarantineReadRuntime = createRecoveryQuarantineRuntime(),
): readonly RecoveryQuarantineEntry[] {
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
    return RecoveryQuarantineStore.readOnly(db).list();
  } finally {
    db.close();
  }
}

export function createRecoveryQuarantineCommandOperations(signal?: AbortSignal): RecoveryQuarantineCommandOperations {
  return {
    list: () => listRecoveryQuarantineLocal(),
    clear: (request) => clearRecoveryQuarantineWithCoordinator(request, signal),
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
    recoveryQuarantine = createRecoveryQuarantineCommandOperations(),
    providerHosts = createProviderHostCommandOperations(),
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
        ...(liveHandoffResult?.publicationIncidents.map(handoffPublicationIncidentExitContribution) ?? []),
      ];
      process.exitCode = combineBackendStatusLocalExitContributions(localExitContributions);
    } catch (error) {
      emitError(error);
    }
  });

  const routingStatusCommand = backend.command('routing-status').description('Inspect and repair routing status');
  const resolveRoutingStatusCommand = routingStatusCommand
    .command('resolve')
    .description('Resolve one retained routing invocation after its owner is no longer authoritative')
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
        if (result.kind === 'refused') {
          const exitCode = result.status.kind === 'absent' ? 0 : 75;
          process.stderr.write(`${formatRoutingStatusDiscardRefusal(result)}\n`);
          process.exitCode = exitCode;
          return;
        }
        process.stdout.write(`Quarantined routing status from ${result.artifactPath} at ${result.quarantinePath}.\n`);
        process.exitCode = 0;
      } catch (error: unknown) {
        emitError(error);
      }
    });

  const shutdownCommand = backend.command('shutdown');
  shutdownCommand.description('Gracefully shut down backend daemon').action(async () => {
    try {
      const result = await shutdownBackend(getPluginRoot());
      const text = formatShutdown(result);

      if (result.ok) {
        process.stdout.write(text + '\n');
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
  recoveryQuarantineCommand
    .command('clear')
    .description('Retry one exact retained recovery failure through the canonical coordinator')
    .requiredOption('--boundary <boundary>', 'Recovery boundary shown by recovery-quarantine list')
    .requiredOption('--key <key>', 'Recovery subject key shown by recovery-quarantine list')
    .requiredOption('--revision <revision>', "Exact revision shown by list, including 'until-cleared'")
    .action(async (options: { boundary: string; key: string; revision: string }) => {
      try {
        const request = parseRecoveryQuarantineClearOptions(options);
        const result = await recoveryQuarantine.clear(request);
        process.stdout.write(`${formatRecoveryQuarantineClear(result)}\n`);
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
          const { continuation, publicationIncidents } = projectHandoffRunResult(handoffResult);
          renderHandoffPublicationIncidents(publicationIncidents.filter((incident) => incident.phase === 'terminal'));
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

/**
 * Accepts a coordinate exactly as `recovery-quarantine list` prints it, which is what this command's
 * own error message tells the operator to copy.
 *
 * `list` renders each field with `JSON.stringify`, so a subject key containing a character JSON escapes
 * reaches the terminal as an escape sequence — and `session-retention-work` joins its two identifiers
 * with a NUL (see `workKey` in `src/sessions/retention-work-item-recovery-source.ts`), which argv cannot
 * carry at all. Passing the
 * printed text through verbatim therefore never matched the stored key, and no other input could:
 * copying gave a literal backslash-u, and the real byte cannot survive a command line. Those rows were
 * unreachable by the one command documented to reach them.
 *
 * Unquoting here rather than changing the stored key keeps existing durable rows addressable; the key's
 * shape is the recovery source's business, not the CLI's.
 */
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

function parseRecoveryQuarantineClearOptions(options: {
  readonly boundary: string;
  readonly key: string;
  readonly revision: string;
}): RecoveryQuarantineClearRequest {
  const revision = unquoteRecoveryCoordinate(options.revision);
  const parsed = recoveryQuarantineClearRequestSchema.safeParse({
    boundary: unquoteRecoveryCoordinate(options.boundary),
    key: unquoteRecoveryCoordinate(options.key),
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
    if (isRecoveryQuarantineTimeout(error)) {
      throw new Error(
        'Recovery quarantine clear timed out before the coordinator returned a result. Run coral-cli backend status, then retry the exact clear.',
        { cause: error },
      );
    }
    throw recoveryCoordinatorRequiredError();
  }
}

class RecoveryQuarantineContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryQuarantineContractError';
  }
}

function isRecoveryQuarantineTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out|deadline (?:already )?exceeded/iu.test(error.message);
}

function recoveryCoordinatorRequiredError(): BackendUnreachableError {
  return new BackendUnreachableError(
    'Recovery quarantine clear requires the canonical coordinator, but it is not reachable. Run coral-cli backend status, start or repair the coordinator, then retry the exact clear.',
  );
}
