const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

export function assertNonEmptyText(value: unknown, label: string): string {
  const normalized = assertString(value, label).trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

export function assertSlug(value: unknown, label: string): string {
  const normalized = assertNonEmptyText(value, label);
  if (!SLUG_PATTERN.test(normalized)) {
    throw new Error(`${label} must be slug-safe`);
  }
  return normalized;
}
