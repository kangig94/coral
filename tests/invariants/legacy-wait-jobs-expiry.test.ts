import { readFileSync } from 'node:fs';
import semver from 'semver';
import { expect, it } from 'vitest';
import { buildProgram } from '#src/cli/program.js';
import { collectCommandCoverage, commandClassMap, commandContainerPaths } from '#src/cli/classify.js';
import { WAIT_INVOCATION_CONTRACT } from '#src/coordinator/handoff-routing/wait-invocation.js';

const shimMarkers = [
  ['src/cli/commands/session.ts', 'registerLegacyWaitJobs'],
  ['src/coordinator/handoff-routing/wait-command.ts', 'legacyWaitJobs:'],
  ['src/coordinator/handoff-routing/wait-command.ts', 'legacyWaitJobsDelegatedChild'],
  ['clients/hooks/lib/coral-invocation.mjs', 'LEGACY_WAIT_INVOCATION_RE'],
] as const;

function expiryProblems(version: string, read: (path: string) => string, contractVersion: number): string[] {
  if (semver.lt(version, '0.11.0')) return [];
  const markers = shimMarkers
    .filter(([path, symbol]) => read(path).includes(symbol))
    .map(([path, symbol]) => `Delete ${symbol} from ${path} and its legacy wait-path references.`);
  return [
    ...markers,
    ...(contractVersion >= 2
      ? []
      : [
          'Bump WAIT_INVOCATION_CONTRACT.version to >= 2 in src/coordinator/handoff-routing/wait-invocation.ts so older runners refuse delegation and request a session restart.',
        ]),
  ];
}

it('expires every legacy wait shim and the version 1 handoff contract at 0.11.0', () => {
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  const problems = expiryProblems(version, (path) => readFileSync(path, 'utf8'), WAIT_INVOCATION_CONTRACT.version);
  expect(problems, problems.join('\n')).toEqual([]);
});

it.each(['0.10.19', '0.10.100', '0.11.0-rc.1'])('allows the shim before expiry at %s', (version) => {
  expect(expiryProblems(version, () => shimMarkers.map(([, symbol]) => symbol).join('\n'), 1)).toEqual([]);
});

it.each(['0.11.0', '0.11.1', '0.12.0', '1.0.0'])('detects every surviving marker at %s', (version) => {
  for (const [path, symbol] of shimMarkers) {
    expect(expiryProblems(version, (file) => (file === path ? symbol : ''), 2)).toEqual([
      `Delete ${symbol} from ${path} and its legacy wait-path references.`,
    ]);
  }
  expect(expiryProblems(version, () => '', 2)).toEqual([]);
});

it.each([1, 2, 3])('requires a contract bump after deleting every shim (contract %s)', (contractVersion) => {
  const problems = expiryProblems('0.11.0', () => '', contractVersion);
  if (contractVersion < 2) {
    expect(problems).toEqual([
      'Bump WAIT_INVOCATION_CONTRACT.version to >= 2 in src/coordinator/handoff-routing/wait-invocation.ts so older runners refuse delegation and request a session restart.',
    ]);
  } else expect(problems).toEqual([]);
});

it('registers every classified command and command container on the built program', () => {
  const paths = new Set(collectCommandCoverage(buildProgram()).map(({ path }) => path));
  const missing = [...Object.keys(commandClassMap), ...commandContainerPaths].filter((path) => !paths.has(path));
  expect(missing, `Delete stale commandClassMap keys and commandContainerPaths entries: ${missing.join(', ')}`).toEqual(
    [],
  );
});
