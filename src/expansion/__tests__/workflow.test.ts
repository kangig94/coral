import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setBuildFlavor } from '../../infra/paths.js';
import { kbRuntimeDir } from '../../kb/paths.js';
import type { Onboarding } from '../contracts.js';
import { installResponseSchema } from '../contracts.js';
import { equipmentAddonPath, equipmentDataDir, equipmentInstallLockPath } from '../paths.js';

const mockState = vi.hoisted(() => ({
  installExpansion: vi.fn(),
  uninstallExpansion: vi.fn(),
  activateExpansion: vi.fn(),
  deactivateExpansion: vi.fn(),
  readEquipmentStatus: vi.fn(),
}));

vi.mock('../install.js', () => ({
  installExpansion: mockState.installExpansion,
  uninstallExpansion: mockState.uninstallExpansion,
}));

vi.mock('../activate.js', () => ({
  activateExpansion: mockState.activateExpansion,
  deactivateExpansion: mockState.deactivateExpansion,
  readEquipmentStatus: mockState.readEquipmentStatus,
}));

import { equip, info, list, unequip, update } from '../workflow.js';

const createdRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mockState.installExpansion.mockReset();
  mockState.uninstallExpansion.mockReset();
  mockState.activateExpansion.mockReset();
  mockState.deactivateExpansion.mockReset();
  mockState.readEquipmentStatus.mockReset();
  mockState.readEquipmentStatus.mockResolvedValue({ status: 'available', equipment: [] });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-workflow-'));
  createdRoots.push(root);
  const homeDir = join(root, 'home');
  const baseDir = join(homeDir, '.coral');
  mkdirSync(homeDir, { recursive: true });
  return { root, homeDir, baseDir };
}

function useFixtureEnv(fixture: ReturnType<typeof createFixture>): void {
  vi.stubEnv('HOME', fixture.homeDir);
  vi.stubEnv('USERPROFILE', fixture.homeDir);
  vi.stubEnv('CORAL_EMBEDDING_PROVIDER', '');
  vi.stubEnv('CORAL_EMBEDDING_MODEL', '');
  vi.stubEnv('CORAL_EMBEDDING_API_KEY', '');
}

function installNeedle(fixture: ReturnType<typeof createFixture>, version = '0.2.0'): void {
  const targetDir = equipmentDataDir('needle', { baseDir: fixture.baseDir });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(equipmentAddonPath('needle', { baseDir: fixture.baseDir }), Buffer.from('addon'));
  writeFileSync(
    join(targetDir, '.needle-meta.json'),
    JSON.stringify({ version, method: 'prebuild' }),
    'utf-8',
  );
}

function installCgc(fixture: ReturnType<typeof createFixture>, version = 'v1.2.3'): void {
  const toolsDir = join(fixture.homeDir, '.claude', 'tools');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, process.platform === 'win32' ? 'cgc.exe' : 'cgc'), Buffer.from('binary'));
  writeFileSync(join(toolsDir, '.cgc.json'), JSON.stringify({ version, method: 'binary' }), 'utf-8');
}

function installCgcSystemMarker(fixture: ReturnType<typeof createFixture>, command = '/usr/local/bin/cgc'): void {
  const targetDir = equipmentDataDir('cgc', { baseDir: fixture.baseDir });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    join(targetDir, '.external-install.json'),
    JSON.stringify({ method: 'system', command, detectedAt: '2026-04-22T00:00:00.000Z' }),
    'utf-8',
  );
}

function createNeedleOnboarding(fixture: ReturnType<typeof createFixture>): Onboarding {
  return {
    envPath: join(fixture.homeDir, '.coral', '.env'),
    requiredEnv: [
      {
        provider: 'local-onnx',
        env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_MODEL'],
      },
      {
        provider: 'default',
        env: ['CORAL_EMBEDDING_PROVIDER', 'CORAL_EMBEDDING_API_KEY'],
      },
    ],
    providerEnvKey: 'CORAL_EMBEDDING_PROVIDER',
    modelEnvKey: 'CORAL_EMBEDDING_MODEL',
    apiKeyEnvKey: 'CORAL_EMBEDDING_API_KEY',
    securityNotice: 'Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json.',
    localRuntime: {
      targetDir: join(fixture.homeDir, '.coral', 'data', 'kb'),
      bootstrapPackageJson: true,
      packageManager: 'npm',
      packageName: 'onnxruntime-node',
    },
    choices: [
      {
        id: 'local-nomic-embed-text',
        label: 'Local model: nomic-embed-text',
        provider: 'local-onnx',
        model: 'nomic-embed-text',
        dims: 768,
      },
      {
        id: 'local-bge-m3',
        label: 'Local model: bge-m3',
        provider: 'local-onnx',
        model: 'bge-m3',
        dims: 1024,
      },
      {
        id: 'manual',
        label: 'Manual setup',
        provider: null,
        model: null,
        dims: null,
      },
    ],
  };
}

