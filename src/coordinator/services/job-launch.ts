import type { ProviderRequest } from '../../providers/contract.js';
import { hasUnterminalRetentionDiscardRequest, type ProviderSession } from '../../sessions/entry.js';
import { resolveEffort } from '../../providers/request-policy.js';
import { hasProviderScope, type InvocationContext } from '../../runtime/invocation-context.js';
import {
  providerBindingFailureCode,
  type ProviderBindingFailure,
  type ProviderBindingRuntime,
} from '../../providers/contracts/binding.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { Runtime } from '../../runtime/ports.js';
import { CoralSetupError } from '../../runtime/errors.js';
import type { SessionExecutionPort } from '../../sessions/contracts.js';
import type { ProviderJobLaunchPort } from '../../jobs/contracts/job-runner.js';
import {
  rejectLaunch,
  type JobLaunchRequest,
  type JobResumeRequest,
  type ProviderSessionLaunchDecision,
  type RejectedLaunchDecision,
} from '../../jobs/launch.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { ListResult } from '../contracts.js';
import {
  buildEffectiveCoralEnv,
  buildSessionControllerProfile,
  type CoralIntent,
  type EffectiveContinuationProfile,
  mapResolverError,
  resolveAgentLaunchProfile,
  runProviderPreflight,
  toPreflightRuntime,
} from './execution-policies.js';
import {
  CHILD_PRINCIPAL_CAPABILITIES,
  CORAL_CHILD_PRINCIPAL_HANDLE,
  type ChildPrincipalRegistry,
} from '../child-principal-registry.js';

export interface JobLaunchServiceDeps {
  runtime: Runtime;
  sessionManager: SessionExecutionPort;
  backendNamespace: string;
  bundleHash: string;
  providerRegistry: ProviderBindingCatalog;
  pluginRegistry: {
    discoverPluginRoot: (namespace: string) => string | null;
  };
  progressStore: JobProgressStore;
  launchOrchestrator: ProviderJobLaunchPort;
  childPrincipalRegistry: ChildPrincipalRegistry;
}

export class JobLaunchService {
  private readonly deps: JobLaunchServiceDeps;
  constructor(deps: JobLaunchServiceDeps) {
    this.deps = deps;
  }

  private rejectLaunchConflict(error: unknown): RejectedLaunchDecision | null {
    if (!(error instanceof CoralSetupError)) return null;
    switch (error.code) {
      case 'job_launch_duplicate':
      case 'job_owner_mismatch':
      case 'job_owner_missing':
      case 'job_provider_session_missing':
      case 'job_binding_owner_mismatch':
      case 'discussion_job_launch_conflict':
      case 'workflow_owner_terminal':
      case 'workflow_slot_chain_invalid':
        return rejectLaunch(error.code, error.userMessage);
      default:
        return null;
    }
  }

  private launchOrReject(run: () => ProviderSessionLaunchDecision): ProviderSessionLaunchDecision {
    try {
      return run();
    } catch (error: unknown) {
      const rejection = this.rejectLaunchConflict(error);
      if (rejection !== null) return rejection;
      throw error;
    }
  }

