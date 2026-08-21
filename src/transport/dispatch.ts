import type { DiscussSessionsListResponse } from '../discuss/read-contract.js';
import type { JobLaunchRequest } from '../jobs/launch.js';
import type { JobsListResponse } from '../jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../jobs/wait.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import {
  canonicalizeWorkDir,
  containsWorkDir,
  type CanonicalWorkDir,
  WorkDirectoryError,
} from '../runtime/canonical-work-dir.js';
import { isCapability, type Capability } from '../security/capability.js';
import type { Principal, ResourceBinding } from '../security/principal.js';
import { authorizeCapability, authorizeResourceBinding, type Decision } from '../security/policy/authorize.js';
import { writeAuthorizationDecisionAudit } from '../infra/audit-log.js';
import { isRecord } from '../infra/json.js';
import type { RecoveryQuarantineClearRequest } from '../recovery/source-registry.js';
import { domainError, type ToolDomainResult } from './tool-result.js';
import { domainResultToHttp, launchToHttp } from './response.js';
import type { HttpHandlerPorts } from './server-ports.js';
import type { RequestBindingRule, RpcMethodSpec } from './rpc/catalog.js';
import {
  providerHostEvictResponseSchema,
  providerHostInspectResponseSchema,
  providerHostListResponseSchema,
  type ProviderHostSelectorRequest,
} from './rpc/catalog.js';
import type { WorkflowPortInput } from './rpc/ports.js';
import type { JobsListFilters } from '../jobs/read-queries.js';
import { buildInvocationContext, buildInvocationContextFromQuery } from './invocation-context.js';
import { callerProviderScopeSchema } from '../infra/provider-scope.js';
import { encodeHostRef } from '../providers/host-ref-codec.js';

type RetentionPolicy = NonNullable<JobLaunchRequest['retention']>;

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export type CatalogRequestExecution =
  | { kind: 'unary'; body: unknown; statusCode?: number }
  | { kind: 'subscription'; notifications: AsyncIterable<unknown> };

const BACKEND_RECOVERING_MESSAGE = 'recovering — retry after 500ms';

function invalidRequestResult(message = 'invalid request', detail?: unknown): ToolDomainResult {
  return domainError('invalid_request', message, detail);
}

// The refused job's own work directory is deliberately not disclosed: the caller is outside the
// scope that would authorize reading it.
function jobScopeMismatchResult(jobs: readonly string[]): ToolDomainResult {
  return {
    ok: false,
    code: 'scope_mismatch',
    message: "Jobs are outside the caller's work directory scope",
    remediation: "Rerun from the job's work directory, or from a directory that contains it.",
    detail: { jobs: [...jobs] },
  };
}

function unary(body: unknown, statusCode?: number): CatalogRequestExecution {
  return statusCode === undefined ? { kind: 'unary', body } : { kind: 'unary', body, statusCode };
}

function unaryHttp(response: { statusCode: number; body: unknown }): CatalogRequestExecution {
  return unary(response.body, response.statusCode);
}

function unaryDomain(result: ToolDomainResult, successStatusCode = 200): CatalogRequestExecution {
  const response = domainResultToHttp(result);
  return unary(response.body, result.ok ? successStatusCode : response.statusCode);
}

function buildBodyInvocationContext(
  request: Record<string, unknown>,
  projectRoot: CanonicalWorkDir | undefined,
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
): InvocationContext | null {
  if (projectRoot === undefined) return null;
  let providerScope: InvocationContext['providerScope'] = rpcPorts.systemProviderScope;
  if (principal.transport !== 'http') {
    if (request.providerScope === undefined) {
      providerScope = undefined;
    } else {
      const callerScope = callerProviderScopeSchema.safeParse(request.providerScope);
      if (!callerScope.success) return null;
      providerScope = callerScope.data;
    }
  }
  return buildInvocationContext(
    request,
    projectRoot,
    rpcPorts.identity.pluginRoot,
    rpcPorts.coralEnvSnapshot,
    principal,
    providerScope,
  );
}

function buildQueryContext(
  projectRoot: CanonicalWorkDir | undefined,
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
): InvocationContext {
  if (projectRoot === undefined) {
    throw new Error('Validated project-scoped request has no canonical project root.');
  }
  return buildInvocationContextFromQuery(
    projectRoot,
    rpcPorts.identity.pluginRoot,
    rpcPorts.coralEnvSnapshot,
    principal,
  );
}

function stripTransportContextKeys<T extends Record<string, unknown>>(
  parsed: T,
): Omit<
  T,
  | 'projectRoot'
  | 'owner'
  | 'effort'
  | 'claudeModelCap'
  | 'claudeTransport'
  | 'jobId'
  | 'sessionId'
  | 'networkEnv'
  | 'coralEnv'
  | 'providerScope'
> {
  const {
    projectRoot: _projectRoot,
    owner: _owner,
    effort: _effort,
    claudeModelCap: _claudeModelCap,
    claudeTransport: _claudeTransport,
    jobId: _jobId,
    sessionId: _sessionId,
    networkEnv: _networkEnv,
    coralEnv: _coralEnv,
    providerScope: _providerScope,
    ...args
  } = parsed as T & {
    projectRoot?: unknown;
    owner?: unknown;
    effort?: unknown;
    claudeModelCap?: unknown;
    claudeTransport?: unknown;
    jobId?: unknown;
    sessionId?: unknown;
    networkEnv?: unknown;
    coralEnv?: unknown;
    providerScope?: unknown;
  };
  return args;
}

function maybeBuildBodyInvocationContext(
  request: Record<string, unknown>,
  projectRoot: CanonicalWorkDir | undefined,
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
): InvocationContext | undefined {
  return projectRoot === undefined
    ? undefined
    : (buildBodyInvocationContext(request, projectRoot, rpcPorts, principal) ?? undefined);
}

