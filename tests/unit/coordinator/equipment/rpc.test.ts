import { describe, expect, it, vi } from 'vitest';

import { createExpansionRpc } from '#src/coordinator/equipment/rpc.js';
import type { EquipmentLifecycleService } from '#src/coordinator/equipment/lifecycle.js';

describe('createExpansionRpc', () => {
  it('re-activates inactive equipment instead of treating restart-cleared state as already_equipped', async () => {
    const release = vi.fn();
    const lifecycle = {
      acquireSlotGuard: vi.fn(async () => release),
      equip: vi.fn(async () => ({
        status: 'catching_up' as const,
        equipment: {
          slot: 'kb.vector',
          name: 'needle',
          status: 'catching_up' as const,
        },
      })),
      uninstall: vi.fn(async () => ({ status: 'uninstalled' as const })),
      listEquipment: vi.fn(async () => [{ slot: 'kb.vector', name: 'needle', status: 'inactive' as const }]),
    } as unknown as EquipmentLifecycleService;

    const rpc = createExpansionRpc(lifecycle);

    await expect(rpc.equipExpansion({ name: 'needle' })).resolves.toEqual({
      status: 'catching_up',
      equipment: {
        name: 'needle',
        status: 'catching_up',
      },
    });
    await expect(rpc.unequipExpansion({ name: 'needle' })).resolves.toEqual({ status: 'uninstalled' });
    await expect(rpc.listExpansion({})).resolves.toEqual({
      equipment: [{ name: 'needle', status: 'inactive' }],
    });
    await expect(rpc.readBinding({ binding: 'kb.vector' })).resolves.toEqual({ bound: false });

    expect(lifecycle.acquireSlotGuard).toHaveBeenCalledTimes(2);
    expect(lifecycle.equip).toHaveBeenCalledWith('needle');
    expect(lifecycle.uninstall).toHaveBeenCalledWith('needle');
    expect(lifecycle.listEquipment).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
