import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { processIncarnationSchema } from '../infra/node-process.js';
import type { Runtime } from '../runtime/ports.js';
import { readEpochKey } from './epoch-key.js';
import { observeStorePath } from './path-observation.js';

const processIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    incarnation: processIncarnationSchema,
    processGroupId: z.number().int().positive(),
  })
  .passthrough();

const custodyIntentSchema = z
  .object({
    version: z.literal('v1'),
    id: z.string().uuid(),
    effect: z.enum(['process-spawn', 'provider-operation-publication']),
    epoch: z.string().min(1),
    epochKey: z.string().min(1).optional(),
    owner: z.string().min(1),
    operationId: z.string().min(1),
    jobId: z.string().min(1).optional(),
    processToken: z.string().uuid(),
    capsule: z.string().nullable(),
    createdAtMs: z.number().int().nonnegative(),
    bindDeadlineMs: z.number().int().nonnegative(),
  })
  .passthrough();

const custodyBindingSchema = z
  .object({
    version: z.literal('v1'),
    intentId: z.string().uuid(),
    processToken: z.string().uuid(),
    operationId: z.string().min(1),
    process: processIdentitySchema.nullable(),
    capsule: z.string().nullable(),
    observedAtMs: z.number().int().nonnegative(),
  })
  .passthrough();

const custodyAbsenceSchema = z
  .object({
    version: z.literal('v1'),
    intentId: z.string().uuid(),
    processToken: z.string().uuid(),
    provenAtMs: z.number().int().nonnegative(),
    evidence: z.string().min(1),
  })
  .passthrough();

export type CustodyIntent = z.infer<typeof custodyIntentSchema>;
export type CustodyBinding = z.infer<typeof custodyBindingSchema>;
export type CustodyProcessIdentity = z.infer<typeof processIdentitySchema>;
export type CustodyChildTicket = Readonly<{ runDir: string; intentId: string; processToken: string }>;

export type CustodyEntry =
  | Readonly<{ kind: 'bound'; intent: CustodyIntent; binding: CustodyBinding }>
  | Readonly<{ kind: 'absent'; intent: CustodyIntent; evidence: string }>
  | Readonly<{ kind: 'holding'; intent: CustodyIntent; exit: 'identity-binding-or-proven-absence'; reason?: string }>
  | Readonly<{ kind: 'unreadable'; path: string; reason: string }>;

export type CustodyObservation =
  | Readonly<{ kind: 'alive' | 'unknown' }>
  | Readonly<{ kind: 'absent'; processToken: string; evidence: string }>;

export function custodyLedgerDir(runDir: string): string {
  return join(runDir, 'custody.v1');
}

const custodyRootSchema = z.object({ version: z.literal('v1'), id: z.string().uuid() }).passthrough();

