import { sameEpoch } from './epoch/identity.js';
import { basename, dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { processIncarnationSchema } from '../infra/node-process.js';
import { tryAcquireDirectoryLock } from '../infra/fs-lock.js';
import type { Runtime } from '../runtime/ports.js';
import { readEpochKey } from './epoch/key.js';
import { observeStorePath } from './path-observation.js';
import type { RetentionRunBudget } from './retention-outcome.js';
import type { StorageBigIntStat } from '../infra/port-types.js';

const processIdentitySchema = z
  .object({
    pid: z.number().int().safe().positive(),
    incarnation: processIncarnationSchema,
    processGroupId: z.number().int().safe().positive(),
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
    createdAtMs: z.number().int().safe().nonnegative(),
    bindDeadlineMs: z.number().int().safe().nonnegative(),
  })
  .passthrough()
  .refine((intent) => intent.bindDeadlineMs > intent.createdAtMs, {
    message: 'Custody binding deadline must follow intent creation.',
  });

const custodyBindingSchema = z
  .object({
    version: z.literal('v1'),
    intentId: z.string().uuid(),
    processToken: z.string().uuid(),
    operationId: z.string().min(1),
    process: processIdentitySchema.nullable(),
    capsule: z.string().nullable(),
    observedAtMs: z.number().int().safe().nonnegative(),
  })
  .passthrough();

const custodyAbsenceSchema = z
  .object({
    version: z.literal('v1'),
    intentId: z.string().uuid(),
    processToken: z.string().uuid(),
    provenAtMs: z.number().int().safe().nonnegative(),
    evidence: z.string().min(1),
    dischargedBinding: custodyBindingSchema.optional(),
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
  | Readonly<{ kind: 'unreadable'; reason: string }>
  | Readonly<{ kind: 'absent'; processToken: string; evidence: string }>;

export function custodyLedgerDir(runDir: string): string {
  return join(runDir, 'custody.v1');
}

const custodyRootSchema = z
  .object({
    version: z.literal('v1'),
    id: z.string().uuid(),
    createdAtMs: z.number().int().safe().nonnegative().optional(),
  })
  .passthrough();

export function initializeCustodyLedger(runtime: Runtime, runDir: string): string {
  runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  runtime.storage.mkdirSync(custodyLedgerDir(runDir), { recursive: true, mode: 0o700 });
  syncDirectory(runtime, runDir);
  const marker = join(custodyLedgerDir(runDir), 'root.v1.json');
  let root = readRecord(runtime, marker, custodyRootSchema);
  if (root === null) {
    try {
      writeOnce(runtime, marker, { version: 'v1', id: runtime.ids.uuid(), createdAtMs: runtime.time.now() });
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

export function readCustodyLedgerStartMs(runtime: Pick<Runtime, 'storage'>, runDir: string): number | null {
  try {
    return readRecord(runtime, join(custodyLedgerDir(runDir), 'root.v1.json'), custodyRootSchema)?.createdAtMs ?? null;
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

function readCustodyAbsence(runtime: Pick<Runtime, 'storage'>, runDir: string, intent: CustodyIntent) {
  const absence = readRecord(runtime, join(intentDir(runDir, intent.id), 'absence.v1.json'), custodyAbsenceSchema);
  if (absence !== null && (absence.intentId !== intent.id || absence.processToken !== intent.processToken)) {
    throw new Error('Custody absence does not match its intent.');
  }
  return absence;
}

function quarantineDamagedCustodyAbsence(runtime: Runtime, runDir: string, intent: CustodyIntent): void {
  try {
    readCustodyAbsence(runtime, runDir, intent);
  } catch {
    const path = join(intentDir(runDir, intent.id), 'absence.v1.json');
    runtime.storage.renameSync(path, `${path}.damaged.${runtime.ids.uuid()}`);
    syncDirectory(runtime, dirname(path));
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
  if (input.epochKey !== undefined && observedEpochKey !== null && !sameEpoch(input.epochKey, observedEpochKey)) {
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
  const release = tryAcquireDirectoryLock(join(intentDir(runDir, intent.id), '.reconcile.lock'), {
    storage: runtime.storage,
    time: runtime.time,
  });
  if (release === null) throw new Error('Custody reconciliation is in progress.');
  try {
    release.assertOwned();
    return bindCustodyIdentityUnderLock(runtime, runDir, intent, observation, mode);
  } finally {
    release();
  }
}

function bindCustodyIdentityUnderLock(
  runtime: Runtime,
  runDir: string,
  intent: CustodyIntent,
  observation: Pick<CustodyBinding, 'process' | 'capsule' | 'observedAtMs'>,
  mode: 'initial' | 'recovered',
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
  quarantineDamagedCustodyAbsence(runtime, runDir, stored);
  if (readCustodyAbsence(runtime, runDir, stored) !== null) {
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
  let existing: CustodyBinding | null;
  try {
    existing = readRecord(runtime, path, custodyBindingSchema);
  } catch (error: unknown) {
    if (mode !== 'recovered' || !(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
    runtime.storage.renameSync(path, `${path}.damaged.${runtime.ids.uuid()}`);
    syncDirectory(runtime, dir);
    existing = null;
  }
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
    .map((name) => readCustodyEntry(runtime, runDir, name));
}

function readCustodyEntry(runtime: Pick<Runtime, 'storage'>, runDir: string, id: string): CustodyEntry {
  const dir = join(custodyLedgerDir(runDir), id);
  try {
    const intent = readRecord(runtime, join(dir, 'intent.v1.json'), custodyIntentSchema);
    if (intent === null || intent.id !== id) throw new Error('Custody intent is missing or mismatched.');
    let bindingInvalid = false;
    try {
      const binding = readCustodyBinding(runtime, runDir, intent);
      if (binding !== null) {
        try {
          const absence = readCustodyAbsence(runtime, runDir, intent);
          if (absence?.dischargedBinding !== undefined && isDeepStrictEqual(absence.dischargedBinding, binding))
            return { kind: 'absent', intent, evidence: absence.evidence };
        } catch {
          // A damaged discharge receipt never overrides a validated binding.
        }
        return { kind: 'bound', intent, binding };
      }
    } catch {
      bindingInvalid = true;
    }
    let absenceInvalid = false;
    try {
      const absence = readCustodyAbsence(runtime, runDir, intent);
      if (absence !== null) {
        return { kind: 'absent', intent, evidence: absence.evidence };
      }
    } catch {
      absenceInvalid = true;
    }
    return {
      kind: 'holding',
      intent,
      exit: 'identity-binding-or-proven-absence',
      ...(absenceInvalid
        ? { reason: 'absence receipt is incomplete or mismatched' }
        : bindingInvalid
          ? { reason: 'identity binding is incomplete or mismatched' }
          : {}),
    };
  } catch (error: unknown) {
    return { kind: 'unreadable', path: dir, reason: String(error) };
  }
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
    if (entry.kind !== 'holding') return entry;
    const release = tryAcquireDirectoryLock(join(intentDir(runDir, entry.intent.id), '.reconcile.lock'), {
      storage: runtime.storage,
      time: runtime.time,
    });
    if (release === null) return entry;
    try {
      release.assertOwned();
      const current = readCustodyEntry(runtime, runDir, entry.intent.id);
      if (current.kind === 'unreadable') return entry;
      if (current.kind !== 'holding' || current.intent.processToken !== entry.intent.processToken) return current;
      quarantineDamagedCustodyAbsence(runtime, runDir, current.intent);
      if (!Number.isSafeInteger(entry.intent.bindDeadlineMs + graceMs) || nowMs < entry.intent.bindDeadlineMs + graceMs)
        return entry;
      const observation = observe(entry.intent);
      if (observation.kind === 'unreadable') return { ...entry, reason: observation.reason };
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
    } finally {
      release();
    }
  });
}

/** The owner supplies exact discharge evidence; a stale binding cannot discharge its replacement. */
export function dischargeCustodyEntry(
  runtime: Runtime,
  runDir: string,
  entry: Extract<CustodyEntry, { kind: 'bound' }>,
  provenAtMs: number,
  evidence: string,
  mutate: <T>(operation: () => T) => T,
): boolean {
  return mutate(() => {
    const release = tryAcquireDirectoryLock(join(intentDir(runDir, entry.intent.id), '.reconcile.lock'), {
      storage: runtime.storage,
      time: runtime.time,
    });
    if (release === null) return false;
    try {
      release.assertOwned();
      const current = readCustodyEntry(runtime, runDir, entry.intent.id);
      if (
        current.kind !== 'bound' ||
        !isDeepStrictEqual(current.intent, entry.intent) ||
        !isDeepStrictEqual(current.binding, entry.binding) ||
        provenAtMs < current.binding.observedAtMs
      )
        return false;
      quarantineDamagedCustodyAbsence(runtime, runDir, current.intent);
      const existing = readCustodyAbsence(runtime, runDir, current.intent);
      const absence = custodyAbsenceSchema.parse({
        ...existing,
        version: 'v1',
        intentId: current.intent.id,
        processToken: current.intent.processToken,
        provenAtMs,
        evidence,
        dischargedBinding: current.binding,
      });
      const path = join(intentDir(runDir, entry.intent.id), 'absence.v1.json');
      if (!runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(absence)}\n`, { mode: 0o600 }))
        throw new Error('Custody discharge receipt was not persisted.');
      return true;
    } finally {
      release();
    }
  });
}

const retirementReceiptSchema = z.object({
  version: z.literal('v1'),
  ledgerId: z.string().uuid(),
  ledgerDev: z.string().regex(/^\d+$/u),
  ledgerIno: z.string().regex(/^\d+$/u),
  entryDev: z.string().regex(/^\d+$/u),
  entryIno: z.string().regex(/^\d+$/u),
  absence: custodyAbsenceSchema,
});
const retirementStagePattern = /^\.stage\.retention\.([0-9a-f-]{36})\.([0-9a-f-]{36})$/u;

/** Only whole, discharged entries cross the visible/private boundary. Receipts survive partial stage cleanup. */
export async function pruneCustodyLedger(input: {
  runtime: Runtime;
  runDir: string;
  cutoff: number;
  afterId: string;
  budget: RetentionRunBudget;
  mutate<T>(operation: () => T): T;
  checkpoint?(id: string): void;
}): Promise<string> {
  const { runtime, runDir, cutoff, budget, mutate } = input;
  const root = custodyLedgerDir(runDir);
  const ledgerId = readCustodyLedgerId(runtime, runDir);
  if (ledgerId === null) {
    if (observeStorePath(runtime.storage, root) !== 'absent')
      budget.record({
        kind: 'kept',
        subject: 'custody',
        reason: 'ledger-identity-unreadable; retry-after-reconciliation',
      });
    return '';
  }
  const identity = runtime.storage.lstatSync(root, { bigint: true });
  const assertRoot = (): void => {
    const current = runtime.storage.lstatSync(root, { bigint: true });
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      readCustodyLedgerId(runtime, runDir) !== ledgerId
    )
      throw new Error('custody-ledger-identity-changed');
  };
  const cleanup = async (name: string): Promise<boolean> => {
    const match = retirementStagePattern.exec(name);
    if (match === null) return false;
    const path = join(root, name);
    const receiptPath = `${path}.receipt.json`;
    const release = mutate(() =>
      tryAcquireDirectoryLock(join(root, `.stage.retention-lock.${match[1]}`), {
        storage: runtime.storage,
        time: runtime.time,
      }),
    );
    if (release === null) return false;
    try {
      const receipt = readRecord(runtime, receiptPath, retirementReceiptSchema);
      if (
        receipt === null ||
        receipt.ledgerId !== ledgerId ||
        receipt.absence.intentId !== match[1] ||
        receipt.absence.provenAtMs >= cutoff ||
        receipt.ledgerDev !== String(identity.dev) ||
        receipt.ledgerIno !== String(identity.ino)
      )
        throw new Error('custody-retirement-proof-unreadable');
      const assertStage = (): void => {
        assertRoot();
        release.assertOwned();
        const entry = runtime.storage.lstatSync(path, { bigint: true });
        if (!entry.isDirectory() || String(entry.dev) !== receipt.entryDev || String(entry.ino) !== receipt.entryIno)
          throw new Error('custody-retirement-identity-changed');
      };
      const directories = new Map<string, StorageBigIntStat>();
      const assertParents = (child: string): void => {
        assertStage();
        let parent = dirname(child);
        while (parent !== root) {
          const expected = directories.get(parent);
          if (expected !== undefined) {
            const current = runtime.storage.lstatSync(parent, { bigint: true });
            if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino)
              throw new Error('custody-retirement-descendant-identity-changed');
          }
          parent = dirname(parent);
        }
      };
      const remove = async (child: string): Promise<boolean> => {
        if (!budget.canContinue()) return false;
        assertParents(child);
        const entry = runtime.storage.lstatSync(child, { bigint: true });
        if (entry.isDirectory()) {
          directories.set(child, entry);
          for (const name of runtime.storage.readdirSync(child)) {
            if (!(await remove(join(child, name)))) return false;
          }
        }
        mutate(() => {
          assertParents(child);
          const current = runtime.storage.lstatSync(child, { bigint: true });
          if (
            current.dev !== entry.dev ||
            current.ino !== entry.ino ||
            current.mode !== entry.mode ||
            (!entry.isDirectory() && current.mtimeNs !== entry.mtimeNs)
          )
            throw new Error('custody-retirement-descendant-identity-changed');
          if (entry.isDirectory()) runtime.storage.rmdirSync(child);
          else runtime.storage.unlinkSync(child);
          directories.delete(child);
        });
        await setImmediate();
        return true;
      };
      if (observeStorePath(runtime.storage, path) !== 'absent') {
        assertStage();
        // Make the retirement rename durable before removing any of its contents, including after a crash.
        mutate(() => {
          assertStage();
          syncDirectory(runtime, root);
        });
        for (const child of runtime.storage.readdirSync(path)) {
          if (!(await remove(join(path, child)))) return false;
        }
        if (!budget.canContinue()) return false;
        mutate(() => {
          assertStage();
          runtime.storage.rmdirSync(path);
          syncDirectory(runtime, root);
        });
        budget.record({ kind: 'deleted', subject: match[1], count: 1 });
      }
      mutate(() => {
        assertRoot();
        release.assertOwned();
        runtime.storage.unlinkSync(receiptPath);
        syncDirectory(runtime, root);
      });
      return true;
    } finally {
      release();
    }
  };
  let cursor = input.afterId;
  let scanned = 0;
  for (const name of runtime.storage.readdirSync(root).sort()) {
    if (name === 'root.v1.json') continue;
    const staged = retirementStagePattern.test(name);
    const orphanReceipt = name.endsWith('.receipt.json') && retirementStagePattern.test(name.slice(0, -13));
    if (!staged && !orphanReceipt && (name.includes('.stage.') || name <= input.afterId)) continue;
    if (!budget.canContinue()) return cursor;
    try {
      if (staged || orphanReceipt) {
        if (!runtime.storage.existsSync(`${join(root, staged ? name : name.slice(0, -13))}.receipt.json`)) continue;
        if (!(await cleanup(staged ? name : name.slice(0, -13)))) return cursor;
        continue;
      }
      const entry = readCustodyEntry(runtime, runDir, name);
      if (entry.kind === 'absent') {
        let stage: string | null = null;
        mutate(() => {
          assertRoot();
          const release = tryAcquireDirectoryLock(join(root, name, '.reconcile.lock'), {
            storage: runtime.storage,
            time: runtime.time,
          });
          if (release === null) return;
          try {
            release.assertOwned();
            const current = readCustodyEntry(runtime, runDir, name);
            if (current.kind !== 'absent') return;
            const absence = readCustodyAbsence(runtime, runDir, current.intent);
            if (absence === null || absence.provenAtMs >= cutoff) return;
            const path = join(root, name);
            const entryIdentity = runtime.storage.lstatSync(path, { bigint: true });
            if (!entryIdentity.isDirectory()) return;
            stage = `.stage.retention.${current.intent.id}.${runtime.ids.uuid()}`;
            writeOnce(runtime, `${join(root, stage)}.receipt.json`, {
              version: 'v1',
              ledgerId,
              ledgerDev: String(identity.dev),
              ledgerIno: String(identity.ino),
              entryDev: String(entryIdentity.dev),
              entryIno: String(entryIdentity.ino),
              absence,
            });
            release.assertOwned();
            runtime.storage.renameSync(path, join(root, stage));
            syncDirectory(runtime, root);
          } finally {
            release();
          }
        });
        if (stage !== null && !(await cleanup(stage))) return cursor;
      } else if (entry.kind === 'unreadable' || entry.kind === 'holding')
        budget.record({ kind: 'kept', subject: name, reason: 'custody-awaits-reconciliation' });
      cursor = name;
      if (++scanned % 32 === 0) input.checkpoint?.(cursor);
    } catch (error: unknown) {
      budget.record({ kind: 'kept', subject: name, reason: `custody-retention-retry: ${String(error)}` });
    }
    await setImmediate();
  }
  return '';
}
