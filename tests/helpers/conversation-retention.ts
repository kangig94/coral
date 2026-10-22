import { dirname, join } from 'node:path';

import { vi } from 'vitest';

import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { createLifecycleReactor } from '#src/jobs/conversation/lifecycle-reactor.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import {
  conversationArchiveDirectory,
  deriveProviderArtifactActionDescriptor,
  deriveProviderArtifactSourceRevision,
} from '#src/jobs/conversation/provider-artifact-archive.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { managed } from '#src/providers/capability.js';
import type {
  DiscardOutcome,
  ProviderArtifactDiscardReconciliation,
  ProviderManagedArtifactCapability,
} from '#src/providers/contract.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { commit, type AppendedEvent, type CommitEventsFn } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { EventsRow } from '#src/store/schema.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import {
  executionHarness,
  executionInput,
  EXECUTION_JOB_ID,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { prepareFixtureExecutionPlan, type FixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

type ArtifactOptions = Parameters<ProviderManagedArtifactCapability<FixtureProviderAccess>['discardArtifacts']>[0];

export function conversationRetentionHarness(
  options: {
    discardArtifacts?: (input: ArtifactOptions) => Promise<DiscardOutcome>;
    reconcileDiscard?: (input: ArtifactOptions) => Promise<ProviderArtifactDiscardReconciliation>;
    autoObserve?: boolean;
    afterCommit?: (events: readonly AppendedEvent[]) => void;
  } = {},
) {
  const h = executionHarness();
  const runtime = new SimulationRuntime();
  vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
    runtime.time.tick(ms);
  });
  const providerEffects: ArtifactOptions[] = [];
  const capabilityCalls: Array<{ kind: 'discard' | 'reconcile'; actionId: string; payloadHash: string }> = [];
  const providers = new ProviderRegistry();
  const reconcileDiscard = options.reconcileDiscard;
  const capability = managed<FixtureProviderAccess>({
    discardArtifacts: async (input) => {
      providerEffects.push(input);
      if (options.discardArtifacts !== undefined) return options.discardArtifacts(input);
      for (const handle of input.handles) {
        if (input.runtime.storage.existsSync(handle)) input.runtime.storage.unlinkSync(handle);
      }
      return { kind: 'discarded' };
    },
    ...(reconcileDiscard === undefined ? {} : { reconcileDiscard }),
  });
  providers.register(
    defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
      name: 'codex',
      transport: 'standalone',
      run: async function* () {},
      prepareExecutionPlan: prepareFixtureExecutionPlan,
    })
      .binding(fixtureProviderBindingCodec('codex'))
      .artifacts({
        ...capability,
        discardArtifacts: async (input) => {
          capabilityCalls.push({ kind: 'discard', actionId: input.actionId, payloadHash: input.payloadHash });
          return capability.discardArtifacts(input);
        },
        reconcileDiscard: async (input) => {
          capabilityCalls.push({ kind: 'reconcile', actionId: input.actionId, payloadHash: input.payloadHash });
          return capability.reconcileDiscard(input);
        },
      })
      .build(),
  );
  const lifetime = new AbortController();
  const logs: string[] = [];
  const batches: AppendedEvent[][] = [];
  const ctx = { ...h.ctx, now: () => new Date(runtime.time.now()) };
  const observe = (events: AppendedEvent[]) => {
    batches.push(events);
    options.afterCommit?.(events);
    if (options.autoObserve !== false) reactor.observe(events);
    return events;
  };
  const commitEvents: CommitEventsFn = (cb) => observe(commit(h.db, cb, ctx));
  const append = (...inputs: CoralEventInput[]) => observe(commitInputs(h.db, inputs, ctx));
  const createReactor = () =>
    createLifecycleReactor({
      db: () => h.db,
      readCtx: h.readCtx,
      providers,
      runtime,
      time: runtime.time,
      commitEvents,
      signal: lifetime.signal,
      log: (message) => logs.push(message),
    });
  let reactor = createReactor();
  const manager = new ConversationManager('/workspace', runtime, commitEvents, h.db);
  const read = (jobId = EXECUTION_JOB_ID) => {
    const entry = readProjectionJobConversation(h.db, jobId);
    if (entry === null) throw new Error(`Expected conversation ${jobId}.`);
    return entry;
  };
  const accepted = (jobId = EXECUTION_JOB_ID) => {
    const row = h.db
      .prepare<
        [string],
        EventsRow
      >("SELECT * FROM events WHERE stream_id = ? AND type = 'job.execution.outcome.accepted' ORDER BY seq DESC LIMIT 1")
      .get(jobId);
    if (row === undefined) throw new Error('Expected accepted outcome.');
    return row;
  };
  const descriptor = (jobId = EXECUTION_JOB_ID) => {
    const entry = read(jobId);
    const outcome = accepted(jobId);
    return deriveProviderArtifactActionDescriptor({
      entry,
      jobId,
      handles: entry.artifactHandles
        .filter((handle) => handle.execution === entry.execution)
        .map((handle) => handle.handle),
      sourceRevision: deriveProviderArtifactSourceRevision({ jobId, execution: entry.execution, accepted: outcome }),
      archivedAt: outcome.ts,
    });
  };
  const finisher = new ExecutionFinisher({
    time: runtime.time,
    commit: commitEvents,
    read: (address) => readExecutionFinishingState(h.db, address, h.readCtx),
    quiesce: async () => true,
    retentionAction: (address) => reactor.retentionAction(address),
    settleRetention: (address, action) => reactor.settleRetention(address, action),
  });
  const start = (input: { jobId?: string; retention?: 'retain' | 'discard_provider_artifacts_on_terminal' } = {}) => {
    const jobId = input.jobId ?? EXECUTION_JOB_ID;
    const base = openedJob();
    if (base.body.jobKind !== 'provider') throw new Error('Expected provider fixture.');
    append(
      executionInput(
        'job.opened',
        {
          ...base.body,
          owner: { kind: 'provider-session', id: jobId },
          conversation: {
            ...base.body.conversation,
            binding: TEST_CODEX_BINDING,
            retention: input.retention ?? 'discard_provider_artifacts_on_terminal',
          },
        },
        jobId,
      ),
      { ...requestedExecution(), stream: { kind: 'job', id: jobId } },
    );
    return jobId;
  };
  const recordArtifact = async (
    handle: string,
    jobId = EXECUTION_JOB_ID,
    content: string | null = 'native artifact\n',
  ) => {
    if (content !== null) {
      runtime.storage.mkdirSync(dirname(handle), { recursive: true });
      runtime.storage.writeFileSync(handle, content, { encoding: 'utf-8' });
    }
    const result = await manager.recordArtifactHandleAtomic(jobId, {
      execution: read(jobId).execution,
      handle,
      identity: { kind: 'test-artifact', handle },
    });
    if (!result.ok) throw new Error('Artifact write lost execution ownership.');
  };
  const accept = (jobId = EXECUTION_JOB_ID) =>
    append(
      executionInput(
        'job.execution.outcome.accepted',
        {
          execution: read(jobId).execution,
          terminal: { content: 'done', durationMs: 0, outcome: { kind: 'completed' } },
        },
        jobId,
      ),
    );
  const request = async (jobId = EXECUTION_JOB_ID) => {
    const execution = read(jobId).execution;
    const action = { execution, ...(await reactor.retentionAction({ jobId, execution })) };
    append(executionInput('job.retention.discard.requested', action, jobId));
    return action;
  };
  return {
    ...h,
    runtime,
    providers,
    lifetime,
    logs,
    batches,
    manager,
    finisher,
    capabilityCalls,
    providerEffects,
    append,
    commit: commitEvents,
    read,
    accepted,
    descriptor,
    start,
    recordArtifact,
    accept,
    request,
    get reactor() {
      return reactor;
    },
    restart() {
      reactor = createReactor();
      return reactor;
    },
    manifestPath(jobId = EXECUTION_JOB_ID) {
      const action = descriptor(jobId);
      return join(conversationArchiveDirectory(runtime, action.jobId), 'manifest.json');
    },
    async close() {
      await finisher.dispose();
      await reactor.dispose();
      h.db.close();
    },
  };
}
