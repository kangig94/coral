import type { Subsystem, SubsystemId, SubsystemStatus } from './contract.js';
import { SubsystemUnavailableError } from './contract.js';

export type SubsystemErrorEnvelope = { ok: false; code: string; message: string; remediation?: string };

export interface SubsystemRegistry {
  register<R>(sub: Subsystem<R>): void;
  /** Fire-and-forget Era III. Each subsystem runs its own internal retry. */
  initAll(signal: AbortSignal): void;
  disposeAll(signal: AbortSignal): Promise<void>;
  run<R, T>(id: SubsystemId, fn: (resource: R) => T): T | SubsystemErrorEnvelope;
  runAsync<R, T>(id: SubsystemId, fn: (resource: R) => Promise<T>): Promise<T | SubsystemErrorEnvelope>;
  list(): readonly SubsystemStatus[];
  status(id: SubsystemId): SubsystemStatus | null;
}

export function phaseToCode(id: SubsystemId, phase: 'initializing' | 'offline'): string {
  return `${id}_${phase}`;
}

export function phaseToMessage(id: SubsystemId, phase: 'initializing' | 'offline'): string {
  if (phase === 'initializing') {
    return `${id === 'kb' ? 'Knowledge base' : id} is starting up`;
  }
  return `${id === 'kb' ? 'Knowledge base' : id} is offline`;
}

export function phaseToRemediation(id: SubsystemId, phase: 'initializing' | 'offline'): string {
  if (phase === 'initializing') {
    return 'Wait briefly, then retry the request';
  }
  return id === 'kb' ? 'Restart the daemon: coral-cli backend shutdown' : `Restart the ${id} subsystem`;
}

export function isErrorEnvelope(value: unknown): value is SubsystemErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    ((value as { remediation?: unknown }).remediation === undefined ||
      typeof (value as { remediation?: unknown }).remediation === 'string')
  );
}

function phaseEnvelope(id: SubsystemId, phase: 'initializing' | 'offline'): SubsystemErrorEnvelope {
  return {
    ok: false,
    code: phaseToCode(id, phase),
    message: phaseToMessage(id, phase),
    remediation: phaseToRemediation(id, phase),
  };
}

export function createSubsystemRegistry(): SubsystemRegistry {
  const subs = new Map<SubsystemId, Subsystem<unknown>>();

  return {
    register(sub) {
      if (subs.has(sub.id)) {
        throw new Error(`Subsystem ${sub.id} already registered`);
      }
      subs.set(sub.id, sub);
    },
    initAll(signal) {
      for (const sub of subs.values()) {
        // Per-sub catch ensures one sub's throw doesn't crash the registry.
        void sub.init(signal).catch(() => {
          // Subsystem captures its own failure into status; registry stays silent.
        });
      }
    },
    async disposeAll(signal) {
      await Promise.all([...subs.values()].map((s) => s.dispose(signal).catch(() => {})));
    },
    run<R, T>(id: SubsystemId, fn: (resource: R) => T): T | SubsystemErrorEnvelope {
      const sub = subs.get(id);
      if (sub === undefined) {
        return phaseEnvelope(id, 'offline');
      }
      const phase = sub.status.phase;
      if (phase === 'online' || phase === 'degraded') {
        try {
          return fn(sub.resource() as R);
        } catch (error) {
          if (error instanceof SubsystemUnavailableError) {
            return phaseEnvelope(id, error.phase);
          }
          throw error;
        }
      }
      const code = phase === 'initializing' ? 'initializing' : 'offline';
      return phaseEnvelope(id, code);
    },
    async runAsync<R, T>(id: SubsystemId, fn: (resource: R) => Promise<T>): Promise<T | SubsystemErrorEnvelope> {
      const sub = subs.get(id);
      if (sub === undefined) {
        return phaseEnvelope(id, 'offline');
      }
      const phase = sub.status.phase;
      if (phase === 'online' || phase === 'degraded') {
        try {
          return await fn(sub.resource() as R);
        } catch (error) {
          if (error instanceof SubsystemUnavailableError) {
            return phaseEnvelope(id, error.phase);
          }
          throw error;
        }
      }
      const code = phase === 'initializing' ? 'initializing' : 'offline';
      return phaseEnvelope(id, code);
    },
    list() {
      return [...subs.values()].map((s) => s.status);
    },
    status(id) {
      const sub = subs.get(id);
      return sub ? sub.status : null;
    },
  };
}
