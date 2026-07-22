import {
  bindingFailure,
  type ProviderBindingResult,
  type ProviderBindingRuntime,
  type ProviderBindingUse,
  type ProviderReadiness,
} from '../contracts/binding.js';
import type {
  ArtifactCleanupRuntime,
  ProviderAppServerContract,
  ProviderArtifactCapability,
  ProviderArtifactHandle,
  ProviderCurationCompleteRuntime,
  ProviderCurationRequest,
  ProviderCurationUsageRuntime,
  ProviderImplementation,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRuntime,
} from '../contract.js';
import type { ProviderCliRequest } from '../protocol.js';
import type { ProviderValueParseResult } from '../binding-parser-contract.js';
import type {
  BoundProvider,
  BoundProviderArtifacts,
  BoundProviderCuration,
  BoundProviderPreparedExecution,
  BoundProviderRecovery,
} from '../bound-provider-contract.js';
import { providerBindingEnvelopeSchema } from '../../infra/provider-binding-envelope.js';
import { jsonValueSchema, type JsonValue } from '../../infra/json-value.js';
import { wrapAcquireServer } from './server-lease-boundary.js';
import { snapshotEventStream, snapshotExecutionRuntime } from './runtime-boundary.js';
import {
  snapshotArtifactHandles,
  snapshotBoundaryData,
  snapshotCliRequest,
  snapshotPlainReceiver,
  snapshotProviderResult,
  snapshotRequest,
  snapshotSource,
} from './snapshot.js';

export interface CapturedBoundCodec<Source extends JsonValue> {
  readonly bindingKind: 'account' | 'profile';
  parseBinding(binding: unknown): ProviderValueParseResult<unknown>;
  presentBinding(binding: unknown): string;
  credentialSource(binding: unknown): Source;
  readiness(
    binding: unknown,
    use: ProviderBindingUse,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderReadiness>>;
  compareBinding(left: unknown, right: unknown): ProviderBindingResult<true>;
}

function bindArtifacts<Source extends JsonValue>(
  artifacts: ProviderArtifactCapability<Source>,
  source: Source,
): BoundProviderArtifacts {
  if (artifacts.kind === 'none') return artifacts;
  const discardArtifacts = artifacts.discardArtifacts;
  const locateArtifact = artifacts.locateArtifact;
  return Object.freeze({
    kind: 'managed' as const,
    discardArtifacts: (options: { handles: readonly ProviderArtifactHandle[]; runtime: ArtifactCleanupRuntime }) => {
      const input = snapshotPlainReceiver(options, 'Bound artifact discard input', new Set(['runtime']));
      return discardArtifacts(
        Object.freeze({
          handles: snapshotBoundaryData(input.handles, 'Bound artifact handles'),
          runtime: input.runtime,
          source,
        }),
      ).then((result) => snapshotProviderResult(result, 'Bound artifact discard outcome'));
    },
    ...(locateArtifact === undefined
      ? {}
      : {
          locateArtifact: (options: { conversationRef: string; runtime: ArtifactCleanupRuntime }) => {
            const input = snapshotPlainReceiver(options, 'Bound artifact location input', new Set(['runtime']));
            return snapshotProviderResult(
              locateArtifact(Object.freeze({ conversationRef: input.conversationRef, runtime: input.runtime, source })),
              'Bound artifact location outcome',
            );
          },
        }),
  });
}

function bindRecovery<Source extends JsonValue>(
  recovery: ProviderRecoveryContract<Source> | undefined,
  source: Source,
): BoundProviderRecovery | undefined {
  if (recovery === undefined) return undefined;
  return Object.freeze({
    ...(recovery.probe === undefined ? {} : { probe: recovery.probe }),
    finalizeInterrupted: recovery.finalizeInterrupted,
    finalizeFromArtifacts: (
      options: Omit<Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0], 'source'>,
    ) => {
      const input = snapshotPlainReceiver(options, 'Bound artifact recovery input', new Set(['storage']));
      return recovery
        .finalizeFromArtifacts(
          Object.freeze({
            ...input,
            ...(input.knownArtifactHandles === undefined
              ? {}
              : { knownArtifactHandles: snapshotArtifactHandles(input.knownArtifactHandles) }),
            source,
          }),
        )
        .then((result) => snapshotProviderResult(result, 'Bound artifact recovery outcome'));
    },
    ...(recovery.extractProgress === undefined ? {} : { extractProgress: recovery.extractProgress }),
  });
}

function bindCuration<Source extends JsonValue>(
  curation: ProviderImplementation<unknown, Source>['curation'],
  source: Source,
): BoundProviderCuration | undefined {
  if (curation === undefined) return undefined;
  return Object.freeze({
    complete: (request: ProviderCurationRequest, runtime: ProviderCurationCompleteRuntime) => {
      const canonicalRequest = snapshotPlainReceiver(request, 'Provider curation request', new Set(['signal']));
      const canonicalRuntime = snapshotPlainReceiver(runtime, 'Provider curation runtime', new Set(['storage', 'ids']));
      return curation.complete(
        canonicalRequest,
        Object.freeze({
          storage: canonicalRuntime.storage,
          ids: canonicalRuntime.ids,
          baseEnv: snapshotBoundaryData(canonicalRuntime.baseEnv, 'Provider curation environment'),
          platform: canonicalRuntime.platform,
          acquireServer: wrapAcquireServer(
            canonicalRuntime,
            canonicalRuntime.acquireServer,
            'Provider curation acquire-server',
          ),
          source,
        }),
      );
    },
    isUsageBudgetExhausted: (runtime: ProviderCurationUsageRuntime) => {
      const canonicalRuntime = snapshotPlainReceiver(runtime, 'Provider curation usage runtime', new Set(['storage']));
      return curation.isUsageBudgetExhausted(
        Object.freeze({
          storage: canonicalRuntime.storage,
          now: canonicalRuntime.now,
          source,
        }),
      );
    },
  });
}

