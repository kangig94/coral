import { join } from 'node:path';

import { SUCCESSION_METHODS } from '../../infra/succession-address.js';
import {
  readSuccessionCapabilities,
  successionTargetKey,
  successionAbortSchema,
  successionCommitSchema,
  successionPrepareSchema,
  successionRequestSchema,
  successionStatusSchema,
} from './protocol.js';
import {
  createSuccessionReconciler,
  type SuccessionReconciler,
  type SuccessionReconcilerOptions,
} from './reconciler/index.js';

export function createSuccessionCoordinator(options: SuccessionReconcilerOptions): Readonly<{
  dispatch: (method: string, params: unknown) => Promise<unknown>;
  reconciler: SuccessionReconciler;
}> {
  const reconciler = createSuccessionReconciler(options);

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case SUCCESSION_METHODS.request: {
        const parsed = successionRequestSchema.safeParse(params);
        if (!parsed.success) return { kind: 'refused', reason: 'invalid succession request' };
        const decision = await reconciler.request(parsed.data);
        const queued =
          decision.kind === 'registered' &&
          decision.intent.nextTarget !== null &&
          decision.intent.nextTarget !== undefined &&
          successionTargetKey(decision.intent.nextTarget.target) === successionTargetKey(parsed.data.target);
        const targetCapabilities =
          decision.kind === 'registered'
            ? readSuccessionCapabilities(
                options.runtime,
                join(parsed.data.target.pluginRootLabel, 'bridge'),
                parsed.data.target.build,
              )
            : null;
        return decision.kind === 'registered'
          ? {
              ...decision,
              incumbentCanCommit:
                options.commitAvailable === true &&
                !queued &&
                targetCapabilities?.kind === 'declared' &&
                targetCapabilities.capabilities.protocols.includes('commit'),
            }
          : decision;
      }
      case SUCCESSION_METHODS.prepare: {
        const parsed = successionPrepareSchema.safeParse(params);
        return parsed.success
          ? reconciler.prepare(parsed.data.requestId)
          : { kind: 'refused', reason: 'invalid succession preparation request' };
      }
      case SUCCESSION_METHODS.commit: {
        const parsed = successionCommitSchema.safeParse(params);
        return parsed.success
          ? reconciler.commit(parsed.data.attemptId)
          : { kind: 'refused', reason: 'invalid succession commit request' };
      }
      case SUCCESSION_METHODS.abort: {
        const parsed = successionAbortSchema.safeParse(params);
        return parsed.success
          ? reconciler.abort(parsed.data.attemptId)
          : { kind: 'refused', reason: 'invalid succession abort request' };
      }
      case SUCCESSION_METHODS.status: {
        const parsed = successionStatusSchema.safeParse(params);
        return parsed.success
          ? reconciler.status(parsed.data.requestId)
          : { kind: 'refused', reason: 'invalid succession status request' };
      }
      default:
        return { kind: 'refused', reason: 'unknown succession method' };
    }
  }

  return { dispatch, reconciler };
}
