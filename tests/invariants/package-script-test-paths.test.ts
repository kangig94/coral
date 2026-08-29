// Every TypeScript test path named by a package script must resolve to an existing file.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

type PackageManifest = Readonly<{ scripts?: Readonly<Record<string, string>> }>;
type ScriptTestPathInspection = Readonly<{
  manifestCount: number;
  extractedPathCount: number;
  missingPaths: string[];
}>;

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

function inspectScriptTestPaths(): ScriptTestPathInspection {
  const manifestPaths = packageJsonFilesUnder(REPO_ROOT);
  let extractedPathCount = 0;
  const missingPaths = manifestPaths.flatMap((manifestPath) => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackageManifest;
    return Object.entries(manifest.scripts ?? {}).flatMap(([scriptName, script]) =>
      testPathsIn(script).flatMap((testPath) => {
        extractedPathCount += 1;
        const resolvedPath = resolve(dirname(manifestPath), testPath);
        return !existsSync(resolvedPath) || !statSync(resolvedPath).isFile()
          ? [`${relative(REPO_ROOT, manifestPath)}#scripts.${scriptName}: ${relative(REPO_ROOT, resolvedPath)}`]
          : [];
      }),
    );
  });

  return { manifestCount: manifestPaths.length, extractedPathCount, missingPaths };
}

describe('package script test paths', () => {
  it('all exist on disk', () => {
    const inspection = inspectScriptTestPaths();

    expect(inspection.manifestCount).toBeGreaterThan(0);
    expect(inspection.extractedPathCount).toBeGreaterThan(0);
    expect(inspection.missingPaths).toEqual([]);
  });

  it('extracts only TypeScript test paths', () => {
    expect(testPathsIn('vitest run "tests/unit/example.test.ts" --config vitest/default.ts')).toEqual([
      'tests/unit/example.test.ts',
    ]);
  });
});
