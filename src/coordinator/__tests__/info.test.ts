import { createHash } from 'node:crypto';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Flavor = 'prod' | 'dev';
type MockPlatform = 'linux' | 'darwin';

const mockState = vi.hoisted(() => ({
  home: '/home/short',
  platform: 'linux' as MockPlatform,
  tmpdir: '/tmp',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.home,
    platform: () => mockState.platform,
    tmpdir: () => mockState.tmpdir,
  };
});

afterEach(() => {
  mockState.home = '/home/short';
  mockState.platform = 'linux';
  mockState.tmpdir = '/tmp';
  vi.restoreAllMocks();
  vi.resetModules();
});

function candidateSocketPath(home: string, flavor: Flavor): string {
  return join(home, '.coral', flavor === 'dev' ? 'run-dev' : 'run', 'coordinator.sock');
}

function fallbackSocketPath(tmp: string, flavor: Flavor, candidateSocket: string): string {
  const hash = createHash('sha256').update(candidateSocket).digest('hex').slice(0, 8);
  return join(tmp, `coral-${flavor}-${hash}.sock`);
}

function syntheticHomeForCandidateBytes(targetBytes: number, flavor: Flavor, fill: string): string {
  const prefix = '/home/';
  const candidateOverhead = Buffer.byteLength(candidateSocketPath('x', flavor), 'utf8') - Buffer.byteLength('x', 'utf8');
  const fillBytes = targetBytes - Buffer.byteLength(prefix, 'utf8') - candidateOverhead;
  if (fillBytes < 0) {
    throw new Error(`targetBytes ${targetBytes} is too short for ${flavor}`);
  }
  const home = `${prefix}${fill.repeat(fillBytes)}`;
  const candidate = candidateSocketPath(home, flavor);
  if (Buffer.byteLength(candidate, 'utf8') !== targetBytes) {
    throw new Error(`expected ${targetBytes} bytes for ${candidate}`);
  }
  return home;
}

async function importCoordinatorPaths(home: string, platform: MockPlatform, tmp = '/tmp') {
  mockState.home = home;
  mockState.platform = platform;
  mockState.tmpdir = tmp;
  vi.resetModules();
  return import('../info.js');
}

describe('coordinatorPaths socket-path fallback', () => {
  it('uses default runDir socket when under limit', async () => {
    const { coordinatorPaths } = await importCoordinatorPaths('/home/short', 'linux');
    const p = coordinatorPaths('prod', { TMPDIR: '/tmp' });
    expect(p.socketPath).toBe(join('/home/short', '.coral', 'run', 'coordinator.sock'));
  });

  it('falls back to TMPDIR when Linux limit (108 bytes) is equalled or exceeded', async () => {
    for (const [targetBytes, fill] of [
      [108, 'a'],
      [109, 'b'],
    ] as const) {
      const longHome = syntheticHomeForCandidateBytes(targetBytes, 'prod', fill);
      const candidate = candidateSocketPath(longHome, 'prod');
      const expected = fallbackSocketPath('/tmp', 'prod', candidate);
      const { coordinatorPaths } = await importCoordinatorPaths(longHome, 'linux');
      const p = coordinatorPaths('prod', { TMPDIR: '/tmp' });

      expect(Buffer.byteLength(candidate, 'utf8')).toBe(targetBytes);
      expect(p.socketPath).toBe(expected);
    }
  });

  it('falls back to TMPDIR on Darwin when its stricter 104-byte limit is equalled or exceeded', async () => {
    for (const [targetBytes, fill] of [
      [104, 'c'],
      [105, 'd'],
    ] as const) {
      const longHome = syntheticHomeForCandidateBytes(targetBytes, 'dev', fill);
      const candidate = candidateSocketPath(longHome, 'dev');
      const expected = fallbackSocketPath('/tmp', 'dev', candidate);
      const { coordinatorPaths } = await importCoordinatorPaths(longHome, 'darwin');
      const p = coordinatorPaths('dev', { TMPDIR: '/tmp' });

      expect(Buffer.byteLength(candidate, 'utf8')).toBe(targetBytes);
      expect(p.socketPath).toBe(expected);
    }
  });

  it('sha8 fallback suffix is deterministic for same input', async () => {
    const longHome = syntheticHomeForCandidateBytes(109, 'prod', 'e');
    const candidate = candidateSocketPath(longHome, 'prod');
    const expected = fallbackSocketPath('/tmp', 'prod', candidate);
    const { coordinatorPaths } = await importCoordinatorPaths(longHome, 'linux');
    const p1 = coordinatorPaths('prod', { TMPDIR: '/tmp' });
    const p2 = coordinatorPaths('prod', { TMPDIR: '/tmp' });

    expect(p1.socketPath).toBe(p2.socketPath);
    expect(p1.socketPath).toBe(expected);
  });
});