function ensureLaunchFenceInactive(rpcPorts: HttpHandlerPorts): { statusCode: number; body: unknown } | null {
  if (!rpcPorts.admin.isLaunchFenceActive()) {
    return null;
  }
  return domainResultToHttp(domainError('backend_recovering', BACKEND_RECOVERING_MESSAGE));
}

function ensureProviderScopeConfigured(
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
): { statusCode: number; body: unknown } | null {
  if (principal.transport !== 'http' || rpcPorts.systemProviderScope !== undefined) return null;
  return {
    statusCode: 503,
    body: {
      code: 'system_provider_scope_unconfigured',
      message: 'Provider execution is disabled because this Coral daemon has no named system provider scope.',
      remediation: 'Configure CORAL_SYSTEM_PROVIDER_SCOPE on the daemon and restart it.',
    },
  };
}

type CommonSessionInput = {
  model?: string;
  cwd: CanonicalWorkDir;
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
};

type CreateSessionInputFields = CommonSessionInput & {
  retention?: RetentionPolicy;
};

function isRetentionPolicy(value: unknown): value is RetentionPolicy {
  return value === 'retain' || value === 'discard_provider_artifacts_on_terminal';
}

function commonSessionInputFields(parsed: Record<string, unknown>, cwd: CanonicalWorkDir): CommonSessionInput {
  const result: CommonSessionInput = { cwd };
  if (typeof parsed.model === 'string') result.model = parsed.model;
  if (typeof parsed.effort === 'string') result.effort = parsed.effort;
  if (typeof parsed.bypassPermissions === 'boolean') result.bypassPermissions = parsed.bypassPermissions;
  if (typeof parsed.systemPrompt === 'string') result.systemPrompt = parsed.systemPrompt;
  return result;
}

function createSessionInputFields(parsed: Record<string, unknown>, cwd: CanonicalWorkDir): CreateSessionInputFields {
  const result: CreateSessionInputFields = commonSessionInputFields(parsed, cwd);
  if (isRetentionPolicy(parsed.retention)) result.retention = parsed.retention;
  return result;
}

function withAbortSignal<T extends object>(request: T, abortSignal?: AbortSignal): T {
  if (!abortSignal) {
    return request;
  }

  Object.defineProperty(request, 'abortSignal', {
    value: abortSignal,
    enumerable: false,
    configurable: true,
  });
  return request;
}

/**
 * `interrupted` is withheld here rather than left to the wire consumer, because HTTP and IPC are two
 * separate emitters and a per-transport check would have to be kept in sync twice. An already-installed
 * CLI that never declared `supportsInterrupted` gets the pre-`interrupted` stream verbatim — indistinguishable
 * from talking to a coordinator that predates the event — instead of a type its renderer has no case for.
 */
async function* withInterruptedGate(
  events: AsyncIterable<WaitStreamEvent>,
  supportsInterrupted: boolean,
): AsyncGenerator<WaitStreamEvent> {
  for await (const event of events) {
    if (event.type === 'interrupted' && !supportsInterrupted) {
      continue;
    }
    yield event;
  }
}

export function resolveRequestBinding(
  rule: RequestBindingRule | undefined,
  projectRoot: CanonicalWorkDir | undefined,
): ResourceBinding {
  const bindingRule = rule ?? ({ kind: 'projectRoot', projectRoot: 'required' } satisfies RequestBindingRule);

  switch (bindingRule.kind) {
    case 'projectRoot': {
      return projectRoot === undefined ? { kind: 'unbound' } : { kind: 'project', root: projectRoot };
    }
  }
}

function requestedBindingFor(
  spec: RpcMethodSpec<unknown, unknown>,
  projectRoot: CanonicalWorkDir | undefined,
): ResourceBinding {
  return resolveRequestBinding(spec.requestBinding, projectRoot);
}

function authorizeCatalogResourceBinding(
  spec: RpcMethodSpec<unknown, unknown>,
  principal: Principal,
  requires: Capability,
  requestedBinding: ResourceBinding,
): Decision {
  const decision = authorizeResourceBinding(principal, requires, requestedBinding);
  if (
    !decision.ok ||
    (spec.name !== 'coordinator.provider_host.inspect' && spec.name !== 'coordinator.provider_host.evict') ||
    principal.binding.kind !== 'project' ||
    requestedBinding.kind !== 'project'
  ) {
    return decision;
  }

  if (containsWorkDir(principal.binding.root, requestedBinding.root)) {
    return decision;
  }

  return {
    ok: false,
    reason: 'resource_unbound',
    detail: { requires, requestedBinding, principalBinding: principal.binding, subject: principal.subject },
  };
}

function canonicalizeRequestProjectRoot(request: unknown): {
  request: unknown;
  projectRoot: CanonicalWorkDir | undefined;
} {
  if (
    request === null ||
    typeof request !== 'object' ||
    !Object.prototype.hasOwnProperty.call(request, 'projectRoot')
  ) {
    return { request, projectRoot: undefined };
  }
  const rawProjectRoot = (request as { projectRoot?: unknown }).projectRoot;
  if (typeof rawProjectRoot !== 'string' || rawProjectRoot.length === 0) {
    return { request, projectRoot: undefined };
  }
  const projectRoot = canonicalizeWorkDir(rawProjectRoot, process.cwd());
  return { request: { ...request, projectRoot }, projectRoot };
}

function canonicalizeCatalogRequest(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
): {
  request: unknown;
  projectRoot: CanonicalWorkDir | undefined;
  authorizationRoot: CanonicalWorkDir | undefined;
} {
  const canonical = canonicalizeRequestProjectRoot(request);
  if (
    canonical.projectRoot === undefined ||
    ![
      'sessions.create',
      'workflow.run',
      'coordinator.provider_host.inspect',
      'coordinator.provider_host.evict',
    ].includes(spec.name) ||
    canonical.request === null ||
    typeof canonical.request !== 'object'
  ) {
    return { ...canonical, authorizationRoot: canonical.projectRoot };
  }

  const rawWorkDir = (canonical.request as { workDir?: unknown }).workDir;
  if (typeof rawWorkDir !== 'string') {
    return { ...canonical, authorizationRoot: canonical.projectRoot };
  }

  const workDir = canonicalizeWorkDir(rawWorkDir, canonical.projectRoot);
  return {
    request: { ...canonical.request, workDir },
    projectRoot: canonical.projectRoot,
    authorizationRoot: workDir,
  };
}

