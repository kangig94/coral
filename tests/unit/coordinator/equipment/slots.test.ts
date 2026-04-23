import { describe, expect, it } from 'vitest';

import type { ConsumerHandle } from '#src/coordinator/consumer-driver.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { createEquipmentSlot, createSlotRegistry } from '#src/coordinator/equipment/slots.js';

type SlotOwner = { backendKind: 'needle' | 'orama' };

function createHandle(id: string): ConsumerHandle {
  return {
    id,
    registrationKind: 'equipment',
    lastApplyError: null,
    async stop() {},
    async unregister() {},
    status() {
      return {
        authority: 'corpus',
        corpusInterest: 'content',
        snapshotId: null,
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: null,
        metadataManifestHash: null,
        pending: false,
        lastApplyError: null,
      };
    },
  };
}

describe('slot registry', () => {
  it('supports declare -> get -> equip -> unequip round-trip', () => {
    const registry = createSlotRegistry();
    const defaultOwner: SlotOwner = { backendKind: 'orama' };
    const equippedOwner: SlotOwner = { backendKind: 'needle' };
    const handle = createHandle('needle-handle');
    const slot = createEquipmentSlot<SlotOwner>({
      id: 'kb.vector',
      defaultOwner: () => defaultOwner,
    });

    registry.declare(slot);

    const resolved = registry.get<SlotOwner>('kb.vector');
    expect(resolved.currentOwner()).toBe(defaultOwner);
    expect(registry.list()).toEqual([
      {
        id: 'kb.vector',
        equipped: false,
        handle: null,
      },
    ]);

    resolved.equip(equippedOwner, handle);

    expect(resolved.currentOwner()).toBe(equippedOwner);
    expect(registry.list()).toEqual([
      {
        id: 'kb.vector',
        equipped: true,
        handle,
      },
    ]);

    expect(resolved.unequip()).toBe(handle);
    expect(resolved.currentOwner()).toBe(defaultOwner);
    expect(registry.list()).toEqual([
      {
        id: 'kb.vector',
        equipped: false,
        handle: null,
      },
    ]);
  });

  it('rejects double-equip for the same slot', () => {
    const slot = createEquipmentSlot<SlotOwner>({
      id: 'kb.vector',
      defaultOwner: () => ({ backendKind: 'orama' }),
    });

    slot.equip({ backendKind: 'needle' }, createHandle('needle-handle-1'));

    expect(() => {
      slot.equip({ backendKind: 'needle' }, createHandle('needle-handle-2'));
    }).toThrow("Equipment slot 'kb.vector' is already equipped.");
  });

  it("throws CoralSetupError('equipment_slot_not_declared') before declare", () => {
    const registry = createSlotRegistry();

    try {
      registry.get('kb.vector');
      throw new Error('expected get() to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CoralSetupError);
      expect(error).toMatchObject({
        code: 'equipment_slot_not_declared',
      });
    }
  });
});
