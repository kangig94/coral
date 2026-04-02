import { textResult, type McpResult } from '../shared/mcp-utils.js';
import type { ToolRouteResponse } from './tool-router.js';

export function jsonTextResult(data: unknown, isError = false): McpResult {
  return textResult(JSON.stringify(data), isError);
}

export function toolError(error: string, detail?: Record<string, unknown>): ToolRouteResponse {
  return {
    statusCode: 200,
    body: jsonTextResult(
      {
        error,
        ...(detail ?? {}),
      },
      true,
    ),
  };
}

export function toolSuccess(data: unknown): ToolRouteResponse {
  return {
    statusCode: 200,
    body: jsonTextResult(data),
  };
}

export function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}
