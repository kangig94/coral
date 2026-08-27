import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

const mockState = vi.hoisted(() => ({
  platform: 'linux' as NodeJS.Platform,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, platform: () => mockState.platform };
});

import {
  coordinatorPaths,
  handoffRoutingStatusPath,
  v0109CoordinatorSocketGuardSetForRunDir,
} from '#src/infra/path/coordinator.js';
import { socketFallbackDir } from '#src/infra/path/unix-socket.js';

function baseDirOfLength(length: number): string {
  return `/${'a'.repeat(length - 1)}`;
}

function socketPathFor(baseDir: string, flavor: 'prod' | 'dev'): string {
  return join(baseDir, 'gen2', flavor === 'dev' ? 'run-dev' : 'run', 'coordinator.sock');
}

function baseDirForSocketLength(targetLength: number, flavor: 'prod' | 'dev'): string {
  const fixedSuffixLength = `/gen2/${flavor === 'dev' ? 'run-dev' : 'run'}/coordinator.sock`.length;
  return baseDirOfLength(targetLength - fixedSuffixLength);
}

afterEach(() => {
  mockState.platform = 'linux';
});

describe('coordinatorPaths', () => {
  it('addresses the routing status database by required generation', () => {
    const options = { baseDir: '/var/lib/coral' };

    expect(handoffRoutingStatusPath('prod', 1, options)).toBe('/var/lib/coral/gen2/run/handoff-routing.1.db');
    expect(handoffRoutingStatusPath('prod', 2, options)).not.toBe(handoffRoutingStatusPath('prod', 1, options));
  });

  it.each([
    { socketBytes: 103, fallback: false },
    { socketBytes: 104, fallback: true },
    { socketBytes: 105, fallback: true },
  ])('uses the Darwin fallback threshold at $socketBytes bytes', ({ socketBytes, fallback }) => {
    mockState.platform = 'darwin';
    const baseDir = baseDirForSocketLength(socketBytes, 'prod');
    const expectedSocket = socketPathFor(baseDir, 'prod');

    expect(Buffer.byteLength(expectedSocket, 'utf8')).toBe(socketBytes);

    const paths = coordinatorPaths('prod', { baseDir });
    if (fallback) {
      expect(paths.socketPath.startsWith(`${socketFallbackDir(join(baseDir, 'gen2'))}/`)).toBe(true);
      expect(paths.socketPath).toMatch(/\/coral-prod-[0-9a-f]{16}\.sock$/);
      return;
    }

    expect(paths.socketPath).toBe(expectedSocket);
  });

  it.each([
    { socketBytes: 107, fallback: false },
    { socketBytes: 108, fallback: true },
    { socketBytes: 109, fallback: true },
  ])('uses the Linux fallback threshold at $socketBytes bytes', ({ socketBytes, fallback }) => {
    mockState.platform = 'linux';
    const baseDir = baseDirForSocketLength(socketBytes, 'dev');
    const expectedSocket = socketPathFor(baseDir, 'dev');

    expect(Buffer.byteLength(expectedSocket, 'utf8')).toBe(socketBytes);

    const paths = coordinatorPaths('dev', { baseDir });
    if (fallback) {
      expect(paths.socketPath.startsWith(`${socketFallbackDir(join(baseDir, 'gen2'))}/`)).toBe(true);
      expect(paths.socketPath).toMatch(/\/coral-dev-[0-9a-f]{16}\.sock$/);
      return;
    }

    expect(paths.socketPath).toBe(expectedSocket);
  });

  it('relocates a multibyte base path at the Linux byte threshold', () => {
    const asciiBaseDir = baseDirForSocketLength(107, 'prod');
    const baseDir = `${asciiBaseDir.slice(0, -1)}é`;
    const expectedSocket = socketPathFor(baseDir, 'prod');

    expect(expectedSocket).toHaveLength(107);
    expect(Buffer.byteLength(expectedSocket, 'utf8')).toBe(108);

    const paths = coordinatorPaths('prod', { baseDir });

    expect(paths.socketPath.startsWith(`${socketFallbackDir(join(baseDir, 'gen2'))}/`)).toBe(true);
  });

  it('keeps one relocated address for one state root when the calling uid changes', () => {
    mockState.platform = 'linux';
    const baseDir = baseDirForSocketLength(150, 'prod');
    const getuid = vi.spyOn(process, 'getuid');

    getuid.mockReturnValueOnce(1_000).mockReturnValueOnce(0);
    const userPath = coordinatorPaths('prod', { baseDir }).socketPath;
    const sudoPath = coordinatorPaths('prod', { baseDir }).socketPath;
    getuid.mockRestore();

    expect(userPath).toBe(sudoPath);
    expect(userPath.startsWith(`${socketFallbackDir(join(baseDir, 'gen2'))}/`)).toBe(true);
  });

  it.each([
    { platform: 'darwin', socketBytes: 103, kind: 'primary-address' },
    { platform: 'darwin', socketBytes: 104, kind: 'guarded-addresses' },
    { platform: 'linux', socketBytes: 107, kind: 'primary-address' },
    { platform: 'linux', socketBytes: 108, kind: 'guarded-addresses' },
    { platform: 'freebsd', socketBytes: 107, kind: 'primary-address' },
    { platform: 'freebsd', socketBytes: 108, kind: 'guarded-addresses' },
    { platform: 'win32', socketBytes: 107, kind: 'primary-address' },
    { platform: 'win32', socketBytes: 108, kind: 'guarded-addresses' },
  ])('uses the tagged v0.10.9 byte limit on $platform at $socketBytes bytes', ({ platform, socketBytes, kind }) => {
    const path = platform === 'win32' ? win32 : posix;
    const root = platform === 'win32' ? 'C:\\' : '/';
    // `path.join` adds a separator to a run directory but not to a root that already ends in one, so the
    // suffix has to be measured against a non-root directory or the target length lands a byte high.
    const suffixBytes =
      Buffer.byteLength(path.join(`${root}a`, 'coordinator.sock'), 'utf8') - Buffer.byteLength(`${root}a`, 'utf8');
    const runDir = `${root}${'a'.repeat(socketBytes - suffixBytes - Buffer.byteLength(root, 'utf8'))}`;

    expect(Buffer.byteLength(path.join(runDir, 'coordinator.sock'), 'utf8')).toBe(socketBytes);
    expect(
      v0109CoordinatorSocketGuardSetForRunDir(runDir, 'dev', {
        platform,
        configuredTempDirectory: undefined,
        systemTempDirectory: platform === 'win32' ? 'C:\\Temp' : '/tmp',
      }).kind,
    ).toBe(kind);
  });

  it.each([
    { semantics: 'posix', configured: undefined, expected: 'guarded-addresses' },
    { semantics: 'posix', configured: '', expected: 'address-unenumerable' },
    { semantics: 'posix', configured: '   ', expected: 'address-unenumerable' },
    { semantics: 'posix', configured: 'relative/temp', expected: 'address-unenumerable' },
    { semantics: 'posix', configured: '/custom-temp', expected: 'guarded-addresses' },
    { semantics: 'win32', configured: undefined, expected: 'guarded-addresses' },
    { semantics: 'win32', configured: '', expected: 'address-unenumerable' },
    { semantics: 'win32', configured: '   ', expected: 'address-unenumerable' },
    { semantics: 'win32', configured: 'relative\\temp', expected: 'address-unenumerable' },
    { semantics: 'win32', configured: 'C:\\custom-temp', expected: 'guarded-addresses' },
  ] as const)(
    'classifies configured temp input $configured with $semantics semantics',
    ({ semantics, configured, expected }) => {
      const windows = semantics === 'win32';
      const selection = v0109CoordinatorSocketGuardSetForRunDir(
        windows ? `C:\\${'a'.repeat(120)}` : `/${'a'.repeat(120)}`,
        'prod',
        {
          platform: windows ? 'win32' : 'linux',
          configuredTempDirectory: configured,
          systemTempDirectory: windows ? 'C:\\Temp' : '/tmp',
        },
      );

      expect(selection.kind).toBe(expected);
      if (selection.kind === 'guarded-addresses') {
        expect(selection.paths).toHaveLength(configured === undefined ? 1 : 2);
        expect(selection.paths.every((path) => (windows ? win32.isAbsolute(path) : posix.isAbsolute(path)))).toBe(true);
      }
    },
  );

  it('deduplicates equal configured and system temp addresses', () => {
    const selection = v0109CoordinatorSocketGuardSetForRunDir(`/${'a'.repeat(120)}`, 'prod', {
      platform: 'linux',
      configuredTempDirectory: '/tmp',
      systemTempDirectory: '/tmp',
    });

    expect(selection).toMatchObject({ kind: 'guarded-addresses' });
    if (selection.kind === 'guarded-addresses') expect(selection.paths).toHaveLength(1);
  });
});
