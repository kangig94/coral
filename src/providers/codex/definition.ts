import { join } from 'node:path';

import type { StoragePort } from '../../infra/port-types.js';
import { readString } from '../../infra/json.js';
import type { ProviderArtifactHandleInput, ProviderRecoveryContract, ProviderTerminalOutcome } from '../contract.js';
import { defineProvider, type ProviderDefinition } from '../registry.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { codexArtifactCapability, locateCodexRolloutArtifact } from './artifacts.js';
import { codexBindingCodec } from './binding.js';
import {
  buildCodexExecutionPlan,
  buildCodexPreflightRuntime,
  type CodexProviderAccess,
  type CodexExecutionPlan,
} from './execution-plan.js';
import { codexAppServerLifecycle, codexPreflight, codexRecoveryLifecycle } from './provider-facets.js';
import { codexThreadProvider } from './thread-provider.js';

type ArtifactRecoveryOptions = Parameters<ProviderRecoveryContract<CodexProviderAccess>['finalizeFromArtifacts']>[0];

function readArtifact(storage: Pick<StoragePort, 'readFileSync'>, path: string): string {
  try {
    return storage.readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function artifactHandlesFromLocator(result: {
  readonly kind: string;
  readonly artifact?: ProviderArtifactHandleInput;
}): readonly ProviderArtifactHandleInput[] | undefined {
  return result.kind === 'match' && result.artifact ? [result.artifact] : undefined;
}

function locateArtifactsForRecovery(
  options: ArtifactRecoveryOptions,
): readonly ProviderArtifactHandleInput[] | undefined {
  if (options.knownArtifactHandles !== undefined && options.knownArtifactHandles.length > 0) {
    return options.knownArtifactHandles;
  }
  const threadId = readString(options.fallbackConversationRef);
  if (threadId === undefined) return undefined;
  return artifactHandlesFromLocator(
    locateCodexRolloutArtifact({
      threadId,
      sessionsRoot: join(options.access.home, 'sessions'),
      storage: options.storage,
    }),
  );
}

function artifactOutcome(options: ArtifactRecoveryOptions): ProviderTerminalOutcome {
  if (options.signal !== null) return { kind: 'aborted', reason: 'signal_abort' };
  if (options.exitCode === null || options.exitCode === 0) return { kind: 'completed' };
  return {
    kind: 'provider_exit',
    code: options.exitCode,
    note: `Codex exited with code ${options.exitCode} before recovery completed.`,
  };
}

async function finalizeFromArtifacts(
  options: ArtifactRecoveryOptions,
): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']> {
  return {
    terminal: {
      kind: 'terminal',
      terminal: buildJobTerminal({
        content: '',
        durationMs: options.durationMs,
        ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
        outcome: artifactOutcome(options),
      }),
      diagnostics: buildJobDiagnostics({
        stdout: readArtifact(options.storage, options.stdoutPath),
        stderr: readArtifact(options.storage, options.stderrPath),
      }),
    },
    continuity:
      readString(options.fallbackConversationRef) !== undefined
        ? undefined
        : { conversationRef: null, resumable: false },
    artifactHandles: locateArtifactsForRecovery(options),
  };
}

const recovery: ProviderRecoveryContract<CodexProviderAccess> = {
  finalizeInterrupted: codexRecoveryLifecycle.finalizeInterrupted.bind(codexRecoveryLifecycle),
  finalizeFromArtifacts,
};

export const codexProviderDefinition: ProviderDefinition = defineProvider<CodexExecutionPlan, CodexProviderAccess>({
  name: 'codex',
  transport: 'app-server',
  run: codexThreadProvider,
  prepareExecutionPlan: buildCodexExecutionPlan,
  preflight: (input) => codexPreflight(buildCodexPreflightRuntime(input)),
  appServer: codexAppServerLifecycle,
  recovery,
})
  .binding(codexBindingCodec)
  .artifacts(codexArtifactCapability)
  .build();
