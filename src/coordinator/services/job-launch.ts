import type { ProviderRequest } from '../../providers/contract.js';
import { hasUnterminalRetentionDiscardRequest, type JobConversation } from '../../jobs/conversation/entry.js';
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
import { assertNever, thrownErrnoCode } from '../../infra/error-format.js';
import { throwIfRequestAborted } from '../../runtime/request-lease-identity.js';
import type { ConversationExecutionPort } from '../../jobs/conversation/contracts.js';
import type { ProviderJobLaunchPort } from '../../jobs/contracts/job-runner.js';
import {
  refuseLaunch,
  undeterminedLaunch,
  type JobLaunchRequest,
  type JobResumeRequest,
  type ProviderJobLaunchDecision,
  type RefusedLaunchDecision,
} from '../../jobs/launch.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { ListResult } from '../contracts.js';
import {
  buildEffectiveCoralEnv,
  buildConversationControllerProfile,
  type CoralIntent,
  type EffectiveContinuationProfile,
  mapResolverError,
  resolveAgentLaunchProfile,
  runProviderPreflight,
  toPreflightRuntime,
} from './execution-policies.js';
import { CHILD_PRINCIPAL_CAPABILITIES, type ChildPrincipalRegistry } from '../child-principal-registry.js';
import { CORAL_CHILD_CREDENTIAL_ID, CORAL_CHILD_CREDENTIAL_KEY } from '../../security/child-principal-env.js';
import type { ProviderOperationProtectedEnvironment } from '../../jobs/contracts/provider-operation-lifecycle.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';

type CanonicalContinuationProfile = Omit<EffectiveContinuationProfile, 'cwd'> & {
  cwd: CanonicalWorkDir;
};

export interface JobLaunchServiceDeps {
  runtime: Runtime;
  conversationManager: ConversationExecutionPort;
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

  private refuseLaunchConflict(error: unknown): RefusedLaunchDecision | null {
    if (!(error instanceof CoralSetupError)) return null;
    switch (error.code) {
      case 'job_launch_duplicate':
      case 'job_owner_mismatch':
      case 'job_owner_missing':
      case 'job_provider_session_missing':
      case 'job_binding_owner_mismatch':
      case 'discussion_job_launch_conflict':
      case 'workflow_owner_terminal':
      case 'workflow_slot_job_conflict':
      case 'workflow_slot_job_mismatch':
        return refuseLaunch(error.code, error.userMessage);
      default:
        return null;
    }
  }

  private async launchOrRefuse(run: () => Promise<ProviderJobLaunchDecision>): Promise<ProviderJobLaunchDecision> {
    try {
      return await run();
    } catch (error: unknown) {
      const refusal = this.refuseLaunchConflict(error);
      if (refusal !== null) return refusal;
      throw error;
    }
  }

