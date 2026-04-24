export { buildInvocationContextFromQuery } from '../invocation-context.js';
export { parseBooleanQuery } from '../../infra/json.js';

export function queryParamsToObject(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params);
}
