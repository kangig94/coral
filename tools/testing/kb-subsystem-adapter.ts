import { KB_ID, SubsystemUnavailableError } from '../../src/coordinator/subsystems/contract.js';
import type { Subsystem, SubsystemStatus } from '../../src/coordinator/subsystems/contract.js';
import type { CreateKbSubsystemOptions, KnowledgeBaseRuntime } from '../../src/kb/subsystem.js';

/**
 * Adapter for tests/simulations that previously passed a legacy
 * `createKbSubsystemFn: async () => KnowledgeBaseRuntime` to
 * `createCoordinatorCore` / `createCoordinatorServer`. Wraps the legacy
 * async factory into a `Subsystem<KnowledgeBaseRuntime>` whose `init()`
 * calls the factory once and transitions straight to `online`.
 *
 * No retry / boot sequence is exercised — production paths use the real
 * `createKbSubsystem` from `src/coordinator/subsystems/kb.ts` which carries
 * those semantics inside the registry's retry loop.
 */
export function adaptLegacyKbFactory(
  factory: (options: CreateKbSubsystemOptions) => Promise<KnowledgeBaseRuntime>,
): (options: CreateKbSubsystemOptions) => Subsystem<KnowledgeBaseRuntime> {
  return (options) => {
    let runtime: KnowledgeBaseRuntime | null = null;
    let status: SubsystemStatus = { id: KB_ID, phase: 'initializing', attempt: 0 };
    const listeners = new Set<(s: SubsystemStatus) => void>();
    const transition = (next: SubsystemStatus): void => {
      status = next;
      for (const l of listeners) l(next);
    };
    return {
      id: KB_ID,
      get status() {
        return status;
      },
      resource(): KnowledgeBaseRuntime {
        if (runtime === null) {
          throw new SubsystemUnavailableError(KB_ID, status.phase === 'offline' ? 'offline' : 'initializing');
        }
        return runtime;
      },
      onStatusChange(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async init(_signal: AbortSignal): Promise<void> {
        runtime = await factory(options);
        transition({ id: KB_ID, phase: 'online' });
      },
      async dispose(): Promise<void> {
        if (runtime !== null) {
          try {
            await runtime.curateScheduler.stop();
          } catch {
            // best-effort
          }
        }
        runtime = null;
        transition({ id: KB_ID, phase: 'offline', reason: 'disposed' });
      },
    };
  };
}
