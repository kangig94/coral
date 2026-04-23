import type { ProviderSpec } from '../../providers/contract.js';
import type { SessionEntry } from '../../sessions/api.js';
import { resolveEffort } from '../../providers/request-policy.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { ProviderCatalog } from '../../providers/catalog.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SessionManager } from '../../sessions/shell/store.js';
import { getSessionById } from '../../sessions/shell/resolve.js';
import type { LaunchOrchestrator } from '../../jobs/shell/launch.js';
import {
  rejectLaunch,
  type AcceptedAdmission,
} from '../../jobs/shell/contracts.js';
import type { SessionLookup } from '../../sessions/lookup.js';
import type { JobProgressStore } from '../../jobs/progress-store-contract.js';
import type { LaunchDecision } from '../../jobs/launch.js';
import type { ProviderRequest } from '../../providers/contract.js';
import type { ExecutionLaunchPool as LaunchPool, ListResult } from '../contracts.js';
import {
  buildEffectiveCoralEnv,
  buildSessionControllerProfile,
  claimJobAtomic,
  type CoralIntent,
  type EffectiveContinuationProfile,
  type ExecIntent,
  type ForkIntent,
  mapResolverError,
  resolveAgentLaunchProfile,
  type ResumeIntent,
  runProviderPreflight,
  toPreflightRuntime,
} from './execution-shared.js';

export interface JobLaunchServiceDeps {
  runtime: Runtime;
  sessionManager: SessionManager;
  backendNamespace: string;
  bundleHash: string;
  providerRegistry: ProviderCatalog;
  pluginRegistry: {
    discoverPluginRoot: (namespace: string) => string | null;
  };
  progressStore: JobProgressStore;
  sessionLookup?: SessionLookup;
  launchOrchestrator: LaunchOrchestrator;
}

export class JobLaunchService {
  constructor(private readonly deps: JobLaunchServiceDeps) {}

  async start(providerName: string, input: ExecIntent, ctx: InvocationContext): Promise<LaunchDecision> {
    const spec = this.deps.providerRegistry.get(providerName);
    if (!spec) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const preflightError = await runProviderPreflight(spec, toPreflightRuntime(this.deps.runtime));
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

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
    const bypassPermissions = input.bypassPermissions ?? (resolvedAgent !== null);

    const session = this.deps.sessionManager.allocate({
      provider: providerName,
      name,
      model,
      cwd,
      projectRoot: ctx.projectRoot,
      backendNamespace: this.deps.backendNamespace,
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
    });
  }

  async resume(providerName: string, input: ResumeIntent, ctx: InvocationContext): Promise<LaunchDecision> {
    const spec = this.deps.providerRegistry.get(providerName);
    if (!spec) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const session = this.deps.sessionManager.get(providerName, input.sessionId);
    if (!session) {
      return rejectLaunch('session_not_found', `Session not found: ${input.sessionId}. Use exec to start a new session.`);
    }

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

    return this.resumeResolved(providerName, spec, session, effectiveInput, ctx);
  }

  async fork(providerName: string, input: ForkIntent, ctx: InvocationContext): Promise<LaunchDecision> {
    const spec = this.deps.providerRegistry.get(providerName);
    if (!spec) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const sourceSession = this.deps.sessionManager.get(providerName, input.sessionId);
    if (!sourceSession) {
      return rejectLaunch('session_not_found', `Session not found: ${input.sessionId}. Use exec to start a new session.`);
    }
    return this.forkResolved(providerName, spec, sourceSession, input, ctx);
  }

  async resumeBySessionId(input: ResumeIntent, ctx: InvocationContext): Promise<LaunchDecision> {
    const resolved = this.resolveSessionByIdForContinuation(input.sessionId, ctx, input.provider);
    if ('status' in resolved) return resolved;

    const spec = this.deps.providerRegistry.get(resolved.providerName);
    if (!spec) return rejectLaunch('unknown_provider', `Unknown provider: ${resolved.providerName}`);

    return this.resumeResolved(resolved.providerName, spec, resolved.session, input, ctx);
  }

