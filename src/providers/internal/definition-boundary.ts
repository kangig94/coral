import type {
  ProviderAppServerContract,
  ProviderArtifactCapability,
  ProviderCurationCapability,
  ProviderImplementation,
  ProviderPreflightInput,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
} from '../contract.js';
import type { JsonValue } from '../../infra/json-value.js';
import { wrapServerLease } from './server-lease-boundary.js';
import { snapshotBoundaryData, snapshotPlainReceiver, snapshotProviderResult, snapshotRequest } from './snapshot.js';

function snapshotAppServer<Context>(
  capability: ProviderAppServerContract<Context> | undefined,
): ProviderAppServerContract<Context> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider app-server capability');
  const buildServerSpec = receiver.buildServerSpec;
  const interrupt = receiver.interrupt;
  const onNotification = receiver.onNotification;
  return Object.freeze({
    name: receiver.name,
    subscriptionPhase: receiver.subscriptionPhase,
    buildServerSpec: (...args: Parameters<ProviderAppServerContract<Context>['buildServerSpec']>) =>
      snapshotProviderResult(
        buildServerSpec.call(
          receiver,
          snapshotRequest(args[0]),
          snapshotBoundaryData(args[1], 'Provider app-server continuity'),
          args[2],
          args[3],
        ),
        'Provider server specification',
      ),
    ...(interrupt === undefined
      ? {}
      : {
          interrupt: (...args: Parameters<NonNullable<ProviderAppServerContract<Context>['interrupt']>>) =>
            interrupt.call(
              receiver,
              wrapServerLease(args[0], 'Provider interrupt lease'),
              snapshotBoundaryData(args[1], 'Provider interrupt continuity'),
            ),
        }),
    ...(onNotification === undefined
      ? {}
      : {
          onNotification: (...args: Parameters<NonNullable<ProviderAppServerContract<Context>['onNotification']>>) =>
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

function snapshotCuration<Source extends JsonValue>(
  capability: ProviderCurationCapability<Source> | undefined,
): ProviderCurationCapability<Source> | undefined {
  if (capability === undefined) return undefined;
  const receiver = snapshotPlainReceiver(capability, 'Provider curation capability');
  const complete = receiver.complete;
  const isUsageBudgetExhausted = receiver.isUsageBudgetExhausted;
  return Object.freeze({
    complete: (...args: Parameters<ProviderCurationCapability<Source>['complete']>) =>
      complete.call(receiver, ...args).then((result) => snapshotProviderResult(result, 'Provider curation outcome')),
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

export function snapshotImplementation<Context, Source extends JsonValue>(
  spec: ProviderImplementation<Context, Source>,
): ProviderImplementation<Context, Source> {
  const receiver = snapshotPlainReceiver(spec, 'Provider implementation');
  const run = receiver.run;
  const prepareExecutionContext = receiver.prepareExecutionContext;
  const preflight = receiver.preflight;
  const appServer = snapshotAppServer(receiver.appServer);
  const recovery = snapshotRecovery(receiver.recovery);
  const curation = snapshotCuration(receiver.curation);
  return Object.freeze({
    name: receiver.name,
    run: (request: ProviderRequest, runtime: ProviderRuntime<Context>) => run.call(receiver, request, runtime),
    prepareExecutionContext: (input: Parameters<typeof prepareExecutionContext>[0]) =>
      prepareExecutionContext.call(receiver, input),
    ...(preflight === undefined
      ? {}
      : { preflight: (input: ProviderPreflightInput<Source>) => preflight.call(receiver, input) }),
    ...(appServer === undefined ? {} : { appServer }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(curation === undefined ? {} : { curation }),
  });
}
