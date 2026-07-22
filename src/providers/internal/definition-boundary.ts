import type {
  ProviderAppServerCapability,
  ProviderArtifactCapability,
  ProviderCurationCapability,
  ProviderImplementation,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
} from '../contract.js';
import type { JsonValue } from '../../infra/json-value.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import { wrapServerLease } from './server-lease-boundary.js';
import { snapshotBoundaryData, snapshotPlainReceiver, snapshotProviderResult } from './snapshot.js';

function snapshotAppServer<Plan extends ProviderExecutionPlan>(
  capability: ProviderAppServerCapability<Plan> | undefined,
): ProviderAppServerCapability<Plan> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider app-server capability');
  const compileStableHost = receiver.compileStableHost;
  if (typeof compileStableHost !== 'function') {
    throw new TypeError('Provider app-server capability.compileStableHost must be a function.');
  }
  const interrupt = receiver.interrupt;
  const onNotification = receiver.onNotification;
  return Object.freeze({
    name: receiver.name,
    subscriptionPhase: receiver.subscriptionPhase,
    compileStableHost: (host: Plan['host']) =>
      snapshotBoundaryData(
        compileStableHost.call(receiver, snapshotBoundaryData(host, 'Provider stable host plan')),
        'Provider stable host specification',
      ),
    ...(interrupt === undefined
      ? {}
      : {
          interrupt: (...args: Parameters<NonNullable<ProviderAppServerCapability<Plan>['interrupt']>>) =>
            interrupt.call(
              receiver,
              wrapServerLease(args[0], 'Provider interrupt lease'),
              snapshotBoundaryData(args[1], 'Provider interrupt continuity'),
            ),
        }),
    ...(onNotification === undefined
      ? {}
      : {
          onNotification: (...args: Parameters<NonNullable<ProviderAppServerCapability<Plan>['onNotification']>>) =>
            onNotification.call(receiver, snapshotBoundaryData(args[0], 'Provider app-server notification')),
        }),
  });
}

function snapshotRecovery<Source extends JsonValue>(
  capability: ProviderRecoveryContract<Source> | undefined,
): ProviderRecoveryContract<Source> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider recovery capability');
  const probe = receiver.probe;
  const finalizeInterrupted = receiver.finalizeInterrupted;
  const finalizeFromArtifacts = receiver.finalizeFromArtifacts;
  const extractProgress = receiver.extractProgress;
  return Object.freeze({
    ...(probe === undefined
      ? {}
      : {
          probe: (...args: Parameters<NonNullable<ProviderRecoveryContract<Source>['probe']>>) =>
            probe
              .call(
                receiver,
                wrapServerLease(args[0], 'Provider recovery lease'),
                snapshotBoundaryData(args[1], 'Provider recovery continuity'),
              )
              .then((result) => snapshotProviderResult(result, 'Provider recovery probe outcome')),
        }),
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

function snapshotCuration<Plan extends ProviderExecutionPlan, Source extends JsonValue>(
  capability: ProviderCurationCapability<Plan, Source> | undefined,
): ProviderCurationCapability<Plan, Source> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider curation capability');
  const prepare = receiver.prepare;
  const isUsageBudgetExhausted = receiver.isUsageBudgetExhausted;
  return Object.freeze({
    prepare: (...args: Parameters<ProviderCurationCapability<Plan, Source>['prepare']>) => {
      const prepared = snapshotPlainReceiver(prepare.call(receiver, ...args), 'Prepared provider curation');
      const complete = prepared.complete;
      return Object.freeze({
        hostPlan: snapshotBoundaryData(prepared.hostPlan, 'Prepared provider curation host plan'),
        turnEnv: snapshotBoundaryData(prepared.turnEnv, 'Prepared provider curation turn environment'),
        complete: (...completeArgs: Parameters<typeof complete>) =>
          complete
            .call(prepared, ...completeArgs)
            .then((result) => snapshotProviderResult(result, 'Provider curation outcome')),
      });
    },
    isUsageBudgetExhausted: (...args: Parameters<ProviderCurationCapability<Plan, Source>['isUsageBudgetExhausted']>) =>
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
  const run = receiver.run;
  const prepareExecutionPlan = receiver.prepareExecutionPlan;
  const preflight = receiver.preflight;
  const appServer = snapshotAppServer(receiver.appServer);
  const recovery = snapshotRecovery(receiver.recovery);
  const curation = snapshotCuration(receiver.curation);
  if (curation !== undefined && appServer === undefined) {
    throw new TypeError(`Provider '${receiver.name}' curation requires an app-server capability.`);
  }
  return Object.freeze({
    name: receiver.name,
    run: (request: ProviderRequest, runtime: ProviderRuntime<Plan>) => run.call(receiver, request, runtime),
    prepareExecutionPlan: (input: Parameters<typeof prepareExecutionPlan>[0]) =>
      prepareExecutionPlan.call(receiver, input),
    ...(preflight === undefined
      ? {}
      : { preflight: (input: ProviderPreflightInput<Source>) => preflight.call(receiver, input) }),
    ...(appServer === undefined ? {} : { appServer }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(curation === undefined ? {} : { curation }),
  });
}
