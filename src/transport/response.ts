import type { LaunchDecision } from '../jobs/launch.js';
import { assertNever } from '../infra/error-format.js';
import { LAUNCH_AND_DOMAIN_RETRY_LATER_ERROR_CODES } from '../runtime/errors.js';
import type { ToolDomainResult } from './tool-result.js';

export function launchToHttp(
  decision: LaunchDecision,
  acceptedStatusCode: 201 | 202,
): { statusCode: number; body: unknown } {
  if (
    (decision.status === 'refused' || decision.status === 'undetermined') &&
    LAUNCH_AND_DOMAIN_RETRY_LATER_ERROR_CODES.has(decision.code)
  ) {
    return {
      statusCode: 503,
      body: {
        code: decision.code,
        message: decision.message,
      },
    };
  }

  switch (decision.status) {
    case 'running':
    case 'queued':
      return {
        statusCode: acceptedStatusCode,
        body:
          decision.kind === 'provider-session'
            ? {
                kind: decision.kind,
                sessionId: decision.sessionId,
                jobId: decision.jobId,
                launchState: decision.status,
              }
            : {
                kind: decision.kind,
                workflowId: decision.workflowId,
                jobId: decision.jobId,
                launchState: decision.status,
              },
      };
    case 'undetermined':
      return {
        statusCode: 500,
        body: {
          code: decision.code,
          message: decision.message,
        },
      };
    case 'refused': {
      let statusCode = 400;
      switch (decision.code) {
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
        case 'provider_mismatch':
        case 'job_owner_mismatch':
        case 'job_owner_missing':
        case 'job_provider_session_missing':
        case 'job_binding_owner_mismatch':
        case 'discussion_job_launch_conflict':
        case 'workflow_owner_terminal':
        case 'workflow_slot_chain_invalid':
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
    default:
      return assertNever(decision);
  }
}

export function domainResultToHttp(result: ToolDomainResult): { statusCode: number; body: unknown } {
  if (result.ok) {
    return { statusCode: 200, body: result.data };
  }

  let statusCode = LAUNCH_AND_DOMAIN_RETRY_LATER_ERROR_CODES.has(result.code) ? 503 : 500;
  switch (result.code) {
    case 'invalid_request':
    case 'provider_scope_missing':
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
    case 'kb_unavailable':
    case 'kb_initializing':
    case 'kb_offline':
      statusCode = 503;
      break;
    case 'start_failed':
    case 'kb_error':
    case 'discuss_error':
      statusCode = 500;
      break;
    case 'kb_daemon_protocol_error':
      statusCode = 502;
      break;
    default:
      if (result.code.startsWith('provider_binding_')) statusCode = 400;
      break;
  }
  const body = {
    code: result.code,
    message: result.message,
    ...(result.remediation === undefined ? {} : { remediation: result.remediation }),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };

  return {
    statusCode,
    body,
  };
}
