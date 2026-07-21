import type { ProviderSpec, ProviderRequest } from '../../providers/contract.js';
import { hasUnterminalRetentionDiscardRequest, type SessionEntry } from '../../sessions/entry.js';
import { resolveEffort } from '../../providers/request-policy.js';
import { hasProviderScope, type InvocationContext } from '../../runtime/invocation-context.js';
import type { ProviderCredentialSourceRef } from '../../infra/provider-credential-sources.js';
import {
  providerBindingFailureCode,
  type ProviderBindingFailure,
  type ProviderBindingRuntime,
} from '../../providers/contracts/binding.js';
import type { RehydratedProviderBinding } from '../../providers/registry.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SessionExecutionPort } from '../../sessions/contracts.js';
import type { ProviderJobLaunchPort } from '../../jobs/contracts/job-runner.js';
import { rejectLaunch, type LaunchDecision, type JobLaunchRequest, type JobResumeRequest } from '../../jobs/launch.js';
import type { AcceptedAdmission, LaunchPool } from '../../jobs/contracts/admission.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { ListResult } from '../contracts.js';
import {
  buildEffectiveCoralEnv,
  buildSessionControllerProfile,
  claimJobAtomic,
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

  async start(providerName: string, input: JobLaunchRequest, ctx: InvocationContext): Promise<LaunchDecision> {
    const spec = this.deps.providerRegistry.get(providerName);
    if (!spec) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const bound = await this.bindInvocationProfile(providerName, ctx, 'launch');
    if ('status' in bound) return bound;
    const credentialSource = bound.credentialSource();

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
      preflightRuntime = toPreflightRuntime(this.deps.runtime, credentialSource, cwd, effectiveCoralEnv);
    } catch (error: unknown) {
      return rejectLaunch(
        'provider_execution_environment_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
    const preflightError = await runProviderPreflight(spec, preflightRuntime);
    if (preflightError) return rejectLaunch('provider_preflight_failed', preflightError);

    const session = this.deps.sessionManager.allocate({
      provider: providerName,
      sessionAuthority: { kind: 'provider', binding: bound.envelope },
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
    const admitted = await this.claimAndAdmitJob(
      session,
      providerName,
      ctx.projectRoot,
      'Session is already running a job',
      session.version,
      pool,
      input.jobId,
    );
    if ('status' in admitted) return admitted;

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

    return this.launchProviderJob(spec, session.sessionId, admitted.jobId, request, admitted.admission, {
      pool,
      projectRoot: ctx.projectRoot,
      parentWorkflowJobId: input.parentWorkflowJobId,
      workflowSlotId: input.workflowSlotId,
      retention,
      protectedEnv: this.mintChildPrincipalSecretEnv(ctx, session.sessionId, admitted.jobId, 'job-launch:start'),
    });
  }

  async resume(providerName: string, input: JobResumeRequest, ctx: InvocationContext): Promise<LaunchDecision> {
    const spec = this.deps.providerRegistry.get(providerName);
    if (!spec) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const session = this.deps.sessionManager.get(providerName, input.sessionId);
    if (!session) {
      return rejectLaunch(
        'session_not_found',
        `Session not found: ${input.sessionId}. Use exec to start a new session.`,
      );
    }

    if (session.sessionAuthority?.kind !== 'provider') {
      return this.rejectBinding({ reason: 'invalid-persisted-binding', provider: providerName });
    }
    const persisted = this.deps.providerRegistry.rehydrateBinding(session.sessionAuthority.binding);
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

    return this.resumeResolved(providerName, spec, session, effectiveInput, ctx, persisted.value.credentialSource());
  }

  private bindingRuntime(): ProviderBindingRuntime {
    return this.deps.runtime.storage;
  }

  private rejectBinding(failure: ProviderBindingFailure): LaunchDecision {
    return rejectLaunch(providerBindingFailureCode(failure), this.deps.providerRegistry.renderBindingFailure(failure));
  }

  private async bindInvocationProfile(
    providerName: string,
    ctx: InvocationContext,
    use: 'launch' | 'resume',
  ): Promise<RehydratedProviderBinding | LaunchDecision> {
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
  ): Promise<LaunchDecision> {
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
          agent: forcedIdent,
          cwd: input.cwd,
          effort: input.effort,
          bypassPermissions,
          systemPrompt: input.systemPrompt,
          parentWorkflowJobId: input.parentWorkflowJobId,
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
        agent: forcedIdent,
        cwd: input.cwd,
        effort: input.effort,
        bypassPermissions,
        systemPrompt: input.systemPrompt,
        parentWorkflowJobId: input.parentWorkflowJobId,
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
    session: SessionEntry,
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
    provider: ProviderSpec,
    session: SessionEntry,
    input: JobResumeRequest,
    ctx: InvocationContext,
    credentialSource: ProviderCredentialSourceRef,
  ): Promise<LaunchDecision> {
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
      preflightRuntime = toPreflightRuntime(
        this.deps.runtime,
        credentialSource,
        continuation.cwd,
        continuation.coralEnv,
      );
    } catch (error: unknown) {
      return rejectLaunch(
        'provider_execution_environment_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
    const preflightError = await runProviderPreflight(provider, preflightRuntime);
    if (preflightError) return rejectLaunch('provider_preflight_failed', preflightError);

    const admitted = await this.claimAndAdmitJob(
      session,
      providerName,
      ctx.projectRoot,
      busyMessage,
      expectedVersion,
      pool,
      input.jobId,
    );
    if ('status' in admitted) return admitted;

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

    return this.launchProviderJob(provider, session.sessionId, admitted.jobId, request, admitted.admission, {
      pool,
      projectRoot: ctx.projectRoot,
      parentWorkflowJobId: input.parentWorkflowJobId,
      workflowSlotId: input.workflowSlotId,
      protectedEnv: this.mintChildPrincipalSecretEnv(ctx, session.sessionId, admitted.jobId, 'job-launch:resume'),
    });
  }

  private async claimAndAdmitJob(
    session: SessionEntry,
    providerName: string,
    projectRoot: string,
    sessionBusyMessage: string,
    expectedVersion: number = session.version,
    pool: LaunchPool = 'default',
    requestedJobId?: string,
  ): Promise<{ jobId: string; admission: AcceptedAdmission } | LaunchDecision> {
    return this.deps.launchOrchestrator.claimAndAdmitJob(
      session,
      providerName,
      projectRoot,
      sessionBusyMessage,
      (claimSession, jobId, claimProviderName, claimProjectRoot, options) =>
        claimJobAtomic(
          {
            sessionManager: this.deps.sessionManager,
          },
          claimSession,
          jobId,
          claimProviderName,
          claimProjectRoot,
          options,
        ),
      expectedVersion,
      pool,
      requestedJobId,
    );
  }

  private launchProviderJob(
    provider: ProviderSpec,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    opts: {
      pool?: LaunchPool;
      projectRoot?: string;
      parentWorkflowJobId?: string;
      workflowSlotId?: string;
      retention?: SessionEntry['retention'];
      protectedEnv?: Record<string, string>;
    },
  ): LaunchDecision {
    return this.deps.launchOrchestrator.launchProviderJob(provider, sessionId, jobId, request, admission, opts);
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
