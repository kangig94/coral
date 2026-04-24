export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  if (value === undefined || value === '') return undefined;
  return undefined;
}