function prepareExecution<Context, Source extends JsonValue>(
  implementation: ProviderImplementation<Context, Source>,
  source: Source,
  input: Parameters<BoundProvider['prepareExecution']>[0],
): BoundProviderPreparedExecution {
  const canonicalInput = snapshotPlainReceiver(input, 'Provider execution preparation input');
  const request = snapshotRequest(canonicalInput.request);
  const prepared = implementation.prepareExecutionContext({
    request,
    baseEnv: snapshotBoundaryData(canonicalInput.baseEnv, 'Provider execution base environment'),
    ...(canonicalInput.protectedEnv === undefined
      ? {}
      : { protectedEnv: snapshotBoundaryData(canonicalInput.protectedEnv, 'Provider protected environment') }),
    platform: canonicalInput.platform,
    source,
  });
  const receiver = snapshotPlainReceiver(prepared, 'Provider prepared execution');
  const prepareCliRequest = receiver.prepareCliRequest;
  const context = receiver.context;
  const appServer = implementation.appServer;
  return Object.freeze({
    prepareCliRequest: (request: ProviderCliRequest) =>
      snapshotCliRequest(prepareCliRequest.call(receiver, snapshotCliRequest(request))),
    execute: (runtime: Omit<ProviderRuntime<never>, 'providerContext'>) =>
      snapshotEventStream(implementation.run(request, snapshotExecutionRuntime(runtime, context))),
    ...(appServer === undefined
      ? {}
      : {
          appServer: Object.freeze({
            name: appServer.name,
            subscriptionPhase: appServer.subscriptionPhase,
            buildServerSpec: (
              continuity: Parameters<ProviderAppServerContract<never>['buildServerSpec']>[1],
              ports: Parameters<ProviderAppServerContract<never>['buildServerSpec']>[2],
            ) => appServer.buildServerSpec(request, continuity, ports, context as never),
            ...(appServer.interrupt === undefined ? {} : { interrupt: appServer.interrupt }),
            ...(appServer.onNotification === undefined ? {} : { onNotification: appServer.onNotification }),
          }),
        }),
  });
}

function runPreflight<Context, Source extends JsonValue>(
  implementation: ProviderImplementation<Context, Source>,
  source: Source,
  input: Omit<ProviderPreflightInput, 'credentialSource'>,
): Promise<void> {
  if (implementation.preflight === undefined) return Promise.resolve();
  const canonical = snapshotPlainReceiver(
    input,
    'Provider preflight input',
    new Set(['process', 'storage', 'env', 'time']),
  );
  return implementation.preflight(
    Object.freeze({
      process: canonical.process,
      storage: canonical.storage,
      env: canonical.env,
      time: canonical.time,
      cwd: canonical.cwd,
      baseEnv: snapshotBoundaryData(canonical.baseEnv, 'Provider preflight base environment'),
      requestEnv: snapshotBoundaryData(canonical.requestEnv, 'Provider preflight request environment'),
      platform: canonical.platform,
      credentialSource: source,
    }),
  );
}

export function rehydrateCodecBinding<Context, Source extends JsonValue>(
  provider: string,
  codec: CapturedBoundCodec<Source>,
  binding: unknown,
  implementation: ProviderImplementation<Context, Source>,
  artifacts: ProviderArtifactCapability<Source>,
): BoundProvider {
  const canonicalBinding = snapshotBoundaryData(jsonValueSchema.parse(binding), 'Provider binding');
  const envelope = snapshotBoundaryData(
    { provider, kind: codec.bindingKind, binding: canonicalBinding },
    'Provider binding envelope',
  );
  const presentation = codec.presentBinding(canonicalBinding);
  const source = snapshotSource(codec.credentialSource(canonicalBinding));
  const recovery = bindRecovery(implementation.recovery, source);
  const curation = bindCuration(implementation.curation, source);
  return Object.freeze({
    name: provider,
    envelope,
    present: () => presentation,
    readiness: async (use: ProviderBindingUse, runtime: ProviderBindingRuntime) =>
      snapshotProviderResult(await codec.readiness(canonicalBinding, use, runtime), 'Provider readiness result'),
    preflight: (input: Omit<ProviderPreflightInput, 'credentialSource'>) => runPreflight(implementation, source, input),
    prepareExecution: (input: Parameters<BoundProvider['prepareExecution']>[0]) =>
      prepareExecution(implementation, source, input),
    ...(recovery === undefined ? {} : { recovery }),
    artifacts: bindArtifacts(artifacts, source),
    ...(curation === undefined ? {} : { curation }),
    compareIdentity(otherEnvelope: unknown) {
      const parsed = providerBindingEnvelopeSchema.safeParse(otherEnvelope);
      if (!parsed.success || parsed.data.provider !== provider || parsed.data.kind !== codec.bindingKind) {
        return bindingFailure({ reason: 'invalid-persisted-binding', provider });
      }
      const otherBinding = codec.parseBinding(parsed.data.binding);
      return otherBinding.success
        ? snapshotProviderResult(
            codec.compareBinding(
              canonicalBinding,
              snapshotBoundaryData(jsonValueSchema.parse(otherBinding.data), 'Compared provider binding'),
            ),
            'Provider identity comparison result',
          )
        : bindingFailure({ reason: 'invalid-persisted-binding', provider });
    },
  });
}
