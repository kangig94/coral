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
import { installResponseSchema, type InstallMethod } from '#src/expansion/rpc-contract.js';
import { acquirePackageOperationLockAtPath } from '#src/infra/package-operation-lock.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { installExpansion } from '#src/cli/expansion/install.js';

const createdRoots: string[] = [];
const kiwiInstallMethod = 'runtime-download' satisfies InstallMethod;

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

  it.each([
    {
      label: 'non-canonical target directory',
      result: (runtime: Runtime) => ({
        status: 'installed' as const,
        method: kiwiInstallMethod,
        targetDir: join(runtime.paths.coral.engine.dataDir('kiwi'), '..', 'other'),
      }),
      message: /non-canonical target directory/u,
    },
    {
      label: 'absolute manifest path',
      result: (runtime: Runtime) => ({
        status: 'installed' as const,
        method: kiwiInstallMethod,
        targetDir: runtime.paths.coral.engine.dataDir('kiwi'),
        postInstall: [
          { action: 'register_expansion' as const, manifestPath: join(fixtureAbsoluteRoot(), 'manifest.json') },
        ],
      }),
      message: /absolute manifest path/u,
    },
  ])('rejects installer registration with $label', async ({ result, message }) => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    vi.spyOn(kiwiInstaller, 'install').mockImplementation(async () => result(runtime));

    await expect(installExpansion('kiwi', { runtime })).rejects.toThrow(message);
  });

  it('rejects the legacy post-install registration action instead of silently ignoring it', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    vi.spyOn(kiwiInstaller, 'install').mockResolvedValue({
      status: 'installed',
      method: kiwiInstallMethod,
      targetDir: runtime.paths.coral.engine.dataDir('kiwi'),
      postInstall: ['register_expansion'],
    });

    await expect(installExpansion('kiwi', { runtime })).rejects.toThrow();
  });
});

describe('Kiwi direct installer boundary', () => {
  it('reports legacy model-only durable state separately from composite readiness', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const files = new Map<KiwiModelFileName, Buffer>(
      KIWI_MODEL_FILES.map((fileName) => [fileName, Buffer.from(`installed:${fileName}`, 'utf-8')]),
    );
    await writeKiwiModelFilesAtomicInWorker(runtime, files);

    expect(kiwiInstaller.inspect(runtime, 'kiwi')).toMatchObject({
      installed: false,
      version: null,
      method: null,
      durableState: true,
    });

    publishKiwiWasmArtifact(
      runtime,
      readFileSync(join(process.cwd(), 'node_modules', 'kiwi-nlp', 'dist', 'kiwi-wasm.wasm')),
    );
    expect(kiwiInstaller.inspect(runtime, 'kiwi')).toMatchObject({
      installed: true,
      version: '0.23.0',
      method: 'runtime-download',
      durableState: true,
    });
  });

  it('rejects a foreign package identity before touching Kiwi data', async () => {
    const fixture = createFixture();
    const runtime = createRuntimeForFixture(fixture);
    const targetDir = runtime.paths.coral.engine.dataDir('kiwi');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'sentinel'), 'keep', 'utf-8');

    expect(() => kiwiInstaller.inspect(runtime, 'foreign-package')).toThrow(/identity mismatch/u);
    await expect(
      kiwiInstaller.uninstall({
        name: 'foreign-package',
        version: '1.0.0',
        runtime,
      }),
    ).rejects.toThrow(/identity mismatch/u);
    expect(pathExists(join(targetDir, 'sentinel'))).toBe(true);
  });

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

function fixtureAbsoluteRoot(): string {
  return process.platform === 'win32' ? 'C:\\outside' : '/outside';
}
