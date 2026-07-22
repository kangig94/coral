import type { StoragePort } from '../../infra/port-types.js';
import { readString } from '../../infra/json.js';
import type { ProviderArtifactHandleInput, ProviderRecoveryContract, ProviderTerminalOutcome } from '../contract.js';
import { defineProvider, type ProviderDefinition } from '../registry.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { claudeArtifactCapability, locateClaudeJsonlArtifact } from './artifacts.js';
import { claudeBindingCodec } from './binding.js';
import {
  buildClaudeExecutionPlan,
  buildClaudePreflightRuntime,
  type ClaudeCredentialSource,
  type ClaudeExecutionPlan,
} from './execution-plan.js';
import { claudeCurationCapability } from './one-shot.js';
import { claudeProvider } from './provider.js';
import { claudeAppServerLifecycle, claudePreflight, claudeRecoveryLifecycle } from './provider-facets.js';

type ArtifactRecoveryOptions = Parameters<ProviderRecoveryContract<ClaudeCredentialSource>['finalizeFromArtifacts']>[0];

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
  const conversationRef = readString(options.fallbackConversationRef);
  if (conversationRef === undefined) return undefined;

  const knownMatches = options.knownArtifactHandles?.filter(
    (artifact) => readString(artifact.identity.conversationRef) === conversationRef,
  );
  if (knownMatches !== undefined && knownMatches.length > 0) return knownMatches;
  return artifactHandlesFromLocator(
    locateClaudeJsonlArtifact({
      conversationRef,
      projectsRoot: options.source.projectsRoot,
      storage: options.storage,
    }),
  );
}

function artifactOutcome(options: ArtifactRecoveryOptions): ProviderTerminalOutcome {
  if (options.signal !== null) return { kind: 'aborted', reason: 'signal_abort' };
  if (typeof options.exitCode === 'number' && options.exitCode !== 0) {
    return {
      kind: 'provider_exit',
      code: options.exitCode,
      note: `Claude exited with code ${options.exitCode} before recovery completed.`,
    };
  }
  return { kind: 'completed' };
}

function artifactContinuity(
  artifactHandles: readonly ProviderArtifactHandleInput[] | undefined,
): Awaited<ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']>>['continuity'] {
  const conversationRef = artifactHandles
    ?.map((artifact) => readString(artifact.identity.conversationRef))
    .find((value) => value !== undefined);
  return conversationRef === undefined
    ? { conversationRef: null, resumable: false }
    : { conversationRef, resumable: true };
}

async function finalizeFromArtifacts(
  options: ArtifactRecoveryOptions,
): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']> {
  const artifactHandles = locateArtifactsForRecovery(options);
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
    continuity: artifactContinuity(artifactHandles),
    artifactHandles,
  };
}

const recovery: ProviderRecoveryContract<ClaudeCredentialSource> = {
  finalizeInterrupted: claudeRecoveryLifecycle.finalizeInterrupted.bind(claudeRecoveryLifecycle),
  finalizeFromArtifacts,
};

export const claudeProviderDefinition: ProviderDefinition = defineProvider<ClaudeExecutionPlan, ClaudeCredentialSource>(
  {
    name: 'claude',
    run: claudeProvider,
    prepareExecutionPlan(input) {
      return buildClaudeExecutionPlan(input);
    },
    preflight: (input) => claudePreflight(buildClaudePreflightRuntime(input)),
    appServer: claudeAppServerLifecycle,
    recovery,
    curation: claudeCurationCapability,
  },
)
  .binding(claudeBindingCodec)
  .artifacts(claudeArtifactCapability)
  .build();
