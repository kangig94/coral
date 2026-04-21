import * as legacyCompat from '../shared/legacy-terminal-outcome-compat.js';
import { nowIsoString } from '../shared/utils.js';
import type { FaultPayload } from './fault.js';
import { providerRequestFailed } from './fault.js';
import {
  buildJobDiagnostics,
  buildJobTerminal,
} from './terminal.js';
import {
  providerProgressEvent,
  providerTerminalEvent,
  type ProviderEventBody as OldProviderEventBody,
  type ProviderRequest as OldProviderRequest,
  type ProviderTerminalEventBody as OldProviderTerminalEventBody,
} from './protocol.js';
import type {
  Provider as OldProvider,
  ProviderArtifactCleanup as OldProviderArtifactCleanup,
  ProviderExecutor,
  ProviderRuntime as OldProviderRuntime,
} from './provider-contracts.js';
import type {
  ProviderAppServerContract,
  ProviderContinuityBlob,
  ProviderEventBody,
  ProviderRecoveryContract,
  ProviderRuntime,
  ProviderSpec,
  ProviderTerminalEventBody,
  TerminalOutcome,
} from './contract.js';

type CompatFault = Parameters<(typeof legacyCompat)['describeLegacyCoralFault']>[0];
type CompatTurnOutcome = legacyCompat.ProviderTurnOutcomeCompat;

const LEGACY_PROVIDER = Symbol('legacyProvider');
type CompatBackedProviderSpec = ProviderSpec & { [LEGACY_PROVIDER]?: OldProvider };
type ProviderCatalogEntry = OldProvider | CompatBackedProviderSpec;

const NOOP_CONTINUITY_BRIDGE: ProviderRuntime['continuityBridge'] = {
  checkpoint: () => {},
  transportClosed: () => {},
};

export function toLegacyProviderExecutor(entry: ProviderCatalogEntry | undefined): ProviderExecutor | undefined {
  if (!entry) {
    return undefined;
  }
  if (isLegacyProvider(entry)) {
    return entry;
  }
  if (LEGACY_PROVIDER in entry && entry[LEGACY_PROVIDER]) {
    return entry[LEGACY_PROVIDER];
  }

  const execute = async function* (
    request: OldProviderRequest,
    runtime: OldProviderRuntime,
  ): AsyncIterable<OldProviderEventBody> {
    let continuity:
      | {
          conversationRef: string | null;
          resumable: boolean;
          providerContinuity: unknown;
        }
      | undefined;

    for await (const event of entry.run(request, toContractRuntime(runtime))) {
      switch (event.kind) {
        case 'progress':
          yield providerProgressEvent(event.message, nowIsoString());
          break;
        case 'continuity':
          continuity = event;
          runtime.continuityBridge?.checkpoint({
            conversationRef: event.conversationRef,
            resumable: event.resumable,
            ...(
              event.providerContinuity === undefined || event.providerContinuity === null
                ? {}
                : { providerContinuity: event.providerContinuity as ProviderContinuityBlob }
            ),
          });
          break;
        case 'terminal':
          yield providerTerminalEvent({
            content: event.terminal.content,
            ...(continuity?.conversationRef === null || continuity?.conversationRef === undefined
              ? {}
              : { conversationRef: continuity.conversationRef }),
            ...(event.terminal.model === undefined ? {} : { model: event.terminal.model }),
            ...(event.terminal.durationMs === undefined ? {} : { durationMs: event.terminal.durationMs }),
            ...(continuity?.resumable === false ? { nonResumable: true } : {}),
            ...(event.terminal.exitCode === undefined ? {} : { exitCode: event.terminal.exitCode }),
            ...(event.terminal.warnings === undefined ? {} : { warnings: [...event.terminal.warnings] }),
            ...(event.terminal.usage === undefined ? {} : { usage: { ...event.terminal.usage } }),
            outcome: toLegacyOutcome(event.terminal.outcome),
          });
          break;
      }
    }
  };

  Object.defineProperty(execute, 'name', { value: entry.name, configurable: true });
  return Object.assign(execute, {
    execute,
    ...(entry.preflight ? { preflight: entry.preflight } : {}),
  });
}

