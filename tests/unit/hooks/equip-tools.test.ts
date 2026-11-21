import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveEquippedTools as resolveProviderTools } from '#src/expansion/equipped-tools.js';
import { resolveEnvBudgetBytes } from '#src/infra/env-sanitize.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  EQUIP_AGENT_TOOLS,
  resolveEquippedTools as resolveHookTools,
} from '../../../clients/hooks/lib/equip-tools.mjs';

const BIN = 'codebase-memory-mcp';
let home: string;
let pathDir: string;

beforeAll(() => {
  resolveEnvBudgetBytes();
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'coral-equip-tools-')));
  pathDir = join(home, 'path-bin');
  mkdirSync(pathDir);
  vi.stubEnv('HOME', home);
  vi.stubEnv('PATH', pathDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function seedLegacyBinary(): void {
  for (const flavor of ['prod', 'dev'] as const) {
    const legacyDir = createRealRuntime(flavor).paths.coral.engine.dataDir('codebase-memory');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, BIN), 'binary', { mode: 0o755 });
  }
}

function fakeMounts(runtime: ReturnType<typeof createRealRuntime>, lines = '') {
  vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
  return vi.spyOn(runtime.storage, 'readFileSync').mockReturnValue(`1 0 0:1 / / rw - ext4 /dev/root rw\n${lines}`);
}

