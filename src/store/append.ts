import type BetterSqlite3 from 'better-sqlite3';

import { isRecord } from '../infra/json.js';
import type { CauseRef, CauseRefToken } from '../causality/cause-ref.js';
import type { ProviderLookupPort } from '../providers/catalog.js';
import { encodeEventBody } from './body-codec.js';
import {
  journalEventInputSchema,
  type CoralEvent,
  type CoralEventInput,
  type ResolvableCoralEventInput,
} from './envelope.js';
import type { UpcasterRegistry } from './upcaster-registry.js';
import type { ComposedReducers, DomainAppendValidationContext } from './reducers.js';
import { applyReducer } from './reducers.js';

type Database = BetterSqlite3.Database;
const COMMIT_CAUSE_REF_TOKEN: unique symbol = Symbol('CommitCauseRefToken');

type RuntimeCauseRefToken = {
  readonly [COMMIT_CAUSE_REF_TOKEN]: {
    readonly slot: number;
  };
};

export interface AppendContext {
  now(): Date;
  reducers: ComposedReducers;
  upcasters: UpcasterRegistry;
  /**
   * Required. Production composes the port from `providers/catalog.ts`
   * (`providerLookupPortFromCatalog`). Tests that don't exercise provider
   * validation may supply `permissiveProviderLookupPort` from
   * `tests/helpers/append-context.ts` — explicit opt-in, never an
   * implicit default. See AC1.2 / Phase 2 step 0 in the architecture-gap
   * follow-up plan.
   */
  providers: ProviderLookupPort;
}

export interface AppendedEvent extends CoralEvent {
  readonly seq: number;
  readonly ts: string;
}

export type AppendInput = CoralEventInput;
export type CommitClosureResult = undefined;

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> =
  IsAny<T> extends true ? false : unknown extends T ? ([keyof T] extends [never] ? true : false) : false;
type SameTokenScope<Left, Right> = [CauseRefToken<Left>] extends [CauseRefToken<Right>]
  ? [CauseRefToken<Right>] extends [CauseRefToken<Left>]
    ? true
    : false
  : false;
type TokenScanDepth = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type PreviousTokenScanDepth = [0, 0, 1, 2, 3, 4, 5, 6, 7];
type ContainsForeignCauseRefToken<Scope, T, Depth extends TokenScanDepth = 8> = Depth extends 0
  ? false
  : IsAny<T> extends true
    ? false
    : T extends CauseRefToken<infer TokenScope>
      ? SameTokenScope<Scope, TokenScope> extends true
        ? false
        : true
      : IsUnknown<T> extends true
        ? false
        : T extends readonly (infer Item)[]
          ? ContainsForeignCauseRefToken<Scope, Item, PreviousTokenScanDepth[Depth]>
          : T extends object
            ? true extends {
                [K in keyof T]-?: ContainsForeignCauseRefToken<Scope, T[K], PreviousTokenScanDepth[Depth]>;
              }[keyof T]
              ? true
              : false
            : false;
type CommitAppendInputGuard<Scope, Body> =
  IsUnknown<Body> extends true
    ? { readonly body: never }
    : ContainsForeignCauseRefToken<Scope, Body> extends true
      ? { readonly body: never }
      : unknown;
export type CommitAppendInput<Scope, Body> = ResolvableCoralEventInput<Scope, Body> &
  CommitAppendInputGuard<Scope, Body>;

export interface CommitContext<Scope> {
  append<const Body>(input: CommitAppendInput<Scope, Body>): CauseRefToken<Scope>;
}
export type CommitEventsFn = (
  cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult,
) => readonly AppendedEvent[] | void;

function toTimestamp(value: Date): string {
  return value.toISOString();
}

function makeCauseRefToken<Scope>(slot: number): CauseRefToken<Scope> {
  return {
    [COMMIT_CAUSE_REF_TOKEN]: { slot },
  } as unknown as CauseRefToken<Scope>;
}

function isCauseRefToken(value: unknown): value is CauseRefToken<unknown> & RuntimeCauseRefToken {
  return typeof value === 'object' && value !== null && COMMIT_CAUSE_REF_TOKEN in value;
}

