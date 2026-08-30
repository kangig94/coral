import {
  formatHandoffPublicationFailureSuccessor,
  formatHandoffPublicationIncident,
} from '#src/cli/format/handoff-publication.js';
import type { HandoffRoutingResolveResult } from '#src/coordinator/handoff-routing/status.js';

formatHandoffPublicationFailureSuccessor({
  kind: 'incident',
  incident: {
    phase: 'selection',
    invocationId: '123e4567-e89b-42d3-a456-426614174000',
    kind: 'not-published',
    cause: 'contended',
  },
});

formatHandoffPublicationFailureSuccessor({
  kind: 'resolution',
  invocationId: '123e4567-e89b-42d3-a456-426614174000',
  outcome: { kind: 'not-published', cause: 'contended' },
});

// @ts-expect-error a publication failure must identify either its incident or resolution context.
formatHandoffPublicationFailureSuccessor({ kind: 'not-published', cause: 'contended' });

// @ts-expect-error every publication incident must carry its exact invocation ID.
formatHandoffPublicationIncident({ phase: 'selection', kind: 'not-published', cause: 'contended' });

// @ts-expect-error a terminal incident must identify the terminal disposition it was recording.
formatHandoffPublicationIncident({
  phase: 'terminal',
  invocationId: '123e4567-e89b-42d3-a456-426614174000',
  kind: 'not-published',
  cause: 'contended',
});

declare const nestedResolveFailure: {
  kind: 'not-published';
  invocationId: string;
  outcome: { kind: 'not-published'; cause: 'contended' };
};

// @ts-expect-error resolve publication failures use their publication discriminator directly.
const flattenedResolveFailure: HandoffRoutingResolveResult = nestedResolveFailure;

void flattenedResolveFailure;
