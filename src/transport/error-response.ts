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
