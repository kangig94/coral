import type BetterSqlite3 from 'better-sqlite3';

import type { CauseRef, CauseRefToken } from '../causality/cause-ref.js';
import { encodeEventBody } from './body-codec.js';
import {
  journalEventInputSchema,
  type CoralEvent,
  type CoralEventInput,
  type ResolvableCoralEventInput,
  type UpcasterRegistry,
} from './envelope.js';
import type { ComposedReducers } from './reducers.js';
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
}

export interface AppendedEvent extends CoralEvent {
  readonly seq: number;
  readonly ts: string;
}

export type AppendInput = CoralEventInput;
export type CommitClosureResult = undefined;
export interface CommitContext<Scope> {
  append(input: ResolvableCoralEventInput<Scope>): CauseRefToken<Scope>;
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

function readCurrentMaxSeq(db: Database): number {
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenPath(path: readonly string[]): string {
  return path.join('.');
}

function resolveToken(
  token: CauseRefToken<unknown> & RuntimeCauseRefToken,
  ownerSlot: number,
  reservedSeqs: readonly number[],
  collectedInputs: readonly ResolvableCoralEventInput<unknown>[],
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
  collectedInputs: readonly ResolvableCoralEventInput<unknown>[],
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
  collectedInputs: readonly ResolvableCoralEventInput<unknown>[],
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

function resolveSessionClosedCauseRef(
  body: unknown,
  ownerSlot: number,
  reservedSeqs: readonly number[],
  collectedInputs: readonly ResolvableCoralEventInput<unknown>[],
): unknown {
  if (!isRecord(body) || !isRecord(body.reason)) {
    return body;
  }

  const reason = body.reason;
  if (reason.kind !== 'failed' || !isCauseRefToken(reason.causeRef)) {
    return body;
  }

  return {
    ...body,
    reason: {
      ...reason,
      causeRef: resolveToken(reason.causeRef, ownerSlot, reservedSeqs, collectedInputs),
    },
  };
}

function rejectResidualTokens(value: unknown, path: readonly string[] = ['body'], seen = new WeakSet<object>()): void {
  if (isCauseRefToken(value)) {
    throw new Error(`CauseRefToken is not allowed at ${tokenPath(path)}.`);
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
  input: ResolvableCoralEventInput<unknown>,
  ownerSlot: number,
  reservedSeqs: readonly number[],
  collectedInputs: readonly ResolvableCoralEventInput<unknown>[],
): CoralEventInput {
  let body = input.body;
  if (input.type === 'workflow.completed') {
    body = resolveDirectCauseRef(body, ownerSlot, reservedSeqs, collectedInputs);
  } else if (input.type === 'job.terminal.recorded') {
    body = resolveJobTerminalCauseRef(body, ownerSlot, reservedSeqs, collectedInputs);
  } else if (input.type === 'session.closed') {
    body = resolveSessionClosedCauseRef(body, ownerSlot, reservedSeqs, collectedInputs);
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
    const collectedInputs: Array<ResolvableCoralEventInput<unknown>> = [];
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

    for (const validateAppend of ctx.reducers.appendValidators) {
      validateAppend(db, validationInputs);
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
