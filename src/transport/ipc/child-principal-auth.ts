import { randomBytes } from 'node:crypto';

import {
  CORAL_CHILD_PRINCIPAL_HANDLE,
  isCoralChildEnvironment,
  type CoralChildEnvironment,
} from '../../security/child-principal-env.js';
import type { IpcAuthMetadata } from './json-rpc.js';

export type ChildPrincipalEnv = CoralChildEnvironment;

export type ChildPrincipalNonceFactory = () => string;
export type ChildPrincipalAuthProvider = (() => IpcAuthMetadata) | null | undefined;
export type ChildPrincipalAuthOptions = { readonly auth: Exclude<ChildPrincipalAuthProvider, null | undefined> };

export class ChildPrincipalBindingError extends Error {
  readonly code = 'child_credentials_incomplete';
  readonly exitCode = 77;
  readonly remediation =
    'Return to the top-level Coral session and run the command there. Retry the parent workflow instead of editing CORAL_* environment variables.';

  constructor() {
    super('This nested Coral command has incomplete child credentials and was not sent.');
    this.name = 'ChildPrincipalBindingError';
  }
}

function defaultNonce(): string {
  return randomBytes(16).toString('hex');
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function childPrincipalAuthFromEnv(
  env: ChildPrincipalEnv = process.env,
  nonce: ChildPrincipalNonceFactory = defaultNonce,
): ChildPrincipalAuthProvider {
  const handle = nonEmpty(env[CORAL_CHILD_PRINCIPAL_HANDLE]);
  const jobId = nonEmpty(env.CORAL_JOB_ID);
  const sessionId = nonEmpty(env.CORAL_SESSION_ID);

  if (handle && jobId && sessionId) {
    return () => ({
      kind: 'child',
      handle,
      token: nonce(),
      jobId,
      sessionId,
    });
  }

  return isCoralChildEnvironment(env) ? null : undefined;
}

/**
 * Convert a captured child-principal provider into IPC request options while
 * keeping incomplete nested credentials out of coordinator discovery/lifecycle
 * work and giving the CLI an actionable public error.
 */
export function childPrincipalAuthOptions(auth: ChildPrincipalAuthProvider): ChildPrincipalAuthOptions | undefined {
  if (auth === null) throw new ChildPrincipalBindingError();
  return auth === undefined ? undefined : { auth };
}
