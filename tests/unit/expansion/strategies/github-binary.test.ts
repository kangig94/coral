import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { equipmentPaths } from '#src/infra/equipment-paths.js';
import type { Runtime } from '#src/runtime/ports.js';
import { GithubBinaryStrategy, type GithubBinaryConfig } from '#src/expansion/strategies/github-binary.js';
import type { ExpansionInstallContext } from '#src/expansion/strategies/strategy.js';

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-expansion-github-binary-'));
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
  const processExecSync = vi.fn(realRuntime.process.execSync);
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
    process: {
      ...realRuntime.process,
      execSync: processExecSync,
    },
  };
  const fixtureEquipment = equipmentPaths('prod', { baseDir: fixture.baseDir });
  const wrappedRuntime: Runtime = {
    ...runtime,
    paths: {
      ...runtime.paths,
      get coral() {
        return { ...runtime.paths.coral, equipment: fixtureEquipment };
      },
    },
  };

  return { runtime: wrappedRuntime };
}

function createConfig(): GithubBinaryConfig {
  const assetName = `cgc-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
  return {
    name: 'cgc',
    repo: 'CodeGraphContext/CodeGraphContext',
    fallbackVersion: 'v0.3.1',
    binaries: {
      [`${process.platform}-${process.arch}`]: assetName,
    },
  };
}

function toolsDir(homeDir: string): string {
  return join(homeDir, '.claude', 'tools');
}

function binaryPath(homeDir: string): string {
  return join(toolsDir(homeDir), process.platform === 'win32' ? 'cgc.exe' : 'cgc');
}

function externalInstallPath(fixture: ReturnType<typeof createFixture>): string {
  return join(fixture.baseDir, 'data', 'equipment', 'cgc', '.external-install.json');
}

describe('GithubBinaryStrategy', () => {
  it('installs the release binary and writes install metadata', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    const binaryBytes = Buffer.from('#!/bin/sh\necho cgc\n');
    const downloadBufferMock = vi.fn().mockResolvedValue(binaryBytes);
    const fetchLatestReleaseTagMock = vi.fn().mockResolvedValue('v1.2.3');
    const strategy = new GithubBinaryStrategy({
      downloadBuffer: downloadBufferMock,
      fetchLatestReleaseTag: fetchLatestReleaseTagMock,
    });

    const result = await strategy.install(ctx, createConfig());

    expect(result).toEqual({
      status: 'installed',
      method: 'binary',
      version: 'v1.2.3',
      command: binaryPath(fixture.homeDir),
    });
    expect(fetchLatestReleaseTagMock).toHaveBeenCalledWith(ctx.runtime, 'CodeGraphContext/CodeGraphContext');
    expect(downloadBufferMock).toHaveBeenCalledWith(
      ctx.runtime,
      `https://github.com/CodeGraphContext/CodeGraphContext/releases/download/v1.2.3/cgc-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`,
    );
    expect(readFileSync(binaryPath(fixture.homeDir))).toEqual(binaryBytes);
    expect(readFileSync(join(toolsDir(fixture.homeDir), '.cgc.json'), 'utf-8')).toBe(
      JSON.stringify({ version: 'v1.2.3', method: 'binary' }),
    );
  });

  it('returns already_installed when the local binary already exists for equip()', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    mkdirSync(toolsDir(fixture.homeDir), { recursive: true });
    writeFileSync(binaryPath(fixture.homeDir), Buffer.from('binary'));
    writeFileSync(join(toolsDir(fixture.homeDir), '.cgc.json'), JSON.stringify({ version: 'v1.2.3', method: 'binary' }), 'utf-8');
    const strategy = new GithubBinaryStrategy({
      downloadBuffer: vi.fn(),
      fetchLatestReleaseTag: vi.fn(),
    });

    const result = await strategy.install(ctx, createConfig());

    expect(result).toEqual({
      status: 'already_installed',
      method: 'binary',
      version: 'v1.2.3',
      command: binaryPath(fixture.homeDir),
    });
  });

  it('returns already_up_to_date when update() targets the installed release', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    mkdirSync(toolsDir(fixture.homeDir), { recursive: true });
    writeFileSync(binaryPath(fixture.homeDir), Buffer.from('binary'));
    writeFileSync(join(toolsDir(fixture.homeDir), '.cgc.json'), JSON.stringify({ version: 'v1.2.3', method: 'binary' }), 'utf-8');
    const strategy = new GithubBinaryStrategy({
      downloadBuffer: vi.fn(),
      fetchLatestReleaseTag: vi.fn().mockResolvedValue('v1.2.3'),
    });

    const result = await strategy.install(ctx, createConfig(), { update: true });

    expect(result).toEqual({
      status: 'already_up_to_date',
      method: 'binary',
      version: 'v1.2.3',
      command: binaryPath(fixture.homeDir),
    });
  });

  it('removes the partial binary when the atomic write fails', async () => {
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
    const strategy = new GithubBinaryStrategy({
      downloadBuffer: vi.fn().mockResolvedValue(Buffer.from('binary')),
      fetchLatestReleaseTag: vi.fn().mockResolvedValue('v1.2.3'),
    });

    await expect(strategy.install(failingCtx, createConfig())).rejects.toThrow('simulated disk failure');
    expect(statSafe(`${binaryPath(fixture.homeDir)}.part`)).toBeNull();
    expect(statSafe(binaryPath(fixture.homeDir))).toBeNull();
  });

  it('uninstalls by removing the binary and its metadata', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    mkdirSync(toolsDir(fixture.homeDir), { recursive: true });
    writeFileSync(binaryPath(fixture.homeDir), Buffer.from('binary'));
    writeFileSync(join(toolsDir(fixture.homeDir), '.cgc.json'), JSON.stringify({ version: 'v1.2.3', method: 'binary' }), 'utf-8');
    const strategy = new GithubBinaryStrategy();

    const result = await strategy.uninstall(ctx, createConfig());

    expect(result).toEqual({ status: 'uninstalled' });
    expect(statSafe(binaryPath(fixture.homeDir))).toBeNull();
    expect(statSafe(join(toolsDir(fixture.homeDir), '.cgc.json'))).toBeNull();
  });

  it('reports installation state and current version from the tool metadata', () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    mkdirSync(toolsDir(fixture.homeDir), { recursive: true });
    writeFileSync(binaryPath(fixture.homeDir), Buffer.from('binary'));
    writeFileSync(join(toolsDir(fixture.homeDir), '.cgc.json'), JSON.stringify({ version: 'v1.2.3', method: 'binary' }), 'utf-8');
    const strategy = new GithubBinaryStrategy();

    expect(strategy.isInstalled(ctx, createConfig())).toBe(true);
    expect(strategy.currentVersion(ctx, createConfig())).toBe('v1.2.3');
  });

  it('persists a PATH hit as a local external-install marker and reports it consistently', async () => {
    const fixture = createFixture();
    const ctx = createContext(fixture);
    vi.mocked(ctx.runtime.process.execSync).mockImplementation((command, args) => {
      if (
        (command === 'which' || command === 'where')
        && Array.isArray(args)
        && args[0] === 'cgc'
      ) {
        return {
          status: 0,
          stdout: '/usr/local/bin/cgc\n',
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });
    const fetchLatestReleaseTagMock = vi.fn();
    const strategy = new GithubBinaryStrategy({
      downloadBuffer: vi.fn(),
      fetchLatestReleaseTag: fetchLatestReleaseTagMock,
    });

    const result = await strategy.install(ctx, createConfig());

    expect(result).toEqual({
      status: 'already_installed',
      method: 'system',
      command: '/usr/local/bin/cgc',
    });
    expect(fetchLatestReleaseTagMock).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(externalInstallPath(fixture), 'utf-8'))).toEqual({
      method: 'system',
      command: '/usr/local/bin/cgc',
      detectedAt: expect.any(String),
    });
    expect(strategy.isInstalled(ctx, createConfig())).toBe(true);
    expect(strategy.currentVersion(ctx, createConfig())).toBeNull();
  });
});

function statSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