  async forkBySessionId(input: ForkIntent, ctx: InvocationContext): Promise<LaunchDecision> {
    const resolved = this.resolveSessionByIdForContinuation(input.sessionId, ctx, input.provider);
    if ('status' in resolved) return resolved;

    const spec = this.deps.providerRegistry.get(resolved.providerName);
    if (!spec) return rejectLaunch('unknown_provider', `Unknown provider: ${resolved.providerName}`);

    return this.forkResolved(resolved.providerName, spec, resolved.session, input, ctx);
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: InvocationContext,
  ): Promise<LaunchDecision> {
    const forcedIdent = coralName.startsWith('coral:') ? coralName : `coral:${coralName}`;
    const bypassPermissions = input.bypassPermissions ?? true;

    if (input.sessionId) {
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
      },
      ctx,
    );
  }

  list(providerName: string): ListResult {
    return { sessions: this.deps.sessionManager.list(providerName) };
  }

  private resolveSessionByIdForContinuation(
    sessionId: string,
    ctx: InvocationContext,
    expectedProvider?: string,
  ): { providerName: string; session: SessionEntry } | LaunchDecision {
    if (!this.deps.sessionLookup) {
      throw new Error('ExecutionService requires sessionLookup for session-id continuation.');
    }
    const session = getSessionById(sessionId, this.deps.runtime, this.deps.sessionLookup);
    if (!session) {
      return rejectLaunch('session_not_found', `Session not found: ${sessionId}. Use exec to start a new session.`);
    }
    if (expectedProvider !== undefined && session.provider !== expectedProvider) {
      return rejectLaunch(
        'provider_mismatch',
        `Session ${sessionId} belongs to provider '${session.provider}'. Use \`coral-cli ${session.provider} -s ${sessionId} ...\` instead.`,
      );
    }
    if (session.backendNamespace !== this.deps.backendNamespace || session.projectRoot !== ctx.projectRoot) {
      return rejectLaunch(
        'scope_mismatch',
        `Session ${sessionId} does not belong to this backend namespace and project scope.`,
      );
    }

    return {
      providerName: session.provider,
      session,
    };
  }

  private buildContinuationProfile(
    input: Pick<
      ResumeIntent | ForkIntent,
      'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt' | 'instruction'
    >,
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
    input: ResumeIntent,
    ctx: InvocationContext,
  ): Promise<LaunchDecision> {
    const busyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    if (session.state === 'non_resumable') {
      return rejectLaunch(
        'non_resumable',
        `Session ${input.sessionId} is non-resumable. Use exec to start a new session or fork to branch from it.`,
      );
    }
    if (session.activeJobId) {
      return rejectLaunch('session_busy', busyMessage);
    }
    const expectedVersion = session.version;
    const pool = input.pool ?? 'default';

    const preflightError = await runProviderPreflight(provider, toPreflightRuntime(this.deps.runtime));
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

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

    const continuation = this.buildContinuationProfile(input, session, ctx);
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
    });
  }

  private async forkResolved(
    providerName: string,
    provider: ProviderSpec,
    sourceSession: SessionEntry,
    input: ForkIntent,
    ctx: InvocationContext,
  ): Promise<LaunchDecision> {
    const sourceBusyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    if (sourceSession.activeJobId) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }
    const sourceExpectedVersion = sourceSession.version;

    const preflightError = await runProviderPreflight(provider, toPreflightRuntime(this.deps.runtime));
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const sourceClaimId = this.deps.runtime.ids.uuid();
    const sourceClaimed = await this.deps.sessionManager.claimForJobAtomic(
      sourceSession.sessionId,
      sourceClaimId,
      sourceExpectedVersion,
    );
    if (!sourceClaimed) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }

    try {
      const name = input.name ?? `fork-${this.deps.runtime.time.now()}`;
      const continuation = this.buildContinuationProfile(input, sourceSession, ctx);
      const newSession = this.deps.sessionManager.allocate({
        provider: providerName,
        name,
        model: continuation.model,
        cwd: continuation.cwd,
        projectRoot: ctx.projectRoot,
        backendNamespace: this.deps.backendNamespace,
        ...(continuation.agentName !== undefined ? { agentName: continuation.agentName } : {}),
        ...(continuation.instruction !== undefined ? { instruction: continuation.instruction } : {}),
        bypassPermissions: continuation.bypassPermissions,
        ...(continuation.systemPrompt !== undefined ? { systemPrompt: continuation.systemPrompt } : {}),
        ...(continuation.controllerProfile !== undefined ? { controllerProfile: continuation.controllerProfile } : {}),
      });
      const admitted = await this.claimAndAdmitJob(
        newSession,
        providerName,
        ctx.projectRoot,
        'New fork session already has an active job',
        newSession.version,
      );
      if ('status' in admitted) return admitted;

      const request: ProviderRequest = {
        action: 'fork',
        sessionId: newSession.sessionId,
        name: input.name,
        prompt: input.prompt ?? '',
        conversationRef: sourceSession.conversationRef,
        model: continuation.model,
        cwd: continuation.cwd,
        effort: continuation.effort,
        bypassPermissions: continuation.bypassPermissions,
        systemPrompt: continuation.systemPrompt,
        instruction: continuation.instruction,
        coralEnv: continuation.coralEnv,
      };

      return this.launchProviderJob(provider, newSession.sessionId, admitted.jobId, request, admitted.admission, {
        projectRoot: ctx.projectRoot,
        workflowSlotId: input.workflowSlotId,
      });
    } finally {
      this.deps.sessionManager.releaseJob(sourceSession.sessionId, sourceClaimId);
    }
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
            progressStore: this.deps.progressStore,
            sessionManager: this.deps.sessionManager,
            backendNamespace: this.deps.backendNamespace,
            bundleHash: this.deps.bundleHash,
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
    opts: { pool?: LaunchPool; projectRoot?: string; parentWorkflowJobId?: string; workflowSlotId?: string } = {},
  ): LaunchDecision {
    return this.deps.launchOrchestrator.launchProviderJob(provider, sessionId, jobId, request, admission, opts);
  }
}
