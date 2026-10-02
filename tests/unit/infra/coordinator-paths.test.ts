import { join, posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

const mockState = vi.hoisted(() => ({
  platform: 'linux' as NodeJS.Platform,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, platform: () => mockState.platform };
});

import { coordinatorPaths, v0109CoordinatorSocketGuardSetForRunDir } from '#src/infra/path/coordinator.js';
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
  it.each([
    { socketBytes: 103, fallback: false },
    { socketBytes: 104, fallback: true },
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
    expect(coordinatorPaths('prod', { baseDir: `${baseDir}x` }).socketPath).not.toBe(userPath);
  });

  it('guards the primary address a tagged build uses when only this build would relocate', () => {
    const socketBytes = 106;
    const suffixBytes = Buffer.byteLength(posix.join('/a', 'coordinator.sock'), 'utf8') - 2;
    const runDir = `/${'a'.repeat(socketBytes - suffixBytes - 1)}`;
    const taggedAddress = posix.join(runDir, 'coordinator.sock');

    const selection = v0109CoordinatorSocketGuardSetForRunDir(runDir, 'prod', {
      platform: 'freebsd',
      configuredTempDirectory: undefined,
      systemTempDirectory: '/tmp',
    });

    expect(Buffer.byteLength(taggedAddress, 'utf8')).toBe(socketBytes);
    expect(selection).toEqual({ kind: 'guarded-addresses', paths: [taggedAddress] });
  });
});
