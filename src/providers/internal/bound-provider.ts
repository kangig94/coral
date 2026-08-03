import {
  bindingFailure,
  bindingSuccess,
  type ProviderBindingResult,
  type ProviderBindingRuntime,
  type ProviderBindingUse,
  type ProviderReadiness,
} from '../contracts/binding.js';
import type {
  ArtifactCleanupRuntime,
  ProviderArtifactCapability,
  ProviderArtifactHandle,
  AppServerSession,
  AppServerTransport,
  HostRef,
  ProviderCurationRequest,
  ProviderCurationUsageRuntime,
  ProviderImplementation,
  ProviderAppServerImplementation,
  ProviderStandaloneImplementation,
  ProviderPreflightInput,
  ProviderRequest,
  ProviderRecoveryContract,
  ProviderRuntime,
  ProviderEventBody,
  ProviderServerSpec,
} from '../contract.js';
import type { ProviderCliRequest } from '../protocol.js';
import type { ProviderValueParseResult } from '../binding-parser-contract.js';
import type {
  ProviderValidatedSessionContinuityMutation,
  SessionContinuityMutation,
} from '../../sessions/continuity-mutation.js';
import type { ProviderValidatedContinuityBlob } from '../../sessions/continuity.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import type {
  BoundProvider,
  BoundProviderAppServerCapability,
  BoundProviderArtifacts,
  BoundProviderCuration,
  BoundProviderHostPreparationInput,
  BoundProviderAppServerExecutionRuntime,
  BoundProviderStandaloneExecutionRuntime,
  BoundProviderPreparedExecution,
  BoundProviderRecovery,
} from '../bound-provider-contract.js';
import type { AppServerHostAuthority, ManagedHostSession } from './app-server-host.js';
import { providerBindingEnvelopeSchema } from '../../infra/provider-binding-envelope.js';
import { jsonValueSchema, type JsonValue } from '../../infra/json-value.js';
import { wrapAppServerSession } from './server-lease-boundary.js';
import {
  snapshotAppServerExecutionRuntime,
  snapshotEventStream,
  snapshotStandaloneExecutionRuntime,
} from './runtime-boundary.js';
import {
  snapshotArtifactHandles,
  snapshotBoundaryData,
  snapshotCliRequest,
  snapshotPlainReceiver,
  snapshotProviderResult,
  snapshotRequest,
  snapshotAccess,
} from './snapshot.js';

