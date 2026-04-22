import { describe, expect, it, vi } from 'vitest';

import { createEquipmentRpc } from '../rpc.js';
import type { EquipmentLifecycleService } from '../lifecycle.js';

describe('createEquipmentRpc', () => {
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

    const rpc = createEquipmentRpc(lifecycle);

    await expect(rpc.registerEquipment({ name: 'needle' })).resolves.toEqual({
      status: 'catching_up',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'catching_up',
      },
    });
    await expect(rpc.unregisterEquipment({ name: 'needle' })).resolves.toEqual({ status: 'uninstalled' });
    await expect(rpc.listEquipment({})).resolves.toEqual({
      equipment: [{ slot: 'kb.vector', name: 'needle', status: 'inactive' }],
    });

    expect(lifecycle.acquireSlotGuard).toHaveBeenCalledTimes(2);
    expect(lifecycle.equip).toHaveBeenCalledWith('needle');
    expect(lifecycle.uninstall).toHaveBeenCalledWith('needle');
    expect(lifecycle.listEquipment).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
