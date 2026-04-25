import type {
  ListEquipmentRequest,
  ListEquipmentResult,
  RegisterEquipmentRequest,
  RegisterEquipmentResult,
  UnregisterEquipmentRequest,
  UnregisterResult,
} from '../../expansion/equipment-contract.js';
import type { EquipmentLifecycleService } from './lifecycle.js';
import type { EquipmentRequestPort } from '../../transport/rpc/ports.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';

/** Wraps lifecycle mutations with the per-slot guard so equipment RPC stays serialized by slot. */
export function createEquipmentRpc(lifecycleService: EquipmentLifecycleService): EquipmentRequestPort {
  return {
    registerEquipment: async (request) => {
      const release = await lifecycleService.acquireSlotGuard(request.name);
      try {
        return await lifecycleService.equip(request.name);
      } finally {
        release();
      }
    },
    unregisterEquipment: async (request) => {
      const release = await lifecycleService.acquireSlotGuard(request.name);
      try {
        return await lifecycleService.uninstall(request.name);
      } finally {
        release();
      }
    },
    listEquipment: async (_request) => ({
      equipment: await lifecycleService.listEquipment(),
    }),
  };
}

/** Exposes a stable unavailable surface when the coordinator boots without equipment wiring. */
export function createUnavailableEquipmentRpc(): EquipmentRequestPort {
  return {
    registerEquipment: async (request: RegisterEquipmentRequest): Promise<RegisterEquipmentResult> => {
      throw documentedCoralSetupError('equipment_runtime_unavailable', { name: request.name });
    },
    unregisterEquipment: async (_request: UnregisterEquipmentRequest): Promise<UnregisterResult> => ({
      status: 'not_equipped',
    }),
    listEquipment: async (_request: ListEquipmentRequest): Promise<ListEquipmentResult> => ({
      equipment: [],
    }),
  };
}