export interface CapturedBoundCodec<Access extends JsonValue> {
  readonly bindingKind: 'account' | 'profile';
  parseBinding(binding: unknown): ProviderValueParseResult<unknown>;
  parseContinuity(continuity: unknown): ProviderValueParseResult<Record<string, unknown>>;
  presentBinding(binding: unknown): string;
  access(binding: unknown): Access;
  readiness(
    binding: unknown,
    use: ProviderBindingUse,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<ProviderReadiness>>;
  compareBinding(left: unknown, right: unknown): ProviderBindingResult<true>;
}

type BoundContinuityDecoder = (
  rawContinuity: unknown,
) => ProviderBindingResult<ProviderValidatedContinuityBlob | undefined>;

function decodeBoundContinuity(
  provider: string,
  codec: CapturedBoundCodec<JsonValue>,
  rawContinuity: unknown,
): ProviderBindingResult<ProviderValidatedContinuityBlob | undefined> {
  if (rawContinuity === null || rawContinuity === undefined) {
    return bindingSuccess<ProviderValidatedContinuityBlob | undefined>(undefined);
  }
  const parsed = codec.parseContinuity(snapshotBoundaryData(rawContinuity, 'Provider continuity parser input'));
  return parsed.success
    ? bindingSuccess(
        snapshotBoundaryData(
          jsonValueSchema.parse(parsed.data),
          'Decoded provider continuity',
        ) as ProviderValidatedContinuityBlob,
      )
    : bindingFailure({ reason: 'invalid-persisted-binding', provider });
}

function requireBoundContinuity(
  provider: string,
  decodeContinuity: BoundContinuityDecoder,
  rawContinuity: unknown,
  label: string,
): ProviderValidatedContinuityBlob {
  const decoded = decodeContinuity(rawContinuity);
  if (!decoded.ok || decoded.value === undefined) {
    throw new TypeError(`Provider '${provider}' produced invalid ${label}.`);
  }
  return decoded.value;
}

function canonicalizeContinuityMutation(
  provider: string,
  decodeContinuity: BoundContinuityDecoder,
  mutation: SessionContinuityMutation,
): ProviderValidatedSessionContinuityMutation {
  if (mutation.providerContinuity === undefined) {
    return snapshotProviderResult(
      mutation,
      'Provider recovery continuity mutation',
    ) as ProviderValidatedSessionContinuityMutation;
  }
  return snapshotProviderResult(
    {
      ...mutation,
      providerContinuity: requireBoundContinuity(
        provider,
        decodeContinuity,
        mutation.providerContinuity,
        'recovery continuity mutation',
      ),
    },
    'Provider recovery continuity mutation',
  ) as ProviderValidatedSessionContinuityMutation;
}

function requireAppServerHost(authority: AppServerHostAuthority | undefined, provider: string): AppServerHostAuthority {
  if (authority === undefined) {
    throw new Error(`Provider '${provider}' has no connected app-server host authority.`);
  }
  return authority;
}

function providerAppServerSession<Plan extends ProviderExecutionPlan>(
  transport: AppServerTransport,
  capability: ProviderAppServerImplementation<Plan>['appServer'],
): AppServerSession {
  return Object.freeze({
    rpc: transport.rpc.bind(transport),
    subscribe: transport.subscribe.bind(transport),
    closed: transport.closed,
    interrupt: async (continuity: NonNullable<ProviderRuntime['persistedContinuity']>) => {
      if (capability.interrupt === undefined) return false;
      return capability.interrupt(transport, snapshotBoundaryData(continuity, 'Provider interrupt continuity'));
    },
  });
}

type PreparedBoundAppServer<Plan extends ProviderExecutionPlan> = {
  readonly hostPlan: Plan['host'];
  execute(
    runtime: BoundProviderAppServerExecutionRuntime,
    operation: (session: AppServerSession) => AsyncIterable<ProviderEventBody>,
  ): AsyncIterable<ProviderEventBody>;
};

interface BoundAppServerLifecycle<Plan extends ProviderExecutionPlan> extends BoundProviderAppServerCapability {
  prepareExecution(input: BoundProviderHostPreparationInput): PreparedBoundAppServer<Plan>;
  planCuration(
    request: ProviderCurationRequest,
    runtime: Parameters<BoundProviderCuration['prepare']>[1],
  ): Plan['host'];
  completeCuration(
    hostPlan: Plan['host'],
    signal: AbortSignal | undefined,
    operation: (session: AppServerSession) => Promise<string>,
  ): Promise<string>;
}

type BoundAppServerTools<Plan extends ProviderExecutionPlan> = Readonly<{
  providerName: string;
  capability: ProviderAppServerImplementation<Plan>['appServer'];
  host(): AppServerHostAuthority;
  planExecution(input: BoundProviderHostPreparationInput): Plan['host'];
  compileHost(hostPlan: Plan['host']): ProviderServerSpec;
  session(transport: AppServerTransport): AppServerSession;
}>;

function createBoundAppServerTools<Plan extends ProviderExecutionPlan, Access extends JsonValue>(
  implementation: ProviderAppServerImplementation<Plan, Access>,
  access: Access,
  appServerHost: AppServerHostAuthority | undefined,
): BoundAppServerTools<Plan> {
  const capability = implementation.appServer;
  return Object.freeze({
    providerName: implementation.name,
    capability,
    host: () => requireAppServerHost(appServerHost, implementation.name),
    planExecution: (input) =>
      capability.planHost({
        purpose: 'execution',
        request: snapshotRequest(input.request),
        ...(input.persistedContinuity === undefined
          ? {}
          : { persistedContinuity: snapshotBoundaryData(input.persistedContinuity, 'Provider host continuity') }),
        baseEnv: snapshotBoundaryData(input.baseEnv, 'Provider host base environment'),
        platform: input.platform,
        storage: input.storage,
        access,
      }),
    compileHost: (hostPlan) => {
      const spec = snapshotBoundaryData(capability.compileStableHost(hostPlan), 'Provider stable host specification');
      if (spec.provider !== implementation.name) {
        throw new Error(`Provider '${implementation.name}' compiled a stable host labeled for '${spec.provider}'.`);
      }
      return spec;
    },
    session: (transport) => providerAppServerSession(transport, capability),
  });
}

function subscribeBoundAppServerNotifications<Plan extends ProviderExecutionPlan>(
  tools: BoundAppServerTools<Plan>,
  managed: ManagedHostSession,
): () => void {
  const onNotification = tools.capability.onNotification;
  return onNotification === undefined ? () => {} : managed.session.subscribe(onNotification);
}

function closeManagedHostSession(managed: ManagedHostSession, unsubscribe: () => void): void {
  try {
    unsubscribe();
  } finally {
    managed.close();
  }
}

function executeBoundAppServer<Plan extends ProviderExecutionPlan>(
  tools: BoundAppServerTools<Plan>,
  hostPlan: Plan['host'],
  runtime: BoundProviderAppServerExecutionRuntime,
  operation: (session: AppServerSession) => AsyncIterable<ProviderEventBody>,
): AsyncIterable<ProviderEventBody> {
  return (async function* () {
    runtime.signal.throwIfAborted();
    const spec = tools.compileHost(hostPlan);
    runtime.onAppServerWaiting({ provider: spec.provider });
    const managed = await tools.host().openSession(spec, { jobId: runtime.jobId, signal: runtime.signal });
    let unsubscribe = () => {};
    try {
      runtime.signal.throwIfAborted();
      runtime.onHostRef(managed.hostRef);
      unsubscribe = subscribeBoundAppServerNotifications(tools, managed);
      yield* snapshotEventStream(operation(tools.session(managed.session)));
    } finally {
      closeManagedHostSession(managed, unsubscribe);
    }
  })();
}

async function completeBoundAppServerCuration<Plan extends ProviderExecutionPlan>(
  tools: BoundAppServerTools<Plan>,
  hostPlan: Plan['host'],
  signal: AbortSignal | undefined,
  operation: (session: AppServerSession) => Promise<string>,
): Promise<string> {
  const managed = await tools
    .host()
    .openSession(tools.compileHost(hostPlan), signal === undefined ? undefined : { signal });
  let unsubscribe = () => {};
  try {
    unsubscribe = subscribeBoundAppServerNotifications(tools, managed);
    return await operation(
      wrapAppServerSession(tools.session(managed.session), 'Provider prepared curation app-server session'),
    );
  } finally {
    closeManagedHostSession(managed, unsubscribe);
  }
}

async function openBoundReplacement<Plan extends ProviderExecutionPlan>(
  tools: BoundAppServerTools<Plan>,
  input: BoundProviderHostPreparationInput,
  runtime: { jobId: string; signal?: AbortSignal },
): Promise<Readonly<{ hostRef: HostRef; close(): void }>> {
  const managed = await tools.host().openSession(tools.compileHost(tools.planExecution(input)), {
    jobId: runtime.jobId,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  return Object.freeze({ hostRef: managed.hostRef, close: () => managed.close() });
}

async function attachExpectedBoundSession<Plan extends ProviderExecutionPlan>(
  tools: BoundAppServerTools<Plan>,
  hostRef: HostRef,
  input: BoundProviderHostPreparationInput & Readonly<{ jobId: string }>,
  label: string,
): Promise<Readonly<{ managed: ManagedHostSession; session: AppServerSession }> | null> {
  if (hostRef.provider !== tools.providerName) return null;
  const managed = await tools.host().attachSession(snapshotBoundaryData(hostRef, label), {
    spec: tools.compileHost(tools.planExecution(input)),
    jobId: input.jobId,
  });
  return managed === null ? null : Object.freeze({ managed, session: tools.session(managed.session) });
}

async function interruptBoundAppServer<Plan extends ProviderExecutionPlan>(
  tools: BoundAppServerTools<Plan>,
  hostRef: HostRef,
  continuity: NonNullable<ProviderRuntime['persistedContinuity']>,
  input: BoundProviderHostPreparationInput & Readonly<{ jobId: string }>,
): Promise<boolean> {
  if (tools.capability.interrupt === undefined) return false;
  const attached = await attachExpectedBoundSession(tools, hostRef, input, 'Provider interrupt host reference');
  if (attached === null) return false;
  try {
    return await attached.session.interrupt(continuity);
  } finally {
    attached.managed.close();
  }
}

async function probeBoundAppServer<Plan extends ProviderExecutionPlan>(
  tools: BoundAppServerTools<Plan>,
  decodeContinuity: BoundContinuityDecoder,
  hostRef: HostRef,
  continuity: NonNullable<ProviderRuntime['persistedContinuity']>,
  input: BoundProviderHostPreparationInput & Readonly<{ jobId: string }>,
): ReturnType<BoundProviderAppServerCapability['probe']> {
  if (tools.capability.probe === undefined) {
    throw new Error(`Provider '${tools.providerName}' has no interrupted recovery probe.`);
  }
  const attached = await attachExpectedBoundSession(tools, hostRef, input, 'Provider probe host reference');
  if (attached === null) return Object.freeze({ kind: 'stale' as const });
  try {
    const result = await tools.capability.probe(
      attached.managed.session,
      snapshotBoundaryData(continuity, 'Provider probe continuity'),
      { request: snapshotRequest(input.request) },
    );
    const outcome = snapshotProviderResult(result, 'Provider recovery probe outcome');
    return Object.freeze({
      kind: 'probed' as const,
      result:
        outcome.updatedContinuity === undefined
          ? outcome
          : Object.freeze({
              ...outcome,
              updatedContinuity: requireBoundContinuity(
                tools.providerName,
                decodeContinuity,
                outcome.updatedContinuity,
                'probe continuity',
              ),
            }),
    });
  } finally {
    attached.managed.close();
  }
}

function bindArtifacts<Access extends JsonValue>(
  artifacts: ProviderArtifactCapability<Access>,
  access: Access,
): BoundProviderArtifacts {
  if (artifacts.kind === 'none') return artifacts;
  const discardArtifacts = artifacts.discardArtifacts;
  const reconcileDiscard = artifacts.reconcileDiscard;
  const locateArtifact = artifacts.locateArtifact;
  return Object.freeze({
    kind: 'managed' as const,
    protocol: artifacts.protocol,
    discardArtifacts: (options: {
      handles: readonly ProviderArtifactHandle[];
      actionId: string;
      payloadHash: string;
      runtime: ArtifactCleanupRuntime;
    }) => {
      const input = snapshotPlainReceiver(options, 'Bound artifact discard input', new Set(['runtime']));
      return discardArtifacts(
        Object.freeze({
          handles: snapshotBoundaryData(input.handles, 'Bound artifact handles'),
          actionId: input.actionId,
          payloadHash: input.payloadHash,
          runtime: input.runtime,
          access,
        }),
      ).then((result) => snapshotProviderResult(result, 'Bound artifact discard outcome'));
    },
    reconcileDiscard: (options: {
      handles: readonly ProviderArtifactHandle[];
      actionId: string;
      payloadHash: string;
      runtime: ArtifactCleanupRuntime;
    }) => {
      const input = snapshotPlainReceiver(options, 'Bound artifact reconciliation input', new Set(['runtime']));
      return reconcileDiscard(
        Object.freeze({
          handles: snapshotBoundaryData(input.handles, 'Bound artifact handles'),
          actionId: input.actionId,
          payloadHash: input.payloadHash,
          runtime: input.runtime,
          access,
        }),
      ).then((result) => snapshotProviderResult(result, 'Bound artifact reconciliation outcome'));
    },
    ...(locateArtifact === undefined
      ? {}
      : {
          locateArtifact: (options: { conversationRef: string; runtime: ArtifactCleanupRuntime }) => {
            const input = snapshotPlainReceiver(options, 'Bound artifact location input', new Set(['runtime']));
            return snapshotProviderResult(
              locateArtifact(Object.freeze({ conversationRef: input.conversationRef, runtime: input.runtime, access })),
              'Bound artifact location outcome',
            );
          },
        }),
  });
}

function bindRecovery<Access extends JsonValue>(
  recovery: ProviderRecoveryContract<Access> | undefined,
  access: Access,
  provider: string,
  decodeContinuity: BoundContinuityDecoder,
): BoundProviderRecovery | undefined {
  if (recovery === undefined) return undefined;
  return Object.freeze({
    finalizeInterrupted: (...args: Parameters<ProviderRecoveryContract['finalizeInterrupted']>) =>
      canonicalizeContinuityMutation(provider, decodeContinuity, recovery.finalizeInterrupted(...args)),
    finalizeFromArtifacts: (
      options: Omit<Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0], 'access'>,
    ) => {
      const input = snapshotPlainReceiver(options, 'Bound artifact recovery input', new Set(['storage']));
      return recovery
        .finalizeFromArtifacts(
          Object.freeze({
            ...input,
            ...(input.knownArtifactHandles === undefined
              ? {}
              : { knownArtifactHandles: snapshotArtifactHandles(input.knownArtifactHandles) }),
            access,
          }),
        )
        .then((result) => snapshotProviderResult(result, 'Bound artifact recovery outcome'))
        .then((result) => {
          const continuity = result.continuity;
          if (continuity?.providerContinuity === undefined) return result;
          return Object.freeze({
            ...result,
            continuity: Object.freeze({
              ...continuity,
              providerContinuity: requireBoundContinuity(
                provider,
                decodeContinuity,
                continuity.providerContinuity,
                'artifact recovery continuity',
              ),
            }),
          });
        });
    },
    ...(recovery.extractProgress === undefined ? {} : { extractProgress: recovery.extractProgress }),
  });
}

function bindCuration<Plan extends ProviderExecutionPlan, Access extends JsonValue>(
  curation: ProviderAppServerImplementation<Plan, Access>['curation'] | undefined,
  appServer: BoundAppServerLifecycle<Plan> | undefined,
  access: Access,
): BoundProviderCuration | undefined {
  if (curation === undefined) return undefined;
  if (appServer === undefined) {
    throw new TypeError('Provider curation requires an app-server capability.');
  }
  return Object.freeze({
    prepare: (request: ProviderCurationRequest, runtime: Parameters<BoundProviderCuration['prepare']>[1]) => {
      const canonicalRequest = snapshotPlainReceiver(request, 'Provider curation request', new Set(['signal']));
      const canonicalRuntime = snapshotPlainReceiver(runtime, 'Provider curation runtime', new Set(['storage', 'ids']));
      const hostPlan = appServer.planCuration(canonicalRequest, canonicalRuntime);
      const prepared = curation.prepare(
        canonicalRequest,
        Object.freeze({
          storage: canonicalRuntime.storage,
          ids: canonicalRuntime.ids,
          baseEnv: snapshotBoundaryData(canonicalRuntime.baseEnv, 'Provider curation environment'),
          platform: canonicalRuntime.platform,
          access,
        }),
      );
      const receiver = snapshotPlainReceiver(prepared, 'Prepared provider curation');
      return Object.freeze({
        complete: () =>
          appServer.completeCuration(hostPlan, canonicalRequest.signal, (session) =>
            receiver.complete.call(receiver, Object.freeze({ appServerSession: session })),
          ),
      });
    },
    isUsageBudgetExhausted: (runtime: ProviderCurationUsageRuntime) => {
      const canonicalRuntime = snapshotPlainReceiver(runtime, 'Provider curation usage runtime', new Set(['storage']));
      return curation.isUsageBudgetExhausted(
        Object.freeze({
          storage: canonicalRuntime.storage,
          now: canonicalRuntime.now,
          access,
        }),
      );
    },
  });
}

function createBoundAppServerLifecycle<Plan extends ProviderExecutionPlan, Access extends JsonValue>(
  implementation: ProviderImplementation<Plan, Access>,
  access: Access,
  appServerHost: AppServerHostAuthority | undefined,
  decodeContinuity: BoundContinuityDecoder,
): BoundAppServerLifecycle<Plan> | undefined {
  if (implementation.transport === 'standalone') return undefined;
  const tools = createBoundAppServerTools(implementation, access, appServerHost);

  const lifecycle: BoundAppServerLifecycle<Plan> = {
    supportsInterrupt: tools.capability.interrupt !== undefined,
    supportsProbe: tools.capability.probe !== undefined,
    prepareExecution: (input) => {
      const hostPlan = tools.planExecution(input);
      return Object.freeze({
        hostPlan,
        execute: (runtime, operation) => executeBoundAppServer(tools, hostPlan, runtime, operation),
      });
    },
    planCuration: (request, runtime) =>
      tools.capability.planHost({
        purpose: 'curation',
        request,
        baseEnv: snapshotBoundaryData(runtime.baseEnv, 'Provider curation environment'),
        platform: runtime.platform,
        storage: runtime.storage,
        access,
      }),
    completeCuration: (hostPlan, signal, operation) =>
      completeBoundAppServerCuration(tools, hostPlan, signal, operation),
    openReplacement: (input, runtime) => openBoundReplacement(tools, input, runtime),
    interrupt: (hostRef, continuity, input) => interruptBoundAppServer(tools, hostRef, continuity, input),
    probe: (hostRef, continuity, input) => probeBoundAppServer(tools, decodeContinuity, hostRef, continuity, input),
  };
  return Object.freeze(lifecycle);
}

function prepareExecution<Plan extends ProviderExecutionPlan, Access extends JsonValue>(
  implementation: ProviderImplementation<Plan, Access>,
  access: Access,
  input: Parameters<BoundProvider['prepareExecution']>[0],
  appServer: BoundAppServerLifecycle<Plan> | undefined,
): BoundProviderPreparedExecution {
  const canonicalInput = snapshotPlainReceiver(input, 'Provider execution preparation input', new Set(['storage']));
  const request = snapshotRequest(canonicalInput.request);
  const preparationContext = {
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
    access,
  };

  if (implementation.transport === 'standalone') {
    const receiver = snapshotPlainReceiver(
      implementation.prepareExecutionPlan(preparationContext),
      'Provider prepared standalone execution',
    );
    return sealPreparedStandaloneExecution(
      implementation,
      request,
      snapshotBoundaryData(receiver.plan, 'Provider standalone execution plan'),
      receiver.prepareCliRequest.bind(receiver),
    );
  }

  if (appServer === undefined) {
    throw new TypeError(`Provider '${implementation.name}' app-server lifecycle was not bound.`);
  }
  const preparedAppServer = appServer.prepareExecution(canonicalInput);
  const receiver = snapshotPlainReceiver(
    implementation.prepareExecutionPlan({ ...preparationContext, hostPlan: preparedAppServer.hostPlan }),
    'Provider prepared app-server execution',
  );
  const plan = snapshotBoundaryData(
    { host: preparedAppServer.hostPlan, session: receiver.session, turn: receiver.turn } as Plan,
    'Provider app-server execution plan',
  );
  return sealPreparedAppServerExecution(implementation, request, plan, preparedAppServer);
}

function sealPreparedStandaloneExecution<Plan extends ProviderExecutionPlan>(
  implementation: Pick<ProviderStandaloneImplementation<Plan>, 'run'>,
  request: ProviderRequest,
  plan: Plan,
  prepareCliRequest: (request: ProviderCliRequest) => ProviderCliRequest,
): BoundProviderPreparedExecution {
  return Object.freeze({
    kind: 'standalone' as const,
    prepareCliRequest: (request: ProviderCliRequest) =>
      snapshotCliRequest(prepareCliRequest(snapshotCliRequest(request))),
    execute: (runtime: BoundProviderStandaloneExecutionRuntime) =>
      snapshotEventStream(implementation.run(request, snapshotStandaloneExecutionRuntime(runtime, plan))),
  });
}

function sealPreparedAppServerExecution<Plan extends ProviderExecutionPlan>(
  implementation: Pick<ProviderAppServerImplementation<Plan>, 'run'>,
  request: ProviderRequest,
  plan: Plan,
  preparedAppServer: PreparedBoundAppServer<Plan>,
): BoundProviderPreparedExecution {
  return Object.freeze({
    kind: 'app-server' as const,
    execute: (runtime: BoundProviderAppServerExecutionRuntime) =>
      preparedAppServer.execute(runtime, (appServerSession) =>
        implementation.run(request, snapshotAppServerExecutionRuntime(runtime, plan, appServerSession)),
      ),
  });
}

function runPreflight<Plan extends ProviderExecutionPlan, Access extends JsonValue>(
  implementation: ProviderImplementation<Plan, Access>,
  access: Access,
  input: Omit<ProviderPreflightInput, 'access'>,
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
      access: access,
    }),
  );
}

