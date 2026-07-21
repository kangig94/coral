import type { DiscussSessionsListResponse } from '../discuss/read-contract.js';
import type { JobLaunchRequest } from '../jobs/launch.js';
import type { JobsListResponse } from '../jobs/records.js';
import type { WaitStreamEvent, WaitStreamRequest } from '../jobs/wait.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { isCapability, type Capability } from '../security/capability.js';
import type { Principal, ResourceBinding } from '../security/principal.js';
import { authorize, type Decision } from '../security/policy/authorize.js';
import { writeAuthorizationDecisionAudit } from '../infra/audit-log.js';
import { domainError, type ToolDomainResult } from './tool-result.js';
import { domainResultToHttp, launchToHttp } from './response.js';
import type { HttpHandlerPorts } from './server-ports.js';
import type { RequestBindingRule, RpcMethodSpec } from './rpc/catalog.js';
import type { JobListFilters, WorkflowPortInput } from './rpc/ports.js';
import { buildInvocationContext, buildInvocationContextFromQuery } from './invocation-context.js';
import { callerProviderScopeSchema } from '../infra/provider-scope.js';

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
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
): InvocationContext | null {
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
    rpcPorts.identity.pluginRoot,
    rpcPorts.coralEnvSnapshot,
    principal,
    providerScope,
  );
}

