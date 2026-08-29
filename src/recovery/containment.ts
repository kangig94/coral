import { errorMessage } from '#src/infra/error-format.js';
import { sha256Hex } from '#src/infra/hash.js';

declare const recoverySourceBrand: unique symbol;

export interface RecoverySource<Raw> {
  readonly boundary: string;
  readonly [recoverySourceBrand]: Raw;
}

export type RecoverySubject = {
  key: string;
  revision: { kind: 'fingerprint'; value: string } | { kind: 'until-cleared' };
};

export type RecoveryRevisionValue = null | string | number | bigint | Uint8Array;

export interface RecoveryRevisionField {
  readonly table: string;
  readonly key: string;
  readonly field: string;
  readonly value: RecoveryRevisionValue;
}

export interface RecoveryRevisionDependency {
  readonly source: string;
  readonly subject: RecoverySubject;
}

export interface RecoverySourceDefinition<Raw> {
  readonly boundary: string;
  readonly scanSubject: RecoverySubject;
  readonly retryRevision?: 'exact' | 'same-key-current-fingerprint';
  scan(): readonly Raw[] | Promise<readonly Raw[]>;
  subject(raw: Raw): RecoverySubject;
}

export type RecoveryObligationId = string & {
  readonly __brand: 'RecoveryObligationId';
};

export type RecoverySettlementFact = {
  obligation: RecoveryObligationId;
  outcome: 'done' | 'not-applicable';
  authorityRef?: string;
};

declare const recoveryReceiptBrand: unique symbol;

export interface RecoveryReceipt<T> {
  readonly [recoveryReceiptBrand]: T;
}

export interface RecoveryReceiptValue<T> {
  readonly payload: T;
  readonly subject: RecoverySubject;
}

export interface CompositeRecoverySourceDefinition<T, Raw> {
  readonly boundary: string;
  readonly scanSubject: RecoverySubject;
  scan(receipts: readonly RecoveryReceiptValue<T>[]): readonly Raw[] | Promise<readonly Raw[]>;
  subject(raw: Raw): RecoverySubject;
}

export type RecoveryDisposition =
  | {
      kind: 'advanced';
      outcome: 'settled' | 'subject-absent';
      facts: readonly RecoverySettlementFact[];
      detail: string;
    }
  | { kind: 'quarantine'; detail: string }
  | {
      kind: 'deferred';
      continuation: { kind: string; key: string };
      detail: string;
    }
  | {
      kind: 'deferred';
      authoritativeSource: { kind: 'unchanged-and-still-enumerable' };
      detail: string;
    }
  | { kind: 'fatal'; error: unknown };

export type RecoveryProcessLocalCleanupResult =
  | { readonly kind: 'released' }
  | { readonly kind: 'incomplete'; readonly error: unknown };

/** Declares only boundary-required ownership release; best-effort caller work stays outside the walk. */
export type RecoveryProcessLocalCleanup<Item> =
  | { readonly kind: 'not-required' }
  | {
      readonly kind: 'boundary-required';
      /** Release must be safe to repeat after an unknown process-local outcome. */
      release(item: Item): RecoveryProcessLocalCleanupResult | Promise<RecoveryProcessLocalCleanupResult>;
    };

export type RecoveryFault<Raw, Item> =
  | {
      readonly boundary: string;
      readonly stage: 'scan';
      readonly subject: RecoverySubject;
      readonly error: unknown;
    }
  | {
      readonly boundary: string;
      readonly stage: 'hydrate';
      readonly subject: RecoverySubject;
      readonly raw: Raw;
      readonly error: unknown;
    }
  | {
      readonly boundary: string;
      readonly stage: 'settle';
      readonly subject: RecoverySubject;
      readonly raw: Raw;
      readonly item: Item;
      readonly error: unknown;
    };

export type RecoveryRetry = {
  readonly subject: RecoverySubject;
  readonly owner: string;
  readonly token: string;
};

export interface RecoveryQuarantineRecord {
  readonly boundary: string;
  readonly subject: RecoverySubject;
  readonly state: 'active' | 'retrying' | 'continuation';
  readonly retry?: { readonly owner: string; readonly token: string };
}