describe('equipped tool detection', () => {
  it('keeps hook and provider guidance in lockstep for every PATH-installed catalog entry', () => {
    const catalog = EQUIP_AGENT_TOOLS;
    for (const { bin } of catalog) {
      writeFileSync(join(pathDir, bin), 'binary', { mode: 0o755 });
    }
    expect(catalog.map(({ id }) => id)).toContain('codebase-memory');
    const expected = catalog.map(({ id, summary, guidance }) => ({ id, summary, guidance }));
    const runtime = createRealRuntime('prod');
    fakeMounts(runtime);
    expect(resolveHookTools(runtime.env, runtime.storage)).toEqual(expected);
    expect(resolveProviderTools(runtime)).toEqual(expected);
  });

  it('finds the standard install when a reduced PATH omits it', () => {
    const standardDir = join(home, '.local', 'bin');
    mkdirSync(standardDir, { recursive: true });
    writeFileSync(join(standardDir, BIN), 'binary', { mode: 0o755 });
    expect(resolveHookTools()).toEqual([expect.objectContaining({ id: 'codebase-memory' })]);
    expect(resolveProviderTools(createRealRuntime('prod'))).toEqual(resolveHookTools());
  });

  it.each(['missing', 'non-executable', 'directory'] as const)(
    'ignores a %s PATH entry and a leftover in the engine tree',
    (entry) => {
      seedLegacyBinary();
      const candidate = join(pathDir, BIN);
      if (entry === 'non-executable') writeFileSync(candidate, 'binary', { mode: 0o644 });
      if (entry === 'directory') mkdirSync(candidate);
      const runtime = createRealRuntime('prod');
      fakeMounts(runtime);
      expect(resolveHookTools(runtime.env, runtime.storage)).toEqual([]);
      expect(resolveProviderTools(runtime)).toEqual([]);
    },
  );

  describe.each([
    ['hook', (runtime: ReturnType<typeof createRealRuntime>) => resolveHookTools(runtime.env, runtime.storage)],
    ['provider', resolveProviderTools],
  ] as const)('%s lookup', (_surface, equipped) => {
    it('selects the first of two local PATH copies ahead of the standard executable', () => {
      const secondDir = join(home, 'second-bin');
      const standardDir = join(home, '.local', 'bin');
      mkdirSync(secondDir);
      mkdirSync(standardDir, { recursive: true });
      const first = join(pathDir, BIN);
      writeFileSync(first, 'first', { mode: 0o755 });
      writeFileSync(join(secondDir, BIN), 'second', { mode: 0o755 });
      writeFileSync(join(standardDir, BIN), 'standard', { mode: 0o755 });
      vi.stubEnv('PATH', [pathDir, secondDir].join(delimiter));
      const runtime = createRealRuntime('prod');
      fakeMounts(runtime);
      const access = vi.spyOn(runtime.storage, 'assertExecutableSync');
      const stat = vi.spyOn(runtime.storage, 'statSync');

      expect(equipped(runtime)).toEqual([expect.objectContaining({ id: 'codebase-memory' })]);
      expect(access).toHaveBeenCalledExactlyOnceWith(first);
      expect(stat).not.toHaveBeenCalled();
    });

    it('skips network and unknown mounts before filesystem probes', () => {
      const remote = join(home, 'network share');
      const nested = join(remote, 'local');
      const local = `${remote}-local`;
      const fuse = join(home, 'fuse');
      const autofs = join(home, 'autofs');
      for (const dir of [remote, nested, fuse, autofs, local]) {
        mkdirSync(dir);
        writeFileSync(join(dir, BIN), 'binary', { mode: 0o755 });
      }
      vi.stubEnv('PATH', [remote, nested, fuse, autofs, local].join(delimiter));
      const runtime = createRealRuntime('prod');
      const mountRead = fakeMounts(
        runtime,
        [
          `2 1 0:2 / ${remote.replaceAll(' ', '\\040')} rw - fuse.sshfs remote rw`,
          `3 2 0:3 / ${nested.replaceAll(' ', '\\040')} rw - ext4 /dev/local rw`,
          `4 1 0:4 / ${fuse} rw - fuse.custom custom rw`,
          `5 1 0:5 / ${autofs} rw - autofs auto rw`,
        ].join('\n'),
      );
      const lstat = vi.spyOn(runtime.storage, 'lstatSync');
      const stat = vi.spyOn(runtime.storage, 'statSync');
      const access = vi.spyOn(runtime.storage, 'assertExecutableSync');

      expect(equipped(runtime)).toEqual([expect.objectContaining({ id: 'codebase-memory' })]);
      expect(mountRead).toHaveBeenCalledExactlyOnceWith('/proc/self/mountinfo', 'utf-8');
      for (const dir of [remote, fuse, autofs]) {
        expect(lstat.mock.calls.every(([path]) => path !== dir && !String(path).startsWith(dir + '/'))).toBe(true);
      }
      expect(stat).not.toHaveBeenCalled();
      expect(access).toHaveBeenCalledExactlyOnceWith(join(local, BIN));

      rmSync(join(local, BIN));
      expect(equipped(runtime)).toEqual([]);
    });

    it('does not follow symlinks on PATH and checks the standard location even on a network mount', () => {
      const aliasDir = join(home, 'alias');
      const targetDir = join(home, 'remote');
      const standardDir = join(home, '.local', 'bin');
      const standard = join(standardDir, BIN);
      const target = join(targetDir, BIN);
      mkdirSync(targetDir);
      mkdirSync(standardDir, { recursive: true });
      writeFileSync(target, 'remote', { mode: 0o755 });
      writeFileSync(standard, 'standard', { mode: 0o755 });
      symlinkSync(targetDir, aliasDir, 'dir');
      symlinkSync(target, join(pathDir, BIN));
      vi.stubEnv('PATH', [aliasDir, pathDir].join(delimiter));
      const runtime = createRealRuntime('prod');
      fakeMounts(
        runtime,
        [`2 1 0:2 / ${targetDir} rw - nfs4 remote rw`, `3 1 0:3 / ${standardDir} rw - cifs standard rw`].join('\n'),
      );
      const lstat = vi.spyOn(runtime.storage, 'lstatSync');
      const stat = vi.spyOn(runtime.storage, 'statSync');
      const access = vi.spyOn(runtime.storage, 'assertExecutableSync');

      expect(equipped(runtime)).toEqual([expect.objectContaining({ id: 'codebase-memory' })]);
      expect(lstat).toHaveBeenCalledWith(aliasDir);
      expect(lstat).toHaveBeenCalledWith(join(pathDir, BIN));
      expect(lstat).not.toHaveBeenCalledWith(join(aliasDir, BIN));
      expect(stat).toHaveBeenCalledExactlyOnceWith(standard);
      expect(access).toHaveBeenCalledExactlyOnceWith(standard);
    });

    it.each(['darwin', 'linux'] as const)('checks only the standard location without mountinfo on %s', (platform) => {
      const standardDir = join(home, '.local', 'bin');
      const standard = join(standardDir, BIN);
      mkdirSync(standardDir, { recursive: true });
      writeFileSync(standard, 'standard', { mode: 0o755 });
      writeFileSync(join(pathDir, BIN), 'external', { mode: 0o755 });
      const runtime = createRealRuntime('prod');
      vi.spyOn(runtime.env, 'platform').mockReturnValue(platform);
      const mountRead = vi.spyOn(runtime.storage, 'readFileSync').mockImplementation(() => {
        throw new Error('No mountinfo');
      });
      const lstat = vi.spyOn(runtime.storage, 'lstatSync');
      const stat = vi.spyOn(runtime.storage, 'statSync');
      const access = vi.spyOn(runtime.storage, 'assertExecutableSync');

      expect(equipped(runtime)).toEqual([expect.objectContaining({ id: 'codebase-memory' })]);
      expect(mountRead).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0);
      expect(lstat).not.toHaveBeenCalled();
      expect(stat).toHaveBeenCalledExactlyOnceWith(standard);
      expect(access).toHaveBeenCalledExactlyOnceWith(standard);
    });
  });
});
