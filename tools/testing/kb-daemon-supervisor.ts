import { vi } from 'vitest';

import type { KbDaemonHealthSnapshot, KbDaemonSupervisor } from '../../src/coordinator/live/kb-daemon-supervisor.js';

export function createOnlineKbDaemonHealth(overrides: Partial<KbDaemonHealthSnapshot> = {}): KbDaemonHealthSnapshot {
  return {
    enabled: true,
    phase: 'online',
    generation: 1,
    pid: 12_345,
    startedAt: 10,
    readyAt: 20,
    ...overrides,
  };
}

export type MockKbDaemonSupervisorOptions = {
  health?: KbDaemonHealthSnapshot;
  read?: KbDaemonSupervisor['read'];
  start?: KbDaemonSupervisor['start'];
  probe?: KbDaemonSupervisor['probe'];
  warmup?: KbDaemonSupervisor['warmup'];
  readKb?: KbDaemonSupervisor['readKb'];
  mutateKb?: KbDaemonSupervisor['mutateKb'];
  expansionRpc?: KbDaemonSupervisor['expansionRpc'];
  abortKbJobs?: KbDaemonSupervisor['abortKbJobs'];
  listActiveKbJobs?: KbDaemonSupervisor['listActiveKbJobs'];
  stop?: KbDaemonSupervisor['stop'];
  restart?: KbDaemonSupervisor['restart'];
  dispose?: KbDaemonSupervisor['dispose'];
  onExit?: KbDaemonSupervisor['onExit'];
};

export function createMockKbDaemonSupervisor(options: MockKbDaemonSupervisorOptions = {}): KbDaemonSupervisor {
  const health = options.health ?? createOnlineKbDaemonHealth();
  return {
    read: options.read ?? vi.fn(() => health),
    start: options.start ?? vi.fn(async () => health),
    probe: options.probe ?? vi.fn(async () => health),
    warmup: options.warmup ?? vi.fn(async () => health),
    readKb:
      options.readKb ??
      vi.fn(async (request) => ({
        ok: true as const,
        data: { servedBy: 'kb-daemon', method: request.method },
      })),
    mutateKb:
      options.mutateKb ??
      vi.fn(async (request) => ({
        ok: true as const,
        data: { servedBy: 'kb-daemon', method: request.method },
      })),
    expansionRpc:
      options.expansionRpc ??
      vi.fn(async (request) => ({
        ok: true as const,
        data:
          request.method === 'listExpansion'
            ? { expansions: [] }
            : request.method === 'readBinding'
              ? { bound: false }
              : { servedBy: 'kb-daemon', method: request.method },
      })),
    abortKbJobs: options.abortKbJobs ?? vi.fn(async (jobIds) => ({ aborted: [], notFound: [...jobIds] })),
    listActiveKbJobs: options.listActiveKbJobs ?? vi.fn(async () => ({ active: [] })),
    stop: options.stop ?? vi.fn(async () => health),
    restart: options.restart ?? vi.fn(async () => health),
    dispose: options.dispose ?? vi.fn(async () => undefined),
    onExit: options.onExit ?? vi.fn(() => () => {}),
  };
}
