import type { ProviderEventBody, ProviderRuntime } from '../contract.js';
import type { ProviderCliRequest } from '../protocol.js';
import type { ProviderExecutionPlan } from '../execution-plan.js';
import { wrapAcquirePreparedServer } from './server-lease-boundary.js';
import { snapshotBoundaryData, snapshotCliRequest, snapshotPlainReceiver, snapshotProviderResult } from './snapshot.js';

export function snapshotExecutionRuntime<Plan extends ProviderExecutionPlan>(
  runtime: Omit<ProviderRuntime<never>, 'executionPlan'>,
  executionPlan: Plan,
): ProviderRuntime<Plan> {
  const receiver = snapshotPlainReceiver(
    runtime,
    'Provider execution runtime',
    new Set(Object.getOwnPropertyNames(runtime)),
  );
  const runCli = receiver.runCli;
  const acquirePreparedServer = receiver.acquirePreparedServer;
  const bridge = snapshotPlainReceiver(receiver.continuityBridge, 'Provider continuity bridge');
  const checkpoint = bridge.checkpoint;
  const transportClosed = bridge.transportClosed;
  return Object.freeze({
    signal: receiver.signal,
    runCli: async (request: ProviderCliRequest) =>
      snapshotProviderResult(await runCli.call(receiver, snapshotCliRequest(request)), 'Provider CLI result'),
    time: receiver.time,
    storage: receiver.storage,
    ...(receiver.env === undefined ? {} : { env: receiver.env }),
    ids: receiver.ids,
    acquirePreparedServer: wrapAcquirePreparedServer(
      receiver,
      acquirePreparedServer,
      'Provider prepared acquire-server',
    ),
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
    executionPlan,
  });
}

export function snapshotEventStream(stream: AsyncIterable<ProviderEventBody>): AsyncIterable<ProviderEventBody> {
  return (async function* () {
    for await (const event of stream) yield snapshotProviderResult(event, 'Provider event');
  })();
}
