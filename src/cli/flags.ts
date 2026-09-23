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

const STDIN_INPUT = '-';
let stdinConsumed = false;

function readStdinInput(): string {
  if (stdinConsumed) {
    throw new UsageError(`Only one input per command can be read from stdin ("${STDIN_INPUT}")`);
  }
  stdinConsumed = true;
  return readFileSync(0, 'utf8');
}

/**
 * Resolve a text-or-file input. `-` reads stdin, so a caller can pass text through a quoted heredoc
 * (`<<'EOF'`), which the shell leaves unexpanded. Multi-value inputs are joined with spaces, which
 * recovers a prompt a shell split into several argv entries (e.g. unquoted `-i hello world`).
 */
export function resolveInput(values: string[]): string {
  return values
    .map((token) => {
      if (token === STDIN_INPUT) return readStdinInput();
      return existsSync(token) ? readFileSync(token, 'utf8') : token;
    })
    .join(' ');
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
