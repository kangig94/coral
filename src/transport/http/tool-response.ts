import type { ZodError, ZodIssue } from 'zod';
import type { LaunchDecision } from '../../jobs/launch.js';
import {
  deriveErrorMessage,
  domainError,
  domainSuccess,
  toolValidationError,
  type ToolDomainResult,
} from '../tool-result.js';

export function formatZodError(error: ZodError): { message: string; detail: { issues: ZodIssue[] } } {
  const first = error.issues[0];
  const path = first?.path.join('.') ?? '';
  const head = first ? (path.length > 0 ? `${path}: ${first.message}` : first.message) : 'invalid request';
  const extras = error.issues.length - 1;
  return {
    message: extras > 0 ? `${head} (+${extras} more issues)` : head,
    detail: { issues: error.issues },
  };
}

export { deriveErrorMessage, domainError, domainSuccess, toolValidationError };
export type { ToolDomainResult };

export function launchToHttp(
  decision: LaunchDecision,
  acceptedStatusCode: 201 | 202,
): { statusCode: number; body: unknown } {
  if (decision.status === 'running' || decision.status === 'queued') {
    return {
      statusCode: acceptedStatusCode,
      body: {
        session: decision.session,
        job: decision.job,
        launchState: decision.status,
      },
    };
  }

  let statusCode = 400;
  switch (decision.code) {
    case 'busy':
    case 'preflight_failed':
      statusCode = 503;
      break;
    case 'invalid_agent':
      statusCode = 400;
      break;
    case 'agent_not_found':
    case 'agent_namespace_not_found':
    case 'unknown_provider':
    case 'session_not_found':
      statusCode = 404;
      break;
    case 'scope_mismatch':
      statusCode = 403;
      break;
    case 'session_busy':
    case 'non_resumable':
    case 'legacy_session_unsupported':
    case 'provider_mismatch':
      statusCode = 409;
      break;
  }

  return {
    statusCode,
    body: {
      code: decision.code,
      message: decision.message,
    },
  };
}

export function domainResultToHttp(result: ToolDomainResult): { statusCode: number; body: unknown } {
  if (result.ok) {
    return { statusCode: 200, body: result.data };
  }

  let statusCode = 500;
  switch (result.code) {
    case 'invalid_request':
      statusCode = 400;
      break;
    case 'not_found':
    case 'session_not_found':
    case 'unknown_tool':
      statusCode = 404;
      break;
    case 'scope_mismatch':
      statusCode = 403;
      break;
    case 'backend_recovering':
    case 'kb_unavailable':
      statusCode = 503;
      break;
    case 'start_failed':
    case 'kb_error':
    case 'discuss_error':
      statusCode = 500;
      break;
  }

  return {
    statusCode,
    body: result.detail === undefined
      ? { code: result.code, message: result.message }
      : { code: result.code, message: result.message, detail: result.detail },
  };
}
