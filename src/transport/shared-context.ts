import type { CallerContext } from '../shared/request-context.js';

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
  if (typeof body.owner === 'string') {
    env.CORAL_OWNER = body.owner;
  }
  if (typeof body.effort === 'string') {
    env.CORAL_EFFORT = body.effort;
  }
  if (typeof body.claudeModelCap === 'string') {
    env.CORAL_CLAUDE_MODEL_CAP = body.claudeModelCap;
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
