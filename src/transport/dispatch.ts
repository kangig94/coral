import type { WaitStreamEvent, WaitStreamRequest } from '../jobs/api.js';
import type { CallerContext } from '../shared/request-context.js';
import type { ToolDomainResult } from '../shared/tool-domain-result.js';
import { buildCallerContextFromQuery } from './http/query-coerce.js';
import { domainError, domainResultToHttp, launchToHttp } from './http/tool-response.js';
import type { HttpHandlerPorts } from './http/contracts.js';
import type { RpcMethodSpec } from './rpc-catalog.js';
import type { JobListFilters, WorkflowPortInput } from './rpc-ports.js';
import { buildCallerContext, decodePathSegment } from './shared-context.js';

export type CatalogRequestExecution =
  | { kind: 'unary'; body: unknown }
  | { kind: 'subscription'; notifications: AsyncIterable<unknown> };

const BACKEND_RECOVERING_RESPONSE = {
  code: 'backend_recovering',
  message: 'recovering — retry after 500ms',
};

function invalidRequestResult(message = 'invalid request', detail?: unknown): ToolDomainResult {
  return domainError('invalid_request', message, detail);
}

function unary(body: unknown): CatalogRequestExecution {
  return { kind: 'unary', body };
}

function buildBodyCallerContext(
  request: Record<string, unknown>,
  rpcPorts: HttpHandlerPorts,
): CallerContext | null {
  return buildCallerContext(request, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot);
}

