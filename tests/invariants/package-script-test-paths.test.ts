// Every TypeScript test path named by a package script must resolve to an existing file.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

type PackageManifest = Readonly<{ scripts?: Readonly<Record<string, string>> }>;

function packageJsonFilesUnder(root: string): string[] {
  const files: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) directories.push(join(directory, entry.name));
      else if (entry.isFile() && entry.name === 'package.json') files.push(join(directory, entry.name));
    }
  }
  return files;
}

function testPathsIn(script: string): string[] {
  return [...script.matchAll(/((?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.test\.ts)/gu)].map((match) => match[1]);
}

function missingScriptTestPaths(): string[] {
  return packageJsonFilesUnder(REPO_ROOT).flatMap((manifestPath) => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackageManifest;
    return Object.entries(manifest.scripts ?? {}).flatMap(([scriptName, script]) =>
      testPathsIn(script)
        .map((testPath) => resolve(dirname(manifestPath), testPath))
        .filter((testPath) => !existsSync(testPath) || !statSync(testPath).isFile())
        .map(
          (testPath) => `${relative(REPO_ROOT, manifestPath)}#scripts.${scriptName}: ${relative(REPO_ROOT, testPath)}`,
        ),
    );
  });
}

describe('package script test paths', () => {
  it('all exist on disk', () => {
    expect(missingScriptTestPaths()).toEqual([]);
  });

  it('extracts only TypeScript test paths', () => {
    expect(testPathsIn('vitest run "tests/unit/example.test.ts" --config vitest/default.ts')).toEqual([
      'tests/unit/example.test.ts',
    ]);
  });
});
