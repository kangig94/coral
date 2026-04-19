import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';

const mockState = vi.hoisted(() => ({
  platform: 'linux' as NodeJS.Platform,
  tmpdir: '/tmp/coral-coordinator-paths',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    platform: () => mockState.platform,
    tmpdir: () => mockState.tmpdir,
  };
});

import { coordinatorPaths } from '../coordinator-paths.js';

function baseDirOfLength(length: number): string {
  return `/${'a'.repeat(length - 1)}`;
}

function socketPathFor(baseDir: string, flavor: 'prod' | 'dev'): string {
  return join(baseDir, flavor === 'dev' ? 'run-dev' : 'run', 'coordinator.sock');
}

function baseDirForSocketLength(targetLength: number, flavor: 'prod' | 'dev'): string {
  const fixedSuffixLength = `/${flavor === 'dev' ? 'run-dev' : 'run'}/coordinator.sock`.length;
  return baseDirOfLength(targetLength - fixedSuffixLength);
}

afterEach(() => {
  mockState.platform = 'linux';
  mockState.tmpdir = '/tmp/coral-coordinator-paths';
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

    const paths = coordinatorPaths('prod', { TMPDIR: mockState.tmpdir }, { baseDir });
    if (fallback) {
      expect(paths.socketPath.startsWith(`${mockState.tmpdir}/`)).toBe(true);
      expect(paths.socketPath).toMatch(/\/coral-prod-[0-9a-f]{8}\.sock$/);
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

    const paths = coordinatorPaths('dev', { TMPDIR: mockState.tmpdir }, { baseDir });
    if (fallback) {
      expect(paths.socketPath.startsWith(`${mockState.tmpdir}/`)).toBe(true);
      expect(paths.socketPath).toMatch(/\/coral-dev-[0-9a-f]{8}\.sock$/);
      return;
    }

    expect(paths.socketPath).toBe(expectedSocket);
  });
});