function causeRefTokenSlot(token: CauseRefToken<unknown> & RuntimeCauseRefToken): number {
  return token[COMMIT_CAUSE_REF_TOKEN].slot;
}

// `seq` is coordinator-reserved here by `MAX(seq)+1..N` and inserted explicitly
// (see commit() below). The schema deliberately omits AUTOINCREMENT — relying
// on SQLite's `sqlite_sequence` bookkeeping would create a competing source of
// truth that the explicit-INSERT path bypasses. BEGIN IMMEDIATE ensures only
// one writer reserves at a time, so MAX(seq) is consistent for the closure.
function readCurrentMaxSeq(db: Database): number {
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
}

function tokenPath(path: readonly string[]): string {
  return path.join('.');
}

function resolveToken(
  token: CauseRefToken<unknown> & RuntimeCauseRefToken,
  ownerSlot: number,
  reservedSeqs: readonly number[],
  collectedInputs: readonly ResolvableCoralEventInput<unknown, unknown>[],
): CauseRef {
  const tokenSlot = causeRefTokenSlot(token);
  if (tokenSlot >= ownerSlot) {
    throw new Error(`CauseRefToken at slot ${tokenSlot} cannot be referenced by owner slot ${ownerSlot}.`);
  }

  const source = collectedInputs[tokenSlot];
  const seq = reservedSeqs[tokenSlot];
  if (!source || seq === undefined) {
    throw new Error(`CauseRefToken references unknown commit slot ${tokenSlot}.`);
  }

  return {
    stream: source.stream,
    seq,
  };
}

function resolveDirectCauseRef(
  body: unknown,
  ownerSlot: number,
  reservedSeqs: readonly number[],
  collectedInputs: readonly ResolvableCoralEventInput<unknown, unknown>[],
): unknown {
  if (!isRecord(body) || !isCauseRefToken(body.causeRef)) {
    return body;
  }

  return {
    ...body,
    causeRef: resolveToken(body.causeRef, ownerSlot, reservedSeqs, collectedInputs),
  };
}

function resolveJobTerminalCauseRef(
  body: unknown,
  ownerSlot: number,
  reservedSeqs: readonly number[],
  collectedInputs: readonly ResolvableCoralEventInput<unknown, unknown>[],
): unknown {
  if (!isRecord(body) || !isRecord(body.terminal) || !isRecord(body.terminal.outcome)) {
    return body;
  }

  const outcome = body.terminal.outcome;
  if (outcome.kind !== 'failed' || !isCauseRefToken(outcome.causeRef)) {
    return body;
  }

  return {
    ...body,
    terminal: {
      ...body.terminal,
      outcome: {
        ...outcome,
        causeRef: resolveToken(outcome.causeRef, ownerSlot, reservedSeqs, collectedInputs),
      },
    },
  };
}

function rejectResidualTokens(value: unknown, path: readonly string[] = ['body'], seen = new WeakSet<object>()): void {
  if (isCauseRefToken(value)) {
    throw new Error(
      `CauseRefToken is not allowed at ${tokenPath(path)}. Tokens may appear only at: ` +
        'workflow.completed:body.causeRef, ' +
        'job.terminal.recorded:body.terminal.outcome.causeRef. ' +
        'Move the token to a pinned path or pass a resolved CauseRef instead.',
    );
  }

  if (typeof value !== 'object' || value === null) {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectResidualTokens(entry, [...path, String(index)], seen));
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    rejectResidualTokens(entry, [...path, key], seen);
  }
}

function resolveTokensInInput(
  input: ResolvableCoralEventInput<unknown, unknown>,
  ownerSlot: number,
  reservedSeqs: readonly number[],
  collectedInputs: readonly ResolvableCoralEventInput<unknown, unknown>[],
): CoralEventInput {
  let body = input.body;
  if (input.type === 'workflow.completed') {
    body = resolveDirectCauseRef(body, ownerSlot, reservedSeqs, collectedInputs);
  } else if (input.type === 'job.terminal.recorded') {
    body = resolveJobTerminalCauseRef(body, ownerSlot, reservedSeqs, collectedInputs);
  }

  rejectResidualTokens(body);

  return {
    ...input,
    body,
  };
}

