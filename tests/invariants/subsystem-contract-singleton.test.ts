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

function exportMatches(symbol: string): string[] {
  const root = process.cwd();
  const direct = new RegExp(`\\bexport\\s+(?:type\\s+|interface\\s+|class\\s+)?${symbol}\\b`);
  const named = new RegExp(`\\bexport\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}`);
  const matches: string[] = [];

  for (const file of sourceFiles(join(root, 'src'))) {
    const rel = relative(root, file).replaceAll('\\', '/');
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      if (direct.test(line) || named.test(line)) {
        matches.push(`${rel}:${index + 1}:${line}`);
      }
    });
  }

  return matches;
}

describe('subsystem-contract-singleton invariant', () => {
  it('Subsystem, SubsystemRegistry, SubsystemStatus types are exported only from src/coordinator/subsystems/', () => {
    const canonical: Record<string, string> = {
      Subsystem: 'src/coordinator/subsystems/contract.ts',
      SubsystemRegistry: 'src/coordinator/subsystems/registry.ts',
      SubsystemStatus: 'src/coordinator/subsystems/contract.ts',
    };
    const offenders: string[] = [];
    for (const [sym, canonicalPath] of Object.entries(canonical)) {
      const matches = exportMatches(sym);
      const canonicalMatches = matches.filter((line) => line.startsWith(`${canonicalPath}:`));
      expect(canonicalMatches.length).toBe(1);
      for (const line of matches) {
        if (line.startsWith(`${canonicalPath}:`)) continue;
        offenders.push(line);
      }
    }
    expect(offenders).toEqual([]);
  });
});
