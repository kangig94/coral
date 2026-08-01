import { serializeCoralSetupError, type SerializedCoralSetupError } from '../runtime/errors.js';

export type TransportErrorResponse = {
  readonly message: string;
  readonly statusCode: number;
  readonly data?: SerializedCoralSetupError;
  readonly body: Record<string, unknown>;
};

function setupErrorStatusCode(code: string): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'job_launch_duplicate':
    case 'job_owner_mismatch':
    case 'job_owner_missing':
    case 'job_provider_session_missing':
    case 'job_binding_owner_mismatch':
    case 'discussion_job_launch_conflict':
    case 'workflow_owner_terminal':
    case 'workflow_slot_chain_invalid':
    case 'workflow_completed_duplicate':
    case 'workflow_lifecycle_invalid':
    case 'legacy_foreign_generation':
    case 'legacy_adoption_required':
    case 'legacy_source_not_quiescent':
    case 'store_newer_incompatible':
    case 'store_older_incompatible':
    case 'store_corrupt_or_unsupported':
    case 'kb_commit_corrupt_or_unsupported':
    case 'coordinator_socket_in_use':
    case 'coordinator_socket_bind_failed':
    case 'kb_commit_not_found':
    case 'kb_commit_already_quarantined':
    case 'kb_commit_quarantine_failed':
    case 'legacy_adoption_source_unreadable':
    case 'legacy_adoption_state_changed':
    case 'legacy_adoption_durability_failed':
      return 409;
    case 'kb_commit_id_invalid':
      return 400;
    case 'kb_disabled':
    case 'kb_initializing':
    case 'kb_offline':
    case 'kb_unavailable':
      return 503;
    default:
      return 500;
  }
}

export function buildTransportErrorResponse(error: unknown): TransportErrorResponse {
  const setupError = serializeCoralSetupError(error);
  if (setupError === null) {
    return {
      message: 'Internal error',
      statusCode: 500,
      body: {
        code: 'internal_error',
        message: 'Internal error',
      },
    };
  }

  return {
    message: setupError.userMessage,
    statusCode: setupErrorStatusCode(setupError.code),
    data: setupError,
    body: {
      code: setupError.code,
      // Keep both wire fields: JSON-RPC clients read `message`; Coral receivers read structured setup details.
      message: setupError.userMessage,
      userMessage: setupError.userMessage,
      remediation: setupError.remediation,
      ...(setupError.context === undefined ? {} : { context: setupError.context }),
    },
  };
}
