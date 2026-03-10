import { afterEach, describe, expect, it, vi } from 'vitest';

import { initSession } from '../../discuss/state-machine.js';
import { DiscussManagerRegistry } from '../discuss-manager.js';
import { createBackendServer, type BackendServerController } from '../server.js';
import type { ExecutionService } from '../service.js';

function createServiceStub(): ExecutionService {
  return Object.create(null) as ExecutionService;
}

function createState(sessionId: string) {
  return {
    ...initSession({
      topic: 'Should the city pedestrianize the downtown core?',
      agents: [
        { name: 'alpha', persona: 'Alpha', participation: 'required' },
        { name: 'beta', persona: 'Beta', participation: 'required' },
      ],
      min_bid_delay_ms: 0,
    }, '2026-03-10T00:00:00.000Z'),
    session_id: sessionId,
  };
}

function createFakeIdleTimer() {
  let checkIdle: (() => boolean) | null = null;
  return {
    beginRequest: vi.fn(),
    endRequest: vi.fn(),
    get inflightRequests() {
      return 0;
    },
    startWatching: vi.fn((predicate: () => boolean) => {
      checkIdle = predicate;
    }),
    stopWatching: vi.fn(),
    getCheckIdle() {
      return checkIdle;
    },
  };
}

describe('DiscussManager lifecycle and backend idle shutdown', () => {
  let controller: BackendServerController | null = null;

  afterEach(async () => {
    if (controller && controller.getLifecycle() !== 'stopped') {
      await controller.shutdown('test');
    }
    controller = null;
    vi.restoreAllMocks();
  });

  async function startWithRegistry(registry: DiscussManagerRegistry) {
    const idleTimer = createFakeIdleTimer();
    controller = createBackendServer({
      token: 'test-token',
      instanceId: 'lifecycle-backend',
      version: '1.0.0-test',
      bundleHash: 'bundle-test',
      discussRegistry: registry,
      createIdleTimer: () => idleTimer as never,
      acquireLockFn: async () => {},
      writeBackendInfoFn: () => {},
      removeBackendInfoIfOwnerFn: () => {},
      removeLockIfOwnerFn: () => {},
      recoverOrphanedJobsFn: () => {},
      markJobsAsErrorFn: () => {},
      killAllChildrenFn: () => {},
      log: () => {},
    });
    await controller.start();
    return idleTimer;
  }

  it('keeps the backend non-idle while the registry still has live sessions', async () => {
    const registry = new DiscussManagerRegistry();
    registry.getOrCreate('/tmp/project', createServiceStub()).createSession('discuss-1', createState('discuss-1'));

    const idleTimer = await startWithRegistry(registry);
    const checkIdle = idleTimer.getCheckIdle();

    expect(registry.hasLiveSessions()).toBe(true);
    expect(checkIdle).not.toBeNull();
    expect(checkIdle?.()).toBe(false);
  });

  it('allows idle shutdown again after the live discuss session is removed', async () => {
    const registry = new DiscussManagerRegistry();
    const manager = registry.getOrCreate('/tmp/project', createServiceStub());
    manager.createSession('discuss-1', createState('discuss-1'));

    const idleTimer = await startWithRegistry(registry);
    const checkIdle = idleTimer.getCheckIdle();

    manager.removeSession('discuss-1');

    expect(registry.hasLiveSessions()).toBe(false);
    expect(checkIdle).not.toBeNull();
    expect(checkIdle?.()).toBe(true);
  });
});
