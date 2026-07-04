// Cause-ref renderer. Causality owns the cross-stream walk + dispatch
// vocabulary; per-event description is injected by the owning domain via an
// `EventDescriberMap`. This file MUST NOT import from any domain
// (`jobs/`, `sessions/`, `workflow/`, `discuss/`) — doing so would create
// a cycle, since those domains import `CauseRef` from this module.

import type { z } from 'zod';

import type { CoralEvent } from '../store/envelope.js';
import { extractCauseRef, type CauseRef } from './cause-ref.js';

export type EventDescriber = (event: CoralEvent) => string;

// Key format: `${stream.kind}:${event.type}` — stable identifier for dispatch.
export type EventDescriberMap = ReadonlyMap<string, EventDescriber>;

/**
 * Schema-typed describer constructor. Mirrors `defineDomainEvent` in the
 * registry: at definition the body type is inferred from `z.output<S>`, so
 * the describer body sees a typed body without `as` casts. The single cast
 * lives here, justified by the same dispatch contract that lets reducers
 * trust their bodies — the journal append/rebuild paths parse each body
 * through the registered schema before the renderer ever sees it.
 *
 * Pass the same schema that the matching `defineDomainEvent` entry uses.
 * The helper type-checks the callback against that schema; the event-type key
 * remains the owning domain's responsibility.
 */
export function typedDescriber<S extends z.ZodTypeAny>(
  _schema: S,
  describe: (body: z.output<S>, event: CoralEvent<z.output<S>>) => string,
): EventDescriber {
  return (event) => describe(event.body as z.output<S>, event as CoralEvent<z.output<S>>);
}

interface CauseRefEventStore {
  getEvent(stream: { kind: string; id: string }, seq: number): CoralEvent | undefined;
}

interface CircularCauseRefDiagnostic {
  readonly key: string;
  readonly stream: CauseRef['stream'];
  readonly seq: number;
  readonly path: readonly string[];
}

interface MissingCauseRefDiagnostic {
  readonly stream: CauseRef['stream'];
  readonly seq: number;
  readonly path: readonly string[];
  readonly hint?: string;
}

interface CauseRefRenderResult {
  readonly description: string;
  readonly chain: readonly string[];
  readonly cycle?: CircularCauseRefDiagnostic;
  readonly missing?: MissingCauseRefDiagnostic;
}

export interface CauseRefRenderer {
  describe(ref: CauseRef, store: CauseRefEventStore, missingLinkHint?: string): string;
  describeDetailed(ref: CauseRef, store: CauseRefEventStore, missingLinkHint?: string): CauseRefRenderResult;
}

export function createCauseRefRenderer(describers: EventDescriberMap): CauseRefRenderer {
  return {
    describe(ref, store, missingLinkHint) {
      return renderCauseRef(ref, store, describers, new Set<string>(), [], missingLinkHint).description;
    },
    describeDetailed(ref, store, missingLinkHint) {
      return renderCauseRef(ref, store, describers, new Set<string>(), [], missingLinkHint);
    },
  };
}

function refKey(ref: CauseRef): string {
  return `${ref.stream.kind}:${ref.stream.id}:${ref.seq}`;
}

function markerForCycle(ref: CauseRef): string {
  return `<cycle detected at ${ref.stream.kind}/${ref.stream.id}/${ref.seq}>`;
}

function markerForMissing(ref: CauseRef): string {
  return `<missing ${ref.stream.kind}/${ref.stream.id}/${ref.seq}>`;
}

function renderCauseRef(
  ref: CauseRef,
  store: CauseRefEventStore,
  describers: EventDescriberMap,
  visited: Set<string>,
  path: string[],
  missingLinkHint?: string,
): CauseRefRenderResult {
  const key = refKey(ref);
  if (visited.has(key)) {
    return {
      description: markerForCycle(ref),
      chain: [...path, markerForCycle(ref)],
      cycle: { key, stream: ref.stream, seq: ref.seq, path },
    };
  }

  visited.add(key);
  const event = store.getEvent(ref.stream, ref.seq);
  if (!event) {
    // Only the chain ROOT carries a missingLinkHint; deeper missing links fall
    // back to the bare marker because their terminal context is lost.
    const description =
      path.length === 0 && missingLinkHint ? `${markerForMissing(ref)} ${missingLinkHint}` : markerForMissing(ref);
    return {
      description,
      chain: [...path, description],
      missing: {
        stream: ref.stream,
        seq: ref.seq,
        path,
        ...(path.length === 0 && missingLinkHint ? { hint: missingLinkHint } : {}),
      },
    };
  }

  const dispatchKey = `${event.stream.kind}:${event.type}`;
  const baseDescription = describers.get(dispatchKey)?.(event) ?? event.type;
  const nextRef = extractCauseRef(event.body);
  if (!nextRef) {
    return { description: baseDescription, chain: [...path, baseDescription] };
  }

  const next = renderCauseRef(nextRef, store, describers, visited, [...path, baseDescription]);
  return {
    description: `${baseDescription} Caused by: ${next.description}`,
    chain: next.chain,
    ...(next.cycle ? { cycle: next.cycle } : {}),
    ...(next.missing ? { missing: next.missing } : {}),
  };
}