export function rehydrateCodecBinding<Plan extends ProviderExecutionPlan, Access extends JsonValue>(
  provider: string,
  codec: CapturedBoundCodec<Access>,
  binding: unknown,
  implementation: ProviderImplementation<Plan, Access>,
  artifacts: ProviderArtifactCapability<Access>,
  appServerHost: AppServerHostAuthority | undefined,
): BoundProvider {
  const canonicalBinding = snapshotBoundaryData(jsonValueSchema.parse(binding), 'Provider binding');
  const envelope = snapshotBoundaryData(
    { provider, kind: codec.bindingKind, binding: canonicalBinding },
    'Provider binding envelope',
  );
  const presentation = codec.presentBinding(canonicalBinding);
  const access = snapshotAccess(codec.access(canonicalBinding));
  const decodeContinuity: BoundContinuityDecoder = (rawContinuity) =>
    decodeBoundContinuity(provider, codec, rawContinuity);
  const recovery = bindRecovery(implementation.recovery, access, provider, decodeContinuity);
  const appServer = createBoundAppServerLifecycle(implementation, access, appServerHost, decodeContinuity);
  const curation = bindCuration(
    implementation.transport === 'app-server' ? implementation.curation : undefined,
    appServer,
    access,
  );
  return Object.freeze({
    name: provider,
    envelope,
    present: () => presentation,
    readiness: async (use: ProviderBindingUse, runtime: ProviderBindingRuntime) =>
      snapshotProviderResult(await codec.readiness(canonicalBinding, use, runtime), 'Provider readiness result'),
    decodeContinuity,
    preflight: (input: Omit<ProviderPreflightInput, 'access'>) => runPreflight(implementation, access, input),
    prepareExecution: (input: Parameters<BoundProvider['prepareExecution']>[0]) =>
      prepareExecution(implementation, access, input, appServer),
    ...(appServer === undefined ? {} : { appServer }),
    ...(recovery === undefined ? {} : { recovery }),
    artifacts: bindArtifacts(artifacts, access),
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
