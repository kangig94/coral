import { InvalidArgumentError, type Command } from 'commander';

import { runHandoff } from '../../coordinator/handoff-runner.js';
import { resolveBuildFlavor, type BuildFlavor } from '../../infra/build-flavor.js';
import { readBuildFlavor } from '../../infra/bundle-manifest.js';
import { assertNever } from '../../infra/error-format.js';
import { BackendUnreachableError } from '../../infra/http-errors.js';
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
import { shutdownBackend } from '../../transport/http/backend/shutdown.js';
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
import {
  formatBackendStatus,
  formatRecoveryQuarantineClear,
  formatRecoveryQuarantineList,
  formatShutdown,
  RECOVERY_REVISION_FINGERPRINT_PREFIX,
  RECOVERY_REVISION_UNTIL_CLEARED,
} from '../format/backend.js';
import { formatStoreResetList, formatStoreResetReport } from '../format/store-reset.js';
import { renderHandoffNotice } from '../handoff-notice.js';
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
  recoveryQuarantine?: RecoveryQuarantineCommandOperations;
  providerHosts?: ProviderHostCommandOperations;
}>;

type RecoveryQuarantineReadRuntime = Pick<Runtime, 'flavor' | 'paths' | 'storage'>;

/** Reads retained recovery failures directly from the local store without coordinator transport. */
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

/** Wires the local read and canonical-coordinator retry used by backend command registration. */
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
    backendStatus = {
      inspectReadiness: () =>
        inspectGenerationReadiness(createRealRuntime(resolveBuildFlavor(process.env)), currentCoralStoreFormat()),
      getStatus: () => getBackendStatusFull(getPluginRoot()),
    },
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
      const status = await backendStatus.getStatus();
      process.stdout.write(formatBackendStatus(status) + '\n');
    } catch (error) {
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
      process.exitCode = 1;
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
          const continuation = await runHandoff(
            { kind: 'cli-invocation', argv: ['node', 'coral-cli', ...program.args] },
            { pluginRoot: getPluginRoot(), activeSelectionTarget: result.target },
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

function parseRecoveryQuarantineClearOptions(options: {
  readonly boundary: string;
  readonly key: string;
  readonly revision: string;
}): RecoveryQuarantineClearRequest {
  const parsed = recoveryQuarantineClearRequestSchema.safeParse({
    boundary: options.boundary,
    key: options.key,
    revision:
      options.revision === RECOVERY_REVISION_UNTIL_CLEARED
        ? null
        : options.revision.startsWith(RECOVERY_REVISION_FINGERPRINT_PREFIX)
          ? options.revision.slice(RECOVERY_REVISION_FINGERPRINT_PREFIX.length)
          : options.revision,
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
