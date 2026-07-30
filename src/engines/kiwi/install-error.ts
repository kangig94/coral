import { documentedCoralSetupError, type DocumentedCoralSetupErrorCode } from '../../runtime/errors.js';

const INSTALL_PATH_UNWRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

export type KiwiInstallError = {
  readonly status: 'error';
  readonly code: string;
  readonly userMessage: string;
  readonly remediation: string;
  readonly context?: Record<string, unknown>;
};

export function kiwiInstallError(
  code: DocumentedCoralSetupErrorCode,
  context?: Record<string, unknown>,
): KiwiInstallError {
  const error = documentedCoralSetupError(code, context);
  return {
    status: 'error',
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(error.context === undefined ? {} : { context: error.context }),
  };
}

export function isInstallPathUnwritableError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    INSTALL_PATH_UNWRITABLE_CODES.has(String((error as NodeJS.ErrnoException).code))
  );
}
