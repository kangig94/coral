import { WaitSessionError } from '../jobs/wait.js';
import { RecoveryQuarantineClearError } from '../recovery/source-registry.js';
import { SuccessionWriterParkedError } from '../store/db.js';
import {
  documentedCoralSetupError,
  serializeCoralSetupError,
  type CoralSetupError,
  type SerializedCoralSetupError,
} from '../runtime/errors.js';

export type TransportErrorResponse = {
  readonly message: string;
  readonly statusCode: number;
  readonly data?: SerializedCoralSetupError | Readonly<{ code: string; message: string }>;
  readonly body: Record<string, unknown>;
};

const SETUP_ERROR_STATUS_CODES = new Map<string, number>([
  ['invalid_request', 400],
  ['job_launch_duplicate', 409],
  ['job_owner_mismatch', 409],
  ['job_owner_missing', 409],
  ['job_provider_session_missing', 409],
  ['job_binding_owner_mismatch', 409],
  ['discussion_job_launch_conflict', 409],
  ['workflow_owner_terminal', 409],
  ['workflow_slot_chain_invalid', 409],
  ['workflow_completed_duplicate', 409],
  ['workflow_lifecycle_invalid', 409],
  ['legacy_foreign_generation', 409],
  ['legacy_source_not_quiescent', 409],
  ['legacy_source_writer_observation_unknown', 409],
  ['active_store_coordination_invalid', 409],
  ['startup_bundle_unresolvable', 409],
  ['store_not_initialized', 409],
  ['kb_commit_corrupt_or_unsupported', 409],
  ['coordinator_socket_in_use', 409],
  ['coordinator_socket_bind_failed', 409],
  ['coordinator_socket_dir_insecure', 409],
  ['coordinator_socket_dir_unverified', 409],
  ['kb_commit_not_found', 409],
  ['kb_commit_already_quarantined', 409],
  ['kb_commit_quarantine_failed', 409],
  ['recovery_quarantine_boundary_not_registered', 409],
  ['recovery_quarantine_subject_not_found', 409],
  ['recovery_quarantine_revision_changed', 409],
  ['recovery_quarantine_continuation_pending', 409],
  ['recovery_quarantine_retry_in_progress', 409],
  ['kb_commit_id_invalid', 400],
  ['startup_not_ready', 503],
  ['request_deadline_exceeded', 503],
  ['kb_disabled', 503],
  ['kb_initializing', 503],
  ['kb_offline', 503],
  ['kb_unavailable', 503],
]);

function setupErrorStatusCode(code: string): number {
  return SETUP_ERROR_STATUS_CODES.get(code) ?? 500;
}

function publicRecoveryQuarantineError(error: unknown): CoralSetupError | null {
  if (!(error instanceof RecoveryQuarantineClearError)) {
    return null;
  }
  switch (error.code) {
    case 'boundary-not-registered':
      return documentedCoralSetupError('recovery_quarantine_boundary_not_registered');
    case 'subject-not-found':
      return documentedCoralSetupError('recovery_quarantine_subject_not_found');
    case 'revision-mismatch':
      return documentedCoralSetupError('recovery_quarantine_revision_changed');
    case 'continuation-not-active':
      return documentedCoralSetupError('recovery_quarantine_continuation_pending');
    case 'retry-in-progress':
      return documentedCoralSetupError('recovery_quarantine_retry_in_progress');
    default:
      return null;
  }
}

/**
 * A parked writer is a succession commit in progress, never a fault. The park can land after a mutation took effect,
 * so the caller must not be told to repeat the request blindly.
 */
const SUCCESSION_WRITER_PARKED_MESSAGE =
  'The coordinator store writer was parked by an upgrade commit while this request ran, so whether the request took effect is not known. A read can be repeated once the commit settles; before repeating a request that changes state, read whether it already took effect.';

export function buildTransportErrorResponse(error: unknown): TransportErrorResponse {
  if (error instanceof WaitSessionError) {
    const data = { code: error.code, message: error.message };
    return { message: error.message, statusCode: 409, data, body: data };
  }
  if (error instanceof SuccessionWriterParkedError) {
    const parked = { code: 'succession_writer_parked', message: SUCCESSION_WRITER_PARKED_MESSAGE } as const;
    return { message: SUCCESSION_WRITER_PARKED_MESSAGE, statusCode: 503, data: parked, body: parked };
  }
  const setupError = serializeCoralSetupError(publicRecoveryQuarantineError(error) ?? error);
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