export type RecoveryQuarantineWrite = {
  readonly boundary: string;
  readonly subject: RecoverySubject;
  readonly state: 'active' | 'continuation';
  readonly stage: 'scan' | 'hydrate' | 'settle';
  readonly errorMessage: string;
  readonly detail: string;
  readonly continuation?: { readonly kind: string; readonly key: string };
  readonly expectedRetry?: {
    readonly owner: string;
    readonly token: string;
    readonly subject: RecoverySubject;
  };
};

export type RecoveryQuarantineDelete = {
  readonly boundary: string;
  readonly subject: RecoverySubject;
  readonly expectedRetry?: { readonly owner: string; readonly token: string };
};

export interface RecoveryQuarantinePort {
  read(
    boundary: string,
    subjectKey: string,
  ): RecoveryQuarantineRecord | null | Promise<RecoveryQuarantineRecord | null>;
  upsert(write: RecoveryQuarantineWrite): boolean | Promise<boolean>;
  delete(request: RecoveryQuarantineDelete): boolean | Promise<boolean>;
}

export interface RecoveryPolicy<Raw, Item> {
  readonly signal: AbortSignal;
  readonly quarantine: RecoveryQuarantinePort;
  readonly processLocalCleanup: RecoveryProcessLocalCleanup<Item>;
  readonly issueReceipts?: boolean;
  readonly retry?: RecoveryRetry;
  hydrate(raw: Raw): Item | Promise<Item>;
  requiredObligations(item: Item): readonly RecoveryObligationId[];
  settle(item: Item): RecoveryDisposition | Promise<RecoveryDisposition>;
  onFault(fault: RecoveryFault<Raw, Item>): RecoveryDisposition | Promise<RecoveryDisposition>;
}

export interface RecoveryReport<Item> {
  readonly advanced: number;
  readonly quarantined: number;
  readonly deferred: number;
  readonly skipped: number;
  readonly receipts: readonly RecoveryReceipt<Item>[];
}

export interface RecoveryContainmentBoundary {
  each<Raw, Item>(source: RecoverySource<Raw>, policy: RecoveryPolicy<Raw, Item>): Promise<RecoveryReport<Item>>;
}

type RegisteredSource<Raw> = {
  readonly boundary: string;
  readonly scanSubject: RecoverySubject;
  readonly retryRevision: 'exact' | 'same-key-current-fingerprint';
  readonly scan: () => readonly Raw[] | Promise<readonly Raw[]>;
  readonly subject: (raw: Raw) => RecoverySubject;
};

type ScannedSubject<Raw> = {
  readonly raw: Raw;
  readonly subject: RecoverySubject;
};

type HydratedSubject<Raw, Item> = ScannedSubject<Raw> & {
  readonly item: Item;
};

type PhaseResult<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | {
      readonly kind: 'fault';
      readonly disposition: RecoveryDisposition;
      readonly error: unknown;
    };

type MutableReport<Item> = {
  advanced: number;
  quarantined: number;
  deferred: number;
  skipped: number;
  receipts: RecoveryReceipt<Item>[];
};

type DeferredBasis =
  | { readonly kind: 'not-deferred' }
  | {
      readonly kind: 'durable-continuation';
      readonly continuation: { readonly kind: string; readonly key: string };
    }
  | { readonly kind: 'unchanged-authoritative-source' };

const sourceDefinitions = new WeakMap<object, RegisteredSource<unknown>>();
const receiptValues = new WeakMap<object, RecoveryReceiptValue<unknown>>();

/** Hashes the complete raw envelope by stable field coordinate without relying on object key order. */
export function canonicalRecoveryRevision(fields: readonly RecoveryRevisionField[]): RecoverySubject['revision'] {
  return hashRecoveryRevision(fields, []);
}

/** Hashes a composite raw envelope together with every explicitly named nested subject revision. */
export function compositeRecoveryRevision(
  fields: readonly RecoveryRevisionField[],
  dependencies: readonly RecoveryRevisionDependency[],
): RecoverySubject['revision'] {
  return hashRecoveryRevision(fields, dependencies);
}

