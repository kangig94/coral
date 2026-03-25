import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage } from '../shared/mcp-utils.js';
import { invalidateTextSnapshot } from './detect.js';
import type { KbIndex } from './types.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertString(value: unknown, label: string): string {
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

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('tags must be an array');
  }
  return value.map((tag) => assertNonEmptyText(tag, 'tag'));
}

function normalizePrinciple(value: unknown): string {
  const normalized = assertNonEmptyText(value, 'principle');
  const wikilink = normalized.match(/^\[\[(.+)\]\]$/)?.[1];
  return assertSlug(wikilink ?? normalized, 'principle');
}

export function normalizePrinciples(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('principles must be an array');
  }
  return value.map(normalizePrinciple);
}

export function writeFileAtomic(filePath: string, payload: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;

  try {
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export function cloneKbIndex(index: KbIndex | null): KbIndex {
  if (index === null) {
    return {
      notes: {},
      principles: {},
    };
  }

  return {
    notes: Object.fromEntries(
      Object.entries(index.notes).map(([note, meta]) => [note, {
        title: meta.title,
        tags: [...meta.tags],
        principles: [...meta.principles],
        source: [...meta.source],
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        ...(meta.mutationSeqAtPromote === undefined
          ? {}
          : { mutationSeqAtPromote: meta.mutationSeqAtPromote }),
      }]),
    ),
    principles: { ...index.principles },
  };
}

export async function markTextIndexStale(reason: string): Promise<void> {
  try {
    invalidateTextSnapshot(reason);
  } catch (error: unknown) {
    invalidateTextSnapshot(errorMessage(error));
  }
}
