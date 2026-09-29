import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeAuditEvent } from '../infra/audit-log.js';
import { sha256Hex } from '../infra/hash.js';
import { readCustodyLedgerId } from './custody-ledger.js';
import type { Runtime } from '../runtime/ports.js';

const obligationSchema = z
  .object({
    owner: z.string().min(1),
    intentId: z.string().uuid(),
    outcome: z.enum(['absent', 'terminal', 'terminal-and-absent']),
    evidence: z.string().min(1),
  })
  .passthrough();

const closureSchema = z
  .object({
    version: z.literal('v1'),
    epochKey: z.string().min(1),
    disposition: z.enum(['closed', 'unrecoverable-retained']),
    dataOutcome: z.enum(['retained', 'unreadable', 'unknown']),
    executionDischarge: z.enum(['certified', 'undecidable']),
    obligations: z.array(obligationSchema),
    reason: z.string().min(1),
    observedAtMs: z.number().int().nonnegative(),
  })
  .passthrough()
  .refine((evidence) => (evidence.disposition === 'closed') === (evidence.executionDischarge === 'certified'), {
    message: 'Execution discharge must agree with the closure disposition.',
  });
const coverageSchema = z
  .object({
    version: z.literal('v1'),
    preEffectCustodyRequired: z.literal(true),
    ledgerId: z.string().uuid(),
  })
  .passthrough();
const COVERAGE_FILE = '.coral-custody-coverage.v1.json';

export type EpochClosureEvidence = z.infer<typeof closureSchema>;
const epochClosureCapabilityBrand: unique symbol = Symbol('EpochClosureCapability');
/** Only a recorded, certified closure constructs this; a structurally matching literal cannot. */
export type EpochClosureCapability = Readonly<{
  epochKey: string;
  executionDischarge: 'certified';
  [epochClosureCapabilityBrand]: true;
}>;

export function recordEpochCustodyCoverage(runtime: Runtime, epochDirectory: string, ledgerId: string): void {
  const path = join(epochDirectory, COVERAGE_FILE);
  const fd = runtime.storage.openSync(path, 'wx', 0o600);
  try {
    const bytes = Buffer.from(
      `${JSON.stringify(coverageSchema.parse({ version: 'v1', preEffectCustodyRequired: true, ledgerId }))}\n`,
    );
    runtime.storage.writeSync(fd, bytes, 0, bytes.length, null);
    runtime.storage.fdatasyncSync(fd);
  } finally {
    runtime.storage.closeSync(fd);
  }
  if (!runtime.storage.syncDirectoryDurableSync(epochDirectory)) throw new Error('Epoch custody coverage sync failed.');
}

export function hasEpochCustodyCoverage(
  runtime: Pick<Runtime, 'storage'>,
  epochDirectory: string,
  runDir: string,
): boolean {
  try {
    const coverage = coverageSchema.parse(
      JSON.parse(runtime.storage.readFileSync(join(epochDirectory, COVERAGE_FILE), 'utf-8')) as unknown,
    );
    return coverage.ledgerId === readCustodyLedgerId(runtime, runDir);
  } catch {
    return false;
  }
}

function closurePath(stateRoot: string, epochKey: string): string {
  return join(stateRoot, 'epoch-closure.v1', `${sha256Hex(epochKey)}.json`);
}

export type EpochClosureRead =
  | Readonly<{ kind: 'recorded'; evidence: EpochClosureEvidence }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unsupported'; path: string; version: string }>
  | Readonly<{ kind: 'unreadable'; path: string }>;

export function observeEpochClosure(
  runtime: Pick<Runtime, 'storage'>,
  stateRoot: string,
  epochKey: string,
): EpochClosureRead {
  const path = closurePath(stateRoot, epochKey);
  let raw: string;
  try {
    raw = runtime.storage.readFileSync(path, 'utf-8');
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable', path };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'unreadable', path };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    value.version !== 'v1'
  ) {
    return { kind: 'unsupported', path, version: value.version };
  }
  const parsed = closureSchema.safeParse(value);
  return parsed.success && parsed.data.epochKey === epochKey
    ? { kind: 'recorded', evidence: parsed.data }
    : { kind: 'unreadable', path };
}