function narrowUnboundPrincipal(principal: Principal, binding: ResourceBinding): Principal {
  return principal.binding.kind === 'unbound' && binding.kind === 'project' ? { ...principal, binding } : principal;
}

function workDirectoryFailure(error: WorkDirectoryError): CatalogRequestExecution {
  return unary(
    {
      code: error.code,
      message: error.message,
      detail: { workDir: error.workDir, projectRoot: error.baseDir },
    },
    400,
  );
}

type ProviderHostAdministrationErrorCode =
  | 'provider_host_inventory_unavailable'
  | 'provider_host_not_found'
  | 'provider_host_ambiguous'
  | 'provider_host_identity_integrity'
  | 'provider_host_stale';

const PROVIDER_HOST_ADMINISTRATION_ERROR_CODES = new Set<ProviderHostAdministrationErrorCode>([
  'provider_host_inventory_unavailable',
  'provider_host_not_found',
  'provider_host_ambiguous',
  'provider_host_identity_integrity',
  'provider_host_stale',
]);

function isProviderHostAdministrationErrorCode(code: unknown): code is ProviderHostAdministrationErrorCode {
  return (
    typeof code === 'string' &&
    PROVIDER_HOST_ADMINISTRATION_ERROR_CODES.has(code as ProviderHostAdministrationErrorCode)
  );
}

function providerHostAdministrationDetail(error: Record<string, unknown>): {
  ownerIds: string[];
  hostRefs: string[];
} {
  const ownerIds = Array.isArray(error.ownerIds)
    ? error.ownerIds.filter((value): value is string => typeof value === 'string')
    : [];
  const hostRefs = Array.isArray(error.matches)
    ? error.matches.flatMap((value) => {
        try {
          return [encodeHostRef(value as Parameters<typeof encodeHostRef>[0])];
        } catch {
          return [];
        }
      })
    : [];
  return { ownerIds, hostRefs };
}

function providerHostAdministrationCopy(
  code: ProviderHostAdministrationErrorCode,
  ownerIds: readonly string[],
  hostRefs: readonly string[],
): { message: string; remediation: string } {
  switch (code) {
    case 'provider_host_inventory_unavailable':
      return {
        message: `Provider-host inventory is unavailable${ownerIds.length === 0 ? '.' : ` from: ${ownerIds.join(', ')}.`}`,
        remediation:
          'Retry the original command; if it persists, run `coral-cli backend shutdown`, then retry the original command to start a fresh coordinator.',
      };
    case 'provider_host_not_found':
      return {
        message: 'No live, retained-blocked, or reclamation-failed provider host matches the selector.',
        remediation: 'Rerun `coral-cli backend provider-host list`, then use a currently listed reference.',
      };
    case 'provider_host_ambiguous':
      return {
        message: `The work directory matches multiple provider hosts: ${hostRefs.join(', ')}.`,
        remediation:
          'For one listed reference, run `coral-cli backend provider-host inspect <ref>` and verify it, then run `coral-cli backend provider-host evict <ref>`; never choose a match by position.',
      };
    case 'provider_host_identity_integrity':
      return {
        message: `The exact provider-host identity matched multiple owners: ${hostRefs.join(', ')}.`,
        remediation:
          'Do not evict: preserve the complete error output, then run `coral-cli backend status` to capture coordinator state before escalating the integrity failure.',
      };
    case 'provider_host_stale':
      return {
        message: `The selected provider host changed before the owner could revalidate it: ${hostRefs.join(', ')}.`,
        remediation: 'Rerun `coral-cli backend provider-host list` and act only on a currently listed reference.',
      };
  }
}

function providerHostAdministrationFailure(error: unknown): CatalogRequestExecution | null {
  if (!isRecord(error) || !isProviderHostAdministrationErrorCode(error.code)) return null;

  const { ownerIds, hostRefs } = providerHostAdministrationDetail(error);
  const { message, remediation } = providerHostAdministrationCopy(error.code, ownerIds, hostRefs);
  const statusCode =
    error.code === 'provider_host_not_found' ? 404 : error.code === 'provider_host_inventory_unavailable' ? 503 : 409;
  return unary(
    {
      code: error.code,
      message,
      remediation,
      detail: { ownerIds, hostRefs },
    },
    statusCode,
  );
}

function providerHostSelectorFromRequest(
  request: ProviderHostSelectorRequest,
  canonicalWorkDir: CanonicalWorkDir | undefined,
):
  | Readonly<{ hostRef: Extract<ProviderHostSelectorRequest, { hostRef: unknown }>['hostRef'] }>
  | Readonly<{ workDir: CanonicalWorkDir }> {
  if ('hostRef' in request) return { hostRef: request.hostRef };
  if (canonicalWorkDir === undefined) {
    throw new Error('Validated provider-host work-directory selector has no canonical work directory.');
  }
  return { workDir: canonicalWorkDir };
}

function requiredCapability(spec: RpcMethodSpec<unknown, unknown>): Capability | null {
  const requires = (spec as { readonly requires?: unknown }).requires;
  return isCapability(requires) ? requires : null;
}

function authorizationFailure(
  decision: Extract<Decision, { ok: false }>,
  principal: Principal,
): CatalogRequestExecution {
  const statusCode = decision.reason === 'resource_unbound' ? 403 : 401;
  const code = decision.reason === 'resource_unbound' ? 'scope_mismatch' : decision.reason;
  const message =
    decision.reason === 'unauthenticated'
      ? 'Authentication required'
      : decision.reason === 'missing_capability'
        ? principal.credential.kind === 'child-principal'
          ? 'This nested Coral session cannot perform this command. Ask the top-level Coral session to run it.'
          : 'Missing required capability'
        : 'Principal is not bound to the requested resource';

  return unary({ code, message, detail: decision.detail }, statusCode);
}