/** Registers a lazy raw recovery source and returns only its opaque capability. */
export function defineRecoverySource<Raw>(definition: RecoverySourceDefinition<Raw>): RecoverySource<Raw> {
  return registerSource({
    boundary: definition.boundary,
    scanSubject: copySubject(definition.scanSubject),
    retryRevision: definition.retryRevision ?? 'exact',
    scan: definition.scan,
    subject: definition.subject,
  });
}

/** Registers the sole source shape permitted to consume sealed hydration receipts. */
export function defineCompositeRecoverySource<T, Raw>(
  receipts: readonly RecoveryReceipt<T>[],
  definition: CompositeRecoverySourceDefinition<T, Raw>,
): RecoverySource<Raw> {
  const values = Object.freeze(receipts.map(readReceipt));

  return registerSource({
    boundary: definition.boundary,
    scanSubject: copySubject(definition.scanSubject),
    retryRevision: 'exact',
    scan: () => definition.scan(values),
    subject: definition.subject,
  });
}

async function each<Raw, Item>(
  source: RecoverySource<Raw>,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<RecoveryReport<Item>> {
  const definition = readSource(source);
  const report = emptyReport<Item>();
  const scan = await scanPhase(definition, policy);

  if (scan.kind === 'fault') {
    await applyDisposition(report, policy, {
      boundary: definition.boundary,
      disposition: scan.disposition,
      error: scan.error,
      stage: 'scan',
      subject: definition.scanSubject,
      hydrated: null,
      obligations: [],
    });
    return finishReport(report);
  }

  if (policy.retry && scan.value.length === 0) {
    await completeAbsentRetry(report, definition, policy);
    return finishReport(report);
  }

  for (const scanned of scan.value) {
    throwIfAborted(policy.signal);
    if (await quarantineSkips(scanned.subject, definition.boundary, policy)) {
      report.skipped += 1;
      continue;
    }

    const hydration = await hydratePhase(definition.boundary, scanned, policy);
    if (hydration.kind === 'fault') {
      await applyDisposition(report, policy, {
        boundary: definition.boundary,
        disposition: hydration.disposition,
        error: hydration.error,
        stage: 'hydrate',
        subject: scanned.subject,
        hydrated: null,
        obligations: [],
      });
      continue;
    }

    await settleAndReleaseSubject(definition.boundary, hydration.value, report, policy);
  }

  return finishReport(report);
}

async function settleAndReleaseSubject<Raw, Item>(
  boundary: string,
  hydrated: HydratedSubject<Raw, Item>,
  report: MutableReport<Item>,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<void> {
  // Cleanup runs on every path but must not become the reported failure: a settlement fault is the
  // originating cause, and throwing from a `finally` would silently replace it with whatever the
  // release reported. Both abort the walk, so precedence is the only thing at stake — and losing the
  // origin is exactly the diagnostic loss this boundary exists to prevent.
  let settlementFailure: { readonly error: unknown } | null = null;
  try {
    const settlement = await settlePhase(boundary, hydrated, policy);
    await applyDisposition(report, policy, {
      boundary,
      disposition: settlement.disposition,
      error: settlement.error,
      stage: 'settle',
      subject: hydrated.subject,
      hydrated,
      obligations: settlement.obligations,
    });
  } catch (error: unknown) {
    settlementFailure = { error };
  }

  const cleanup = await releaseBoundaryOwnership(policy, hydrated.item);
  if (settlementFailure !== null && cleanup.kind === 'incomplete') {
    throwIfAborted(policy.signal);
    throw new AggregateError(
      [settlementFailure.error, cleanup.error],
      `Recovery settlement failed and process-local cleanup did not complete for ${boundary}:${hydrated.subject.key}`,
    );
  }
  if (settlementFailure !== null) throw settlementFailure.error;
  if (cleanup.kind === 'incomplete') {
    const cleanupContext = `Recovery process-local cleanup did not complete for ${boundary}:${hydrated.subject.key}`;
    if (cleanup.error instanceof Error) {
      cleanup.error.message = `${cleanupContext}: ${cleanup.error.message}`;
      throw cleanup.error;
    }
    throw new Error(cleanupContext, { cause: cleanup.error });
  }
}

async function scanPhase<Raw, Item>(
  definition: RegisteredSource<Raw>,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<PhaseResult<readonly ScannedSubject<Raw>[]>> {
  throwIfAborted(policy.signal);
  let rawItems: readonly Raw[];

  try {
    rawItems = await definition.scan();
  } catch (error) {
    rethrowIfAborted(policy.signal, error);
    const disposition = await policy.onFault({
      boundary: definition.boundary,
      stage: 'scan',
      subject: definition.scanSubject,
      error,
    });
    throwIfAborted(policy.signal);
    return {
      kind: 'fault',
      disposition,
      error,
    };
  }

  throwIfAborted(policy.signal);
  const scanned = rawItems.map((raw) => ({
    raw,
    subject: copySubject(definition.subject(raw)),
  }));
  assertExactRetryScan(definition, scanned, policy.retry);
  return { kind: 'completed', value: scanned };
}

async function hydratePhase<Raw, Item>(
  boundary: string,
  scanned: ScannedSubject<Raw>,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<PhaseResult<HydratedSubject<Raw, Item>>> {
  throwIfAborted(policy.signal);

  try {
    const item = await policy.hydrate(scanned.raw);
    throwIfAborted(policy.signal);
    return {
      kind: 'completed',
      value: {
        ...scanned,
        item,
      },
    };
  } catch (error) {
    rethrowIfAborted(policy.signal, error);
    const disposition = await policy.onFault({
      boundary,
      stage: 'hydrate',
      subject: scanned.subject,
      raw: scanned.raw,
      error,
    });
    throwIfAborted(policy.signal);
    return {
      kind: 'fault',
      disposition,
      error,
    };
  }
}

async function settlePhase<Raw, Item>(
  boundary: string,
  hydrated: HydratedSubject<Raw, Item>,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<{
  readonly disposition: RecoveryDisposition;
  readonly error: unknown;
  readonly obligations: readonly RecoveryObligationId[];
}> {
  throwIfAborted(policy.signal);
  let obligations: readonly RecoveryObligationId[] = [];

  try {
    obligations = policy.requiredObligations(hydrated.item);
    throwIfAborted(policy.signal);
    const disposition = await policy.settle(hydrated.item);
    throwIfAborted(policy.signal);
    return { disposition, error: undefined, obligations };
  } catch (error) {
    rethrowIfAborted(policy.signal, error);
    const disposition = await policy.onFault({
      boundary,
      stage: 'settle',
      subject: hydrated.subject,
      raw: hydrated.raw,
      item: hydrated.item,
      error,
    });
    throwIfAborted(policy.signal);
    return {
      disposition,
      error,
      obligations,
    };
  }
}

async function applyDisposition<Raw, Item>(
  report: MutableReport<Item>,
  policy: RecoveryPolicy<Raw, Item>,
  context: {
    readonly boundary: string;
    readonly disposition: RecoveryDisposition;
    readonly error: unknown;
    readonly stage: 'scan' | 'hydrate' | 'settle';
    readonly subject: RecoverySubject;
    readonly hydrated: HydratedSubject<Raw, Item> | null;
    readonly obligations: readonly RecoveryObligationId[];
  },
): Promise<void> {
  throwIfAborted(policy.signal);
  const { disposition } = context;

  if (disposition.kind === 'fatal') {
    throw disposition.error;
  }

  if (disposition.kind === 'advanced') {
    if (disposition.outcome !== 'settled') {
      throw new Error('Recovery subject-absent is valid only for an authoritative one-shot retry');
    }
    assertSettlementFacts(context.obligations, disposition.facts);
    await deleteCompletedRetry(context.boundary, context.subject, policy);
    report.advanced += 1;
    if (policy.issueReceipts && context.hydrated) {
      report.receipts.push(issueReceipt(context.hydrated.item, context.hydrated.subject));
    }
    return;
  }

  const deferredBasis =
    disposition.kind === 'deferred'
      ? readDeferredBasis(disposition, context.stage, policy.retry)
      : ({ kind: 'not-deferred' } as const);
  if (deferredBasis.kind === 'unchanged-authoritative-source') {
    report.deferred += 1;
    return;
  }

  const expectedRetry: RecoveryQuarantineWrite['expectedRetry'] | undefined = policy.retry
    ? { owner: policy.retry.owner, token: policy.retry.token, subject: policy.retry.subject }
    : undefined;
  const write: RecoveryQuarantineWrite = {
    boundary: context.boundary,
    subject: context.subject,
    state: disposition.kind === 'quarantine' ? 'active' : 'continuation',
    stage: context.stage,
    errorMessage: context.error === undefined ? disposition.detail : errorMessage(context.error),
    detail: disposition.detail,
    ...(deferredBasis.kind === 'durable-continuation' ? { continuation: deferredBasis.continuation } : {}),
    ...(expectedRetry ? { expectedRetry } : {}),
  };
  const persisted = await policy.quarantine.upsert(write);
  throwIfAborted(policy.signal);
  if (!persisted) {
    const record = await policy.quarantine.read(context.boundary, context.subject.key);
    throwIfAborted(policy.signal);
    if (
      policy.retry === undefined &&
      record?.boundary === context.boundary &&
      record.subject.key === context.subject.key &&
      record.state === 'retrying'
    ) {
      report.skipped += 1;
      return;
    }
    throw new Error(`Recovery quarantine write lost authority for ${context.boundary}:${context.subject.key}`);
  }

  if (disposition.kind === 'quarantine') {
    report.quarantined += 1;
  } else {
    report.deferred += 1;
  }
}

function readDeferredBasis(
  disposition: Extract<RecoveryDisposition, { kind: 'deferred' }>,
  stage: 'scan' | 'hydrate' | 'settle',
  retry: RecoveryRetry | undefined,
): Exclude<DeferredBasis, { kind: 'not-deferred' }> {
  const hasContinuation = 'continuation' in disposition;
  const hasAuthoritativeSource = 'authoritativeSource' in disposition;
  if (hasContinuation === hasAuthoritativeSource) {
    throw new Error('Recovery deferred disposition requires exactly one durable basis');
  }

  if (hasContinuation) {
    const continuation = disposition.continuation;
    if (
      typeof continuation !== 'object' ||
      continuation === null ||
      typeof continuation.kind !== 'string' ||
      continuation.kind.length === 0 ||
      typeof continuation.key !== 'string' ||
      continuation.key.length === 0
    ) {
      throw new Error('Recovery deferred continuation requires a non-empty kind and key');
    }
    return { kind: 'durable-continuation', continuation };
  }

  if (
    typeof disposition.authoritativeSource !== 'object' ||
    disposition.authoritativeSource === null ||
    disposition.authoritativeSource.kind !== 'unchanged-and-still-enumerable'
  ) {
    throw new Error('Recovery deferred authoritative source declaration is invalid');
  }
  if (stage === 'scan') {
    throw new Error('Recovery unchanged-source deferral requires successful enumeration');
  }
  if (retry !== undefined) {
    throw new Error('Recovery retry deferral requires a durable continuation');
  }
  return { kind: 'unchanged-authoritative-source' };
}

async function quarantineSkips<Raw, Item>(
  subject: RecoverySubject,
  boundary: string,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<boolean> {
  const record = await policy.quarantine.read(boundary, subject.key);
  throwIfAborted(policy.signal);
  if (!record) {
    if (policy.retry) {
      throw new Error(`Recovery retry no longer owns ${boundary}:${subject.key}`);
    }
    return false;
  }
  if (record.boundary !== boundary || record.subject.key !== subject.key) {
    throw new Error(`Recovery quarantine returned the wrong subject for ${boundary}:${subject.key}`);
  }

  if (policy.retry) {
    assertRetryAuthority(record, boundary, policy.retry);
    return false;
  }

  if (record.state === 'retrying') {
    return true;
  }

  if (record.subject.revision.kind === 'until-cleared' || sameSubject(record.subject, subject)) {
    return true;
  }

  const deleted = await policy.quarantine.delete({
    boundary,
    subject: record.subject,
  });
  throwIfAborted(policy.signal);
  if (!deleted) {
    throw new Error(`Recovery quarantine changed while clearing ${boundary}:${subject.key}`);
  }
  return false;
}

async function completeAbsentRetry<Raw, Item>(
  report: MutableReport<Item>,
  definition: RegisteredSource<Raw>,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<void> {
  const retry = policy.retry;
  if (!retry) {
    throw new Error('Recovery absent completion requires a one-shot retry');
  }
  const record = await policy.quarantine.read(definition.boundary, retry.subject.key);
  throwIfAborted(policy.signal);
  if (!record) {
    throw new Error(`Recovery retry no longer owns ${definition.boundary}:${retry.subject.key}`);
  }
  assertRetryAuthority(record, definition.boundary, retry);

  const disposition = subjectAbsentDisposition();
  if (disposition.outcome !== 'subject-absent') {
    throw new Error('Recovery absence disposition is invalid');
  }
  const deleted = await policy.quarantine.delete({
    boundary: definition.boundary,
    subject: retry.subject,
    expectedRetry: { owner: retry.owner, token: retry.token },
  });
  throwIfAborted(policy.signal);
  if (!deleted) {
    throw new Error(`Recovery retry completion lost authority for ${definition.boundary}:${retry.subject.key}`);
  }
  report.advanced += 1;
}

function subjectAbsentDisposition(): Extract<RecoveryDisposition, { kind: 'advanced' }> {
  return {
    kind: 'advanced',
    outcome: 'subject-absent',
    facts: [],
    detail: 'authoritative source no longer contains the retry subject',
  };
}

async function deleteCompletedRetry<Raw, Item>(
  boundary: string,
  subject: RecoverySubject,
  policy: RecoveryPolicy<Raw, Item>,
): Promise<void> {
  const expectedRetry = retryClaim(subject, policy.retry);
  if (!expectedRetry || !policy.retry) return;

  const deleted = await policy.quarantine.delete({
    boundary,
    subject,
    expectedRetry,
  });
  throwIfAborted(policy.signal);
  if (!deleted) {
    throw new Error(`Recovery retry completion lost authority for ${subject.key}`);
  }
}

function registerSource<Raw>(definition: RegisteredSource<Raw>): RecoverySource<Raw> {
  const handle = Object.freeze({
    boundary: definition.boundary,
  }) as RecoverySource<Raw>;
  sourceDefinitions.set(handle, Object.freeze(definition) as RegisteredSource<unknown>);
  return handle;
}

function readSource<Raw>(source: RecoverySource<Raw>): RegisteredSource<Raw> {
  const definition = sourceDefinitions.get(source as object);
  if (!definition) {
    throw new Error('Recovery source handle is not registered');
  }
  return definition as RegisteredSource<Raw>;
}

function issueReceipt<T>(payload: T, subject: RecoverySubject): RecoveryReceipt<T> {
  const receipt = Object.freeze({}) as RecoveryReceipt<T>;
  receiptValues.set(receipt, Object.freeze({ payload, subject: copySubject(subject) }));
  return receipt;
}

function readReceipt<T>(receipt: RecoveryReceipt<T>): RecoveryReceiptValue<T> {
  const value = receiptValues.get(receipt as object);
  if (!value) {
    throw new Error('Recovery receipt is not boundary-issued');
  }
  return value as RecoveryReceiptValue<T>;
}

function assertSettlementFacts(
  obligations: readonly RecoveryObligationId[],
  facts: readonly RecoverySettlementFact[],
): void {
  const required = new Set<string>();
  for (const obligation of obligations) {
    if (required.has(obligation)) {
      throw new Error(`Duplicate recovery obligation: ${obligation}`);
    }
    required.add(obligation);
  }

  const settled = new Set<string>();
  for (const fact of facts) {
    if (settled.has(fact.obligation)) {
      throw new Error(`Duplicate recovery settlement fact: ${fact.obligation}`);
    }
    if (!required.has(fact.obligation)) {
      throw new Error(`Unexpected recovery settlement fact: ${fact.obligation}`);
    }
    settled.add(fact.obligation);
  }

  for (const obligation of required) {
    if (!settled.has(obligation)) {
      throw new Error(`Missing recovery settlement fact: ${obligation}`);
    }
  }
}

function assertExactRetryScan<Raw>(
  definition: RegisteredSource<Raw>,
  scanned: readonly ScannedSubject<Raw>[],
  retry: RecoveryRetry | undefined,
): void {
  if (!retry) return;
  if (!sameSubject(definition.scanSubject, retry.subject)) {
    throw new Error('Recovery retry source is not scoped to the exact subject');
  }
  const outsideScope = scanned.some(({ subject }) => {
    if (definition.retryRevision === 'exact') return !sameSubject(subject, retry.subject);
    return (
      subject.key !== retry.subject.key ||
      subject.revision.kind !== 'fingerprint' ||
      retry.subject.revision.kind !== 'fingerprint'
    );
  });
  if (scanned.length > 1 || outsideScope) {
    throw new Error('Recovery retry scan returned a subject outside its exact scope');
  }
}

function assertRetryAuthority(record: RecoveryQuarantineRecord, boundary: string, retry: RecoveryRetry): void {
  if (
    record.boundary !== boundary ||
    record.state !== 'retrying' ||
    !sameSubject(record.subject, retry.subject) ||
    record.retry?.owner !== retry.owner ||
    record.retry?.token !== retry.token
  ) {
    throw new Error(`Recovery retry does not own ${boundary}:${retry.subject.key}`);
  }
}

function retryClaim(
  subject: RecoverySubject,
  retry: RecoveryRetry | undefined,
): { readonly owner: string; readonly token: string } | undefined {
  return retry && sameSubject(subject, retry.subject) ? { owner: retry.owner, token: retry.token } : undefined;
}

function sameSubject(left: RecoverySubject, right: RecoverySubject): boolean {
  if (left.key !== right.key || left.revision.kind !== right.revision.kind) {
    return false;
  }
  return (
    left.revision.kind === 'until-cleared' ||
    (right.revision.kind === 'fingerprint' && left.revision.value === right.revision.value)
  );
}

function hashRecoveryRevision(
  fields: readonly RecoveryRevisionField[],
  dependencies: readonly RecoveryRevisionDependency[],
): Extract<RecoverySubject['revision'], { kind: 'fingerprint' }> {
  const orderedFields = [...fields];
  for (const field of orderedFields) {
    assertRevisionLabel(field.table, 'table');
    assertRevisionLabel(field.key, 'key');
    assertRevisionLabel(field.field, 'field');
  }
  orderedFields.sort(compareRevisionFields);
  for (let index = 1; index < orderedFields.length; index += 1) {
    const previous = orderedFields[index - 1];
    const current = orderedFields[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.table === current.table &&
      previous.key === current.key &&
      previous.field === current.field
    ) {
      throw new Error(`Duplicate recovery revision field: ${current.table}:${current.key}:${current.field}`);
    }
  }

  const orderedDependencies = [...dependencies];
  for (const dependency of orderedDependencies) {
    assertRevisionLabel(dependency.source, 'dependency source');
    assertRevisionLabel(dependency.subject.key, 'dependency subject key');
    if (dependency.subject.revision.kind === 'fingerprint') {
      assertRevisionLabel(dependency.subject.revision.value, 'dependency subject revision');
    }
  }
  orderedDependencies.sort(compareRevisionDependencies);
  for (let index = 1; index < orderedDependencies.length; index += 1) {
    const previous = orderedDependencies[index - 1];
    const current = orderedDependencies[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.source === current.source &&
      previous.subject.key === current.subject.key
    ) {
      throw new Error(`Duplicate recovery revision dependency: ${current.source}:${current.subject.key}`);
    }
  }

  const frames: Uint8Array[] = [revisionFrame(0, [Buffer.from('coral.recovery-revision.v1', 'utf8')])];
  for (const field of orderedFields) {
    const [valueKind, valueBytes] = revisionValueBytes(field.value);
    frames.push(
      revisionFrame(1, [
        Buffer.from(field.table, 'utf8'),
        Buffer.from(field.key, 'utf8'),
        Buffer.from(field.field, 'utf8'),
        valueKind,
        valueBytes,
      ]),
    );
  }
  for (const dependency of orderedDependencies) {
    const revision = dependency.subject.revision;
    frames.push(
      revisionFrame(2, [
        Buffer.from(dependency.source, 'utf8'),
        Buffer.from(dependency.subject.key, 'utf8'),
        Buffer.from(revision.kind, 'utf8'),
        Buffer.from(revision.kind === 'fingerprint' ? revision.value : '', 'utf8'),
      ]),
    );
  }

  return {
    kind: 'fingerprint',
    value: `sha256:${sha256Hex(Buffer.concat(frames))}`,
  };
}

function compareRevisionFields(left: RecoveryRevisionField, right: RecoveryRevisionField): number {
  return (
    compareRevisionText(left.table, right.table) ||
    compareRevisionText(left.key, right.key) ||
    compareRevisionText(left.field, right.field)
  );
}

function compareRevisionDependencies(left: RecoveryRevisionDependency, right: RecoveryRevisionDependency): number {
  return compareRevisionText(left.source, right.source) || compareRevisionText(left.subject.key, right.subject.key);
}

function compareRevisionText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function assertRevisionLabel(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Recovery revision ${name} must be a non-empty string`);
  }
}

function revisionValueBytes(value: RecoveryRevisionValue): readonly [kind: Uint8Array, bytes: Uint8Array] {
  if (value === null) {
    return [Uint8Array.of(0), new Uint8Array()];
  }
  if (typeof value === 'string') {
    return [Uint8Array.of(1), Buffer.from(value, 'utf8')];
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Recovery revision number must be finite');
    }
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return [Uint8Array.of(2), bytes];
  }
  if (typeof value === 'bigint') {
    return [Uint8Array.of(3), Buffer.from(value.toString(10), 'utf8')];
  }
  if (value instanceof Uint8Array) {
    return [Uint8Array.of(4), value];
  }
  throw new Error('Recovery revision value must be null, text, number, bigint, or bytes');
}

function revisionFrame(kind: number, parts: readonly Uint8Array[]): Buffer {
  const chunks: Uint8Array[] = [Uint8Array.of(kind)];
  for (const part of parts) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.byteLength));
    chunks.push(length, part);
  }
  return Buffer.concat(chunks);
}

function copySubject(subject: RecoverySubject): RecoverySubject {
  return Object.freeze({
    key: subject.key,
    revision:
      subject.revision.kind === 'fingerprint'
        ? Object.freeze({
            kind: 'fingerprint' as const,
            value: subject.revision.value,
          })
        : Object.freeze({ kind: 'until-cleared' as const }),
  });
}

/**
 * Normalizes boundary-required ownership release so the walk sees one result shape: a throwing
 * `release`, an `incomplete` result, and an unrecognized result are all incomplete releases.
 */
async function releaseBoundaryOwnership<Raw, Item>(
  policy: RecoveryPolicy<Raw, Item>,
  item: Item,
): Promise<RecoveryProcessLocalCleanupResult> {
  if (policy.processLocalCleanup.kind === 'not-required') return { kind: 'released' };

  try {
    const result = await policy.processLocalCleanup.release(item);
    if (result.kind === 'released' || result.kind === 'incomplete') return result;
    return { kind: 'incomplete', error: new Error('Recovery process-local cleanup returned an invalid result') };
  } catch (error: unknown) {
    return { kind: 'incomplete', error };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error;
}

function emptyReport<Item>(): MutableReport<Item> {
  return {
    advanced: 0,
    quarantined: 0,
    deferred: 0,
    skipped: 0,
    receipts: [],
  };
}

function finishReport<Item>(report: MutableReport<Item>): RecoveryReport<Item> {
  return Object.freeze({
    advanced: report.advanced,
    quarantined: report.quarantined,
    deferred: report.deferred,
    skipped: report.skipped,
    receipts: Object.freeze([...report.receipts]),
  });
}

export const RecoveryContainment: RecoveryContainmentBoundary = Object.freeze({
  each,
});