function prepareInput(
  input: CoralEventInput,
  ctx: AppendContext,
): {
  input: AppendInput;
  parsedBody: unknown;
  bodyBytes: Buffer;
} {
  const parsedInput = journalEventInputSchema.parse(input) as AppendInput;
  const schema = ctx.reducers.schemas.get(parsedInput.type);
  const parsedBody = schema
    ? ctx.upcasters.parseBody(parsedInput.type, parsedInput.bodyVersion, parsedInput.body, schema)
    : parsedInput.body;
  // Persist RAW input bytes (not parsedBody): old events are never rewritten;
  // only the in-memory interpretation evolves. Upcasters run on READ
  // (rebuild/read paths) against the stored body_version. Storing parsedBody
  // here would double-upcast on later rebuild.
  const bodyBytes = encodeEventBody(parsedInput.body);

  return { input: parsedInput, parsedBody, bodyBytes };
}

export function commit(
  db: Database,
  cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult,
  ctx: AppendContext,
): AppendedEvent[] {
  const txn = db.transaction((): AppendedEvent[] => {
    const collectedInputs: Array<ResolvableCoralEventInput<unknown, unknown>> = [];
    const c: CommitContext<unknown> = {
      append(input) {
        const slot = collectedInputs.length;
        const token = makeCauseRefToken<unknown>(slot);
        collectedInputs.push(input);
        return token;
      },
    };

    cb(c);
    if (collectedInputs.length === 0) return [];

    const baseSeq = readCurrentMaxSeq(db);
    const reservedSeqs = collectedInputs.map((_, slot) => baseSeq + slot + 1);
    const ts = toTimestamp(ctx.now());
    const resolvedInputs = collectedInputs.map((input, slot) =>
      resolveTokensInInput(input, slot, reservedSeqs, collectedInputs),
    );
    const prepared = resolvedInputs.map((input) => prepareInput(input, ctx));
    const validationInputs: AppendInput[] = prepared.map(({ input, parsedBody }) => ({
      ...input,
      body: parsedBody,
    }));
    const validationCtx: DomainAppendValidationContext = {
      db,
      providers: ctx.providers,
    };

    for (const validateAppend of ctx.reducers.appendValidators) {
      validateAppend(validationCtx, validationInputs);
    }

    const insertStmt = db.prepare<
      [
        number,
        string,
        string,
        CoralEvent['stream']['kind'],
        string,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
        number,
        Buffer,
      ],
      { seq: number }
    >(
      `INSERT INTO events (seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body_version, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING seq`,
    );

    const assigned: AppendedEvent[] = [];
    for (const [slot, item] of prepared.entries()) {
      const { input, parsedBody, bodyBytes } = item;
      const seq = reservedSeqs[slot];
      if (seq === undefined) {
        throw new Error(`commit: missing reserved seq for slot ${slot}`);
      }
      const eventTs = input.tsOverride ?? ts;
      const row = insertStmt.get(
        seq,
        eventTs,
        input.type,
        input.stream.kind,
        input.stream.id,
        input.namespace ?? null,
        input.project ?? null,
        input.correlationId ?? null,
        input.causationSeq ?? null,
        input.refs ? JSON.stringify(input.refs) : null,
        input.bodyVersion,
        bodyBytes,
      );

      if (!row || row.seq !== seq) {
        throw new Error(`commit: INSERT did not return reserved seq ${seq} for type '${input.type}'`);
      }

      const event: AppendedEvent = {
        seq,
        ts: eventTs,
        type: input.type,
        stream: input.stream,
        namespace: input.namespace,
        project: input.project,
        correlationId: input.correlationId,
        causationSeq: input.causationSeq,
        refs: input.refs,
        bodyVersion: input.bodyVersion,
        body: parsedBody,
      };

      applyReducer(db, event, ctx.reducers);
      assigned.push(event);
    }

    return assigned;
  });

  return txn.immediate();
}