export async function executeCatalogRequest(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
  abortSignal?: AbortSignal,
): Promise<CatalogRequestExecution> {
  const requires = requiredCapability(spec);
  if (requires === null) {
    return unary(
      {
        code: 'authorization_misconfigured',
        message: `RPC route ${spec.name} is missing an authorization capability.`,
      },
      500,
    );
  }

  const capabilityAuthz = authorizeCapability(principal, requires);
  if (!capabilityAuthz.ok) {
    const unbound = { kind: 'unbound' } as const;
    writeAuthorizationDecisionAudit(principal, spec.name, capabilityAuthz, unbound);
    return authorizationFailure(capabilityAuthz, principal);
  }

  let canonicalRequest: ReturnType<typeof canonicalizeCatalogRequest>;
  try {
    canonicalRequest = canonicalizeCatalogRequest(spec, request);
  } catch (error: unknown) {
    if (error instanceof WorkDirectoryError) return workDirectoryFailure(error);
    throw error;
  }
  request = canonicalRequest.request;
  const requestedBinding = requestedBindingFor(spec, canonicalRequest.authorizationRoot);
  principal = narrowUnboundPrincipal(principal, requestedBinding);
  const authz = authorizeCatalogResourceBinding(spec, principal, requires, requestedBinding);
  writeAuthorizationDecisionAudit(principal, spec.name, authz, requestedBinding);
  if (!authz.ok) {
    return authorizationFailure(authz, principal);
  }

  return dispatchCatalogRequest({ spec, request, canonicalRequest, rpcPorts, principal, abortSignal });
}

type AuthorizedCatalogRequest = Readonly<{
  spec: RpcMethodSpec<unknown, unknown>;
  request: unknown;
  canonicalRequest: ReturnType<typeof canonicalizeCatalogRequest>;
  rpcPorts: HttpHandlerPorts;
  principal: Principal;
  abortSignal: AbortSignal | undefined;
}>;

function dispatchCatalogRequest(context: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  if (context.spec.name.startsWith('jobs.')) return executeJobsCatalogRequest(context);
  if (context.spec.name.startsWith('discuss.')) return executeDiscussCatalogRequest(context);
  if (context.spec.name.startsWith('kb.')) return executeKnowledgeBaseCatalogRequest(context);
  return executeCoordinatorCatalogRequest(context);
}

function executeCoordinatorCatalogRequest(context: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const route = context.spec.name;
  if (route.startsWith('coordinator.provider_host.')) return executeProviderHostCatalogRequest(context);

  switch (route) {
    case 'coordinator.recovery_quarantine.clear':
      return executeRecoveryQuarantineCatalogRequest(context);
    case 'sessions.create':
      return executeCreateSessionCatalogRequest(context);
    case 'workflow.run':
      return executeWorkflowCatalogRequest(context);
    default:
      return executeExpansionCatalogRequest(context);
  }
}

async function executeRecoveryQuarantineCatalogRequest({
  request,
  rpcPorts,
  abortSignal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  return unary(await rpcPorts.recoveryQuarantine.clear(request as RecoveryQuarantineClearRequest, abortSignal));
}

async function executeProviderHostListCatalogRequest({
  rpcPorts,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const providerHosts = rpcPorts.providerHosts;
  if (providerHosts === undefined) {
    return providerHostAdministrationFailure({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['coordinator'],
    }) as CatalogRequestExecution;
  }
  try {
    return unary(providerHostListResponseSchema.parse(await providerHosts.list()));
  } catch (error: unknown) {
    const failure = providerHostAdministrationFailure(error);
    if (failure !== null) return failure;
    throw error;
  }
}

async function executeProviderHostInspectCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const providerHosts = rpcPorts.providerHosts;
  if (providerHosts === undefined) {
    return providerHostAdministrationFailure({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['coordinator'],
    }) as CatalogRequestExecution;
  }
  try {
    const selector = providerHostSelectorFromRequest(
      request as ProviderHostSelectorRequest,
      canonicalRequest.authorizationRoot,
    );
    return unary(providerHostInspectResponseSchema.parse(await providerHosts.inspect(selector)));
  } catch (error: unknown) {
    if (error instanceof WorkDirectoryError) return workDirectoryFailure(error);
    const failure = providerHostAdministrationFailure(error);
    if (failure !== null) return failure;
    throw error;
  }
}

async function executeProviderHostEvictCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const providerHosts = rpcPorts.providerHosts;
  if (providerHosts === undefined) {
    return providerHostAdministrationFailure({
      code: 'provider_host_inventory_unavailable',
      ownerIds: ['coordinator'],
    }) as CatalogRequestExecution;
  }
  try {
    const selector = providerHostSelectorFromRequest(
      request as ProviderHostSelectorRequest,
      canonicalRequest.authorizationRoot,
    );
    return unary(providerHostEvictResponseSchema.parse(await providerHosts.evict(selector)));
  } catch (error: unknown) {
    if (error instanceof WorkDirectoryError) return workDirectoryFailure(error);
    const failure = providerHostAdministrationFailure(error);
    if (failure !== null) return failure;
    throw error;
  }
}

function executeProviderHostCatalogRequest(context: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (context.spec.name) {
    case 'coordinator.provider_host.list':
      return executeProviderHostListCatalogRequest(context);
    case 'coordinator.provider_host.inspect':
      return executeProviderHostInspectCatalogRequest(context);
    case 'coordinator.provider_host.evict':
      return executeProviderHostEvictCatalogRequest(context);
    default:
      throw new Error(`Unhandled transport RPC route: ${context.spec.name}`);
  }
}