function ensureLaunchFenceInactive(rpcPorts: HttpHandlerPorts): unknown | null {
  if (!rpcPorts.admin.isLaunchFenceActive()) {
    return null;
  }
  return BACKEND_RECOVERING_RESPONSE;
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

function defaultSuccessStatus(methodName: string): number {
  switch (methodName) {
    case 'sessions.create':
    case 'sessions.fork':
    case 'discuss.session.create':
    case 'kb.memo.create':
    case 'kb.note.create':
    case 'kb.source.create':
      return 201;
    case 'sessions.message':
    case 'workflow.run':
      return 202;
    default:
      return 200;
  }
}

function defaultErrorStatus(methodName: string): number {
  switch (methodName) {
    case 'sessions.create':
    case 'sessions.message':
    case 'sessions.fork':
    case 'workflow.run':
      return 400;
    default:
      return 500;
  }
}

function errorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const code = (body as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

export function catalogHttpStatus(
  spec: RpcMethodSpec<unknown, unknown>,
  body: unknown,
): number {
  const code = errorCode(body);
  if (!code) {
    return defaultSuccessStatus(spec.name);
  }

  switch (code) {
    case 'invalid_request':
    case 'invalid_agent':
      return 400;
    case 'not_found':
    case 'session_not_found':
    case 'unknown_tool':
    case 'agent_not_found':
    case 'agent_namespace_not_found':
    case 'unknown_provider':
    case 'job_not_found':
    case 'jobs_not_found':
      return 404;
    case 'scope_mismatch':
      return 403;
    case 'backend_recovering':
    case 'busy':
    case 'preflight_failed':
    case 'kb_unavailable':
      return 503;
    case 'session_busy':
    case 'non_resumable':
    case 'legacy_session_unsupported':
    case 'provider_mismatch':
    case 'audit_requires_ended_session':
      return 409;
    case 'start_failed':
    case 'kb_error':
    case 'discuss_error':
      return 500;
    default:
      return defaultErrorStatus(spec.name);
  }
}

export async function executeCatalogRequest(
  spec: RpcMethodSpec<unknown, unknown>,
  request: unknown,
  rpcPorts: HttpHandlerPorts,
  abortSignal?: AbortSignal,
): Promise<CatalogRequestExecution> {
  switch (spec.name) {
    case 'sessions.create': {
      const parsed = request as Record<string, unknown> & { provider: string; prompt: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unary(recovering);
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const decision = await rpcPorts.sessions.start(
        parsed.provider,
        {
          prompt: parsed.prompt,
          ...(typeof parsed.agent === 'string' ? { agent: parsed.agent } : {}),
          ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
          ...(typeof parsed.workDir === 'string' ? { cwd: parsed.workDir } : {}),
          ...(typeof parsed.effort === 'string' ? { effort: parsed.effort } : {}),
          ...(typeof parsed.bypassPermissions === 'boolean' ? { bypassPermissions: parsed.bypassPermissions } : {}),
          ...(typeof parsed.systemPrompt === 'string' ? { systemPrompt: parsed.systemPrompt } : {}),
        },
        ctx,
      );
      return unary(launchToHttp(decision, 201).body);
    }

    case 'sessions.message': {
      const parsed = request as Record<string, unknown> & { sessionId: string; prompt: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unary(recovering);
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const decision = await rpcPorts.sessions.resumeBySessionId(
        {
          sessionId: parsed.sessionId,
          prompt: parsed.prompt,
          ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
          ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
          ...(typeof parsed.workDir === 'string' ? { cwd: parsed.workDir } : {}),
          ...(typeof parsed.effort === 'string' ? { effort: parsed.effort } : {}),
          ...(typeof parsed.bypassPermissions === 'boolean' ? { bypassPermissions: parsed.bypassPermissions } : {}),
          ...(typeof parsed.systemPrompt === 'string' ? { systemPrompt: parsed.systemPrompt } : {}),
        },
        ctx,
      );
      return unary(launchToHttp(decision, 202).body);
    }

    case 'sessions.fork': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unary(recovering);
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const decision = await rpcPorts.sessions.forkBySessionId(
        {
          sessionId: parsed.sessionId,
          ...(typeof parsed.prompt === 'string' ? { prompt: parsed.prompt } : {}),
          ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
          ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
          ...(typeof parsed.workDir === 'string' ? { cwd: parsed.workDir } : {}),
          ...(typeof parsed.effort === 'string' ? { effort: parsed.effort } : {}),
          ...(typeof parsed.bypassPermissions === 'boolean' ? { bypassPermissions: parsed.bypassPermissions } : {}),
          ...(typeof parsed.systemPrompt === 'string' ? { systemPrompt: parsed.systemPrompt } : {}),
        },
        ctx,
      );
      return unary(launchToHttp(decision, 201).body);
    }

    case 'workflow.run': {
      const parsed = request as Record<string, unknown>;
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unary(recovering);
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const { projectRoot: _projectRoot, claudeModelCap: _claudeModelCap, ...workflowCommand } = parsed;
      const result = await rpcPorts.workflows.execute(workflowCommand as WorkflowPortInput, ctx);
      if (result.kind === 'invalid_request') {
        return unary(domainResultToHttp(invalidRequestResult(result.message, result.detail)).body);
      }

      return unary(launchToHttp(result.decision, 202).body);
    }

    case 'jobs.abort': {
      const parsed = request as { jobs: string[]; projectRoot: string };
      const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobs, parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return unary(
          domainResultToHttp(
            domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
          ).body,
        );
      }
      if (scopeCheck.missing.length === parsed.jobs.length) {
        return unary({
          code: 'jobs_not_found',
          message: 'Requested jobs were not found',
          detail: { jobs: parsed.jobs },
        });
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
      jobs.sort((left, right) => right.status.launch.updatedAt.localeCompare(left.status.launch.updatedAt));
      return unary({ jobs });
    }

    case 'jobs.detail': {
      const parsed = request as { jobId: string };
      const detail = rpcPorts.jobs.detail(parsed.jobId);
      if (!detail) {
        return unary({ code: 'job_not_found', message: `Job not found: ${parsed.jobId}` });
      }
      return unary(detail);
    }

    case 'jobs.wait': {
      const parsed = request as {
        jobIds: string[];
        projectRoot: string;
        timeoutSeconds?: number;
        cursor?: { jobs: Record<string, number> };
      };
      const scopeCheck = rpcPorts.jobs.scopeCheck(parsed.jobIds, parsed.projectRoot);
      if (scopeCheck.mismatch.length > 0) {
        return unary(
          domainResultToHttp(
            domainError('scope_mismatch', 'Jobs do not belong to this project', { jobs: scopeCheck.mismatch }),
          ).body,
        );
      }
      if (scopeCheck.missing.length === parsed.jobIds.length) {
        return unary({
          code: 'jobs_not_found',
          message: 'Requested jobs were not found',
          detail: { jobs: scopeCheck.missing },
        });
      }

      const waitRequest: WaitStreamRequest = { ...parsed };
      return {
        kind: 'subscription',
        notifications: rpcPorts.jobs.waitStream(withAbortSignal(waitRequest, abortSignal)) as AsyncIterable<WaitStreamEvent>,
      };
    }

    case 'discuss.persona.generate':
      return unary(domainResultToHttp(rpcPorts.discuss.seed(request)).body);

    case 'discuss.session.create': {
      const parsed = request as Record<string, unknown>;
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unary(recovering);
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const {
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return unary(domainResultToHttp(await rpcPorts.discuss.start(args, ctx)).body);
    }

    case 'discuss.session.list':
      return unary({ sessions: rpcPorts.discuss.listSessions() });

    case 'discuss.session.detail': {
      const parsed = request as { projectRoot: string; sessionId: string; view?: 'control' | 'audit' };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        rpcPorts.identity.pluginRoot,
        rpcPorts.coralEnvSnapshot,
      );
      const detail = rpcPorts.discuss.loadDetail(context.projectRoot, parsed.sessionId, parsed.view ?? 'control');
      if (!detail) {
        return unary({ code: 'session_not_found', message: 'Session not found' });
      }
      if (detail === 'audit_requires_ended_session') {
        return unary({ code: 'audit_requires_ended_session', message: 'Audit requires ended session' });
      }
      return unary(detail);
    }

    case 'discuss.session.events': {
      const parsed = request as { sessionId: string; projectRoot: string; cursor?: number };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        rpcPorts.identity.pluginRoot,
        rpcPorts.coralEnvSnapshot,
      );
      return unary(
        domainResultToHttp(
          rpcPorts.discuss.watch(
            {
              session: parsed.sessionId,
              ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
            },
            context,
          ),
        ).body,
      );
    }

    case 'discuss.session.bid': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unary(recovering);
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const {
        sessionId,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return unary(domainResultToHttp(await rpcPorts.discuss.bid({ ...args, session: sessionId }, ctx)).body);
    }

    case 'discuss.session.speech': {
      const parsed = request as Record<string, unknown> & { sessionId: string };
      const recovering = ensureLaunchFenceInactive(rpcPorts);
      if (recovering) return unary(recovering);
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const {
        sessionId,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return unary(domainResultToHttp(await rpcPorts.discuss.speech({ ...args, session: sessionId }, ctx)).body);
    }

    case 'discuss.session.delete': {
      const parsed = request as { sessionId: string; projectRoot: string };
      const context = buildCallerContextFromQuery(
        parsed.projectRoot,
        rpcPorts.identity.pluginRoot,
        rpcPorts.coralEnvSnapshot,
      );
      return unary(domainResultToHttp(await rpcPorts.discuss.abort({ session: parsed.sessionId }, context)).body);
    }

    case 'kb.entries.search': {
      const parsed = request as { q: string; scope?: string; top_k?: number };
      return unary(
        domainResultToHttp(
          await rpcPorts.kb.readSearch({
            query: parsed.q,
            ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
            ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
          }),
        ).body,
      );
    }

    case 'kb.note.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);
      return unary(domainResultToHttp(rpcPorts.kb.readNote(slug)).body);
    }

    case 'kb.note.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const {
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return unary(domainResultToHttp(await rpcPorts.kb.createNote(args, ctx)).body);
    }

    case 'kb.note.update': {
      const parsed = request as Record<string, unknown> & { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);

      const {
        slug: _slug,
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return unary(domainResultToHttp(await rpcPorts.kb.updateNote({ ...args, note: slug })).body);
    }

    case 'kb.note.delete': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);
      return unary(domainResultToHttp(await rpcPorts.kb.deleteNote(slug)).body);
    }

    case 'kb.source.list':
      return unary(domainResultToHttp(await rpcPorts.kb.listSources()).body);

    case 'kb.source.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);
      return unary(domainResultToHttp(rpcPorts.kb.readSource(slug)).body);
    }

    case 'kb.source.create': {
      const parsed = request as Record<string, unknown>;
      const {
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      return unary(domainResultToHttp(await rpcPorts.kb.createSource(args)).body);
    }

    case 'kb.source.delete': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);
      return unary(domainResultToHttp(await rpcPorts.kb.deleteSource(slug)).body);
    }

    case 'kb.community.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);
      return unary(domainResultToHttp(rpcPorts.kb.readCommunity(slug)).body);
    }

    case 'kb.memo.list': {
      const parsed = request as { projectRoot: string; owner?: string };
      return unary(
        domainResultToHttp(
          rpcPorts.kb.listMemos(
            parsed.owner === undefined ? {} : { owner: parsed.owner },
            buildCallerContextFromQuery(parsed.projectRoot, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot),
          ),
        ).body,
      );
    }

    case 'kb.memo.read': {
      const parsed = request as { slug: string; projectRoot: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);
      return unary(
        domainResultToHttp(
          rpcPorts.kb.readMemo(
            slug,
            buildCallerContextFromQuery(parsed.projectRoot, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot),
          ),
        ).body,
      );
    }

    case 'kb.memo.create': {
      const parsed = request as Record<string, unknown>;
      const ctx = buildBodyCallerContext(parsed, rpcPorts);
      if (!ctx) return unary(domainResultToHttp(invalidRequestResult()).body);

      const {
        projectRoot: _projectRoot,
        owner: _owner,
        effort: _effort,
        claudeModelCap: _claudeModelCap,
        ...args
      } = parsed;
      const memoArgs = ctx.coralEnv.CORAL_OWNER === undefined ? args : { ...args, owner: ctx.coralEnv.CORAL_OWNER };
      return unary(domainResultToHttp(rpcPorts.kb.createMemo(memoArgs, ctx)).body);
    }

    case 'kb.memo.delete': {
      const parsed = request as { projectRoot: string; pattern?: string; owner?: string; all?: boolean };
      return unary(
        domainResultToHttp(
          rpcPorts.kb.deleteMemos(
            {
              ...(parsed.pattern === undefined ? {} : { pattern: parsed.pattern }),
              ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
              ...(parsed.all === undefined ? {} : { all: parsed.all }),
            },
            buildCallerContextFromQuery(parsed.projectRoot, rpcPorts.identity.pluginRoot, rpcPorts.coralEnvSnapshot),
          ),
        ).body,
      );
    }

    case 'kb.principles.list': {
      const parsed = request as { q?: string; top_k?: number; verbose?: boolean };
      return unary(
        domainResultToHttp(
          await rpcPorts.kb.listPrinciples({
            ...(parsed.q === undefined ? {} : { query: parsed.q }),
            ...(parsed.top_k === undefined ? {} : { top_k: parsed.top_k }),
            ...(parsed.verbose === undefined ? {} : { verbose: parsed.verbose }),
          }),
        ).body,
      );
    }

    case 'kb.principle.read': {
      const parsed = request as { slug: string };
      const slug = decodePathSegment(parsed.slug);
      if (slug === null) return unary(domainResultToHttp(invalidRequestResult('Invalid KB slug')).body);
      return unary(domainResultToHttp(rpcPorts.kb.readPrinciple(slug)).body);
    }

    case 'kb.reindex':
      return unary(domainResultToHttp(await rpcPorts.kb.reindex()).body);

    default:
      throw new Error(`Unhandled transport RPC route: ${spec.name}`);
  }
}
