import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { inspectKiwiArtifact } from '#src/engines/kiwi/artifact.js';
import { kiwiInstaller } from '#src/engines/kiwi/install.js';
import { writeKiwiModelFilesAtomicInWorker } from '#src/engines/kiwi/model-artifact.js';
import { kiwiWasmManifestPath } from '#src/engines/kiwi/paths.js';
import { publishKiwiWasmArtifact } from '#src/engines/kiwi/wasm-artifact.js';
import { KIWI_MODEL_FILES, type KiwiModelFileName } from '#src/engines/kiwi/constants.js';
import { acquirePackageOperationLockAtPath } from '#src/infra/package-operation-lock.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { installExpansion } from '#src/cli/expansion/install.js';

const createdRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

// `baseDir` scopes the WHOLE path tree to the fixture. Patching only
// `paths.coral.engine` used to suffice because generation coordination
// reverse-derived its root from `engineRoot`; once the generation family became
// published path authority, a partial override let the install pipeline take its
// adoption lock in the developer's real ~/.coral. The env override stays — the
// install pipeline still needs a fixture HOME.
function createRuntimeForFixture(fixture: ReturnType<typeof createFixture>): Runtime {
  const realRuntime = createRealRuntime('prod', { baseDir: fixture.baseDir });
  const envRecord: Record<string, string> = {
    HOME: fixture.homeDir,
    USERPROFILE: fixture.homeDir,
  };

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
  };
}

describe('installExpansion', () => {
  it('installs a supported package through the shared outer lock without self-contention', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const files = new Map<KiwiModelFileName, Buffer>(
      KIWI_MODEL_FILES.map((fileName) => [fileName, Buffer.from(`installed:${fileName}`, 'utf-8')]),
    );
    await writeKiwiModelFilesAtomicInWorker(runtime, files);
    publishKiwiWasmArtifact(
      runtime,
      readFileSync(join(process.cwd(), 'node_modules', 'kiwi-nlp', 'dist', 'kiwi-wasm.wasm')),
    );
    rmSync(kiwiWasmManifestPath(runtime));
    expect(inspectKiwiArtifact(runtime)).toMatchObject({
      ready: false,
      model: { installed: true },
      wasm: { installed: false, payloadValid: true },
    });

    await expect(installExpansion('kiwi', { runtime })).resolves.toMatchObject({
      status: 'installed',
    });
    expect(inspectKiwiArtifact(runtime).ready).toBe(true);
  });
});

describe('Kiwi direct installer boundary', () => {
  it('keeps direct uninstall behind the shared package-operation lock', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const targetDir = runtime.paths.coral.engine.dataDir('kiwi');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'sentinel'), 'keep', 'utf-8');
    const lease = await acquirePackageOperationLockAtPath(
      runtime.paths.coral.engine.installLockPath('kiwi'),
      { storage: runtime.storage, time: runtime.time },
      50,
    );

    try {
      await expect(
        kiwiInstaller.uninstall({
          name: 'kiwi',
          version: '1.0.0',
          runtime,
          lockTimeoutMs: 50,
        }),
      ).resolves.toMatchObject({ status: 'error', code: 'expansion_install_lock_contended' });
      expect(pathExists(join(targetDir, 'sentinel'))).toBe(true);
    } finally {
      lease();
    }

    await expect(
      kiwiInstaller.uninstall({
        name: 'kiwi',
        version: '1.0.0',
        runtime,
        lockTimeoutMs: 50,
      }),
    ).resolves.toMatchObject({ status: 'uninstalled' });
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
