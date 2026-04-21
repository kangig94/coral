import { CoralSetupError } from '../../runtime/errors.js';
import type { ConsumerHandle } from '../consumer-driver.js';

export interface EquipmentSlot<T> {
  readonly id: string;
  readonly defaultOwner: () => T;
  currentOwner(): T;
  equip(owner: T, handle: ConsumerHandle): void;
  unequip(): ConsumerHandle | null;
}

export interface EquipmentSlotView {
  readonly id: string;
  readonly equipped: boolean;
  readonly handle: ConsumerHandle | null;
}

export interface SlotRegistry {
  declare<T>(slot: EquipmentSlot<T>): void;
  get<T>(slotId: string): EquipmentSlot<T>;
  list(): EquipmentSlotView[];
}

type InspectableEquipmentSlot<T> = EquipmentSlot<T> & {
  view(): EquipmentSlotView;
};

class MutableEquipmentSlot<T> implements InspectableEquipmentSlot<T> {
  private owner: T | null = null;
  private handle: ConsumerHandle | null = null;

  constructor(
    readonly id: string,
    readonly defaultOwner: () => T,
  ) {}

  currentOwner(): T {
    return this.owner ?? this.defaultOwner();
  }

  equip(owner: T, handle: ConsumerHandle): void {
    if (this.handle !== null) {
      throw new Error(`Equipment slot '${this.id}' is already equipped.`);
    }

    this.owner = owner;
    this.handle = handle;
  }

  unequip(): ConsumerHandle | null {
    const previousHandle = this.handle;
    this.owner = null;
    this.handle = null;
    return previousHandle;
  }

  view(): EquipmentSlotView {
    return {
      id: this.id,
      equipped: this.handle !== null,
      handle: this.handle,
    };
  }
}

class InMemorySlotRegistry implements SlotRegistry {
  private readonly slots = new Map<string, InspectableEquipmentSlot<unknown>>();

  declare<T>(slot: EquipmentSlot<T>): void {
    if (this.slots.has(slot.id)) {
      throw new Error(`Equipment slot '${slot.id}' is already declared.`);
    }

    this.slots.set(slot.id, slot as InspectableEquipmentSlot<unknown>);
  }

  get<T>(slotId: string): EquipmentSlot<T> {
    const slot = this.slots.get(slotId);
    if (slot === undefined) {
      throw new CoralSetupError({
        code: 'equipment_slot_not_declared',
        userMessage: `Equipment slot '${slotId}' is not declared.`,
        remediation: 'Declare the slot before reading or equipping it.',
        context: { slotId },
      });
    }

    return slot as EquipmentSlot<T>;
  }

  list(): EquipmentSlotView[] {
    return [...this.slots.values()].map((slot) => slot.view());
  }
}

export function createEquipmentSlot<T>(options: {
  id: string;
  defaultOwner: () => T;
}): EquipmentSlot<T> {
  return new MutableEquipmentSlot(options.id, options.defaultOwner);
}

export function createSlotRegistry(): SlotRegistry {
  return new InMemorySlotRegistry();
}
