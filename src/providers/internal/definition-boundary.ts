import type {
  ProviderAppServerCapability,
  ProviderArtifactCapability,
  ProviderAppServerImplementation,
  ProviderCurationCapability,
  ProviderImplementation,
  ProviderHostPlanningInput,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderAppServerRuntime,
  ProviderStandaloneRuntime,
  ProviderStandaloneImplementation,
} from '../contract.js';
import type { JsonValue } from '../../infra/json-value.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import { wrapAppServerTransport } from './server-lease-boundary.js';
import { snapshotBoundaryData, snapshotPlainReceiver, snapshotProviderResult } from './snapshot.js';

function snapshotAppServer<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  capability: ProviderAppServerCapability<Plan, Source> | undefined,
): ProviderAppServerCapability<Plan, Source> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider app-server capability');
  const planHost = receiver.planHost;
  if (typeof planHost !== 'function') {
    throw new TypeError('Provider app-server capability.planHost must be a function.');
  }
  const compileStableHost = receiver.compileStableHost;
  if (typeof compileStableHost !== 'function') {
    throw new TypeError('Provider app-server capability.compileStableHost must be a function.');
  }
  const interrupt = receiver.interrupt;
  const probe = receiver.probe;
  const onNotification = receiver.onNotification;
  return Object.freeze({
    name: receiver.name,
    planHost: (input: ProviderHostPlanningInput<Source>) => {
      const canonicalInput = snapshotPlainReceiver(
        input,
        'Provider host planning input',
        new Set(['storage', 'request']),
      );
      const common = {
        source: snapshotBoundaryData(canonicalInput.source, 'Provider host credential source'),
        baseEnv: snapshotBoundaryData(canonicalInput.baseEnv, 'Provider host base environment'),
        platform: canonicalInput.platform,
        storage: canonicalInput.storage,
      };
      const providerInput: ProviderHostPlanningInput<Source> =
        canonicalInput.purpose === 'execution'
          ? {
              ...common,
              purpose: 'execution',
              request: snapshotBoundaryData(canonicalInput.request, 'Provider host request'),
              ...(canonicalInput.persistedContinuity === undefined
                ? {}
                : {
                    persistedContinuity: snapshotBoundaryData(
                      canonicalInput.persistedContinuity,
                      'Provider host continuity',
                    ),
                  }),
            }
          : {
              ...common,
              purpose: 'curation',
              request: snapshotPlainReceiver(
                canonicalInput.request,
                'Provider host curation request',
                new Set(['signal']),
              ),
            };
      return snapshotBoundaryData(planHost.call(receiver, providerInput), 'Provider stable host plan');
    },
    compileStableHost: (host: Plan['host']) =>
      snapshotBoundaryData(
        compileStableHost.call(receiver, snapshotBoundaryData(host, 'Provider stable host plan')),
        'Provider stable host specification',
      ),
    ...(interrupt === undefined
      ? {}
      : {
          interrupt: (...args: Parameters<NonNullable<ProviderAppServerCapability<Plan, Source>['interrupt']>>) =>
            interrupt.call(
              receiver,
              wrapAppServerTransport(args[0], 'Provider interrupt session'),
              snapshotBoundaryData(args[1], 'Provider interrupt continuity'),
            ),
        }),
    ...(probe === undefined
      ? {}
      : {
          probe: (...args: Parameters<NonNullable<ProviderAppServerCapability<Plan, Source>['probe']>>) =>
            probe
              .call(
                receiver,
                wrapAppServerTransport(args[0], 'Provider recovery session'),
                snapshotBoundaryData(args[1], 'Provider recovery continuity'),
                { request: snapshotBoundaryData(args[2].request, 'Provider recovery request') },
              )
              .then((result) => snapshotProviderResult(result, 'Provider recovery probe outcome')),
        }),
    ...(onNotification === undefined
      ? {}
      : {
          onNotification: (
            ...args: Parameters<NonNullable<ProviderAppServerCapability<Plan, Source>['onNotification']>>
          ) => onNotification.call(receiver, snapshotBoundaryData(args[0], 'Provider app-server notification')),
        }),
  });
}

function snapshotRecovery<Source extends JsonValue>(
  capability: ProviderRecoveryContract<Source> | undefined,
): ProviderRecoveryContract<Source> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider recovery capability');
  const finalizeInterrupted = receiver.finalizeInterrupted;
  const finalizeFromArtifacts = receiver.finalizeFromArtifacts;
  const extractProgress = receiver.extractProgress;
  return Object.freeze({
    finalizeInterrupted: (...args: Parameters<ProviderRecoveryContract<Source>['finalizeInterrupted']>) =>
      snapshotProviderResult(
        finalizeInterrupted.call(
          receiver,
          snapshotBoundaryData(args[0], 'Provider recovery probe result'),
          snapshotBoundaryData(args[1], 'Provider recovery continuity'),
          snapshotBoundaryData(args[2], 'Provider recovery context'),
        ),
        'Provider interrupted recovery outcome',
      ),
    finalizeFromArtifacts: (...args: Parameters<ProviderRecoveryContract<Source>['finalizeFromArtifacts']>) =>
      finalizeFromArtifacts
        .call(
          receiver,
          snapshotPlainReceiver(args[0], 'Provider artifact recovery input', new Set(['storage'])) as (typeof args)[0],
        )
        .then((result) => snapshotProviderResult(result, 'Provider artifact recovery outcome')),
    ...(extractProgress === undefined
      ? {}
      : {
          extractProgress: (...args: Parameters<NonNullable<ProviderRecoveryContract<Source>['extractProgress']>>) =>
            snapshotProviderResult(
              extractProgress.call(receiver, snapshotBoundaryData(args[0], 'Provider recovery progress input')),
              'Provider recovery progress outcome',
            ),
        }),
  });
}

