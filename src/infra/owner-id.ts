import { identPattern } from './identifiers.js';

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
