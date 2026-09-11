import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SOURCE_FILES = listProductionSourceFiles(resolve(REPO_ROOT, 'src'));
const SOURCE = SOURCE_FILES.map((path) => readFileSync(path, 'utf8')).join('\n');
function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('launch permit migration constraints', () => {
  it('keeps one exact release signature and removes legacy ownership shortcuts', () => {
    const declarations = [
      ...SOURCE.matchAll(/\breleaseLaunch\s*\(([^)]*:[^)]*)\)\s*(?::\s*LaunchRelease)?\s*[;{]/gu),
    ].map((match) => match[1]?.replace(/\s+/gu, ' ').trim());

    expect(new Set(declarations)).toEqual(new Set(['permit: LaunchPermit']));
    expect(declarations).toHaveLength(2);
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
});
