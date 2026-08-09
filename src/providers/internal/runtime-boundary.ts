import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderStandaloneRuntime,
} from '../contract.js';
import type { ProviderCliRequest } from '../protocol.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import { wrapAppServerSession } from './server-lease-boundary.js';
import { snapshotBoundaryData, snapshotCliRequest, snapshotPlainReceiver, snapshotProviderResult } from './snapshot.js';
import { forwardContinuityCommit } from './continuity-commit.js';

type CommonRuntimeInput = Pick<
  ProviderAppServerRuntime<never>,
  | 'signal'
  | 'time'
  | 'storage'
  | 'env'
  | 'ids'
  | 'persistedContinuity'
  | 'continuityBridge'
  | 'kbRoot'
  | 'coralProjects'
  | 'projectSource'
  | 'equippedTools'
>;

function snapshotCommonRuntime(runtime: CommonRuntimeInput) {
  const receiver = snapshotPlainReceiver(
    runtime,
    'Provider execution runtime',
    new Set(Object.getOwnPropertyNames(runtime)),
  );
  const bridge = snapshotPlainReceiver(receiver.continuityBridge, 'Provider continuity bridge');
  const checkpoint = bridge.checkpoint;
  const transportClosed = bridge.transportClosed;
  return Object.freeze({
    signal: receiver.signal,
    time: receiver.time,
    storage: receiver.storage,
    ...(receiver.env === undefined ? {} : { env: receiver.env }),
    ids: receiver.ids,
    ...(receiver.persistedContinuity === undefined
      ? {}
      : { persistedContinuity: snapshotBoundaryData(receiver.persistedContinuity, 'Provider persisted continuity') }),
    continuityBridge: Object.freeze({
      checkpoint: (update: Parameters<typeof checkpoint>[0]) =>
        checkpoint.call(bridge, snapshotBoundaryData(update, 'Provider continuity update')),
      transportClosed: (closed: Parameters<typeof transportClosed>[0]) => {
        const canonical = snapshotPlainReceiver(closed, 'Provider transport close', new Set(['error']));
        transportClosed.call(bridge, canonical);
      },
    }),
    kbRoot: receiver.kbRoot,
    ...(receiver.coralProjects === undefined ? {} : { coralProjects: receiver.coralProjects }),
    ...(receiver.projectSource === undefined ? {} : { projectSource: receiver.projectSource }),
    ...(receiver.equippedTools === undefined
      ? {}
      : { equippedTools: snapshotBoundaryData(receiver.equippedTools, 'Provider equipped tools') }),
  });
}

export function snapshotAppServerExecutionRuntime<Plan extends ProviderExecutionPlan>(
  runtime: CommonRuntimeInput & Pick<ProviderAppServerRuntime<never>, 'onProviderTurnTerminal'>,
  executionPlan: Plan,
  appServerSession: AppServerSession,
): ProviderAppServerRuntime<Plan> {
  const onProviderTurnTerminal = runtime.onProviderTurnTerminal;
  return Object.freeze({
    ...snapshotCommonRuntime(runtime),
    transport: 'app-server' as const,
    appServerSession: wrapAppServerSession(appServerSession, 'Provider app-server session'),
    onProviderTurnTerminal: (evidence: Parameters<typeof onProviderTurnTerminal>[0]) =>
      onProviderTurnTerminal.call(runtime, snapshotBoundaryData(evidence, 'Provider turn terminal evidence')),
    executionPlan,
  });
}

export function snapshotStandaloneExecutionRuntime<Plan extends ProviderExecutionPlan>(
  runtime: CommonRuntimeInput & Pick<ProviderStandaloneRuntime<never>, 'runCli'>,
  executionPlan: Plan,
): ProviderStandaloneRuntime<Plan> {
  const runCli = runtime.runCli;
  return Object.freeze({
    ...snapshotCommonRuntime(runtime),
    transport: 'standalone' as const,
    runCli: async (request: ProviderCliRequest) =>
      snapshotProviderResult(await runCli(snapshotCliRequest(request)), 'Provider CLI result'),
    executionPlan,
  });
}

export function snapshotEventStream(stream: AsyncIterable<ProviderEventBody>): AsyncIterable<ProviderEventBody> {
  return (async function* () {
    for await (const event of stream) {
      if (event.kind === 'continuity') {
        const snapshot = snapshotProviderResult(
          {
            kind: event.kind,
            conversationRef: event.conversationRef,
            resumable: event.resumable,
            providerContinuity: event.providerContinuity,
          },
          'Provider event',
        );
        yield forwardContinuityCommit(event, snapshot);
        continue;
      }
      yield snapshotProviderResult(event, 'Provider event');
    }
  })();
}
