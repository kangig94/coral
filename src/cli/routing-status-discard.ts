import type { Runtime } from '../runtime/ports.js';
import {
  readHandoffRoutingStatus,
  type HandoffRoutingStatusReadResult,
} from '../coordinator/handoff-routing-status.js';
import { quarantineHandoffRoutingStoreArtifact } from '../store/handoff-routing-status-store.js';

type DiscardableRoutingStatus = Extract<
  HandoffRoutingStatusReadResult,
  { readonly kind: 'unreadable' | 'unsupported-generation' }
>;

type RefusedRoutingStatus = Exclude<HandoffRoutingStatusReadResult, DiscardableRoutingStatus>;

export type HandoffRoutingStatusDiscardResult =
  | Readonly<{
      kind: 'discarded';
      artifactPath: string;
      quarantinePath: string;
      previousStatus: DiscardableRoutingStatus;
    }>
  | Readonly<{ kind: 'refused'; status: RefusedRoutingStatus }>;

export function discardHandoffRoutingStatus(
  runtime: Pick<Runtime, 'ids' | 'storage'>,
  path: string,
): HandoffRoutingStatusDiscardResult {
  const status = readHandoffRoutingStatus(runtime, path);
  if (status.kind !== 'unreadable' && status.kind !== 'unsupported-generation') {
    return { kind: 'refused', status };
  }
  return {
    kind: 'discarded',
    artifactPath: path,
    quarantinePath: quarantineHandoffRoutingStoreArtifact(runtime.storage, path, runtime.ids.uuid()),
    previousStatus: status,
  };
}
