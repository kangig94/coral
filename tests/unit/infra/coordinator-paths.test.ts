import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

const mockState = vi.hoisted(() => ({
  platform: 'linux' as NodeJS.Platform,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, platform: () => mockState.platform };
});

import { coordinatorPaths } from '#src/infra/path/coordinator.js';
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
    { socketBytes: 105, fallback: true },
  ])('uses the Darwin fallback threshold at $socketBytes bytes', ({ socketBytes, fallback }) => {
    mockState.platform = 'darwin';
    const baseDir = baseDirForSocketLength(socketBytes, 'prod');
    const expectedSocket = socketPathFor(baseDir, 'prod');

    expect(Buffer.byteLength(expectedSocket, 'utf8')).toBe(socketBytes);

    const paths = coordinatorPaths('prod', { baseDir });
    if (fallback) {
      expect(paths.socketPath.startsWith(`${socketFallbackDir(process.getuid?.() ?? 0)}/`)).toBe(true);
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
      expect(paths.socketPath.startsWith(`${socketFallbackDir(process.getuid?.() ?? 0)}/`)).toBe(true);
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

    expect(paths.socketPath.startsWith(`${socketFallbackDir(process.getuid?.() ?? 0)}/`)).toBe(true);
  });
});
