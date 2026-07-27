import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installResponseSchema } from '#src/expansion/rpc-contract.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { installExpansion, removeInstallArtifacts } from '#src/cli/expansion/install.js';

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-install-'));
  createdRoots.push(root);
  const homeDir = join(root, 'home');
  const baseDir = join(homeDir, '.coral');
  mkdirSync(homeDir, { recursive: true });
  return { root, homeDir, baseDir };
}

function createRuntimeForFixture(fixture: ReturnType<typeof createFixture>): Runtime {
  const realRuntime = createRealRuntime('prod');
  const envRecord: Record<string, string> = {
    HOME: fixture.homeDir,
    USERPROFILE: fixture.homeDir,
  };
  const fixtureEngine = enginePaths('prod', { baseDir: fixture.baseDir });

  return {
    ...realRuntime,
    env: {
      ...realRuntime.env,
      get: (key) => envRecord[key],
      homedir: () => fixture.homeDir,
      cwd: () => fixture.root,
      fullSnapshot: () => envRecord,
      coralSnapshot: () => ({}),
    },
    paths: {
      ...realRuntime.paths,
      get coral() {
        return { ...realRuntime.paths.coral, engine: fixtureEngine };
      },
    },
  };
}

describe('installExpansion', () => {
  it('returns a structured unknown_expansion error for names outside the bundled manifest', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);

    const result = await installExpansion('missing-package', { runtime });

    expect(installResponseSchema.parse(result)).toMatchObject({
      status: 'error',
      code: 'unknown_expansion',
      context: { name: 'missing-package' },
    });
  });
});

describe('removeInstallArtifacts', () => {
  it('removes local expansion artifacts for uninstall cleanup', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const targetDir = runtime.paths.coral.engine.dataDir('fixture-engine');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'fixture.bin'), Buffer.from('artifact'));

    await removeInstallArtifacts(runtime, 'fixture-engine');

    expect(pathExists(targetDir)).toBe(false);
  });
});

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
