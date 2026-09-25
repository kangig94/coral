import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeAuditEvent } from '../infra/audit-log.js';
import { readCustodyLedgerId } from './custody-ledger.js';

const obligationSchema = z.object({
  owner: z.string().min(1),
  intentId: z.string().uuid(),
  outcome: z.enum(['absent', 'terminal', 'terminal-and-absent']),
  evidence: z.string().min(1),
}).passthrough();

const closureSchema = z.object({
  version: z.literal('v1'),
  epochKey: z.string().min(1),
  disposition: z.enum(['closed', 'unrecoverable-retained']),
  dataOutcome: z.enum(['retained', 'unreadable', 'unknown']),
  executionDischarge: z.enum(['certified', 'undecidable']),
  obligations: z.array(obligationSchema),
  reason: z.string().min(1),
  observedAtMs: z.number().int().nonnegative(),
}).passthrough();
const coverageSchema = z.object({
  version: z.literal('v1'), preEffectCustodyRequired: z.literal(true), ledgerId: z.string().uuid(),
}).passthrough();
const COVERAGE_FILE = '.coral-custody-coverage.v1.json';

export type EpochClosureEvidence = z.infer<typeof closureSchema>;
export type EpochClosureCapability = Readonly<{ epochKey: string; executionDischarge: 'certified' }>;

export function recordEpochCustodyCoverage(epochDirectory: string, ledgerId: string): void {
  const path = join(epochDirectory, COVERAGE_FILE);
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(coverageSchema.parse({ version: 'v1', preEffectCustodyRequired: true, ledgerId }))}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dirFd = openSync(epochDirectory, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

export function hasEpochCustodyCoverage(epochDirectory: string, runDir: string): boolean {
  try {
    const coverage = coverageSchema.parse(JSON.parse(readFileSync(join(epochDirectory, COVERAGE_FILE), 'utf8')) as unknown);
    return coverage.ledgerId === readCustodyLedgerId(runDir);
  } catch {
    return false;
  }
}

function closurePath(stateRoot: string, epochKey: string): string {
  return join(stateRoot, 'epoch-closure.v1', `${Buffer.from(epochKey).toString('base64url')}.json`);
}

export function readEpochClosure(stateRoot: string, epochKey: string): EpochClosureEvidence | null {
  try {
    const evidence = closureSchema.parse(JSON.parse(readFileSync(closurePath(stateRoot, epochKey), 'utf8')) as unknown);
    if (evidence.epochKey !== epochKey) throw new Error('Epoch closure key does not match its address.');
    return evidence;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function recordEpochClosure(stateRoot: string, input: EpochClosureEvidence): EpochClosureEvidence {
  const evidence = closureSchema.parse(input);
  if ((evidence.disposition === 'closed') !== (evidence.executionDischarge === 'certified')) {
    throw new Error('Execution discharge must agree with the closure disposition.');
  }
  const existing = readEpochClosure(stateRoot, evidence.epochKey);
  if (existing?.disposition === 'closed' && evidence.disposition !== 'closed') return existing;
  const path = closurePath(stateRoot, evidence.epochKey);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stateRootFd = openSync(stateRoot, 'r');
  try { fsyncSync(stateRootFd); } finally { closeSync(stateRootFd); }
  const stage = `${path}.stage.${process.pid}.${randomUUID()}`;
  const fd = openSync(stage, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(evidence)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stage, path);
  const parentFd = openSync(parent, 'r');
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  if (existing === null || existing.disposition !== evidence.disposition ||
      existing.executionDischarge !== evidence.executionDischarge || existing.dataOutcome !== evidence.dataOutcome ||
      existing.reason !== evidence.reason || JSON.stringify(existing.obligations) !== JSON.stringify(evidence.obligations)) {
    writeAuditEvent('epoch_closure_status_changed', {
      epochKey: evidence.epochKey,
      previous: existing?.disposition ?? 'pending',
      disposition: evidence.disposition,
      custody: evidence.executionDischarge,
      resultRetention: evidence.dataOutcome,
    });
  }
  return evidence;
}

export function closureCapability(stateRoot: string, epochKey: string): EpochClosureCapability | null {
  const evidence = readEpochClosure(stateRoot, epochKey);
  return evidence?.disposition === 'closed' && evidence.executionDischarge === 'certified'
    ? { epochKey, executionDischarge: 'certified' }
    : null;
}
