import { describe, expect, it } from 'vitest';
import { disabledKbSubsystem } from '#src/coordinator/subsystems/kb.js';
import { SubsystemUnavailableError } from '#src/coordinator/subsystems/contract.js';
import { KB_DISABLED_REASON } from '#src/infra/kb-toggle.js';

describe('disabledKbSubsystem', () => {
  it('reports a terminal offline status carrying the shared disabled reason', () => {
    const sub = disabledKbSubsystem();
    expect(sub.id).toBe('kb');
    expect(sub.status).toEqual({ id: 'kb', phase: 'offline', reason: KB_DISABLED_REASON });
  });

  it('throws SubsystemUnavailableError when its resource is accessed (KB never comes online)', () => {
    const sub = disabledKbSubsystem();
    expect(() => sub.resource()).toThrow(SubsystemUnavailableError);
  });

  it('has no-op init and dispose so boot and shutdown stay clean', async () => {
    const sub = disabledKbSubsystem();
    await expect(sub.init(new AbortController().signal)).resolves.toBeUndefined();
    await expect(sub.dispose(new AbortController().signal)).resolves.toBeUndefined();
  });
});
