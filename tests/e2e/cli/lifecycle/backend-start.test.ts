import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { assertLifecycleBundleSetFresh } from '#tests/support/bundle-build-freshness.js';
import { createTemporaryHomeOwner, type TemporaryHome } from '#tests/support/temporary-home-lifecycle.js';
import { createPluginFixture, readDiscoveryRecordForHome } from '../../../integration/coordinator/helpers.js';

const REPO_ROOT = process.cwd();
const RUNNING_VERDICT = 'Backend start: a running coordinator is serving.';

const tempRoots: string[] = [];
const temporaryHomes = createTemporaryHomeOwner();

function buildFlavor(): BuildFlavor {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, 'clients', 'build', 'manifest.json'), 'utf-8')) as {
    flavor?: unknown;
  };
  if (parsed.flavor !== 'prod' && parsed.flavor !== 'dev') throw new Error('Built manifest must declare a flavor.');
  return parsed.flavor;
}

type Fixture = Readonly<{ cli: string; home: TemporaryHome; projectRoot: string; flavor: BuildFlavor }>;

function createFixture(): Fixture {
  const flavor = buildFlavor();
  const plugin = createPluginFixture(tempRoots, { flavor });
  const projectRoot = join(plugin.root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  return {
    cli: join(plugin.root, 'bridge', 'coral-cli'),
    home: temporaryHomes.create('coral-bstart-', flavor),
    projectRoot,
    flavor,
  };
}

function runCli(fixture: Fixture, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const {
    CORAL_CHILD: _coralChild,
    CORAL_CHILD_PRINCIPAL_HANDLE: _childPrincipal,
    CORAL_JOB_ID: _coralJobId,
    CORAL_SESSION_ID: _coralSessionId,
    ...topLevelEnv
  } = process.env;
  const result = spawnSync('node', [fixture.cli, ...args], {
    cwd: fixture.projectRoot,
    env: { ...topLevelEnv, ...temporaryHomes.environment(fixture.home), TMPDIR: fixture.home },
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function lastLine(output: string): string | undefined {
  return output.trimEnd().split('\n').at(-1);
}

function coordinatorPid(fixture: Fixture): number | undefined {
  return readDiscoveryRecordForHome(fixture.home, fixture.flavor)?.pid;
}

afterEach(async () => {
  await temporaryHomes.cleanup();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backend start', () => {
  it('starts the coordinator that status points at, and a second start reaches the same one', () => {
    assertLifecycleBundleSetFresh(REPO_ROOT);
    const fixture = createFixture();

    expect(runCli(fixture, ['backend', 'status']).stdout).toContain('command=coral-cli backend start');

    const started = runCli(fixture, ['backend', 'start']);
    expect(started.status, started.stderr).toBe(0);
    expect(lastLine(started.stdout)).toBe(RUNNING_VERDICT);
    const pid = coordinatorPid(fixture);
    expect(pid).toBeDefined();

    const again = runCli(fixture, ['backend', 'start']);
    expect(again.status, again.stderr).toBe(0);
    expect(lastLine(again.stdout)).toBe(RUNNING_VERDICT);
    expect(coordinatorPid(fixture)).toBe(pid);
  });
});
