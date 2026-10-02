export const CORAL_CHILD_MARKER = 'CORAL_CHILD';

export const CORAL_CHILD_PRINCIPAL_HANDLE = 'CORAL_CHILD_PRINCIPAL_HANDLE';
export const CORAL_CHILD_CREDENTIAL_ID = 'CORAL_CHILD_CREDENTIAL_ID';
export const CORAL_CHILD_CREDENTIAL_KEY = 'CORAL_CHILD_CREDENTIAL_KEY';

export type CoralChildEnvironment = Readonly<
  Record<string, string | undefined> &
    Partial<
      Record<
        | typeof CORAL_CHILD_MARKER
        | typeof CORAL_CHILD_PRINCIPAL_HANDLE
        | typeof CORAL_CHILD_CREDENTIAL_ID
        | typeof CORAL_CHILD_CREDENTIAL_KEY
        | 'CORAL_JOB_ID'
        | 'CORAL_SESSION_ID',
        string | undefined
      >
    >
>;

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Detect a Coral-managed child boundary, including partial child-principal
 * bindings. Empty exported values keep the CLI's existing "unset" semantics.
 */
export function isCoralChildEnvironment(env: CoralChildEnvironment): boolean {
  return (
    env[CORAL_CHILD_MARKER] === '1' ||
    nonEmpty(env[CORAL_CHILD_PRINCIPAL_HANDLE]) ||
    nonEmpty(env[CORAL_CHILD_CREDENTIAL_ID]) ||
    nonEmpty(env[CORAL_CHILD_CREDENTIAL_KEY]) ||
    nonEmpty(env.CORAL_JOB_ID) ||
    nonEmpty(env.CORAL_SESSION_ID)
  );
}
