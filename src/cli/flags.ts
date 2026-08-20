import { existsSync, readFileSync } from 'node:fs';

import { UsageError } from './errors.js';

export function resolveFilePath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  if (!filePath.endsWith('.md')) {
    const withMd = `${filePath}.md`;
    if (existsSync(withMd)) return withMd;
  }
  return filePath;
}

export function resolveInput(values: string[]): string {
  // Multi-value inputs are joined with spaces, which recovers prompts that a shell split into
  // multiple argv entries (e.g. unquoted `-i hello world`) and prompts that the bash-rewrite
  // hook partially materialized into a temp file alongside adjacent literal tokens.
  return values.map((token) => (existsSync(token) ? readFileSync(token, 'utf8') : token)).join(' ');
}

export function parseIntegerFlag(flagName: string, value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new UsageError(`${flagName} must be an integer`);
  }

  return Number.parseInt(value, 10);
}

export function parseJobIds(raw: string): string[] {
  const jobIds: string[] = [];
  for (const entry of raw.split(/[,\s]+/u)) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      jobIds.push(trimmed);
    }
  }
  if (jobIds.length === 0) {
    throw new UsageError('jobs must include at least one job ID');
  }

  return jobIds;
}