export function toProviderSpec(entry: ProviderCatalogEntry | undefined): ProviderSpec | undefined {
  if (!entry) {
    return undefined;
  }
  if (isProviderSpec(entry)) {
    return entry;
  }

  const run = async function* (
    request: Parameters<ProviderSpec['run']>[0],
    runtime: Parameters<ProviderSpec['run']>[1],
  ): AsyncIterable<ProviderEventBody> {
    const legacyRuntime = toLegacyRuntime(runtime);
    for await (const event of typeof entry === 'function' ? entry(request, legacyRuntime) : entry.execute(request, legacyRuntime)) {
      if (event.type === 'launch.progress') {
        yield {
          kind: 'progress',
          message: event.message,
        };
        continue;
      }

      const continuity = legacyTerminalToContinuity(event);
      if (continuity) {
        yield {
          kind: 'continuity',
          ...continuity,
          providerContinuity: null,
        };
      }
      yield {
        kind: 'terminal',
        terminal: buildJobTerminal({
          content: event.content,
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          ...(event.warnings === undefined ? {} : { warnings: event.warnings }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          outcome: toContractOutcome(entry.name, event.outcome),
        }),
        diagnostics: buildJobDiagnostics({}),
      };
    }
  };

  Object.defineProperty(run, 'name', { value: entry.name, configurable: true });
  const spec: CompatBackedProviderSpec = {
    name: entry.name,
    run,
    ...(entry.preflight ? { preflight: entry.preflight } : {}),
    ...(getProviderAppServer(entry) ? { appServer: getProviderAppServer(entry) } : {}),
    ...(getProviderRecovery(entry) ? { recovery: getProviderRecovery(entry) } : {}),
    ...(getProviderCleanup(entry) ? { cleanup: getProviderCleanup(entry) } : {}),
  };
  Object.defineProperty(spec, LEGACY_PROVIDER, { value: entry, enumerable: false, configurable: true });
  return spec;
}

export function getProviderAppServer(entry: ProviderCatalogEntry | undefined): ProviderAppServerContract | undefined {
  if (!entry) {
    return undefined;
  }
  if (isProviderSpec(entry)) {
    return entry.appServer;
  }

  const lifecycle = entry.appServerLifecycle;
  if (!lifecycle) {
    return undefined;
  }

  return {
    name: entry.name,
    subscriptionPhase: inferSubscriptionPhase(entry.name),
    buildServerSpec: (request, persistedContinuity) => lifecycle.buildServerSpec(persistedContinuity, request),
    interrupt: (lease, continuity) => lifecycle.interrupt(lease, continuity),
  };
}

export function getProviderRecovery(entry: ProviderCatalogEntry | undefined): ProviderRecoveryContract | undefined {
  if (!entry) {
    return undefined;
  }
  if (isProviderSpec(entry)) {
    return entry.recovery;
  }

  const artifactRecovery = entry.artifactRecovery;
  const appServerLifecycle = entry.appServerLifecycle;
  if (!artifactRecovery && !appServerLifecycle) {
    return undefined;
  }

  return {
    ...(appServerLifecycle?.probe ? { probe: appServerLifecycle.probe.bind(appServerLifecycle) } : {}),
    ...(appServerLifecycle?.finalizeInterrupted
      ? { finalizeInterrupted: appServerLifecycle.finalizeInterrupted.bind(appServerLifecycle) }
      : {}),
    finalizeFromArtifacts: artifactRecovery
      ? async (options) => adaptLegacyRecoveryResult(entry.name, await artifactRecovery.finalizeFromArtifacts(options))
      : async () => {
          throw new Error(`Provider ${entry.name} does not support artifact recovery.`);
        },
    ...(artifactRecovery?.buildRecoveryMeta
      ? { buildRecoveryMeta: artifactRecovery.buildRecoveryMeta.bind(artifactRecovery) }
      : {}),
    ...(artifactRecovery?.extractProgress
      ? { extractProgress: artifactRecovery.extractProgress.bind(artifactRecovery) }
      : {}),
  };
}

export function getProviderCleanup(
  entry: ProviderCatalogEntry | undefined,
): OldProviderArtifactCleanup | undefined {
  if (!entry) {
    return undefined;
  }
  if (isProviderSpec(entry)) {
    return entry.cleanup;
  }
  return entry.artifactCleanup;
}

export function migrateLegacyContinuity(
  entry: ProviderCatalogEntry | undefined,
  meta: Record<string, unknown>,
): ProviderContinuityBlob | undefined {
  if (!entry || isProviderSpec(entry)) {
    return undefined;
  }
  return entry.appServerLifecycle?.migrateLegacyContinuity?.(meta);
}

function isProviderSpec(entry: ProviderCatalogEntry): entry is ProviderSpec {
  return 'run' in entry;
}

function isLegacyProvider(entry: ProviderCatalogEntry): entry is OldProvider {
  return !('run' in entry);
}

function inferSubscriptionPhase(name: string): 'beforeInitialize' | 'afterInitialize' {
  return name === 'claude' ? 'beforeInitialize' : 'afterInitialize';
}

function toContractRuntime(runtime: OldProviderRuntime): ProviderRuntime {
  return {
    signal: runtime.signal,
    runCli: runtime.runCli,
    storage: runtime.storage,
    env: runtime.env,
    acquireServer: runtime.acquireServer ?? missingAcquireServer,
    persistedContinuity: runtime.persistedContinuity,
    continuityBridge: runtime.continuityBridge ?? NOOP_CONTINUITY_BRIDGE,
  };
}

function toLegacyRuntime(runtime: ProviderRuntime): OldProviderRuntime {
  return {
    signal: runtime.signal,
    runCli: runtime.runCli,
    storage: runtime.storage,
    env: runtime.env,
    acquireServer: runtime.acquireServer,
    persistedContinuity: runtime.persistedContinuity,
    continuityBridge: runtime.continuityBridge,
  };
}

async function missingAcquireServer(_spec: { provider: string }): Promise<never> {
  throw new Error('Provider runtime requires acquireServer().');
}

function toLegacyOutcome(outcome: TerminalOutcome): CompatTurnOutcome {
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'completed' };
    case 'aborted':
      return { kind: 'aborted', reason: outcome.reason };
    case 'failed':
      return {
        kind: 'legacy_fault',
        fault: toLegacyFault(outcome.fault),
      };
  }
}

