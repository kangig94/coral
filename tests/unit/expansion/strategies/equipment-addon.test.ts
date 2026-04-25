import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { equipmentPaths } from "#src/infra/equipment-paths.js";
import type { Onboarding } from '#src/expansion/contracts.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { EquipmentAddonStrategy, type EquipmentAddonConfig } from '#src/expansion/strategies/equipment-addon.js';
import type { ExpansionInstallContext } from '#src/expansion/strategies/strategy.js';

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-equipment-addon-'));
  createdRoots.push(root);
  const homeDir = join(root, 'home');
  const baseDir = join(homeDir, '.coral');
  mkdirSync(homeDir, { recursive: true });
  return { root, homeDir, baseDir };
}

function createContext(fixture: ReturnType<typeof createFixture>): ExpansionInstallContext {
  const realRuntime = createRealRuntime('prod');
  const envRecord: Record<string, string> = {
    HOME: fixture.homeDir,
    USERPROFILE: fixture.homeDir,
  };
  const fixtureEquipment = equipmentPaths('prod', { baseDir: fixture.baseDir });
  const runtime: Runtime = {
    ...realRuntime,
    env: {
      ...realRuntime.env,
      get: (key) => envRecord[key],
      homedir: () => fixture.homeDir,
      platform: () => process.platform,
      cwd: () => fixture.root,
      fullSnapshot: () => envRecord,
      coralSnapshot: () => ({}),
    },
    paths: {
      ...realRuntime.paths,
      get coral() {
        return { ...realRuntime.paths.coral, equipment: fixtureEquipment };
      },
    },
  };

  return { runtime };
}

function createPrebuildArchive(fileName: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, fileName, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, content.length, 124, 12);
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 'ustar', 257, 6);
  writeTarString(header, '00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarOctal(header, checksum, 148, 8);

  const paddingSize = (512 - (content.length % 512)) % 512;
  const archive = Buffer.concat([header, content, Buffer.alloc(paddingSize, 0), Buffer.alloc(1024, 0)]);
  return gzipSync(archive);
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  Buffer.from(encoded, 'utf-8').copy(header, offset, 0, length);
}

function createConfig(onboarding?: Onboarding): EquipmentAddonConfig {
  return {
    name: 'needle',
    repo: 'kangig94/coral-needle',
    needleVersion: '0.2.0',
    addonFilename: 'coral-needle.node',
    postInstall: ['register_equipment'],
    ...(onboarding === undefined ? {} : { onboarding }),
  };
}

describe('EquipmentAddonStrategy', () => {
  it('installs the addon from the GitHub prebuild and writes metadata', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    const onboarding: Onboarding = {
      envPath: join(fixture.baseDir, '.env'),
      requiredEnv: [{ provider: 'default', env: ['CORAL_EMBEDDING_PROVIDER'] }],
      providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
      modelEnvKey: 'CORAL_EMBEDDING_MODEL',
      apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
      securityNotice: 'Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json.',
      localRuntime: {
        targetDir: join(fixture.baseDir, 'data', 'kb'),
        bootstrapPackageJson: true,
        packageManager: 'npm',
        packageName: 'onnxruntime-node',
      },
      choices: [{ id: 'manual', label: 'Manual setup', provider: null, model: null, dims: null }],
    };
    const addonBytes = Buffer.from('native-addon');
    const downloadBufferMock = vi.fn().mockResolvedValue(createPrebuildArchive('coral-needle.node', addonBytes));
    const strategy = new EquipmentAddonStrategy({
      downloadBuffer: downloadBufferMock,
      installSourceBuild: vi.fn(),
    });

    const result = await strategy.install(ctx, createConfig(onboarding));

    expect(result).toEqual({
      status: 'installed',
      method: 'prebuild',
      version: '0.2.0',
      targetDir: ctx.runtime.paths.coral.equipment.dataDir('needle'),
      postInstall: ['register_equipment'],
      onboarding,
    });
    expect(downloadBufferMock).toHaveBeenCalledWith(
      ctx.runtime,
      `https://github.com/kangig94/coral-needle/releases/download/v0.2.0/coral-needle-v0.2.0-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}.tar.gz`,
    );
    expect(readFileSync(ctx.runtime.paths.coral.equipment.addonPath('needle'))).toEqual(addonBytes);
    expect(readFileSync(join(ctx.runtime.paths.coral.equipment.dataDir('needle'), '.needle-meta.json'), 'utf-8')).toBe(
      JSON.stringify({ version: '0.2.0', method: 'prebuild' }),
    );
  });

  it('returns already_installed when the current packaged addon is already present', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    const targetDir = ctx.runtime.paths.coral.equipment.dataDir('needle');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(ctx.runtime.paths.coral.equipment.addonPath('needle'), Buffer.from('addon'));
    writeFileSync(join(targetDir, '.needle-meta.json'), JSON.stringify({ version: '0.2.0', method: 'prebuild' }), 'utf-8');
    const strategy = new EquipmentAddonStrategy({
      downloadBuffer: vi.fn(),
      installSourceBuild: vi.fn(),
    });

    const result = await strategy.install(ctx, createConfig());

    expect(result).toEqual({
      status: 'already_installed',
      method: 'prebuild',
      version: '0.2.0',
      targetDir,
      postInstall: ['register_equipment'],
    });
  });

  it('removes the partial addon when the atomic write fails', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    const failingCtx: ExpansionInstallContext = {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        storage: {
          ...ctx.runtime.storage,
          renameSync: () => {
            throw new Error('simulated disk failure');
          },
        },
      },
    };
    const strategy = new EquipmentAddonStrategy({
      downloadBuffer: vi.fn().mockResolvedValue(createPrebuildArchive('coral-needle.node', Buffer.from('broken-addon'))),
      installSourceBuild: vi.fn().mockRejectedValue(new Error('source build disabled in unit test')),
    });

    await expect(strategy.install(failingCtx, createConfig())).rejects.toThrow(/Could not install needle/);
    expect(statSafe(`${ctx.runtime.paths.coral.equipment.addonPath('needle')}.part`)).toBeNull();
    expect(statSafe(ctx.runtime.paths.coral.equipment.addonPath('needle'))).toBeNull();
  });

  it('uninstalls by removing the entire equipment directory', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    const targetDir = ctx.runtime.paths.coral.equipment.dataDir('needle');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(ctx.runtime.paths.coral.equipment.addonPath('needle'), Buffer.from('addon'));
    writeFileSync(join(targetDir, '.needle-meta.json'), JSON.stringify({ version: '0.2.0', method: 'prebuild' }), 'utf-8');
    const strategy = new EquipmentAddonStrategy();

    const result = await strategy.uninstall(ctx, createConfig());

    expect(result).toEqual({ status: 'uninstalled' });
    expect(statSafe(targetDir)).toBeNull();
  });

  it('reports installation status and current version from the installed metadata', () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    const targetDir = ctx.runtime.paths.coral.equipment.dataDir('needle');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(ctx.runtime.paths.coral.equipment.addonPath('needle'), Buffer.from('addon'));
    writeFileSync(join(targetDir, '.needle-meta.json'), JSON.stringify({ version: '0.2.0', method: 'source-build' }), 'utf-8');
    const strategy = new EquipmentAddonStrategy();

    expect(strategy.isInstalled(ctx, createConfig())).toBe(true);
    expect(strategy.currentVersion(ctx, createConfig())).toBe('0.2.0');
  });
});

function statSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