  async start(
    providerName: string,
    input: JobLaunchRequest,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    if (!this.deps.providerRegistry.get(providerName)) {
      return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }

    const bound = await this.bindInvocationProfile(providerName, ctx, 'launch');
    if ('status' in bound) return bound;

    let resolvedAgent: ReturnType<typeof resolveAgentLaunchProfile> | null = null;
    if (input.agent) {
      try {
        resolvedAgent = resolveAgentLaunchProfile(input.agent, {
          projectRoot: ctx.projectRoot,
          coralPluginRoot: ctx.pluginRoot,
          discoverPluginRoot: this.deps.pluginRegistry.discoverPluginRoot.bind(this.deps.pluginRegistry),
          storage: this.deps.runtime.storage,
        });
      } catch (err) {
        const rejection = mapResolverError(err);
        if (rejection) return rejection;
        throw err;
      }
    }
    const effectiveCoralEnv = buildEffectiveCoralEnv(ctx.coralEnv, { effort: input.effort });
    const cwd = input.cwd ?? ctx.projectRoot;
    const requestName = resolvedAgent?.name ?? input.name;
    const name = requestName ?? `session-${this.deps.runtime.time.now()}`;
    const model = input.model ?? resolvedAgent?.model;
    const pool = input.pool ?? 'default';
    const controllerProfile = buildSessionControllerProfile(effectiveCoralEnv);
    const instruction = resolvedAgent?.instruction ?? input.instruction;
    const bypassPermissions = input.bypassPermissions ?? resolvedAgent !== null;
    const retention = input.retention ?? 'retain';

    let preflightRuntime;
    try {
      preflightRuntime = toPreflightRuntime(this.deps.runtime, cwd, effectiveCoralEnv);
    } catch (error: unknown) {
      return rejectLaunch(
        'provider_execution_environment_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
    const preflightError = await runProviderPreflight(bound, preflightRuntime);
    if (preflightError) return rejectLaunch('provider_preflight_failed', preflightError);

    const session = this.deps.sessionManager.prepare({
      binding: bound.envelope,
      name,
      model,
      cwd,
      projectRoot: ctx.projectRoot,
      backendNamespace: this.deps.backendNamespace,
      retention,
      ...(resolvedAgent !== null ? { agentName: resolvedAgent.agentName } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      bypassPermissions,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(controllerProfile !== undefined ? { controllerProfile } : {}),
    });

    const request: ProviderRequest = {
      action: 'exec',
      sessionId: session.sessionId,
      name: requestName,
      prompt: input.prompt,
      model,
      cwd,
      effort: resolveEffort(input.effort),
      bypassPermissions,
      systemPrompt: input.systemPrompt,
      instruction,
      coralEnv: effectiveCoralEnv,
    };

    return this.launchOrReject(() =>
      this.deps.launchOrchestrator.launchInitialProviderJob(bound, session, request, {
        owner: input.owner ?? { kind: 'provider-session', id: session.sessionId },
        requestedJobId: input.jobId,
        pool,
        projectRoot: ctx.projectRoot,
        parentWorkflowJobId: input.parentWorkflowJobId,
        workflowSlotId: input.workflowSlotId,
        workflowSlotGeneration: input.workflowSlotGeneration,
        replacesWorkflowJobId: input.replacesWorkflowJobId,
        discussionRun: input.discussionRun,
        retention,
        mintProtectedEnv: (jobId) =>
          this.mintChildPrincipalSecretEnv(ctx, session.sessionId, jobId, 'job-launch:start'),
      }),
    );
  }

  async resume(
    providerName: string,
    input: JobResumeRequest,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    if (!this.deps.providerRegistry.get(providerName)) {
      return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }

    const session = this.deps.sessionManager.get(providerName, input.sessionId);
    if (!session) {
      return rejectLaunch(
        'session_not_found',
        `Session not found: ${input.sessionId}. Use exec to start a new session.`,
      );
    }

    const persisted = this.deps.providerRegistry.rehydrateBinding(session.binding);
    if (!persisted.ok) return this.rejectBinding(persisted.failure);
    const persistedReadiness = await persisted.value.readiness('resume', this.bindingRuntime());
    if (!persistedReadiness.ok) return this.rejectBinding(persistedReadiness.failure);
    const caller = await this.bindInvocationProfile(providerName, ctx, 'resume');
    if ('status' in caller) return caller;

    let effectiveInput = input;
    if (input.agent) {
      let resolvedAgent: ReturnType<typeof resolveAgentLaunchProfile>;
      try {
        resolvedAgent = resolveAgentLaunchProfile(input.agent, {
          projectRoot: ctx.projectRoot,
          coralPluginRoot: ctx.pluginRoot,
          discoverPluginRoot: this.deps.pluginRegistry.discoverPluginRoot.bind(this.deps.pluginRegistry),
          storage: this.deps.runtime.storage,
        });
      } catch (err) {
        const rejection = mapResolverError(err);
        if (rejection) return rejection;
        throw err;
      }
      effectiveInput = {
        ...input,
        name: resolvedAgent.name,
        model: input.model ?? resolvedAgent.model,
        instruction: input.instruction ?? resolvedAgent.instruction,
      };
    }

    const identity = persisted.value.compareIdentity(caller.envelope);
    if (!identity.ok) return this.rejectBinding(identity.failure);

    return this.resumeResolved(providerName, persisted.value, session, effectiveInput, ctx);
  }

  private bindingRuntime(): ProviderBindingRuntime {
    return this.deps.runtime.storage;
  }

  private rejectBinding(failure: ProviderBindingFailure): RejectedLaunchDecision {
    return rejectLaunch(providerBindingFailureCode(failure), this.deps.providerRegistry.renderBindingFailure(failure));
  }

  private async bindInvocationProfile(
    providerName: string,
    ctx: InvocationContext,
    use: 'launch' | 'resume',
  ): Promise<BoundProvider | RejectedLaunchDecision> {
    if (!hasProviderScope(ctx)) {
      return this.rejectBinding({ reason: 'missing-profile', provider: providerName });
    }
    const binding = await this.deps.providerRegistry.bindFromScope(
      ctx.providerScope,
      providerName,
      use,
      this.bindingRuntime(),
    );
    if (!binding.ok) return this.rejectBinding(binding.failure);
    return binding.value;
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    const forcedIdent = coralName.startsWith('coral:') ? coralName : `coral:${coralName}`;
    const bypassPermissions = input.bypassPermissions ?? true;

    if (input.sessionId !== undefined) {
      return this.resume(
        providerName,
        {
          sessionId: input.sessionId,
          prompt: input.prompt,
          jobId: input.jobId,
          workflowSlotId: input.workflowSlotId,
          workflowSlotGeneration: input.workflowSlotGeneration,
          replacesWorkflowJobId: input.replacesWorkflowJobId,
          agent: forcedIdent,
          cwd: input.cwd,
          effort: input.effort,
          bypassPermissions,
          systemPrompt: input.systemPrompt,
          parentWorkflowJobId: input.parentWorkflowJobId,
          owner: input.owner,
        },
        ctx,
      );
    }

    return this.start(
      providerName,
      {
        prompt: input.prompt,
        jobId: input.jobId,
        workflowSlotId: input.workflowSlotId,
        workflowSlotGeneration: input.workflowSlotGeneration,
        replacesWorkflowJobId: input.replacesWorkflowJobId,
        agent: forcedIdent,
        cwd: input.cwd,
        effort: input.effort,
        bypassPermissions,
        systemPrompt: input.systemPrompt,
        parentWorkflowJobId: input.parentWorkflowJobId,
        owner: input.owner,
        ...(input.retention !== undefined ? { retention: input.retention } : {}),
      },
      ctx,
    );
  }

  list(providerName: string): ListResult {
    return { sessions: this.deps.sessionManager.list(providerName) };
  }

  private buildContinuationProfile(
    input: Pick<JobResumeRequest, 'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt' | 'instruction'>,
    session: ProviderSession,
    ctx: InvocationContext,
  ): EffectiveContinuationProfile {
    const coralEnv = buildEffectiveCoralEnv(ctx.coralEnv, {
      effort: input.effort,
      controllerProfile: session.controllerProfile,
    });

    return {
      model: input.model ?? session.model,
      cwd: input.cwd ?? session.cwd,
      effort: resolveEffort(input.effort),
      bypassPermissions: input.bypassPermissions ?? session.bypassPermissions ?? false,
      systemPrompt: input.systemPrompt ?? session.systemPrompt,
      instruction: input.instruction ?? session.instruction,
      controllerProfile: buildSessionControllerProfile(coralEnv),
      coralEnv,
      agentName: session.agentName,
    };
  }

  private async resumeResolved(
    providerName: string,
    provider: BoundProvider,
    session: ProviderSession,
    input: JobResumeRequest,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    const busyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    if (session.state === 'non_resumable') {
      return rejectLaunch(
        'non_resumable',
        `Session ${input.sessionId} is non-resumable. Use exec to start a new session.`,
      );
    }
    if (session.activeJobId !== undefined) {
      return rejectLaunch('session_busy', busyMessage);
    }
    if (hasUnterminalRetentionDiscardRequest(session)) {
      return rejectLaunch(
        'retention_discard_in_flight',
        `Session ${input.sessionId} has a retention discard request in flight. Start a new session instead.`,
      );
    }
    const expectedVersion = session.version;
    const pool = input.pool ?? 'default';

    const continuation = this.buildContinuationProfile(input, session, ctx);
    let preflightRuntime;
    try {
      preflightRuntime = toPreflightRuntime(this.deps.runtime, continuation.cwd, continuation.coralEnv);
    } catch (error: unknown) {
      return rejectLaunch(
        'provider_execution_environment_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
    const preflightError = await runProviderPreflight(provider, preflightRuntime);
    if (preflightError) return rejectLaunch('provider_preflight_failed', preflightError);

    const request: ProviderRequest = {
      action: 'resume',
      sessionId: session.sessionId,
      prompt: input.prompt,
      conversationRef: session.conversationRef,
      model: continuation.model,
      cwd: continuation.cwd,
      effort: continuation.effort,
      bypassPermissions: continuation.bypassPermissions,
      systemPrompt: continuation.systemPrompt,
      instruction: continuation.instruction,
      coralEnv: continuation.coralEnv,
    };

    if (
      input.owner?.kind === 'workflow' &&
      input.parentWorkflowJobId !== undefined &&
      input.workflowSlotId !== undefined &&
      input.workflowSlotGeneration !== undefined &&
      input.replacesWorkflowJobId !== undefined
    ) {
      const owner = input.owner;
      const parentWorkflowJobId = input.parentWorkflowJobId;
      const workflowSlotId = input.workflowSlotId;
      const workflowSlotGeneration = input.workflowSlotGeneration;
      const replacesWorkflowJobId = input.replacesWorkflowJobId;
      return this.launchOrReject(() =>
        this.deps.launchOrchestrator.launchWorkflowReplacement(provider, session, request, {
          owner,
          parentWorkflowJobId,
          workflowSlotId,
          workflowSlotGeneration,
          replacesWorkflowJobId,
          pool,
          projectRoot: ctx.projectRoot,
          mintProtectedEnv: (jobId) =>
            this.mintChildPrincipalSecretEnv(ctx, session.sessionId, jobId, 'job-launch:workflow-replacement'),
        }),
      );
    }

    return this.launchOrReject(() =>
      this.deps.launchOrchestrator.launchResumedProviderJob(provider, session, request, {
        owner: input.owner ?? { kind: 'provider-session', id: session.sessionId },
        expectedVersion,
        sessionBusyMessage: busyMessage,
        requestedJobId: input.jobId,
        pool,
        projectRoot: ctx.projectRoot,
        parentWorkflowJobId: input.parentWorkflowJobId,
        workflowSlotId: input.workflowSlotId,
        workflowSlotGeneration: input.workflowSlotGeneration,
        replacesWorkflowJobId: input.replacesWorkflowJobId,
        discussionRun: input.discussionRun,
        mintProtectedEnv: (jobId) =>
          this.mintChildPrincipalSecretEnv(ctx, session.sessionId, jobId, 'job-launch:resume'),
      }),
    );
  }

  private mintChildPrincipalSecretEnv(
    ctx: InvocationContext,
    sessionId: string,
    jobId: string,
    issuer: string,
  ): Record<string, string> {
    const credential = this.deps.childPrincipalRegistry.register({
      issuer,
      parentPrincipal: ctx.principal,
      namespace: this.deps.backendNamespace,
      parentJobId: jobId,
      parentSessionId: sessionId,
      nowMs: this.deps.runtime.time.now(),
      childCaps: CHILD_PRINCIPAL_CAPABILITIES,
    });
    return {
      CORAL_JOB_ID: jobId,
      CORAL_SESSION_ID: sessionId,
      [CORAL_CHILD_PRINCIPAL_HANDLE]: credential.handle,
    };
  }
}
