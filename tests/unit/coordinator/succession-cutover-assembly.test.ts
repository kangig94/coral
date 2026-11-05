import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { createSuccessionCoordinator } from '#src/coordinator/succession/index.js';
import type * as SuccessionModule from '#src/coordinator/succession/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createTestExecutionFinisher } from '#tests/helpers/execution-finisher.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

vi.mock('#src/coordinator/succession/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SuccessionModule>();
  return { ...actual, createSuccessionCoordinator: vi.fn(actual.createSuccessionCoordinator) };
});

it('wires quiescent retirement through the real assembly to lifecycle replacement shutdown', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-cutover-assembly-'));
  const runtime = createRealRuntime('prod', { baseDir });
  try {
    const core = createCoordinatorCore(
      {
        runtime,
        storeFormat: currentCoralStoreFormat(),
        executionFinisher: createTestExecutionFinisher(() => {
          throw new Error('Store services are not started in this assembly test');
        }, runtime),
        kbDaemonSupervisor: createMockKbDaemonSupervisor(),
        getConsumerStuck: () => [],
        onFatalShutdownError: vi.fn(),
      },
      async () => {},
    );
    const shutdown = vi.spyOn(core.lifecycleController, 'shutdown').mockResolvedValue({ disposition: 'finalized' });
    const [options] = vi.mocked(createSuccessionCoordinator).mock.calls.at(-1) ?? [];
    expect(options?.retireForCutover).toBeTypeOf('function');

    options?.retireForCutover?.();

    expect(shutdown).toHaveBeenCalledExactlyOnceWith('replaced');
    core.idleTimer.stopWatching();
  } finally {
    vi.restoreAllMocks();
    vi.mocked(createSuccessionCoordinator).mockClear();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