export function initializeCustodyLedger(runtime: Runtime, runDir: string): string {
  runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  runtime.storage.mkdirSync(custodyLedgerDir(runDir), { recursive: true, mode: 0o700 });
  syncDirectory(runtime, runDir);
  const marker = join(custodyLedgerDir(runDir), 'root.v1.json');
  let root = readRecord(runtime, marker, custodyRootSchema);
  if (root === null) {
    try {
      writeOnce(runtime, marker, { version: 'v1', id: runtime.ids.uuid() });
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    root = readRecord(runtime, marker, custodyRootSchema);
  }
  if (root === null) throw new Error('Custody ledger root marker was not persisted.');
  return root.id;
}

export function readCustodyLedgerId(runtime: Pick<Runtime, 'storage'>, runDir: string): string | null {
  try {
    return readRecord(runtime, join(custodyLedgerDir(runDir), 'root.v1.json'), custodyRootSchema)?.id ?? null;
  } catch {
    return null;
  }
}

function intentDir(runDir: string, id: string): string {
  return join(custodyLedgerDir(runDir), id);
}

function syncDirectory(runtime: Runtime, path: string): void {
  if (!runtime.storage.syncDirectoryDurableSync(path)) throw new Error('Custody directory sync failed.');
}

function writeOnce(runtime: Runtime, path: string, value: unknown): void {
  const parent = dirname(path);
  const stage = `${path}.stage.${runtime.env.pid()}.${runtime.ids.uuid()}`;
  let fd: number | null = null;
  try {
    fd = runtime.storage.openSync(stage, 'wx', 0o600);
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    runtime.storage.writeSync(fd, bytes, 0, bytes.length, null);
    runtime.storage.fdatasyncSync(fd);
    runtime.storage.closeSync(fd);
    fd = null;
    runtime.storage.linkSync(stage, path);
    syncDirectory(runtime, parent);
  } finally {
    if (fd !== null) runtime.storage.closeSync(fd);
    runtime.storage.rmSync(stage, { force: true });
  }
}

function readRecord<T>(runtime: Pick<Runtime, 'storage'>, path: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as unknown);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Intent persistence is the permission boundary for the external effect. */
export function recordCustodyIntent(
  runtime: Runtime,
  runDir: string,
  input: Pick<CustodyIntent, 'effect' | 'epoch' | 'epochKey' | 'owner' | 'operationId' | 'jobId' | 'capsule'> &
    Readonly<{ bindWithinMs: number; nowMs: number }>,
): CustodyIntent {
  if (!Number.isSafeInteger(input.bindWithinMs) || input.bindWithinMs <= 0) {
    throw new RangeError('Custody binding deadline must be positive.');
  }
  if (
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    !Number.isSafeInteger(input.nowMs + input.bindWithinMs)
  ) {
    throw new RangeError('Custody binding deadline is outside the clock range.');
  }
  const { bindWithinMs, nowMs, ...fields } = input;
  const epochNumber = /^epoch-([1-9]\d*)$/.exec(basename(input.epoch))?.[1];
  const observedEpochKey =
    epochNumber === undefined
      ? null
      : readEpochKey(runtime, {
          storeRoot: dirname(input.epoch),
          epoch: epochNumber,
          path: join(input.epoch, 'store.db'),
        });
  if (input.epochKey !== undefined && observedEpochKey !== null && input.epochKey !== observedEpochKey) {
    throw new Error('Custody epoch key does not match its directory lineage.');
  }
  if (
    observedEpochKey === null &&
    observeStorePath(runtime.storage, join(input.epoch, '.coral-custody-coverage.v1.json')) === 'present'
  ) {
    throw new Error('Covered epoch lineage is unreadable before the external effect.');
  }
  const intent = custodyIntentSchema.parse({
    ...fields,
    ...(observedEpochKey === null ? {} : { epochKey: observedEpochKey }),
    version: 'v1',
    id: runtime.ids.uuid(),
    processToken: runtime.ids.uuid(),
    createdAtMs: nowMs,
    bindDeadlineMs: nowMs + bindWithinMs,
  });
  const ledgerDir = custodyLedgerDir(runDir);
  initializeCustodyLedger(runtime, runDir);
  const dir = intentDir(runDir, intent.id);
  const stageDir = join(ledgerDir, `.stage.${intent.id}.${runtime.ids.uuid()}`);
  runtime.storage.mkdirSync(stageDir, { mode: 0o700 });
  try {
    writeOnce(runtime, join(stageDir, 'intent.v1.json'), intent);
    runtime.storage.renameSync(stageDir, dir);
    syncDirectory(runtime, ledgerDir);
  } finally {
    runtime.storage.rmSync(stageDir, { recursive: true, force: true });
  }
  return intent;
}

/** The child must bind before performing work and exit if the absolute deadline has expired. */
export function bindCustodyIdentity(
  runtime: Runtime,
  runDir: string,
  intent: CustodyIntent,
  observation: Pick<CustodyBinding, 'process' | 'capsule' | 'observedAtMs'>,
  mode: 'initial' | 'recovered' = 'initial',
): CustodyBinding {
  const dir = intentDir(runDir, intent.id);
  const stored = readRecord(runtime, join(dir, 'intent.v1.json'), custodyIntentSchema);
  if (stored === null || stored.processToken !== intent.processToken || stored.operationId !== intent.operationId) {
    throw new Error('Custody intent identity does not match the durable record.');
  }
  if (
    observation.capsule !== stored.capsule ||
    (observation.process === null) !== (stored.effect === 'provider-operation-publication')
  ) {
    throw new Error('Custody binding does not match the intended effect.');
  }
  if (readRecord(runtime, join(dir, 'absence.v1.json'), custodyAbsenceSchema) !== null) {
    throw new Error('Custody intent was already settled absent.');
  }
  const binding = custodyBindingSchema.parse({
    ...observation,
    version: 'v1',
    intentId: stored.id,
    processToken: stored.processToken,
    operationId: stored.operationId,
  });
  const path = join(dir, mode === 'recovered' ? 'binding.recovered.v1.json' : 'binding.v1.json');
  const existing = readRecord(runtime, path, custodyBindingSchema);
  if (existing !== null) {
    if (
      existing.processToken !== binding.processToken ||
      existing.operationId !== binding.operationId ||
      JSON.stringify(existing.process) !== JSON.stringify(binding.process) ||
      existing.capsule !== binding.capsule
    ) {
      throw new Error('Custody intent is already bound to a different identity.');
    }
    return existing;
  }
  if (stored.effect === 'process-spawn' && observation.observedAtMs > stored.bindDeadlineMs) {
    throw new Error('Custody identity binding missed its deadline.');
  }
  try {
    writeOnce(runtime, path, binding);
    return binding;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const concurrent = readRecord(runtime, path, custodyBindingSchema);
    if (
      concurrent !== null &&
      concurrent.processToken === binding.processToken &&
      concurrent.operationId === binding.operationId &&
      JSON.stringify(concurrent.process) === JSON.stringify(binding.process) &&
      concurrent.capsule === binding.capsule
    ) {
      return concurrent;
    }
    throw new Error('Custody intent is already bound to a different identity.', { cause: error });
  }
}

/** A child may claim only the intent token it received at spawn. */
export function bindCustodyChild(
  runtime: Runtime,
  ticket: CustodyChildTicket,
  process: CustodyProcessIdentity,
  observedAtMs: number,
): CustodyBinding {
  const parsedId = z.string().uuid().parse(ticket.intentId);
  const intent = readRecord(runtime, join(intentDir(ticket.runDir, parsedId), 'intent.v1.json'), custodyIntentSchema);
  if (intent === null || intent.processToken !== ticket.processToken || intent.effect !== 'process-spawn') {
    throw new Error('Custody child ticket does not name a spawn intent.');
  }
  return bindCustodyIdentity(runtime, ticket.runDir, intent, { process, capsule: intent.capsule, observedAtMs });
}

export function readCustodyBinding(
  runtime: Pick<Runtime, 'storage'>,
  runDir: string,
  intent: CustodyIntent,
): CustodyBinding | null {
  let invalid = false;
  for (const name of ['binding.v1.json', 'binding.recovered.v1.json']) {
    try {
      const binding = readRecord(runtime, join(intentDir(runDir, intent.id), name), custodyBindingSchema);
      if (binding === null) continue;
      if (
        binding.intentId === intent.id &&
        binding.processToken === intent.processToken &&
        binding.operationId === intent.operationId &&
        binding.capsule === intent.capsule &&
        (binding.process === null) === (intent.effect === 'provider-operation-publication')
      )
        return binding;
      invalid = true;
    } catch {
      invalid = true;
    }
  }
  if (invalid) throw new Error('Custody binding does not match its intent.');
  return null;
}

export function readCustodyLedger(runtime: Pick<Runtime, 'storage'>, runDir: string): CustodyEntry[] {
  let names: string[];
  try {
    names = runtime.storage.readdirSync(custodyLedgerDir(runDir));
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    return [{ kind: 'unreadable', path: custodyLedgerDir(runDir), reason: String(error) }];
  }
  return names
    .filter((name) => name !== 'root.v1.json' && !name.includes('.stage.'))
    .map((name): CustodyEntry => {
      const dir = join(custodyLedgerDir(runDir), name);
      try {
        const intent = readRecord(runtime, join(dir, 'intent.v1.json'), custodyIntentSchema);
        if (intent === null || intent.id !== name) throw new Error('Custody intent is missing or mismatched.');
        let bindingInvalid = false;
        try {
          const binding = readCustodyBinding(runtime, runDir, intent);
          if (binding !== null) return { kind: 'bound', intent, binding };
        } catch {
          bindingInvalid = true;
        }
        const absence = readRecord(runtime, join(dir, 'absence.v1.json'), custodyAbsenceSchema);
        if (absence !== null) {
          if (absence.intentId !== intent.id || absence.processToken !== intent.processToken) {
            throw new Error('Custody absence does not match its intent.');
          }
          return { kind: 'absent', intent, evidence: absence.evidence };
        }
        return {
          kind: 'holding',
          intent,
          exit: 'identity-binding-or-proven-absence',
          ...(bindingInvalid ? { reason: 'identity binding is incomplete or mismatched' } : {}),
        };
      } catch (error: unknown) {
        return { kind: 'unreadable', path: dir, reason: String(error) };
      }
    });
}

/** Time alone cannot settle an unbound external effect. */
export function reconcileCustodyLedger(
  runtime: Runtime,
  runDir: string,
  nowMs: number,
  graceMs: number,
  observe: (intent: CustodyIntent) => CustodyObservation,
): CustodyEntry[] {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Custody observation time is invalid.');
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new RangeError('Custody grace must be nonnegative.');
  return readCustodyLedger(runtime, runDir).map((entry): CustodyEntry => {
    if (
      entry.kind !== 'holding' ||
      !Number.isSafeInteger(entry.intent.bindDeadlineMs + graceMs) ||
      nowMs < entry.intent.bindDeadlineMs + graceMs
    )
      return entry;
    const observation = observe(entry.intent);
    if (observation.kind !== 'absent' || observation.processToken !== entry.intent.processToken) return entry;
    const absence = custodyAbsenceSchema.parse({
      version: 'v1',
      intentId: entry.intent.id,
      processToken: entry.intent.processToken,
      provenAtMs: nowMs,
      evidence: observation.evidence,
    });
    writeOnce(runtime, join(intentDir(runDir, entry.intent.id), 'absence.v1.json'), absence);
    return { kind: 'absent', intent: entry.intent, evidence: observation.evidence };
  });
}
