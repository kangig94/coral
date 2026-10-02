import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { createTemporaryHomeOwner, type TemporaryHome } from '#tests/support/temporary-home-lifecycle.js';
import {
  buildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
} from '../../../integration/coordinator/helpers.js';

const SOURCE_MANIFEST = join(process.cwd(), 'clients', 'build', 'manifest.json');
const tempRoots: string[] = [];
const temporaryHomes = createTemporaryHomeOwner();

function sourceFlavor(): BuildFlavor {
  const parsed = JSON.parse(readFileSync(SOURCE_MANIFEST, 'utf-8')) as { flavor?: unknown };
  if (parsed.flavor !== 'prod' && parsed.flavor !== 'dev') {
    throw new Error('Built manifest must declare prod or dev flavor.');
  }
  return parsed.flavor;
}

function unregisteredChildCliEnvironment(home: TemporaryHome): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...temporaryHomes.environment(home),
    TMPDIR: home,
    CORAL_CHILD: '1',
    CORAL_CHILD_PRINCIPAL_HANDLE: 'fixture-child-handle',
    CORAL_JOB_ID: 'fixture-parent-job',
    CORAL_SESSION_ID: 'fixture-parent-session',
  };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function runUnregisteredChildCli(cliPath: string, home: TemporaryHome) {
  return spawnSync(process.execPath, [cliPath, 'jobs', 'detail', 'fixture-job'], {
    cwd: home,
    env: unregisteredChildCliEnvironment(home),
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

afterEach(async () => {
  await temporaryHomes.cleanup();
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundled child coordinator confinement', () => {
  it('does not create coordinator state when a child has no parent', () => {
    if (!buildArtifactsAvailable() || !existsSync(SOURCE_MANIFEST)) {
      throw new Error('Expected a built Coral bundle before running lifecycle E2E tests.');
    }

    const flavor = sourceFlavor();
    const home = temporaryHomes.create('coral-child-noparent-', flavor);
    const fixture = createPluginFixture(tempRoots, { flavor, bundleHash: 'child-no-parent' });
    const paths = coordinatorFilesForHome(home, flavor);

    const result = runUnregisteredChildCli(join(fixture.root, 'bridge', 'coral-cli'), home);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Nested Coral command stopped because its parent coordinator is unreachable');
    expect(existsSync(paths.infoFile)).toBe(false);
    expect(existsSync(paths.startupErrorFile)).toBe(false);
    expect(existsSync(paths.startupDiagnosticFile)).toBe(false);
    expect(existsSync(join(paths.runDir, 'coordinator.log'))).toBe(false);
  });
});
