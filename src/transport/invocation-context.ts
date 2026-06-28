import { FORWARDED_NETWORK_ENV_KEYS } from '../infra/network-env.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { Principal } from '../security/principal.js';
import { CONTEXT_ENV_KEY, TRANSPORT_CONTEXT_FIELDS } from './context-profile.js';

export function buildControllerEnv(
  body: Record<string, unknown>,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = { ...coralEnvSnapshot };
  // Caller-forwarded proxy/CA env overlays the daemon's boot snapshot so the
  // spawned provider sees the invoking shell's network settings. These keys
  // intentionally ride in the controller env (coralEnv), not a separate field:
  // that is what carries them into the claude `envHash` and the codex host spec,
  // so a changed proxy correctly re-bootstraps rather than reusing a stale one.
  // Do not split this out. Read only the recognized keys with non-empty string
  // values — the body is untrusted wire input.
  const networkEnv = body.networkEnv;
  if (networkEnv !== null && typeof networkEnv === 'object') {
    for (const key of FORWARDED_NETWORK_ENV_KEYS) {
      const value = (networkEnv as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) {
        env[key] = value;
      }
    }
  }
  for (const field of TRANSPORT_CONTEXT_FIELDS) {
    const value = body[field];
    if (typeof value === 'string') {
      env[CONTEXT_ENV_KEY[field]] = value;
    }
  }
  if (typeof body.jobId === 'string' && body.jobId.length > 0) {
    env.CORAL_JOB_ID = body.jobId;
  }
  if (typeof body.sessionId === 'string' && body.sessionId.length > 0) {
    env.CORAL_SESSION_ID = body.sessionId;
  }
  return env;
}

export function buildInvocationContext(
  body: Record<string, unknown>,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
  principal: Principal,
): InvocationContext | null {
  if (typeof body.projectRoot !== 'string' || body.projectRoot.length === 0) {
    return null;
  }
  return {
    projectRoot: body.projectRoot,
    pluginRoot,
    coralEnv: buildControllerEnv(body, coralEnvSnapshot),
    principal,
  };
}

export function buildInvocationContextFromQuery(
  projectRoot: string,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
  principal: Principal,
): InvocationContext {
  return { projectRoot, pluginRoot, coralEnv: { ...coralEnvSnapshot }, principal };
}
