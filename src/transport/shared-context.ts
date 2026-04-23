import type { CallerContext } from '../transport/request-context.js';
import { CONTEXT_ENV_KEY, TRANSPORT_CONTEXT_FIELDS } from '../transport/context-profile.js';

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
  return env;
}

export function buildCallerContext(
  body: Record<string, unknown>,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): CallerContext | null {
  if (typeof body.projectRoot !== 'string' || body.projectRoot.length === 0) {
    return null;
  }
  return {
    projectRoot: body.projectRoot,
    pluginRoot,
    coralEnv: buildControllerEnv(body, coralEnvSnapshot),
  };
}

export function buildCallerContextFromQuery(
  projectRoot: string,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): CallerContext {
  return { projectRoot, pluginRoot, coralEnv: { ...coralEnvSnapshot } };
}
