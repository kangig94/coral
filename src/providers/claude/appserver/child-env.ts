import { buildChildEnv } from '../../../infra/env-sanitize.js';
import { normalizeControllerEnv } from '../request-prep.js';

export function buildClaudeChildEnv(controllerEnv?: Record<string, string>): Record<string, string> {
  return buildChildEnv(normalizeControllerEnv(controllerEnv));
}