async function executeCreateSessionCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Record<string, unknown> & { provider: string; prompt: string };
  const recovering = ensureLaunchFenceInactive(rpcPorts);
  if (recovering) return unaryHttp(recovering);
  const unconfigured = ensureProviderScopeConfigured(rpcPorts, principal);
  if (unconfigured) return unaryHttp(unconfigured);
  const projectRoot = canonicalRequest.projectRoot;
  const cwd = canonicalRequest.authorizationRoot;
  if (projectRoot === undefined || cwd === undefined) {
    return unaryHttp(domainResultToHttp(invalidRequestResult()));
  }
  const ctx = buildBodyInvocationContext(parsed, projectRoot, rpcPorts, principal);
  if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

  const decision = await rpcPorts.sessions.start(
    parsed.provider,
    {
      prompt: parsed.prompt,
      ...(typeof parsed.agent === 'string' ? { agent: parsed.agent } : {}),
      ...createSessionInputFields(parsed, cwd),
    },
    ctx,
  );
  return unaryHttp(launchToHttp(decision, 201));
}

async function executeWorkflowCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Record<string, unknown>;
  const recovering = ensureLaunchFenceInactive(rpcPorts);
  if (recovering) return unaryHttp(recovering);
  const unconfigured = ensureProviderScopeConfigured(rpcPorts, principal);
  if (unconfigured) return unaryHttp(unconfigured);
  const projectRoot = canonicalRequest.projectRoot;
  const workDir = canonicalRequest.authorizationRoot;
  if (projectRoot === undefined || workDir === undefined) {
    return unaryHttp(domainResultToHttp(invalidRequestResult()));
  }
  const ctx = buildBodyInvocationContext(parsed, projectRoot, rpcPorts, principal);
  if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

  // Strip only the pure transport-context keys that are NOT workflow command
  // fields. `owner` is a genuine workflowCommandSchema field and must reach
  // executeWorkflow, so this deliberately does not use stripTransportContextKeys.
  const {
    projectRoot: _projectRoot,
    effort: _effort,
    claudeModelCap: _claudeModelCap,
    claudeTransport: _claudeTransport,
    networkEnv: _networkEnv,
    coralEnv: _coralEnv,
    providerScope: _providerScope,
    ...rawWorkflowCommand
  } = parsed;
  const workflowCommand: WorkflowPortInput = {
    expression: String(rawWorkflowCommand.expression),
    startPrompt: String(rawWorkflowCommand.startPrompt),
    provider: String(rawWorkflowCommand.provider),
    ...(typeof rawWorkflowCommand.context === 'string' ? { context: rawWorkflowCommand.context } : {}),
    ...(typeof rawWorkflowCommand.owner === 'string' ? { owner: rawWorkflowCommand.owner } : {}),
    workDir,
  };
  const result = await rpcPorts.workflows.execute(workflowCommand, ctx);
  if (result.kind === 'invalid_request') {
    return unaryHttp(domainResultToHttp(invalidRequestResult(result.message, result.detail)));
  }

  return unaryHttp(launchToHttp(result.decision, 202));
}

async function executeExpansionCatalogRequest({
  spec,
  request,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'coordinator.equipExpansion': {
      const parsed = request as { name: string };
      return unary(await rpcPorts.expansion.equipExpansion(parsed, principal));
    }

    case 'coordinator.unequipExpansion': {
      const parsed = request as { name: string };
      const name = decodePathSegment(parsed.name);
      if (name === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid expansion name')));
      return unary(await rpcPorts.expansion.unequipExpansion({ name }, principal));
    }

    case 'coordinator.removeExpansionCatalog': {
      const parsed = request as { name: string };
      const name = decodePathSegment(parsed.name);
      if (name === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid expansion name')));
      return unary(await rpcPorts.expansion.removeExpansionCatalog({ name }, principal));
    }

    case 'coordinator.listExpansion':
      return unary(await rpcPorts.expansion.listExpansion({}, principal));

    case 'coordinator.readBinding': {
      const parsed = request as { binding: string };
      const binding = decodePathSegment(parsed.binding);
      if (binding === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid binding name')));
      return unary(await rpcPorts.expansion.readBinding({ binding }, principal));
    }

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}

async function executeJobsAbortCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as { jobs: string[]; projectRoot: string };
  const callerRoot = canonicalRequest.projectRoot;
  if (callerRoot === undefined) return unaryHttp(domainResultToHttp(invalidRequestResult()));
  const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobs, callerRoot, 'contains');
  if (scopeCheck.mismatch.length > 0) {
    return unaryHttp(domainResultToHttp(jobScopeMismatchResult(scopeCheck.mismatch)));
  }
  if (scopeCheck.missing.length === parsed.jobs.length) {
    return unary(
      {
        code: 'jobs_not_found',
        message: 'Requested jobs were not found',
        detail: { jobs: scopeCheck.missing },
      },
      404,
    );
  }

  return unary(rpcPorts.jobs.abort(parsed.jobs));
}

async function executeJobsListCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Omit<JobsListFilters, 'projectRoot'> & { provider?: string };
  const callerRoot = canonicalRequest.projectRoot;
  const jobs = rpcPorts.jobs.list({
    ...(callerRoot === undefined ? {} : { projectRoot: callerRoot }),
    ...(parsed.phase === undefined ? {} : { phase: parsed.phase }),
    ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
    all: parsed.all === true,
  });
  jobs.sort((left, right) => right.status.updatedAt.localeCompare(left.status.updatedAt));
  return unary({ jobs } satisfies JobsListResponse);
}

async function executeJobsDetailCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as { jobId: string; projectRoot: string };
  const callerRoot = canonicalRequest.projectRoot;
  if (callerRoot === undefined) return unaryHttp(domainResultToHttp(invalidRequestResult()));
  const scopeCheck = rpcPorts.jobs.scopeCheck([parsed.jobId], callerRoot, 'contains');
  if (scopeCheck.mismatch.length > 0) {
    return unaryHttp(domainResultToHttp(jobScopeMismatchResult(scopeCheck.mismatch)));
  }
  if (scopeCheck.missing.length === 1) {
    return unary({ code: 'job_not_found', message: `Job not found: ${parsed.jobId}` }, 404);
  }

  const detail = rpcPorts.jobs.detail(parsed.jobId);
  if (!detail) {
    return unary({ code: 'job_not_found', message: `Job not found: ${parsed.jobId}` }, 404);
  }
  return unary(detail);
}

