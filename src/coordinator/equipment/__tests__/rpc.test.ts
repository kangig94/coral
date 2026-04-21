import { describe, expect, it, vi } from 'vitest';

import { createEquipmentRpc } from '../rpc.js';
import type { EquipmentLifecycleService } from '../lifecycle.js';

describe('createEquipmentRpc', () => {
  it('returns already_equipped without delegating to equip when the slot is already active', async () => {
    const release = vi.fn();
    const acquireSlotGuard = vi.fn(async () => release);
    const getEquipment = vi.fn(() => ({
      slot: 'kb.vector',
      name: 'needle',
      status: 'equipped' as const,
    }));
    const equip = vi.fn();
    const lifecycle = {
      acquireSlotGuard,
      getEquipment,
      equip,
      uninstall: vi.fn(),
      listEquipment: vi.fn(),
    } as unknown as EquipmentLifecycleService;

    const rpc = createEquipmentRpc(lifecycle);
    await expect(rpc.registerEquipment({ name: 'needle' })).resolves.toEqual({
      status: 'already_equipped',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'equipped',
      },
    });

    expect(acquireSlotGuard).toHaveBeenCalledWith('needle');
    expect(getEquipment).toHaveBeenCalledWith('needle');
    expect(equip).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('re-activates inactive equipment instead of treating restart-cleared state as already_equipped', async () => {
    const release = vi.fn();
    const lifecycle = {
      acquireSlotGuard: vi.fn(async () => release),
      getEquipment: vi.fn(() => ({
        slot: 'kb.vector',
        name: 'needle',
        status: 'inactive' as const,
      })),
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
