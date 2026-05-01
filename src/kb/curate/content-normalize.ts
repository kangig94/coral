import { createHash } from 'node:crypto';
import { stripMarkdownCodeFences } from '../validation.js';

export type ParsedArrayResult = {
  entries: unknown[];
  parseFailed: boolean;
};

export function parseJsonArray(raw: string): ParsedArrayResult {
  const normalized = stripMarkdownCodeFences(raw.trim());
  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    parsed = null;
  }

  if (!Array.isArray(parsed)) {
    return {
      entries: [],
      parseFailed: true,
    };
  }

  return {
    entries: parsed,
    parseFailed: false,
  };
}

export function uniqueTrimmedList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function fingerprintEntryContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function approximateTokenCount(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.length / 4);
}
