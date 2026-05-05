import { z } from 'zod';

export const identPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const providerIdentPattern = /^[a-z][a-z0-9-]*$/;
export const AGENT_IDENT_RE = /^(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*$/;
export const nonEmptyStringSchema = z.string().min(1);

export function readNonEmptyString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && identPattern.test(value);
}

export function assertOwnerId(value: unknown, label = 'owner'): string {
  if (!isOwnerId(value)) {
    throw new Error(
      `${label} must be a non-empty token-safe identifier (alphanumeric, '.', '_', '-'; must start with alphanumeric)`,
    );
  }
  return value;
}
