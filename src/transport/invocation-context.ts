import type { InvocationContext } from '../runtime/invocation-context.js';
import { CONTEXT_ENV_KEY, TRANSPORT_CONTEXT_FIELDS } from './context-profile.js';

export function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function buildControllerEnv(
  body: Record<string, unknown>,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = { ...coralEnvSnapshot };
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
): InvocationContext | null {
  if (typeof body.projectRoot !== 'string' || body.projectRoot.length === 0) {
    return null;
  }
  return {
    projectRoot: body.projectRoot,
    pluginRoot,
    coralEnv: buildControllerEnv(body, coralEnvSnapshot),
  };
}

export function buildInvocationContextFromQuery(
  projectRoot: string,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): InvocationContext {
  return { projectRoot, pluginRoot, coralEnv: { ...coralEnvSnapshot } };
}
