import type { Database } from '../../src/store/db.js';

import { commit, type AppendContext, type AppendedEvent } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { jobLaunchRequestBodySchema } from '#src/jobs/launch.js';
import { seedTestSessionProjection } from './session.js';

export type { AppendContext };

export function commitInputs(db: Database, inputs: readonly CoralEventInput[], ctx: AppendContext): AppendedEvent[] {
  const openedInBatch = new Set(
    inputs.filter((input) => input.type === 'session.opened').map((input) => input.stream.id),
  );
  const sessionSnapshotsInBatch = new Set(
    inputs.filter((input) => input.stream.kind === 'session').map((input) => input.stream.id),
  );
  for (const input of inputs) {
    if (input.type !== 'job.launch.requested') continue;
    const launch = jobLaunchRequestBodySchema.parse(input.body);
    if (
      launch.jobKind !== 'provider' ||
      openedInBatch.has(launch.sessionId) ||
      sessionSnapshotsInBatch.has(launch.sessionId)
    )
      continue;
    seedTestSessionProjection(db, {
      sessionId: launch.sessionId,
      provider: launch.provider,
      projectRoot: launch.projectRoot,
      backendNamespace: launch.backendNamespace,
      activeJobId: input.stream.id,
    });
  }
  return commit(
    db,
    (c) => {
      for (const input of inputs) {
        c.append(input as Parameters<typeof c.append>[0]);
      }
      return undefined;
    },
    ctx,
  );
}
