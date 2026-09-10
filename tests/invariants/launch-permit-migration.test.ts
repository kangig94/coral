import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SOURCE_FILES = listProductionSourceFiles(resolve(REPO_ROOT, 'src'));
const SOURCE = SOURCE_FILES.map((path) => readFileSync(path, 'utf8')).join('\n');
const GIT_OPTIONS = { cwd: REPO_ROOT, encoding: 'utf8', timeout: 5_000 } as const;
const MAIN_REVISIONS = ['origin/main', 'main'] as const;

function git(...args: string[]): string {
  return execFileSync('git', args, GIT_OPTIONS).trim();
}

function mergeBase(): string {
  for (const revision of MAIN_REVISIONS) {
    try {
      return git('merge-base', 'HEAD', revision);
    } catch {
      // CI normally has origin/main while local clones commonly have main.
    }
  }
  throw new Error('Could not resolve the merge base against origin/main or main.');
}

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function jsonAt(revision: string, path: string): Record<string, unknown> {
  return JSON.parse(git('show', `${revision}:${path}`)) as Record<string, unknown>;
}

describe('launch permit migration constraints', () => {
  it('keeps one exact release signature and removes legacy ownership shortcuts', () => {
    const declarations = [
      ...SOURCE.matchAll(/\breleaseLaunch\s*\(([^)]*:[^)]*)\)\s*(?::\s*LaunchRelease)?\s*[;{]/gu),
    ].map((match) => match[1]?.replace(/\s+/gu, ' ').trim());

    expect(new Set(declarations)).toEqual(new Set(['permit: LaunchPermit']));
    expect(declarations).toHaveLength(2); // The jobs contract and its sole coordinator implementation.
    for (const legacyName of [
      'releaseByAbortAuthority',
      'jobPools',
      'permitAcquired',
      'preserveOwnership',
      'proxiedOperationIds',
    ]) {
      expect(SOURCE).not.toMatch(new RegExp(`\\b${legacyName}\\b`, 'u'));
    }
  });

  it('composes operation binding and the health producer, decoder, and formatter explicitly', () => {
    const executionServices = source('src/coordinator/composition/execution-services.ts');
    expect(executionServices).toContain('world.operationRegistry.connectBinding(world.launchCoordinator)');
    expect(executionServices).toContain('binding: world.launchCoordinator');

    expect(source('src/coordinator/composition/index.ts')).toContain('diagnostics.launchPermits = launchPermits');
    expect(source('src/coordinator/composition/index.ts')).toContain(
      'diagnostics.launchReleaseDispositions = launchReleaseDispositions',
    );
    expect(source('src/coordinator/composition/index.ts')).toContain(
      'diagnostics.launchReclamations = launchReclamations',
    );
    expect(source('src/coordinator/composition/index.ts')).toContain(
      'diagnostics.settlementRefusalRecordingFailures = [...settlementRefusalRecordingFailures.values()]',
    );
    expect(source('src/transport/http/backend/health.ts')).toContain('isLaunchPermits(value.launchPermits)');
    expect(source('src/transport/http/backend/health.ts')).toContain(
      'isSettlementRefusalRecordingFailures(value.settlementRefusalRecordingFailures)',
    );
    expect(source('src/transport/http/backend/health.ts')).toContain('isLaunchReclamations(value.launchReclamations)');
    expect(source('src/cli/format/backend.ts')).toContain("lines.push('', 'Launch permits:')");
    expect(source('src/cli/format/backend.ts')).toContain("lines.push('', 'Automatic launch reclamations:')");
    expect(source('src/cli/format/backend.ts')).toContain("lines.push('', 'Settlement refusal recording failures:')");
  });

  it('keeps versions, bridge sources, CLI registration, and transport method declarations unchanged from base', () => {
    const base = mergeBase();
    const changedPaths = git('diff', '--name-only', base, '--').split('\n').filter(Boolean);

    expect(changedPaths.filter((path) => path.startsWith('clients/bridge/'))).toEqual([]);

    const currentPackage = JSON.parse(source('package.json')) as Record<string, unknown>;
    const basePackage = jsonAt(base, 'package.json');
    const currentLock = JSON.parse(source('package-lock.json')) as Record<string, unknown>;
    const baseLock = jsonAt(base, 'package-lock.json');
    const lockRootVersion = (value: Record<string, unknown>): unknown =>
      ((value.packages as Record<string, Record<string, unknown>> | undefined)?.[''] ?? {}).version;

    expect(currentPackage.version).toBe(basePackage.version);
    expect(currentLock.version).toBe(baseLock.version);
    expect(lockRootVersion(currentLock)).toBe(lockRootVersion(baseLock));

    // The readable-record discard opt-in is the only operator surface this migration adds: an
    // ambiguous readable provider-operation row is undetermined, so no automatic reclamation may
    // free it and its exit has to be a command a person can run.
    const authorityDeclarationPaths = changedPaths.filter(
      (path) =>
        (path.startsWith('src/cli/commands/') && path !== 'src/cli/commands/backend.ts') ||
        path === 'src/cli/program.ts' ||
        path === 'src/cli/dispatch.ts' ||
        path === 'src/cli/parse.ts' ||
        path.startsWith('src/transport/rpc/') ||
        path === 'src/transport/dispatch.ts' ||
        path === 'src/transport/http/handler.ts',
    );
    expect(authorityDeclarationPaths).toEqual([]);

    const changedTransportFiles = changedPaths
      .filter((path) => path.startsWith('src/transport/'))
      .map((path) => relative(REPO_ROOT, resolve(REPO_ROOT, path)));
    expect(
      changedTransportFiles.every((path) =>
        ['src/transport/http/backend/health.ts', 'src/transport/response.ts', 'src/transport/server-ports.ts'].includes(
          path,
        ),
      ),
    ).toBe(true);
  });
});