async function executeJobsWaitCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  abortSignal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as {
    jobIds: string[];
    projectRoot: string;
    timeoutSeconds?: number;
    cursor?: { afterSeq: number };
    supportsInterrupted?: boolean;
  };
  const callerRoot = canonicalRequest.projectRoot;
  if (callerRoot === undefined) return unaryHttp(domainResultToHttp(invalidRequestResult()));
  const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobIds, callerRoot, 'contains');
  if (scopeCheck.mismatch.length > 0) {
    return unaryHttp(domainResultToHttp(jobScopeMismatchResult(scopeCheck.mismatch)));
  }
  if (scopeCheck.missing.length === parsed.jobIds.length) {
    return unary(
      {
        code: 'jobs_not_found',
        message: 'Requested jobs were not found',
        detail: { jobs: scopeCheck.missing },
      },
      404,
    );
  }

  const { supportsInterrupted, ...waitFields } = parsed;
  const waitRequest: WaitStreamRequest = waitFields;
  return {
    kind: 'subscription',
    notifications: withInterruptedGate(
      rpcPorts.jobs.waitStream(withAbortSignal(waitRequest, abortSignal)) as AsyncIterable<WaitStreamEvent>,
      supportsInterrupted === true,
    ),
  };
}

function executeJobsCatalogRequest(context: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (context.spec.name) {
    case 'jobs.abort':
      return executeJobsAbortCatalogRequest(context);
    case 'jobs.list':
      return executeJobsListCatalogRequest(context);
    case 'jobs.detail':
      return executeJobsDetailCatalogRequest(context);
    case 'jobs.wait':
      return executeJobsWaitCatalogRequest(context);
    default:
      throw new Error(`Unhandled transport RPC route: ${context.spec.name}`);
  }
}

async function executeDiscussSessionCreateCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Record<string, unknown>;
  const recovering = ensureLaunchFenceInactive(rpcPorts);
  if (recovering) return unaryHttp(recovering);
  const unconfigured = ensureProviderScopeConfigured(rpcPorts, principal);
  if (unconfigured) return unaryHttp(unconfigured);
  const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
  if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

  return unaryDomain(await rpcPorts.discuss.start(stripTransportContextKeys(parsed), ctx), 201);
}

async function executeDiscussSessionDetailCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as { projectRoot: string; sessionId: string; view?: 'control' | 'audit' };
  const context = buildQueryContext(canonicalRequest.projectRoot, rpcPorts, principal);
  const detail = rpcPorts.discuss.loadDetail(context.projectRoot, parsed.sessionId, parsed.view ?? 'control');
  if (!detail) {
    return unary({ code: 'session_not_found', message: 'Session not found' }, 404);
  }
  if (detail === 'audit_requires_ended_session') {
    return unary({ code: 'audit_requires_ended_session', message: 'Audit requires ended session' }, 409);
  }
  return unary(detail);
}

async function executeDiscussSessionEventsCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as { sessionId: string; projectRoot: string; cursor?: number };
  const context = buildQueryContext(canonicalRequest.projectRoot, rpcPorts, principal);
  return unaryHttp(
    domainResultToHttp(
      rpcPorts.discuss.watch(
        {
          session: parsed.sessionId,
          ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        },
        context,
      ),
    ),
  );
}

async function executeDiscussSessionBidCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Record<string, unknown> & { sessionId: string };
  const recovering = ensureLaunchFenceInactive(rpcPorts);
  if (recovering) return unaryHttp(recovering);
  const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
  if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

  const { sessionId } = parsed;
  const args = stripTransportContextKeys(parsed);
  return unaryHttp(domainResultToHttp(await rpcPorts.discuss.bid({ ...args, session: sessionId }, ctx)));
}

async function executeDiscussSessionSpeechCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Record<string, unknown> & { sessionId: string };
  const recovering = ensureLaunchFenceInactive(rpcPorts);
  if (recovering) return unaryHttp(recovering);
  const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
  if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

  const { sessionId } = parsed;
  const args = stripTransportContextKeys(parsed);
  return unaryHttp(domainResultToHttp(await rpcPorts.discuss.speech({ ...args, session: sessionId }, ctx)));
}

async function executeDiscussSessionDeleteCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as { sessionId: string; projectRoot: string };
  const context = buildQueryContext(canonicalRequest.projectRoot, rpcPorts, principal);
  return unaryHttp(domainResultToHttp(await rpcPorts.discuss.abort({ session: parsed.sessionId }, context)));
}

async function executeDiscussCatalogRequest(context: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (context.spec.name) {
    case 'discuss.persona.generate':
      return unaryHttp(domainResultToHttp(context.rpcPorts.discuss.seed(context.request)));
    case 'discuss.session.create':
      return executeDiscussSessionCreateCatalogRequest(context);
    case 'discuss.session.list':
      return unary({ sessions: context.rpcPorts.discuss.listSessions() } satisfies DiscussSessionsListResponse);
    case 'discuss.session.detail':
      return executeDiscussSessionDetailCatalogRequest(context);
    case 'discuss.session.events':
      return executeDiscussSessionEventsCatalogRequest(context);
    case 'discuss.session.bid':
      return executeDiscussSessionBidCatalogRequest(context);
    case 'discuss.session.speech':
      return executeDiscussSessionSpeechCatalogRequest(context);
    case 'discuss.session.delete':
      return executeDiscussSessionDeleteCatalogRequest(context);
    default:
      throw new Error(`Unhandled transport RPC route: ${context.spec.name}`);
  }
}

