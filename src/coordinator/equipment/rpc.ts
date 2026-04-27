import type {
  EquipExpansionRequest,
  EquipExpansionResult,
  ListExpansionRequest,
  ListExpansionResult,
  ExpansionView,
  ReadBindingRequest,
  ReadBindingResult,
  UnequipExpansionRequest,
  UnequipExpansionResult,
} from '../expansion/rpc.js';
import type { EquipmentLifecycleService } from './lifecycle.js';
import type { ExpansionRequestPort } from '../../transport/rpc/ports.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';

function toExpansionView(view: { name: string; status: ExpansionView['status'] }): ExpansionView {
  return {
    name: view.name,
    status: view.status,
  };
}

/** Wraps lifecycle mutations with the per-slot guard so equipment RPC stays serialized by slot. */
export function createExpansionRpc(lifecycleService: EquipmentLifecycleService): ExpansionRequestPort {
  return {
    equipExpansion: async (request) => {
      const release = await lifecycleService.acquireSlotGuard(request.name);
      try {
        const result = await lifecycleService.equip(request.name);
        return 'equipment' in result ? { ...result, equipment: toExpansionView(result.equipment) } : result;
      } finally {
        release();
      }
    },
    unequipExpansion: async (request) => {
      const release = await lifecycleService.acquireSlotGuard(request.name);
      try {
        return await lifecycleService.uninstall(request.name);
      } finally {
        release();
      }
    },
    listExpansion: async (_request) => ({
      equipment: (await lifecycleService.listEquipment()).map(toExpansionView),
    }),
    readBinding: async (_request) => ({ bound: false }),
  };
}

/** Exposes a stable unavailable surface when the coordinator boots without equipment wiring. */
export function createUnavailableExpansionRpc(): ExpansionRequestPort {
  return {
    equipExpansion: async (request: EquipExpansionRequest): Promise<EquipExpansionResult> => {
      throw documentedCoralSetupError('equipment_runtime_unavailable', { name: request.name });
    },
    unequipExpansion: async (_request: UnequipExpansionRequest): Promise<UnequipExpansionResult> => ({
      status: 'not_equipped',
    }),
    listExpansion: async (_request: ListExpansionRequest): Promise<ListExpansionResult> => ({
      equipment: [],
    }),
    readBinding: async (_request: ReadBindingRequest): Promise<ReadBindingResult> => ({
      bound: false,
    }),
  };
}