function buildQueryContext(
  request: { projectRoot: string },
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
): InvocationContext {
  return buildInvocationContextFromQuery(
    request.projectRoot,
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
  rpcPorts: HttpHandlerPorts,
  principal: Principal,
): InvocationContext | undefined {
  if (typeof request.projectRoot !== 'string' || request.projectRoot.length === 0) {
    return undefined;
  }
  return buildBodyInvocationContext(request, rpcPorts, principal) ?? undefined;
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
  cwd?: string;
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

function commonSessionInputFields(parsed: Record<string, unknown>): CommonSessionInput {
  const result: CommonSessionInput = {};
  if (typeof parsed.model === 'string') result.model = parsed.model;
  if (typeof parsed.workDir === 'string') result.cwd = parsed.workDir;
  if (typeof parsed.effort === 'string') result.effort = parsed.effort;
  if (typeof parsed.bypassPermissions === 'boolean') result.bypassPermissions = parsed.bypassPermissions;
  if (typeof parsed.systemPrompt === 'string') result.systemPrompt = parsed.systemPrompt;
  return result;
}

function createSessionInputFields(parsed: Record<string, unknown>): CreateSessionInputFields {
  const result: CreateSessionInputFields = commonSessionInputFields(parsed);
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

export function resolveRequestBinding(rule: RequestBindingRule | undefined, request: unknown): ResourceBinding {
  const bindingRule = rule ?? ({ kind: 'projectRoot', projectRoot: 'required' } satisfies RequestBindingRule);

  switch (bindingRule.kind) {
    case 'projectRoot': {
      if (request !== null && typeof request === 'object') {
        const projectRoot = (request as { projectRoot?: unknown }).projectRoot;
        if (typeof projectRoot === 'string' && projectRoot.length > 0) {
          return { kind: 'project', root: projectRoot };
        }
      }
      return { kind: 'unbound' };
    }
  }
}

function requestedBindingFor(spec: RpcMethodSpec<unknown, unknown>, request: unknown): ResourceBinding {
  return resolveRequestBinding(spec.requestBinding, request);
}

function requiredCapability(spec: RpcMethodSpec<unknown, unknown>): Capability | null {
  const requires = (spec as { readonly requires?: unknown }).requires;
  return isCapability(requires) ? requires : null;
}

function authorizationFailure(decision: Extract<Decision, { ok: false }>): CatalogRequestExecution {
  const statusCode = decision.reason === 'resource_unbound' ? 403 : 401;
  const code = decision.reason === 'resource_unbound' ? 'scope_mismatch' : decision.reason;
  const message =
    decision.reason === 'unauthenticated'
      ? 'Authentication required'
      : decision.reason === 'missing_capability'
        ? 'Missing required capability'
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

  const requestedBinding = requestedBindingFor(spec, request);
  const authz = authorize(principal, requires, requestedBinding);
  writeAuthorizationDecisionAudit(principal, spec.name, authz, requestedBinding);
  if (!authz.ok) {
    return authorizationFailure(authz);
  }

  switch (spec.name) {
    case 'sessions.create': {
      const parsed = request as Record<string, unknown> & { provider: string; prompt: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unaryHttp(recovering);
      const unconfigured = ensureProviderScopeConfigured(rpcPorts, principal);
      if (unconfigured) return unaryHttp(unconfigured);
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const decision = await rpcPorts.sessions.start(
        parsed.provider,
        {
          prompt: parsed.prompt,
          ...(typeof parsed.agent === 'string' ? { agent: parsed.agent } : {}),
          ...createSessionInputFields(parsed),
        },
        ctx,
      );
      return unaryHttp(launchToHttp(decision, 201));
    }

    case 'workflow.run': {
      const parsed = request as Record<string, unknown>;
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unaryHttp(recovering);
      const unconfigured = ensureProviderScopeConfigured(rpcPorts, principal);
      if (unconfigured) return unaryHttp(unconfigured);
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
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
        ...workflowCommand
      } = parsed;
      const result = await rpcPorts.workflows.execute(workflowCommand as WorkflowPortInput, ctx);
      if (result.kind === 'invalid_request') {
        return unaryHttp(domainResultToHttp(invalidRequestResult(result.message, result.detail)));
      }

      return unaryHttp(launchToHttp(result.decision, 202));
    }

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

    case 'jobs.abort': {
      const parsed = request as { jobs: string[]; projectRoot: string };
      const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobs, parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return unaryHttp(
          domainResultToHttp(
            domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
          ),
        );
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

    case 'jobs.list': {
      const parsed = request as JobListFilters & { provider?: string };
      const jobs = rpcPorts.jobs.list({
        ...(parsed.projectRoot === undefined ? {} : { projectRoot: parsed.projectRoot }),
        ...(parsed.phase === undefined ? {} : { phase: parsed.phase }),
        ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
        all: parsed.all === true,
      });
      jobs.sort((left, right) => right.status.updatedAt.localeCompare(left.status.updatedAt));
      return unary({ jobs } satisfies JobsListResponse);
    }

    case 'jobs.detail': {
      const parsed = request as { jobId: string; projectRoot: string };
      const scopeCheck = rpcPorts.jobs.scopeCheck([parsed.jobId], parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return unaryHttp(
          domainResultToHttp(
            domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
          ),
        );
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

    case 'jobs.wait': {
      const parsed = request as {
        jobIds: string[];
        projectRoot: string;
        timeoutSeconds?: number;
        cursor?: { afterSeq: number };
      };
      const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobIds, parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return unaryHttp(
          domainResultToHttp(
            domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
          ),
        );
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

      const waitRequest: WaitStreamRequest = { ...parsed };
      return {
        kind: 'subscription',
        notifications: rpcPorts.jobs.waitStream(
          withAbortSignal(waitRequest, abortSignal),
        ) as AsyncIterable<WaitStreamEvent>,
      };
    }

    case 'discuss.persona.generate':
      return unaryHttp(domainResultToHttp(rpcPorts.discuss.seed(request)));

    case 'discuss.session.create': {
      const parsed = request as Record<string, unknown>;
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unaryHttp(recovering);
      const unconfigured = ensureProviderScopeConfigured(rpcPorts, principal);
      if (unconfigured) return unaryHttp(unconfigured);
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      return unaryDomain(await rpcPorts.discuss.start(stripTransportContextKeys(parsed), ctx), 201);
    }

    case 'discuss.session.list':
      return unary({ sessions: rpcPorts.discuss.listSessions() } satisfies DiscussSessionsListResponse);

    case 'discuss.session.detail': {
      const parsed = request as { projectRoot: string; sessionId: string; view?: 'control' | 'audit' };
      const context = buildQueryContext(parsed, rpcPorts, principal);
      const detail = rpcPorts.discuss.loadDetail(context.projectRoot, parsed.sessionId, parsed.view ?? 'control');
      if (!detail) {
        return unary({ code: 'session_not_found', message: 'Session not found' }, 404);
      }
      if (detail === 'audit_requires_ended_session') {
        return unary({ code: 'audit_requires_ended_session', message: 'Audit requires ended session' }, 409);
      }
      return unary(detail);
    }

    case 'discuss.session.events': {
      const parsed = request as { sessionId: string; projectRoot: string; cursor?: number };
      const context = buildQueryContext(parsed, rpcPorts, principal);
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

    case 'discuss.session.bid': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unaryHttp(recovering);
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { sessionId } = parsed;
      const args = stripTransportContextKeys(parsed);
      return unaryHttp(domainResultToHttp(await rpcPorts.discuss.bid({ ...args, session: sessionId }, ctx)));
    }

    case 'discuss.session.speech': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unaryHttp(recovering);
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { sessionId } = parsed;
      const args = stripTransportContextKeys(parsed);
      return unaryHttp(domainResultToHttp(await rpcPorts.discuss.speech({ ...args, session: sessionId }, ctx)));
    }

    case 'discuss.session.delete': {
      const parsed = request as { sessionId: string; projectRoot: string };
      const context = buildQueryContext(parsed, rpcPorts, principal);
      return unaryHttp(domainResultToHttp(await rpcPorts.discuss.abort({ session: parsed.sessionId }, context)));
    }

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

    case 'kb.note.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.readNote(slug, principal)));
    }

    case 'kb.note.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      return unaryDomain(await rpcPorts.kb.createNote(stripTransportContextKeys(parsed), ctx), 201);
    }

    case 'kb.note.update': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
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
          await rpcPorts.kb.deleteNote(slug, maybeBuildBodyInvocationContext(parsed, rpcPorts, principal)),
        ),
      );
    }

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
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
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
          await rpcPorts.kb.deleteSource(slug, maybeBuildBodyInvocationContext(parsed, rpcPorts, principal)),
        ),
      );
    }

    case 'kb.wiki.list':
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.listWikis(principal)));

    case 'kb.wiki.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.readWiki(slug, principal)));
    }

    case 'kb.wiki.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      return unaryDomain(await rpcPorts.kb.createWiki(stripTransportContextKeys(parsed), ctx), 201);
    }

    case 'kb.wiki.rewrite': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { slug: _slug, ...args } = stripTransportContextKeys(parsed);
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.rewriteWiki({ ...args, slug }, ctx)));
    }

    case 'kb.wiki.link': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { slug: _slug, ...args } = stripTransportContextKeys(parsed);
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.linkWiki({ ...args, slug }, ctx)));
    }

    case 'kb.wiki.unlink': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { slug: _slug, ...args } = stripTransportContextKeys(parsed);
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.unlinkWiki({ ...args, slug }, ctx)));
    }

    case 'kb.wiki.cite': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { slug: _slug, ...args } = stripTransportContextKeys(parsed);
      return unaryHttp(domainResultToHttp(await rpcPorts.kb.citeWiki({ ...args, slug }, ctx)));
    }

    case 'kb.wiki.adopt': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
      if (!ctx) return unaryHttp(domainResultToHttp(invalidRequestResult()));

      const { slug: _slug, ...args } = stripTransportContextKeys(parsed);
      return unaryDomain(await rpcPorts.kb.adoptWiki({ ...args, slug }, ctx), 201);
    }

    case 'kb.wiki.delete': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.deleteWiki(slug, maybeBuildBodyInvocationContext(parsed, rpcPorts, principal)),
        ),
      );
    }

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
            maybeBuildBodyInvocationContext(parsed, rpcPorts, principal),
          ),
        ),
      );
    }

    case 'kb.memo.list': {
      const parsed = request as { projectRoot: string; owner?: string };
      return unaryHttp(
        domainResultToHttp(
          await rpcPorts.kb.listMemos(
            parsed.owner === undefined ? {} : { owner: parsed.owner },
            buildQueryContext(parsed, rpcPorts, principal),
          ),
        ),
      );
    }

    case 'kb.memo.read': {
      const parsed = request as { slug: string; projectRoot: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unaryHttp(domainResultToHttp(invalidRequestResult('Invalid KB slug')));
      return unaryHttp(
        domainResultToHttp(await rpcPorts.kb.readMemo(slug, buildQueryContext(parsed, rpcPorts, principal))),
      );
    }

    case 'kb.memo.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyInvocationContext(parsed, rpcPorts, principal);
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
        buildBodyInvocationContext(parsed, rpcPorts, principal) ?? buildQueryContext(parsed, rpcPorts, principal);
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
            maybeBuildBodyInvocationContext(parsed, rpcPorts, principal),
          ),
        ),
      );
    }

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}