function toLegacyFault(fault: FaultPayload): CompatFault {
  switch (fault.kind) {
    case 'adapter_output_unparseable':
      return {
        kind: 'adapter_output_unparseable',
        provider: legacyProviderName(fault.provider),
        exitCode: fault.exitCode,
        stdout: fault.stdout,
        stderr: fault.stderr,
        parseError: fault.parseError,
      };
    case 'provider_session_unavailable':
      return {
        kind: 'provider_session_unavailable',
        provider: legacyProviderName(fault.provider),
        note: fault.reason,
      };
    case 'provider_request_failed':
      return {
        kind: 'provider_request_failed',
        provider: legacyProviderName(fault.provider),
        message: fault.message,
      };
  }
}

function adaptLegacyRecoveryResult(
  providerName: string,
  legacy: OldProviderTerminalEventBody,
): Promise<{
  terminal: ProviderTerminalEventBody;
  continuity?: {
    conversationRef: string | null;
    resumable: boolean;
    providerContinuity?: ProviderContinuityBlob;
  };
}> {
  return Promise.resolve({
    terminal: {
      kind: 'terminal',
      terminal: buildJobTerminal({
        content: legacy.content,
        ...(legacy.model === undefined ? {} : { model: legacy.model }),
        ...(legacy.durationMs === undefined ? {} : { durationMs: legacy.durationMs }),
        ...(legacy.exitCode === undefined ? {} : { exitCode: legacy.exitCode }),
        ...(legacy.warnings === undefined ? {} : { warnings: legacy.warnings }),
        ...(legacy.usage === undefined ? {} : { usage: legacy.usage }),
        outcome: toContractOutcome(providerName, legacy.outcome),
      }),
      diagnostics: buildJobDiagnostics({}),
    },
    continuity: legacyTerminalToContinuity(legacy),
  });
}

function toContractOutcome(providerName: string, outcome: CompatTurnOutcome): TerminalOutcome {
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'completed' };
    case 'aborted':
      return { kind: 'aborted', reason: outcome.reason };
    case 'provider_exit':
      if (outcome.code === 0) {
        return { kind: 'completed' };
      }
      return {
        kind: 'failed',
        fault: providerRequestFailed({
          provider: providerName,
          message: outcome.note ?? `Provider exited with code ${outcome.code}.`,
        }),
      };
    case 'legacy_fault':
      return {
        kind: 'failed',
        fault: toContractFault(providerName, outcome.fault),
      };
    default:
      return {
        kind: 'failed',
        fault: providerRequestFailed({
          provider: providerName,
          message: `Unknown legacy outcome kind: ${JSON.stringify(outcome)}`,
        }),
      };
  }
}

function toContractFault(providerName: string, fault: CompatFault): FaultPayload {
  switch (fault.kind) {
    case 'adapter_output_unparseable':
      return {
        kind: 'adapter_output_unparseable',
        provider: fault.provider,
        exitCode: fault.exitCode,
        stdout: fault.stdout,
        stderr: fault.stderr,
        parseError: fault.parseError,
      };
    case 'provider_session_unavailable':
      return {
        kind: 'provider_session_unavailable',
        provider: fault.provider,
        reason: fault.note,
      };
    case 'provider_request_failed':
      return {
        kind: 'provider_request_failed',
        provider: fault.provider,
        message: fault.message,
      };
    default:
      return providerRequestFailed({
        provider: providerName,
        message: legacyCompat['describeLegacyCoralFault'](fault),
      });
  }
}

function legacyTerminalToContinuity(legacy: OldProviderTerminalEventBody):
  | {
      conversationRef: string | null;
      resumable: boolean;
      providerContinuity?: ProviderContinuityBlob;
    }
  | undefined {
  if (legacy.conversationRef !== undefined) {
    return {
      conversationRef: legacy.conversationRef,
      resumable: true,
    };
  }
  if (legacy.nonResumable === true) {
    return {
      conversationRef: null,
      resumable: false,
    };
  }
  return undefined;
}

function legacyProviderName(provider: string): 'claude' | 'codex' {
  return provider === 'claude' ? 'claude' : 'codex';
}