/** An unreadable closure must be moved aside intact before recertification; it must never be overwritten. */
export function setAsideUnreadableEpochClosure(runtime: Runtime, stateRoot: string, epochKey: string): boolean {
  const path = closurePath(stateRoot, epochKey);
  try {
    runtime.storage.renameSync(path, `${path}.unreadable.${runtime.time.now()}.${runtime.ids.uuid()}`);
    if (!runtime.storage.syncDirectoryDurableSync(dirname(path))) return false;
  } catch {
    return false;
  }
  writeAuditEvent('epoch_closure_record_set_aside', { epochKey }, 'warn');
  return true;
}

/**
 * An unreadable closure may be another build's certified record, so it is never overwritten; it already reads as
 * unrecoverable-retained, which is the status every caller that meets it must leave in place.
 */
export type EpochClosureRecording =
  | Readonly<{ kind: 'recorded'; evidence: EpochClosureEvidence }>
  | Readonly<{ kind: 'unsupported'; path: string; version: string }>
  | Readonly<{ kind: 'unreadable'; path: string }>;

export function recordEpochClosure(
  runtime: Runtime,
  stateRoot: string,
  input: EpochClosureEvidence,
): EpochClosureRecording {
  const evidence = closureSchema.parse(input);
  const read = observeEpochClosure(runtime, stateRoot, evidence.epochKey);
  if (read.kind === 'unreadable' || read.kind === 'unsupported') return read;
  const existing = read.kind === 'recorded' ? read.evidence : null;
  if (existing?.disposition === 'closed' && evidence.disposition !== 'closed') {
    return { kind: 'recorded', evidence: existing };
  }
  const updated: EpochClosureEvidence = {
    ...existing,
    ...evidence,
    obligations: evidence.obligations.map((obligation) => ({
      ...existing?.obligations.find(
        (previous) => previous.owner === obligation.owner && previous.intentId === obligation.intentId,
      ),
      ...obligation,
    })),
  };
  const path = closurePath(stateRoot, evidence.epochKey);
  const parent = dirname(path);
  runtime.storage.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!runtime.storage.syncDirectoryDurableSync(stateRoot)) throw new Error('Epoch closure root sync failed.');
  const stage = `${path}.stage.${runtime.env.pid()}.${runtime.ids.uuid()}`;
  const fd = runtime.storage.openSync(stage, 'wx', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(updated)}\n`);
    runtime.storage.writeSync(fd, bytes, 0, bytes.length, null);
    runtime.storage.fdatasyncSync(fd);
  } finally {
    runtime.storage.closeSync(fd);
  }
  runtime.storage.renameSync(stage, path);
  if (!runtime.storage.syncDirectoryDurableSync(parent)) throw new Error('Epoch closure directory sync failed.');
  if (
    existing === null ||
    existing.disposition !== evidence.disposition ||
    existing.executionDischarge !== evidence.executionDischarge ||
    existing.dataOutcome !== evidence.dataOutcome ||
    existing.reason !== evidence.reason ||
    JSON.stringify(existing.obligations) !== JSON.stringify(evidence.obligations)
  ) {
    writeAuditEvent('epoch_closure_status_changed', {
      epochKey: evidence.epochKey,
      previous: existing?.disposition ?? 'pending',
      disposition: evidence.disposition,
      custody: evidence.executionDischarge,
      resultRetention: evidence.dataOutcome,
    });
  }
  return { kind: 'recorded', evidence: updated };
}

export function closureCapability(
  runtime: Pick<Runtime, 'storage'>,
  stateRoot: string,
  epochKey: string,
): EpochClosureCapability | null {
  const read = observeEpochClosure(runtime, stateRoot, epochKey);
  return read.kind === 'recorded' &&
    read.evidence.disposition === 'closed' &&
    read.evidence.executionDischarge === 'certified'
    ? { epochKey, executionDischarge: 'certified', [epochClosureCapabilityBrand]: true }
    : null;
}