function executeKnowledgeBaseCatalogRequest(context: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const route = context.spec.name;
  if (route.startsWith('kb.note.')) return executeKnowledgeBaseNoteCatalogRequest(context);
  if (route.startsWith('kb.source.')) return executeKnowledgeBaseSourceCatalogRequest(context);
  if (route.startsWith('kb.wiki.')) return executeKnowledgeBaseWikiCatalogRequest(context);
  if (route.startsWith('kb.community.') || route === 'kb.wake_up') {
    return executeKnowledgeBaseCommunityCatalogRequest(context);
  }
  if (route.startsWith('kb.memo.')) return executeKnowledgeBaseMemoCatalogRequest(context);
  if (route.startsWith('kb.principle') || route === 'kb.reindex') {
    return executeKnowledgeBasePrinciplesCatalogRequest(context);
  }
  return executeKnowledgeBaseSearchCatalogRequest(context);
}

async function executeKnowledgeBaseSearchCatalogRequest({
  spec,
  request,
  rpcPorts,
  principal,
  abortSignal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'kb.entries.search': {
      const parsed = request as {
        q: string;
        scope?: string;
        top_k?: number;
        mode?: 'text' | 'vector' | 'hybrid';
      };
      const searchRequest = {
        query: parsed.q,
        ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
        ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
        ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
      };
      return unaryHttp(
        domainResultToHttp(await rpcPorts.kb.readSearch(withAbortSignal(searchRequest, abortSignal), principal)),
      );
    }

    case 'kb.diagnose':
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.diagnose(principal)));

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}

async function executeKnowledgeBaseNoteCatalogRequest({
  spec,
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'kb.note.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.readNote(slug, principal)));
    }

    case 'kb.note.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      return unaryDomain(await rpcPorts.kb.createNote(stripTransportContextKeys(parsed), ctx), 201);
    }

    case 'kb.note.update': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { slug: _slug, ...args } = stripTransportContextKeys(parsed);
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.updateNote({ ...args, note: slug }, ctx)));
    }

    case 'kb.note.delete': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.deleteNote(
            slug,
            maybeBuildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal),
          ),
        ),
      );
    }

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}

async function executeKnowledgeBaseSourceCatalogRequest({
  spec,
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'kb.source.list':
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.listSources(principal)));

    case 'kb.source.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.readSource(slug, principal)));
    }

    case 'kb.source.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const result = await rpcPorts.kb.createSource(stripTransportContextKeys(parsed), ctx);
      const response = domainResultToHttp(result);
      if (!result.ok) {
        return unaryHttp(response);
      }
      const data = result.data;
      let status: unknown;
      if (typeof data === 'object' && data !== null && 'status' in data) {
        status = (data as { status?: unknown }).status;
      }
      return unary(response.body, status === 'running' || status === 'queued' ? 202 : 201);
    }

    case 'kb.source.delete': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.deleteSource(
            slug,
            maybeBuildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal),
          ),
        ),
      );
    }

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}

type PreparedKnowledgeBaseWikiMutation =
  | Readonly<{ ok: true; slug: string; args: Record<string, unknown>; ctx: InvocationContext }>
  | Readonly<{ ok: false; execution: CatalogRequestExecution }>;

