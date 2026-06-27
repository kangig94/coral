import { vi } from 'vitest';

import type { KbChildHealthSnapshot, KbChildSupervisor } from '../../src/coordinator/kb-child/supervisor.js';

export function createOnlineKbChildHealth(overrides: Partial<KbChildHealthSnapshot> = {}): KbChildHealthSnapshot {
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

export type MockKbChildSupervisorOptions = {
  health?: KbChildHealthSnapshot;
  read?: KbChildSupervisor['read'];
  start?: KbChildSupervisor['start'];
  probe?: KbChildSupervisor['probe'];
  warmup?: KbChildSupervisor['warmup'];
  readKb?: KbChildSupervisor['readKb'];
  mutateKb?: KbChildSupervisor['mutateKb'];
  expansionRpc?: KbChildSupervisor['expansionRpc'];
  abortKbJobs?: KbChildSupervisor['abortKbJobs'];
  listActiveKbJobs?: KbChildSupervisor['listActiveKbJobs'];
  stop?: KbChildSupervisor['stop'];
  restart?: KbChildSupervisor['restart'];
  dispose?: KbChildSupervisor['dispose'];
  onExit?: KbChildSupervisor['onExit'];
};

export function createMockKbChildSupervisor(options: MockKbChildSupervisorOptions = {}): KbChildSupervisor {
  const health = options.health ?? createOnlineKbChildHealth();
  return {
    read: options.read ?? vi.fn(() => health),
    start: options.start ?? vi.fn(async () => health),
    probe: options.probe ?? vi.fn(async () => health),
    warmup: options.warmup ?? vi.fn(async () => health),
    readKb:
      options.readKb ??
      vi.fn(async (request) => ({
        ok: true as const,
        data: { servedBy: 'kb-child', method: request.method },
      })),
    mutateKb:
      options.mutateKb ??
      vi.fn(async (request) => ({
        ok: true as const,
        data: { servedBy: 'kb-child', method: request.method },
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
              : { servedBy: 'kb-child', method: request.method },
      })),
    abortKbJobs: options.abortKbJobs ?? vi.fn(async (jobIds) => ({ aborted: [], notFound: [...jobIds] })),
    listActiveKbJobs: options.listActiveKbJobs ?? vi.fn(async () => ({ active: [] })),
    stop: options.stop ?? vi.fn(async () => health),
    restart: options.restart ?? vi.fn(async () => health),
    dispose: options.dispose ?? vi.fn(async () => undefined),
    onExit: options.onExit ?? vi.fn(() => () => {}),
  };
}
