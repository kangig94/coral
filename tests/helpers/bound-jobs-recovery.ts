import { bindWithHandoff, type BoundCoordinator } from '#src/coordinator/handoff.js';
import type { CoordinatorIdentity } from '#src/coordinator/lifecycle.js';
import type { RecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import type { RecoveryCapableService } from '#src/jobs/reconcile/contracts.js';
import type { JobStore } from '#src/jobs/store.js';
import type { ProviderRegistry } from '#src/providers/registry.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { CommitEventsFn } from '#src/store/append.js';

type BoundJobsRecoveryOptions = Readonly<{
  identity: CoordinatorIdentity;
  runtime: Runtime;
  progressStore: JobStore;
  providerRegistry: ProviderRegistry;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  bindWithHandoffFn?: typeof bindWithHandoff;
}>;

export type BoundJobsRecoveryHarness = Readonly<{
  bound: BoundCoordinator;
  run(recoveryCoordinator: RecoveryCoordinator): Promise<void>;
}>;

export async function createBoundJobsRecoveryHarness(
  options: BoundJobsRecoveryOptions,
): Promise<BoundJobsRecoveryHarness> {
  const bound = await (options.bindWithHandoffFn ?? bindWithHandoff)({
    socketPath: 'bound-jobs-recovery-test.sock',
    desired: {
      version: options.identity.version,
      bundleHash: options.identity.bundleHash,
      flavor: options.identity.flavor,
      namespace: options.identity.namespace,
    },
    bindAttempt: async () => ({ kind: 'bound' }),
    runStartupRecovery: async (inputs, runJobsStartup) => {
      await runJobsStartup({
        namespace: inputs.identity.namespace,
        bundleHash: inputs.identity.bundleHash,
        runtime: inputs.runtime,
        progressStore: inputs.progressStore,
        providerRegistry: inputs.providerRegistry,
        getRecoveryService: inputs.getRecoveryService,
        createInvocationContext: inputs.createInvocationContext,
        signal: inputs.signal,
        log: inputs.identity.log,
        coordinatorCommit: options.coordinatorCommit,
        interruptedAppServerReason: inputs.interruptedAppServerReason,
      });
      return [];
    },
    runtime: options.runtime,
    readVerifiedIncumbentFromDiscovery: () => null,
    totalBudgetMs: 0,
  });

  return {
    bound,
    run: async (recoveryCoordinator) => {
      await bound.runStartupRecovery({
        identity: options.identity,
        runtime: options.runtime,
        progressStore: options.progressStore,
        providerRegistry: options.providerRegistry,
        getExecutionService: options.getRecoveryService as never,
        getRecoveryService: options.getRecoveryService,
        knownDiscussSources: () => new Set(),
        getDiscussStoreForSource: () => {
          throw new Error('Jobs recovery must not read discussion stores');
        },
        getDiscussContext: () => {
          throw new Error('Jobs recovery must not read discussion contexts');
        },
        createInvocationContext: options.createInvocationContext,
        recoveryCoordinator,
        signal: options.signal,
        recoverPersistedDiscussFn: async () => [],
      });
    },
  };
}
