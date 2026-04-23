import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoordinatorDiscoveryRecord } from '../../infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  readDiscoveryRecord: vi.fn<(flavor: 'prod' | 'dev') => CoordinatorDiscoveryRecord | null>(),
}));

vi.mock('../../infra/backend-discovery.js', async () => {
  const actual = await vi.importActual<typeof import('../../infra/backend-discovery.js')>(
    '../../infra/backend-discovery.js',
  );
  return {
    ...actual,
    readDiscoveryRecord: mockState.readDiscoveryRecord,
  };
});

import { readPassiveDiscovery } from '../discovery-api.js';

function makeDiscoveryRecord(
  overrides: Partial<CoordinatorDiscoveryRecord> = {},
): CoordinatorDiscoveryRecord {
  return {
    pid: 1234,
    port: 4312,
    socketPath: '/tmp/coral.sock',
    bundleHash: 'bundle-a',
    flavor: 'prod',
    namespace: 'ns-a',
    startedAt: 1_713_456_789_000,
    token: 'token-a',
    ...overrides,
  };
}

describe('coordinator discovery api (AC6)', () => {
  beforeEach(() => {
    mockState.readDiscoveryRecord.mockReset();
  });

  it('returns null on ENOENT', () => {
    mockState.readDiscoveryRecord.mockImplementation(() => {
      throw Object.assign(new Error('missing discovery'), { code: 'ENOENT' });
    });

    expect(readPassiveDiscovery('prod')).toBeNull();
    expect(mockState.readDiscoveryRecord).toHaveBeenCalledWith('prod');
  });

  it('returns null on EACCES', () => {
    mockState.readDiscoveryRecord.mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    expect(readPassiveDiscovery('dev')).toBeNull();
    expect(mockState.readDiscoveryRecord).toHaveBeenCalledWith('dev');
  });

  it('returns null on SyntaxError', () => {
    mockState.readDiscoveryRecord.mockImplementation(() => {
      throw new SyntaxError('Unexpected token');
    });

    expect(readPassiveDiscovery('prod')).toBeNull();
  });

  it('returns the parsed record when discovery is readable', () => {
    const record = makeDiscoveryRecord({ flavor: 'dev', socketPath: '/tmp/coral-dev.sock' });
    mockState.readDiscoveryRecord.mockReturnValue(record);

    expect(readPassiveDiscovery('dev')).toEqual(record);
  });
});
