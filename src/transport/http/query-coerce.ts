import type { CallerContext } from '../../shared/request-context.js';

export function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  if (value === undefined || value === '') return undefined;
  return undefined;
}

export function queryParamsToObject(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params);
}

export function buildCallerContextFromQuery(
  projectRoot: string,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): CallerContext {
  return { projectRoot, pluginRoot, coralEnv: { ...coralEnvSnapshot } };
}
