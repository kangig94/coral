import {
  bindingFailure,
  type ProviderBindingResult,
  type ProviderBindingRuntime,
  type ProviderBindingUse,
  type ProviderReadiness,
} from '../contracts/binding.js';
import type {
  ArtifactCleanupRuntime,
  ProviderArtifactCapability,
  ProviderArtifactHandle,
  ProviderCurationRequest,
  ProviderCurationUsageRuntime,
  ProviderImplementation,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRuntime,
} from '../contract.js';
import type { ProviderCliRequest } from '../protocol.js';
import type { ProviderValueParseResult } from '../binding-parser-contract.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import type {
  BoundProvider,
  BoundProviderAppServerCapability,
  BoundProviderArtifacts,
  BoundProviderCuration,
  BoundProviderExecutionPreparationInput,
  BoundProviderPreparedExecution,
  BoundProviderPreparedStableHost,
  BoundProviderRecovery,
} from '../bound-provider-contract.js';
import { providerBindingEnvelopeSchema } from '../../infra/provider-binding-envelope.js';
import { jsonValueSchema, type JsonValue } from '../../infra/json-value.js';
import { wrapAcquirePreparedServer } from './server-lease-boundary.js';
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

function bindCuration<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  curation: ProviderImplementation<Plan, Source>['curation'],
  appServer: ProviderImplementation<Plan, Source>['appServer'],
  source: Source,
): BoundProviderCuration | undefined {
  if (curation === undefined) return undefined;
  if (appServer === undefined) {
    throw new TypeError('Provider curation requires an app-server capability.');
  }
  return Object.freeze({
    prepare: (request: ProviderCurationRequest, runtime: Parameters<BoundProviderCuration['prepare']>[1]) => {
      const canonicalRequest = snapshotPlainReceiver(request, 'Provider curation request', new Set(['signal']));
      const canonicalRuntime = snapshotPlainReceiver(runtime, 'Provider curation runtime', new Set(['storage', 'ids']));
      const prepared = curation.prepare(
        canonicalRequest,
        Object.freeze({
          storage: canonicalRuntime.storage,
          ids: canonicalRuntime.ids,
          baseEnv: snapshotBoundaryData(canonicalRuntime.baseEnv, 'Provider curation environment'),
          platform: canonicalRuntime.platform,
          source,
        }),
      );
      const receiver = snapshotPlainReceiver(prepared, 'Prepared provider curation');
      const hostPlan = snapshotBoundaryData(receiver.hostPlan, 'Prepared provider curation host plan');
      const turnEnv = snapshotBoundaryData(receiver.turnEnv, 'Prepared provider curation turn environment');
      const launch = snapshotBoundaryData(
        { host: appServer.compileStableHost(hostPlan), turnEnv },
        'Prepared provider curation launch',
      );
      return Object.freeze({
        launch,
        complete: (completionRuntime: Parameters<typeof receiver.complete>[0]) => {
          const canonicalCompletionRuntime = snapshotPlainReceiver(
            completionRuntime,
            'Provider prepared curation completion runtime',
          );
          const acquirePreparedServer = wrapAcquirePreparedServer(
            canonicalCompletionRuntime,
            canonicalCompletionRuntime.acquirePreparedServer,
            'Provider prepared curation acquisition',
          );
          return receiver.complete.call(receiver, Object.freeze({ acquirePreparedServer }));
        },
      });
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

function prepareStableHost<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  implementation: ProviderImplementation<Plan, Source>,
  source: Source,
  input: Omit<BoundProviderExecutionPreparationInput, 'protectedEnv'>,
): BoundProviderPreparedStableHost {
  const appServer = implementation.appServer;
  if (appServer === undefined) {
    throw new TypeError(`Provider '${implementation.name}' has no app-server capability.`);
  }
  const canonicalInput = snapshotPlainReceiver(input, 'Provider stable host preparation input', new Set(['storage']));
  const prepared = implementation.prepareExecutionPlan({
    source,
    request: snapshotRequest(canonicalInput.request),
    ...(canonicalInput.persistedContinuity === undefined
      ? {}
      : {
          persistedContinuity: snapshotBoundaryData(
            canonicalInput.persistedContinuity,
            'Provider attachment persisted continuity',
          ),
        }),
    baseEnv: snapshotBoundaryData(canonicalInput.baseEnv, 'Provider attachment base environment'),
    platform: canonicalInput.platform,
    storage: canonicalInput.storage,
  });
  const receiver = snapshotPlainReceiver(prepared, 'Provider stable host plan');
  return Object.freeze({
    host: snapshotBoundaryData(appServer.compileStableHost(receiver.plan.host), 'Provider stable host specification'),
  });
}

function bindAppServerCapability<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  implementation: ProviderImplementation<Plan, Source>,
  source: Source,
): BoundProviderAppServerCapability | undefined {
  const appServer = implementation.appServer;
  if (appServer === undefined) return undefined;
  return Object.freeze({
    name: appServer.name,
    subscriptionPhase: appServer.subscriptionPhase,
    prepareStableHost: (input: Omit<BoundProviderExecutionPreparationInput, 'protectedEnv'>) =>
      prepareStableHost(implementation, source, input),
    ...(appServer.interrupt === undefined ? {} : { interrupt: appServer.interrupt }),
    ...(appServer.onNotification === undefined ? {} : { onNotification: appServer.onNotification }),
  });
}

function prepareExecution<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  implementation: ProviderImplementation<Plan, Source>,
  source: Source,
  input: Parameters<BoundProvider['prepareExecution']>[0],
): BoundProviderPreparedExecution {
  const canonicalInput = snapshotPlainReceiver(input, 'Provider execution preparation input', new Set(['storage']));
  const request = snapshotRequest(canonicalInput.request);
  const prepared = implementation.prepareExecutionPlan({
    request,
    ...(canonicalInput.persistedContinuity === undefined
      ? {}
      : {
          persistedContinuity: snapshotBoundaryData(
            canonicalInput.persistedContinuity,
            'Provider persisted continuity',
          ),
        }),
    baseEnv: snapshotBoundaryData(canonicalInput.baseEnv, 'Provider execution base environment'),
    ...(canonicalInput.protectedEnv === undefined
      ? {}
      : { protectedEnv: snapshotBoundaryData(canonicalInput.protectedEnv, 'Provider protected environment') }),
    platform: canonicalInput.platform,
    storage: canonicalInput.storage,
    source,
  });
  const receiver = snapshotPlainReceiver(prepared, 'Provider prepared execution');
  const prepareCliRequest = receiver.prepareCliRequest;
  const plan = receiver.plan;
  const appServerTurnEnv = receiver.appServerTurnEnv;
  const appServer = implementation.appServer;
  let boundAppServer: BoundProviderPreparedExecution['appServer'];
  if (appServer !== undefined) {
    if (appServerTurnEnv === undefined) {
      throw new TypeError(`Provider '${implementation.name}' must prepare app-server turn environment additions.`);
    }
    const launch = {
      host: appServer.compileStableHost(plan.host),
      turnEnv: appServerTurnEnv,
    };
    boundAppServer = Object.freeze({
      name: appServer.name,
      subscriptionPhase: appServer.subscriptionPhase,
      launch: snapshotBoundaryData(launch, 'Provider app-server launch'),
      ...(appServer.interrupt === undefined ? {} : { interrupt: appServer.interrupt }),
      ...(appServer.onNotification === undefined ? {} : { onNotification: appServer.onNotification }),
    });
  }
  return Object.freeze({
    prepareCliRequest: (request: ProviderCliRequest) =>
      snapshotCliRequest(prepareCliRequest.call(receiver, snapshotCliRequest(request))),
    execute: (runtime: Omit<ProviderRuntime<never>, 'executionPlan'>) =>
      snapshotEventStream(implementation.run(request, snapshotExecutionRuntime(runtime, plan))),
    ...(boundAppServer === undefined ? {} : { appServer: boundAppServer }),
  });
}

function runPreflight<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  implementation: ProviderImplementation<Plan, Source>,
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

export function rehydrateCodecBinding<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  provider: string,
  codec: CapturedBoundCodec<Source>,
  binding: unknown,
  implementation: ProviderImplementation<Plan, Source>,
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
  const curation = bindCuration(implementation.curation, implementation.appServer, source);
  const appServer = bindAppServerCapability(implementation, source);
  return Object.freeze({
    name: provider,
    envelope,
    present: () => presentation,
    readiness: async (use: ProviderBindingUse, runtime: ProviderBindingRuntime) =>
      snapshotProviderResult(await codec.readiness(canonicalBinding, use, runtime), 'Provider readiness result'),
    preflight: (input: Omit<ProviderPreflightInput, 'credentialSource'>) => runPreflight(implementation, source, input),
    prepareExecution: (input: Parameters<BoundProvider['prepareExecution']>[0]) =>
      prepareExecution(implementation, source, input),
    ...(appServer === undefined ? {} : { appServer }),
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