describe('expansion workflow (AC7)', () => {
  it('list() merges coordinator equipment state with install-only local state', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    installNeedle(fixture);
    installCgc(fixture);
    mockState.readEquipmentStatus.mockResolvedValue({
      status: 'available',
      equipment: [{ slot: 'kb.vector', name: 'needle', status: 'catching_up' }],
    });

    const result = installResponseSchema.parse(await list());

    expect(result.status).toBe('catalog');
    if (result.status !== 'catalog') {
      throw new Error(`Expected catalog result, received ${result.status}`);
    }
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'needle',
          activation: 'equipment',
          status: 'catching_up',
          version: '0.2.0',
          addonPath: equipmentAddonPath('needle', { baseDir: fixture.baseDir }),
        }),
        expect.objectContaining({
          id: 'cgc',
          activation: 'none',
          status: 'installed',
          version: 'v1.2.3',
        }),
      ]),
    );
    expect(mockState.readEquipmentStatus).toHaveBeenCalledTimes(1);
  });

  it('list() marks an installed needle as inactive when passive coordinator status is unavailable', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    installNeedle(fixture);
    installCgc(fixture);
    mockState.readEquipmentStatus.mockResolvedValue({ status: 'unavailable' });

    const result = installResponseSchema.parse(await list());

    expect(result.status).toBe('catalog');
    if (result.status !== 'catalog') {
      throw new Error(`Expected catalog result, received ${result.status}`);
    }
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'needle',
          activation: 'equipment',
          status: 'inactive',
        }),
        expect.objectContaining({
          id: 'cgc',
          activation: 'none',
          status: 'installed',
        }),
      ]),
    );
  });

  it('list() keeps a never-installed needle as not_equipped when passive coordinator status is unavailable', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    installCgc(fixture);
    mockState.readEquipmentStatus.mockResolvedValue({ status: 'unavailable' });

    const result = installResponseSchema.parse(await list());

    expect(result.status).toBe('catalog');
    if (result.status !== 'catalog') {
      throw new Error(`Expected catalog result, received ${result.status}`);
    }
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'needle',
          activation: 'equipment',
          status: 'not_equipped',
        }),
        expect.objectContaining({
          id: 'cgc',
          activation: 'none',
          status: 'installed',
        }),
      ]),
    );
  });

  it('info(name) preserves equipment coordinator state and enriches local metadata', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    installNeedle(fixture);
    mockState.readEquipmentStatus.mockResolvedValue({
      status: 'available',
      equipment: [{ slot: 'kb.vector', name: 'needle', status: 'inactive' }],
    });

    const result = installResponseSchema.parse(await info('needle'));

    expect(result).toEqual({
      status: 'info',
      package: expect.objectContaining({
        id: 'needle',
        activation: 'equipment',
        status: 'inactive',
        version: '0.2.0',
        addonPath: equipmentAddonPath('needle', { baseDir: fixture.baseDir }),
      }),
    });
    expect(mockState.readEquipmentStatus).toHaveBeenCalledWith('needle');
  });

  it('info(name) prefers coordinator-equipped state over local fallback status', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    installNeedle(fixture);
    mockState.readEquipmentStatus.mockResolvedValue({
      status: 'available',
      equipment: [{ slot: 'kb.vector', name: 'needle', status: 'equipped' }],
    });

    const result = installResponseSchema.parse(await info('needle'));

    expect(result).toEqual({
      status: 'info',
      package: expect.objectContaining({
        id: 'needle',
        activation: 'equipment',
        status: 'equipped',
        version: '0.2.0',
        addonPath: equipmentAddonPath('needle', { baseDir: fixture.baseDir }),
      }),
    });
    expect(mockState.readEquipmentStatus).toHaveBeenCalledWith('needle');
  });

  it('info(name) reports install-only lock state without touching coordinator status RPCs', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    mkdirSync(equipmentInstallLockPath('cgc', { baseDir: fixture.baseDir }), { recursive: true });

    const result = installResponseSchema.parse(await info('cgc'));

    expect(result).toEqual({
      status: 'info',
      package: expect.objectContaining({
        id: 'cgc',
        activation: 'none',
        status: 'installing',
      }),
    });
    expect(mockState.readEquipmentStatus).not.toHaveBeenCalled();
  });

  it('list() and info(name) report marker-backed system installs for install-only expansions', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    installCgcSystemMarker(fixture);

    const catalog = installResponseSchema.parse(await list());
    const pkgInfo = installResponseSchema.parse(await info('cgc'));

    expect(catalog).toEqual({
      status: 'catalog',
      packages: expect.arrayContaining([
        expect.objectContaining({
          id: 'cgc',
          activation: 'none',
          status: 'installed',
          method: 'system',
          command: '/usr/local/bin/cgc',
        }),
      ]),
    });
    expect(pkgInfo).toEqual({
      status: 'info',
      package: expect.objectContaining({
        id: 'cgc',
        activation: 'none',
        status: 'installed',
        method: 'system',
        command: '/usr/local/bin/cgc',
      }),
    });
  });

  it('equip(name) pauses on unsatisfied onboarding, then activates equipment on resume', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    const onboarding = createNeedleOnboarding(fixture);
    mockState.installExpansion
      .mockResolvedValueOnce({
        status: 'installed',
        method: 'prebuild',
        version: '0.2.0',
        targetDir: equipmentDataDir('needle', { baseDir: fixture.baseDir }),
        postInstall: ['register_equipment'],
        onboarding,
      })
      .mockResolvedValueOnce({
        status: 'already_installed',
        method: 'prebuild',
        version: '0.2.0',
        targetDir: equipmentDataDir('needle', { baseDir: fixture.baseDir }),
        postInstall: ['register_equipment'],
        onboarding,
      });
    mockState.activateExpansion.mockResolvedValue({
      status: 'equipped',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'equipped',
      },
    });

    const first = installResponseSchema.parse(await equip('needle'));

    expect(first).toMatchObject({
      status: 'installed',
      onboarding,
    });
    expect(mockState.activateExpansion).not.toHaveBeenCalled();

    mkdirSync(join(fixture.homeDir, '.coral'), { recursive: true });
    writeFileSync(
      onboarding.envPath,
      'CORAL_EMBEDDING_PROVIDER=local-onnx\nCORAL_EMBEDDING_MODEL=nomic-embed-text\n',
      'utf-8',
    );

    const second = installResponseSchema.parse(await equip('needle'));

    expect(second).toEqual({
      status: 'equipped',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'equipped',
      },
    });
    expect(mockState.installExpansion).toHaveBeenNthCalledWith(1, 'needle');
    expect(mockState.installExpansion).toHaveBeenNthCalledWith(2, 'needle');
    expect(mockState.activateExpansion).toHaveBeenCalledOnce();
  });

  it('equip(name) returns install-only results unchanged without activation attempts', async () => {
    mockState.installExpansion.mockResolvedValue({
      status: 'installed',
      method: 'binary',
      version: 'v1.2.3',
      command: '/tmp/cgc',
    });

    const result = installResponseSchema.parse(await equip('cgc'));

    expect(result).toEqual({
      status: 'installed',
      method: 'binary',
      version: 'v1.2.3',
      command: '/tmp/cgc',
    });
    expect(mockState.activateExpansion).not.toHaveBeenCalled();
  });

  it('update(name) activates equipment when an update was applied', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    mkdirSync(join(fixture.homeDir, '.coral'), { recursive: true });
    writeFileSync(
      join(fixture.homeDir, '.coral', '.env'),
      'CORAL_EMBEDDING_PROVIDER=local-onnx\nCORAL_EMBEDDING_MODEL=nomic-embed-text\n',
      'utf-8',
    );
    mockState.installExpansion.mockResolvedValue({
      status: 'updated',
      method: 'prebuild',
      version: '0.2.0',
      targetDir: '/tmp/needle',
      postInstall: ['register_equipment'],
    });
    mockState.activateExpansion.mockResolvedValue({
      status: 'catching_up',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'catching_up',
      },
    });

    const result = installResponseSchema.parse(await update('needle'));

    expect(result).toEqual({
      status: 'catching_up',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'catching_up',
      },
    });
    expect(mockState.installExpansion).toHaveBeenCalledWith('needle', { update: true });
    expect(mockState.activateExpansion).toHaveBeenCalledWith('needle');
  });

  it('update(name) returns already_up_to_date unchanged and skips activation', async () => {
    mockState.installExpansion.mockResolvedValue({
      status: 'already_up_to_date',
      method: 'binary',
      version: 'v1.2.3',
      command: '/tmp/cgc',
    });

    const result = installResponseSchema.parse(await update('cgc'));

    expect(result).toEqual({
      status: 'already_up_to_date',
      method: 'binary',
      version: 'v1.2.3',
      command: '/tmp/cgc',
    });
    expect(mockState.installExpansion).toHaveBeenCalledWith('cgc', { update: true });
    expect(mockState.activateExpansion).not.toHaveBeenCalled();
  });

  it('unequip(name) deactivates live equipment before uninstall cleanup', async () => {
    mockState.readEquipmentStatus.mockResolvedValue({
      status: 'available',
      equipment: [{ slot: 'kb.vector', name: 'needle', status: 'equipped' }],
    });
    mockState.deactivateExpansion.mockResolvedValue({ status: 'uninstalled' });
    mockState.uninstallExpansion.mockResolvedValue({ status: 'uninstalled' });

    const result = installResponseSchema.parse(await unequip('needle'));

    expect(result).toEqual({ status: 'uninstalled' });
    expect(mockState.readEquipmentStatus).toHaveBeenCalledWith('needle');
    expect(mockState.deactivateExpansion).toHaveBeenCalledWith('needle');
    expect(mockState.uninstallExpansion).toHaveBeenCalledWith('needle');
  });

  it('unequip(name) skips coordinator deactivation for inactive equipment and for install-only expansions', async () => {
    mockState.readEquipmentStatus.mockResolvedValue({
      status: 'available',
      equipment: [{ slot: 'kb.vector', name: 'needle', status: 'inactive' }],
    });
    mockState.uninstallExpansion.mockResolvedValueOnce({ status: 'uninstalled' }).mockResolvedValueOnce({ status: 'uninstalled' });

    const needleResult = installResponseSchema.parse(await unequip('needle'));
    const cgcResult = installResponseSchema.parse(await unequip('cgc'));

    expect(needleResult).toEqual({ status: 'uninstalled' });
    expect(cgcResult).toEqual({ status: 'uninstalled' });
    expect(mockState.deactivateExpansion).not.toHaveBeenCalled();
    expect(mockState.readEquipmentStatus).toHaveBeenCalledTimes(1);
    expect(mockState.uninstallExpansion).toHaveBeenNthCalledWith(1, 'needle');
    expect(mockState.uninstallExpansion).toHaveBeenNthCalledWith(2, 'cgc');
  });

  it('equip(name) resolves onboarding local runtime paths from the settled KB runtime dir', async () => {
    const fixture = createFixture();
    useFixtureEnv(fixture);
    setBuildFlavor('dev');
    mockState.installExpansion.mockResolvedValue({
      status: 'installed',
      method: 'prebuild',
      version: '0.2.0',
      targetDir: equipmentDataDir('needle', { baseDir: fixture.baseDir, env: { CORAL_FLAVOR: 'dev' } }),
      postInstall: ['register_equipment'],
    });

    const result = installResponseSchema.parse(await equip('needle'));

    expect(result).toMatchObject({
      status: 'installed',
      onboarding: expect.objectContaining({
        localRuntime: expect.objectContaining({
          targetDir: kbRuntimeDir(),
        }),
      }),
    });
    expect(result.status).toBe('installed');
    if (result.status === 'installed') {
      expect(result.onboarding?.localRuntime.targetDir).toBe(kbRuntimeDir());
    }
  });
});