function snapshotCuration<Source extends JsonValue>(
  capability: ProviderCurationCapability<Source> | undefined,
): ProviderCurationCapability<Source> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider curation capability');
  const prepare = receiver.prepare;
  const isUsageBudgetExhausted = receiver.isUsageBudgetExhausted;
  return Object.freeze({
    prepare: (...args: Parameters<ProviderCurationCapability<Source>['prepare']>) => {
      const prepared = snapshotPlainReceiver(prepare.call(receiver, ...args), 'Prepared provider curation');
      const complete = prepared.complete;
      return Object.freeze({
        complete: (...completeArgs: Parameters<typeof complete>) =>
          complete
            .call(prepared, ...completeArgs)
            .then((result) => snapshotProviderResult(result, 'Provider curation outcome')),
      });
    },
    isUsageBudgetExhausted: (...args: Parameters<ProviderCurationCapability<Source>['isUsageBudgetExhausted']>) =>
      isUsageBudgetExhausted.call(receiver, ...args),
  });
}

export function snapshotArtifacts<Source extends JsonValue>(
  capability: ProviderArtifactCapability<Source>,
): ProviderArtifactCapability<Source> {
  const receiver = snapshotPlainReceiver(capability, 'Provider artifact capability');
  if (receiver.kind === 'none') return Object.freeze({ kind: 'none', reason: receiver.reason });
  const discardArtifacts = receiver.discardArtifacts;
  const locateArtifact = receiver.locateArtifact;
  return Object.freeze({
    kind: 'managed',
    discardArtifacts: (
      ...args: Parameters<Extract<ProviderArtifactCapability<Source>, { kind: 'managed' }>['discardArtifacts']>
    ) =>
      discardArtifacts
        .call(receiver, ...args)
        .then((result) => snapshotProviderResult(result, 'Provider artifact discard outcome')),
    ...(locateArtifact === undefined
      ? {}
      : {
          locateArtifact: (...args: Parameters<NonNullable<typeof locateArtifact>>) =>
            snapshotProviderResult(locateArtifact.call(receiver, ...args), 'Provider artifact location outcome'),
        }),
  });
}

export function snapshotImplementation<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  spec: ProviderImplementation<Plan, Source>,
): ProviderImplementation<Plan, Source> {
  const receiver = snapshotPlainReceiver(spec, 'Provider implementation');
  const preflight = receiver.preflight;
  const recovery = snapshotRecovery(receiver.recovery);
  const common = {
    name: receiver.name,
    ...(preflight === undefined
      ? {}
      : { preflight: (input: ProviderPreflightInput<Source>) => preflight.call(receiver, input) }),
    ...(recovery === undefined ? {} : { recovery }),
  };
  if (receiver.transport === 'standalone') {
    const standalone = receiver as ProviderStandaloneImplementation<Plan, Source>;
    const run = standalone.run;
    const prepareExecutionPlan = standalone.prepareExecutionPlan;
    return Object.freeze({
      ...common,
      transport: 'standalone' as const,
      run: (request: ProviderRequest, runtime: ProviderStandaloneRuntime<Plan>) =>
        run.call(standalone, request, runtime),
      prepareExecutionPlan: (input: Parameters<typeof prepareExecutionPlan>[0]) =>
        prepareExecutionPlan.call(standalone, input),
    });
  }
  if (receiver.transport !== 'app-server') {
    throw new TypeError('Provider implementation has an invalid transport discriminator.');
  }

  const appServerImplementation = receiver as ProviderAppServerImplementation<Plan, Source>;
  const appServer = snapshotAppServer(appServerImplementation.appServer);
  if (appServer === undefined) throw new TypeError(`Provider '${receiver.name}' requires an app-server capability.`);
  const curation = snapshotCuration(appServerImplementation.curation);
  const run = appServerImplementation.run;
  const prepareExecutionPlan = appServerImplementation.prepareExecutionPlan;
  return Object.freeze({
    ...common,
    transport: 'app-server' as const,
    run: (request: ProviderRequest, runtime: ProviderAppServerRuntime<Plan>) =>
      run.call(appServerImplementation, request, runtime),
    appServer,
    prepareExecutionPlan: (input: Parameters<typeof prepareExecutionPlan>[0]) =>
      prepareExecutionPlan.call(appServerImplementation, input),
    ...(curation === undefined ? {} : { curation }),
  });
}
