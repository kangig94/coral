import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const FORBIDDEN = ['getKbStatus', 'setKbStatus', 'getCurateHealth', 'setCurateHealth', 'currentKbRuntime'] as const;

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

describe('no-kb-status-accessors invariant', () => {
  it.each(FORBIDDEN)('production source has zero references to %s', (sym) => {
    expect(grepSource(new RegExp(`\\b${sym}\\b`))).toEqual([]);
  });

  it('production source does not export KbStatus or CurateHealth types', () => {
    for (const symbol of ['KbStatus', 'CurateHealth']) {
      expect(grepSource(new RegExp(`(export type|export interface)\\s+${symbol}\\b`))).toEqual([]);
    }
  });
});
