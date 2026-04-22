import { serializeCoralSetupError, type SerializedCoralSetupError } from '../runtime/errors.js';

export type TransportErrorResponse = {
  readonly message: string;
  readonly data?: SerializedCoralSetupError;
  readonly body: Record<string, unknown>;
};

export function buildTransportErrorResponse(error: unknown): TransportErrorResponse {
  const setupError = serializeCoralSetupError(error);
  if (setupError === null) {
    return {
      message: 'Internal error',
      body: {
        code: 'internal_error',
        message: 'Internal error',
      },
    };
  }

  return {
    message: setupError.userMessage,
    data: setupError,
    body: {
      code: setupError.code,
      // Keep both for JSON-RPC error compatibility here and CoralSetupError compatibility on the receiver.
      message: setupError.userMessage,
      userMessage: setupError.userMessage,
      remediation: setupError.remediation,
      ...(setupError.context === undefined ? {} : { context: setupError.context }),
    },
  };
}
