import type {
  ListEquipmentRequest,
  ListEquipmentResult,
  RegisterEquipmentRequest,
  RegisterEquipmentResult,
  UnregisterEquipmentRequest,
  UnregisterResult,
} from './contract.js';
import type { EquipmentLifecycleService } from './lifecycle.js';
import type { EquipmentRequestPort } from '../../transport/rpc-ports.js';
import { CoralSetupError } from '../../runtime/errors.js';

/** Wraps lifecycle mutations with the per-slot guard so equipment RPC stays serialized by slot. */
export function createEquipmentRpc(lifecycleService: EquipmentLifecycleService): EquipmentRequestPort {
  return {
    registerEquipment: async (request) => {
      const release = await lifecycleService.acquireSlotGuard(request.name);
      try {
        const current = lifecycleService.getEquipment(request.name);
        if (current.status === 'equipped' || current.status === 'catching_up') {
          return {
            status: 'already_equipped',
            equipment: current,
          };
        }

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
      throw new CoralSetupError({
        code: 'equipment_runtime_unavailable',
        userMessage: `Equipment activation is unavailable for '${request.name}'.`,
        remediation: 'Start a coordinator with KB equipment wiring before retrying /equip.',
        context: { name: request.name },
      });
    },
    unregisterEquipment: async (_request: UnregisterEquipmentRequest): Promise<UnregisterResult> => ({
      status: 'not_equipped',
    }),
    listEquipment: async (_request: ListEquipmentRequest): Promise<ListEquipmentResult> => ({
      equipment: [],
    }),
  };
}
