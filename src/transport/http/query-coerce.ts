export { buildInvocationContextFromQuery } from '../invocation-context.js';

export function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  if (value === undefined || value === '') return undefined;
  return undefined;
}

export function queryParamsToObject(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params);
}
