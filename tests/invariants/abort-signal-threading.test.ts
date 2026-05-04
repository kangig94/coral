import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function grepSource(pattern: RegExp): string[] {
  const root = process.cwd();
  const offenders: string[] = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    const rel = relative(root, file).replaceAll('\\', '/');
    readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, index) => {
        if (pattern.test(line)) {
          offenders.push(`${rel}:${index + 1}:${line}`);
        }
      });
  }
  return offenders;
}

describe('abort-signal-threading invariant', () => {
  it('production source has zero references to assertStartupStillActive', () => {
    expect(grepSource(/\bassertStartupStillActive\b/)).toEqual([]);
  });

  it('production source has zero references to StartupInterruptedError', () => {
    expect(grepSource(/\bStartupInterruptedError\b/)).toEqual([]);
  });
});
