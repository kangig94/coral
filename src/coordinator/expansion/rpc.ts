/**
 * Coordinator-side wiring for the expansion RPC port.
 *
 * Schemas, types, and the `ExpansionRequestPort` interface live in the
 * domain contract at `src/expansion/rpc-contract.ts`; transport, CLI, and
 * tests import directly from there. This file holds only the bindings
 * that wrap `ExpansionLifecycleService`.
 */
import { documentedCoralSetupError } from '../../runtime/errors.js';
import {
  type EquipExpansionRequest,
  type EquipExpansionResult,
  type ExpansionRequestPort,
  type ExpansionView,
  type ListExpansionRequest,
  type ListExpansionResult,
  type ReadBindingRequest,
  type ReadBindingResult,
  type UnequipExpansionRequest,
  type UnequipExpansionResult,
} from '../../expansion/rpc-contract.js';
import type { ExpansionLifecycleService } from './lifecycle.js';

function toExpansionView(view: ReturnType<ExpansionLifecycleService['info']>): ExpansionView {
  return {
    name: view.id,
    tier: view.tier,
    status: view.status === 'active' ? 'equipped' : view.status,
    ...(view.lastError === undefined ? {} : { lastError: view.lastError }),
    ...(view.provides === undefined ? {} : { provides: view.provides }),
    ...(view.capabilityStatus === undefined ? {} : { capabilityStatus: view.capabilityStatus }),
  };
}

export function createExpansionRpc(lifecycleService: ExpansionLifecycleService): ExpansionRequestPort {
  return {
    equipExpansion: async (request: EquipExpansionRequest): Promise<EquipExpansionResult> => {
      if (lifecycleService.isActive(request.name)) {
        return {
          status: 'already_equipped',
          expansion: toExpansionView(lifecycleService.info(request.name)),
        };
      }

      await lifecycleService.equip(request.name);
      return {
        status: 'equipped',
        expansion: toExpansionView(lifecycleService.info(request.name)),
      };
    },
    unequipExpansion: async (request: UnequipExpansionRequest): Promise<UnequipExpansionResult> => {
      if (!lifecycleService.has(request.name)) {
        return { status: 'not_equipped' };
      }

      await lifecycleService.unequip(request.name);
      return { status: 'uninstalled' };
    },
    listExpansion: async (_request: ListExpansionRequest): Promise<ListExpansionResult> => ({
      expansions: lifecycleService.list().map(toExpansionView),
    }),
    readBinding: async (request: ReadBindingRequest): Promise<ReadBindingResult> =>
      lifecycleService.readBinding(request.binding),
  };
}

export function createUnavailableExpansionRpc(): ExpansionRequestPort {
  return {
    equipExpansion: async (request: EquipExpansionRequest): Promise<EquipExpansionResult> => {
      throw documentedCoralSetupError('expansion_runtime_unavailable', { name: request.name });
    },
    unequipExpansion: async (_request: UnequipExpansionRequest): Promise<UnequipExpansionResult> => ({
      status: 'not_equipped',
    }),
    listExpansion: async (_request: ListExpansionRequest): Promise<ListExpansionResult> => ({ expansions: [] }),
    readBinding: async (_request: ReadBindingRequest): Promise<ReadBindingResult> => ({ bound: false }),
  };
}