function prepareKnowledgeBaseWikiMutation({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): PreparedKnowledgeBaseWikiMutation {
  const parsed = request as Record<string, unknown> & { slug: string };
  const slug = decodePathSegment(parsed.slug);
  if (slug === null) {
    return { ok: false, execution: unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug'))) };
  }
  const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
  if (!ctx) return { ok: false, execution: unaryHttp(domainResultToHttp(invalidRequestResult())) };

  const { slug: _slug, ...args } = stripTransportContextKeys(parsed);
  return { ok: true, slug, args, ctx };
}

async function executeKnowledgeBaseWikiReadCatalogRequest({
  request,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as { slug: string };
  const slug = decodePathSegment(parsed.slug);
  if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
  return unaryHttp(domainResultToHttp(await rpcPorts.kb.readWiki(slug, principal)));
}

async function executeKnowledgeBaseWikiCreateCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Record<string, unknown>;
  const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
  if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

  return unaryDomain(await rpcPorts.kb.createWiki(stripTransportContextKeys(parsed), ctx), 201);
}

async function executeKnowledgeBaseWikiRewriteCatalogRequest(
  context: AuthorizedCatalogRequest,
): Promise<CatalogRequestExecution> {
  const prepared = prepareKnowledgeBaseWikiMutation(context);
  if (!prepared.ok) return prepared.execution;
  return unaryHttp(
    domainResultToHttp(await context.rpcPorts.kb.rewriteWiki({ ...prepared.args, slug: prepared.slug }, prepared.ctx)),
  );
}

async function executeKnowledgeBaseWikiLinkCatalogRequest(
  context: AuthorizedCatalogRequest,
): Promise<CatalogRequestExecution> {
  const prepared = prepareKnowledgeBaseWikiMutation(context);
  if (!prepared.ok) return prepared.execution;
  return unaryHttp(
    domainResultToHttp(await context.rpcPorts.kb.linkWiki({ ...prepared.args, slug: prepared.slug }, prepared.ctx)),
  );
}

async function executeKnowledgeBaseWikiUnlinkCatalogRequest(
  context: AuthorizedCatalogRequest,
): Promise<CatalogRequestExecution> {
  const prepared = prepareKnowledgeBaseWikiMutation(context);
  if (!prepared.ok) return prepared.execution;
  return unaryHttp(
    domainResultToHttp(await context.rpcPorts.kb.unlinkWiki({ ...prepared.args, slug: prepared.slug }, prepared.ctx)),
  );
}

async function executeKnowledgeBaseWikiCiteCatalogRequest(
  context: AuthorizedCatalogRequest,
): Promise<CatalogRequestExecution> {
  const prepared = prepareKnowledgeBaseWikiMutation(context);
  if (!prepared.ok) return prepared.execution;
  return unaryHttp(
    domainResultToHttp(await context.rpcPorts.kb.citeWiki({ ...prepared.args, slug: prepared.slug }, prepared.ctx)),
  );
}

async function executeKnowledgeBaseWikiAdoptCatalogRequest(
  context: AuthorizedCatalogRequest,
): Promise<CatalogRequestExecution> {
  const prepared = prepareKnowledgeBaseWikiMutation(context);
  if (!prepared.ok) return prepared.execution;
  return unaryDomain(await context.rpcPorts.kb.adoptWiki({ ...prepared.args, slug: prepared.slug }, prepared.ctx), 201);
}

async function executeKnowledgeBaseWikiDeleteCatalogRequest({
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  const parsed = request as Record<string, unknown> & { slug: string };
  const slug = decodePathSegment(parsed.slug);
  if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
  return unaryHttp(
    domainResultToHttp(
      await rpcPorts.kb.deleteWiki(
        slug,
        maybeBuildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal),
      ),
    ),
  );
}

async function executeKnowledgeBaseWikiReadRoutesCatalogRequest(
  context: AuthorizedCatalogRequest,
): Promise<CatalogRequestExecution> {
  switch (context.spec.name) {
    case 'kb.wiki.list':
      return unaryHttp(domainResultToHttp(await context.rpcPorts.kb.listWikis(context.principal)));
    case 'kb.wiki.read':
      return executeKnowledgeBaseWikiReadCatalogRequest(context);
    default:
      throw new Error(`Unhandled transport RPC route: ${context.spec.name}`);
  }
}

function executeKnowledgeBaseWikiMutationCatalogRequest(
  context: AuthorizedCatalogRequest,
): Promise<CatalogRequestExecution> {
  switch (context.spec.name) {
    case 'kb.wiki.create':
      return executeKnowledgeBaseWikiCreateCatalogRequest(context);
    case 'kb.wiki.rewrite':
      return executeKnowledgeBaseWikiRewriteCatalogRequest(context);
    case 'kb.wiki.link':
      return executeKnowledgeBaseWikiLinkCatalogRequest(context);
    case 'kb.wiki.unlink':
      return executeKnowledgeBaseWikiUnlinkCatalogRequest(context);
    case 'kb.wiki.cite':
      return executeKnowledgeBaseWikiCiteCatalogRequest(context);
    case 'kb.wiki.adopt':
      return executeKnowledgeBaseWikiAdoptCatalogRequest(context);
    case 'kb.wiki.delete':
      return executeKnowledgeBaseWikiDeleteCatalogRequest(context);
    default:
      throw new Error(`Unhandled transport RPC route: ${context.spec.name}`);
  }
}

function executeKnowledgeBaseWikiCatalogRequest(context: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  return context.spec.name === 'kb.wiki.list' || context.spec.name === 'kb.wiki.read'
    ? executeKnowledgeBaseWikiReadRoutesCatalogRequest(context)
    : executeKnowledgeBaseWikiMutationCatalogRequest(context);
}

async function executeKnowledgeBaseCommunityCatalogRequest({
  spec,
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'kb.wake_up': {
      const parsed = request as Record<string, unknown>;
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.wakeUp(parsed, principal)));
    }

    case 'kb.community.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.readCommunity(slug, principal)));
    }

    case 'kb.community.list-stale':
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.listStaleCommunities(principal)));

    case 'kb.community.summary-input': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.readCommunitySummaryInput(slug, principal)));
    }

    case 'kb.community.set-summary': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.setCommunitySummary(
            { ...stripTransportContextKeys(parsed), slug },
            maybeBuildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal),
          ),
        ),
      );
    }

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}

async function executeKnowledgeBaseMemoCatalogRequest({
  spec,
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'kb.memo.list': {
      const parsed = request as { projectRoot: string; owner?: string };
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.listMemos(
            parsed.owner === undefined ? {} : { owner: parsed.owner },
            buildQueryContext(canonicalRequest.projectRoot, rpcPorts, principal),
          ),
        ),
      );
    }

    case 'kb.memo.read': {
      const parsed = request as { slug: string; projectRoot: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.readMemo(slug, buildQueryContext(canonicalRequest.projectRoot, rpcPorts, principal)),
        ),
      );
    }

    case 'kb.memo.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const args = stripTransportContextKeys(parsed);
      const memoArgs = ctx.coralEnv.CORAL_OWNER === undefined ? args : { ...args, owner: ctx.coralEnv.CORAL_OWNER };
      return unaryDomain(await rpcPorts.kb.createMemo(memoArgs, ctx), 201);
    }

    case 'kb.memo.delete': {
      const parsed = request as Record<string, unknown> & {
        projectRoot: string;
        pattern?: string;
        owner?: string;
        all?: boolean;
      };
      const ctx =
        buildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal) ??
        buildQueryContext(canonicalRequest.projectRoot, rpcPorts, principal);
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.deleteMemos(
            {
              ...(parsed.pattern === undefined ? {} : { pattern: parsed.pattern }),
              ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
              ...(parsed.all === undefined ? {} : { all: parsed.all }),
            },
            ctx,
          ),
        ),
      );
    }

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}

async function executeKnowledgeBasePrinciplesCatalogRequest({
  spec,
  request,
  canonicalRequest,
  rpcPorts,
  principal,
}: AuthorizedCatalogRequest): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'kb.principles.list': {
      const parsed = request as { q?: string; top_k?: number; verbose?: boolean };
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.listPrinciples(
            {
              ...(parsed.q === undefined ? {} : { query: parsed.q }),
              ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
              ...(parsed.verbose === undefined ? {} : { verbose: parsed.verbose }),
            },
            principal,
          ),
        ),
      );
    }

    case 'kb.principle.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.readPrinciple(slug, principal)));
    }

    case 'kb.reindex': {
      const parsed = request as Record<string, unknown>;
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.reindex(
            { async: parsed.async === true },
            maybeBuildBodyInvocationContext(parsed, canonicalRequest.projectRoot, rpcPorts, principal),
          ),
        ),
      );
    }

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}