  async start(
    providerName: string,
    input: JobLaunchRequest,
    ctx: InvocationContext,
    signal?: AbortSignal,
  ): Promise<ProviderJobLaunchDecision> {
    throwIfRequestAborted(signal);
    if (!this.deps.providerRegistry.get(providerName)) {
      return refuseLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }

    const bound = await this.bindInvocationProfile(providerName, ctx, 'launch');
    throwIfRequestAborted(signal);
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
    const controllerProfile = buildConversationControllerProfile(effectiveCoralEnv);
    const instruction = resolvedAgent?.instruction ?? input.instruction;
    const bypassPermissions = input.bypassPermissions ?? resolvedAgent !== null;
    const retention = input.retention ?? 'retain';

    let preflightRuntime;
    try {
      preflightRuntime = toPreflightRuntime(this.deps.runtime, cwd, effectiveCoralEnv);
    } catch (error: unknown) {
      return refuseLaunch(
        'provider_execution_environment_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
    const preflightDecision = await runProviderPreflight(bound, preflightRuntime, signal);
    throwIfRequestAborted(signal);
    switch (preflightDecision.kind) {
      case 'satisfied':
        break;
      case 'refused':
        return refuseLaunch('provider_preflight_failed', preflightDecision.message);
      case 'undetermined':
        return undeterminedLaunch('provider_preflight_undetermined', preflightDecision.message);
      default:
        return assertNever(preflightDecision);
    }

    throwIfRequestAborted(signal);
    const session = this.deps.conversationManager.prepare({
      jobId: input.jobId,
      effort: resolveEffort(input.effort) ?? resolvedAgent?.effort,
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
      jobId: session.jobId,
      name: requestName,
      prompt: input.prompt,
      model,
      cwd,
      effort: resolveEffort(input.effort) ?? resolvedAgent?.effort,
      bypassPermissions,
      systemPrompt: input.systemPrompt,
      instruction,
      coralEnv: effectiveCoralEnv,
    };

    throwIfRequestAborted(signal);
    return this.launchOrRefuse(() =>
      this.deps.launchOrchestrator.launchExecution(bound, session, request, {
        owner: input.owner ?? { kind: 'provider-session', id: session.jobId },
        pool,
        parentWorkflowJobId: input.parentWorkflowJobId,
        workflowSlotId: input.workflowSlotId,
        discussionRun: input.discussionRun,
        retention,
        mintProtectedEnv: (jobId, execution) =>
          this.mintChildPrincipalSecretEnv(ctx, jobId, execution, 'job-launch:start'),
      }),
    );
  }

  async resume(
    providerName: string,
    input: JobResumeRequest,
    ctx: InvocationContext,
  ): Promise<ProviderJobLaunchDecision> {
    if (!this.deps.providerRegistry.get(providerName)) {
      return refuseLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }

    const session = this.deps.conversationManager.get(providerName, input.jobId);
    if (!session) {
      return refuseLaunch(
        'session_not_found',
        `Conversation job not found: ${input.jobId}. Use exec to open a new conversation job.`,
      );
    }

    const persisted = this.deps.providerRegistry.rehydrateBinding(session.binding);
    if (!persisted.ok) return this.refuseBinding(persisted.failure);
    const persistedReadiness = await persisted.value.readiness('resume', this.bindingRuntime());
    if (!persistedReadiness.ok) return this.refuseBinding(persistedReadiness.failure);
    const caller = await this.bindInvocationProfile(providerName, ctx, 'resume');
    if ('status' in caller) return caller;

    const identity = persisted.value.compareIdentity(caller.envelope);
    if (!identity.ok) return this.refuseBinding(identity.failure);

    return this.resumeResolved(providerName, persisted.value, session, input, ctx);
  }

  private bindingRuntime(): ProviderBindingRuntime {
    return this.deps.runtime.storage;
  }

  private refuseBinding(failure: ProviderBindingFailure): RefusedLaunchDecision {
    return refuseLaunch(providerBindingFailureCode(failure), this.deps.providerRegistry.renderBindingFailure(failure));
  }

  private async bindInvocationProfile(
    providerName: string,
    ctx: InvocationContext,
    use: 'launch' | 'resume',
  ): Promise<BoundProvider | RefusedLaunchDecision> {
    if (!hasProviderScope(ctx)) {
      return this.refuseBinding({ reason: 'missing-profile', provider: providerName });
    }
    const binding = await this.deps.providerRegistry.bindFromScope(
      ctx.providerScope,
      providerName,
      use,
      this.bindingRuntime(),
    );
    if (!binding.ok) return this.refuseBinding(binding.failure);
    return binding.value;
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: InvocationContext,
  ): Promise<ProviderJobLaunchDecision> {
    const forcedIdent = coralName.startsWith('coral:') ? coralName : `coral:${coralName}`;
    const bypassPermissions = input.bypassPermissions ?? true;

    if (input.jobId !== undefined && this.deps.conversationManager.readById(input.jobId) !== null) {
      return this.resume(
        providerName,
        {
          jobId: input.jobId,
          prompt: input.prompt,
          workflowSlotId: input.workflowSlotId,
          agent: forcedIdent,
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
    return { sessions: this.deps.conversationManager.list(providerName) };
  }

  private buildContinuationProfile(
    input: Pick<JobResumeRequest, 'effort' | 'bypassPermissions' | 'systemPrompt' | 'instruction'>,
    session: JobConversation,
    ctx: InvocationContext,
  ): CanonicalContinuationProfile {
    const coralEnv = buildEffectiveCoralEnv(ctx.coralEnv, {
      effort: input.effort,
      controllerProfile: session.controllerProfile,
    });

    return {
      model: session.model,
      cwd: session.cwd,
      effort: session.effort,
      bypassPermissions: session.bypassPermissions,
      systemPrompt: session.systemPrompt,
      instruction: session.instruction,
      controllerProfile: buildConversationControllerProfile(coralEnv),
      coralEnv,
      agentName: session.agent,
    };
  }

  private async resumeResolved(
    providerName: string,
    provider: BoundProvider,
    session: JobConversation,
    input: JobResumeRequest,
    ctx: InvocationContext,
  ): Promise<ProviderJobLaunchDecision> {
    const busyMessage = `Job ${input.jobId} already has an active execution. Run coral-cli jobs wait ${input.jobId} before continuing.`;
    if (session.conversationRef === undefined) {
      return refuseLaunch(
        'non_resumable',
        `No provider conversation reference was recorded for job ${input.jobId}; its conversation cannot be continued.`,
      );
    }
    if (session.open && !session.finishing) {
      return refuseLaunch('session_busy', busyMessage);
    }
    if (!session.finishing && hasUnterminalRetentionDiscardRequest(session)) {
      return refuseLaunch(
        'retention_discard_in_flight',
        `Execution of ${input.jobId} is finishing retention. Run coral-cli jobs wait ${input.jobId} before continuing.`,
      );
    }
    const pool = input.pool ?? 'default';

    const continuation = this.buildContinuationProfile(input, session, ctx);
    try {
      if (!this.deps.runtime.storage.statSync(continuation.cwd).isDirectory())
        return refuseLaunch('work_directory_missing', 'The conversation work directory is no longer a directory.');
    } catch (error: unknown) {
      const code = thrownErrnoCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return refuseLaunch('work_directory_missing', 'The conversation work directory is missing.');
      return undeterminedLaunch(
        'work_directory_unobservable',
        'The conversation work directory could not be observed.',
      );
    }
    let preflightRuntime;
    try {
      preflightRuntime = toPreflightRuntime(this.deps.runtime, continuation.cwd, continuation.coralEnv);
    } catch (error: unknown) {
      return refuseLaunch(
        'provider_execution_environment_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
    const preflightDecision = await runProviderPreflight(provider, preflightRuntime);
    switch (preflightDecision.kind) {
      case 'satisfied':
        break;
      case 'refused':
        return refuseLaunch('provider_preflight_failed', preflightDecision.message);
      case 'undetermined':
        return undeterminedLaunch('provider_preflight_undetermined', preflightDecision.message);
      default:
        return assertNever(preflightDecision);
    }

    const request: ProviderRequest = {
      action: 'resume',
      jobId: session.jobId,
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

    return this.launchOrRefuse(() =>
      this.deps.launchOrchestrator.launchExecution(provider, session, request, {
        owner: input.owner ?? { kind: 'provider-session', id: session.jobId },
        pool,
        parentWorkflowJobId: input.parentWorkflowJobId,
        workflowSlotId: input.workflowSlotId,
        discussionRun: input.discussionRun,
        originatingClientMessageId: input.originatingClientMessageId,
        continuationTarget: input.continuationTarget,
        mintProtectedEnv: (jobId, execution) =>
          this.mintChildPrincipalSecretEnv(ctx, jobId, execution, 'job-launch:resume'),
      }),
    );
  }

  private mintChildPrincipalSecretEnv(
    ctx: InvocationContext,
    jobId: string,
    execution: number,
    issuer: string,
  ): ProviderOperationProtectedEnvironment {
    const credential = this.deps.childPrincipalRegistry.register({
      issuer,
      parentPrincipal: ctx.principal,
      namespace: this.deps.backendNamespace,
      parentJobId: jobId,
      execution,
      nowMs: this.deps.runtime.time.now(),
      childCaps: CHILD_PRINCIPAL_CAPABILITIES,
    });
    return {
      env: {
        CORAL_JOB_ID: jobId,
        [CORAL_CHILD_CREDENTIAL_ID]: credential.credentialId,
        [CORAL_CHILD_CREDENTIAL_KEY]: credential.privateKey,
      },
      childAuthorization: credential.authorization,
    };
  }
}
