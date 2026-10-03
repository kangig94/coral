import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const CUSTODY_PROCESS_TICKET_ENV = 'CORAL_CUSTODY_PROCESS_TICKET';

const epochLineageKeySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d*$/u);

const ticketSchema = z
  .object({
    runDir: z.string().min(1),
    intentId: z.string().uuid(),
    processToken: z.string().uuid(),
    processGroupId: z.number().int().safe().positive().nullable(),
    epoch: z.string().min(1),
    epochKey: epochLineageKeySchema.optional(),
  })
  .passthrough();

const intentSchema = z
  .object({
    version: z.literal('v1'),
    id: z.string().uuid(),
    effect: z.literal('process-spawn'),
    owner: z.string().min(1),
    operationId: z.string().min(1),
    epoch: z.string().min(1),
    epochKey: epochLineageKeySchema.optional(),
    processToken: z.string().uuid(),
    capsule: z.string().nullable(),
    createdAtMs: z.number().int().safe().nonnegative(),
    bindDeadlineMs: z.number().int().safe().nonnegative(),
  })
  .passthrough()
  .refine((intent) => intent.bindDeadlineMs > intent.createdAtMs, {
    message: 'Custody binding deadline must follow intent creation.',
  });

const bindingSchema = z
  .object({
    version: z.literal('v1'),
    intentId: z.string().uuid(),
    processToken: z.string().uuid(),
    operationId: z.string().min(1),
    process: z
      .object({
        pid: z.number().int().safe().positive(),
        incarnation: z.string().min(1),
        processGroupId: z.number().int().safe().positive(),
      })
      .passthrough(),
    capsule: z.string().nullable(),
    observedAtMs: z.number().int().safe().nonnegative(),
  })
  .passthrough();

export type CustodyProcessTicket = z.infer<typeof ticketSchema>;

export function custodyProcessArgument(processToken: string): string {
  return `--coral-custody-token=${z.string().uuid().parse(processToken)}`;
}

/** Only a complete process listing may prove a pre-minted process token absent. */
export function findCustodyProcessToken(
  processToken: string,
): Readonly<{ kind: 'alive'; pid: number }> | Readonly<{ kind: 'absent' | 'unknown' }> {
  const argument = custodyProcessArgument(processToken);
  if (process.platform === 'darwin') {
    const scan = spawnSync('ps', ['-axo', 'pid=,uid=,command=', '-ww'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (scan.error !== undefined || scan.status !== 0) return { kind: 'unknown' };
    for (const line of scan.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) return { kind: 'unknown' };
      if (Number(match[2]) === process.getuid?.() && match[3]?.includes(argument)) {
        return { kind: 'alive', pid: Number(match[1]) };
      }
    }
    return { kind: 'absent' };
  }
  if (process.platform !== 'linux') return { kind: 'unknown' };
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return { kind: 'unknown' };
  }
  let undecidable = false;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const processDir = join('/proc', name);
    try {
      if (statSync(processDir).uid !== process.getuid?.()) continue;
      const args = readFileSync(join(processDir, 'cmdline'), 'utf8').split('\0');
      if (args.includes(argument)) return { kind: 'alive', pid: Number(name) };
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) continue;
      undecidable = true;
    }
  }
  return { kind: undecidable ? 'unknown' : 'absent' };
}

export function recordChildRoleCustodyIntent(
  input: Readonly<{
    runDir: string;
    epoch: string;
    epochKey?: string;
    owner: string;
    operationId: string;
    capsule: string | null;
    nowMs: number;
    bindWithinMs: number;
    processGroupId: number | null;
  }>,
): CustodyProcessTicket {
  if (
    !Number.isSafeInteger(input.bindWithinMs) ||
    input.bindWithinMs <= 0 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    !Number.isSafeInteger(input.nowMs + input.bindWithinMs)
  ) {
    throw new RangeError('Custody binding deadline is invalid.');
  }
  const id = randomUUID();
  const processToken = randomUUID();
  const ticket = ticketSchema.parse({
    runDir: input.runDir,
    intentId: id,
    processToken,
    processGroupId: input.processGroupId,
    epoch: input.epoch,
    ...(input.epochKey === undefined ? {} : { epochKey: input.epochKey }),
  });
  const ledgerDir = join(input.runDir, 'custody.v1');
  const dir = join(ledgerDir, id);
  const stageDir = join(ledgerDir, `.stage.${id}.${randomUUID()}`);
  mkdirSync(input.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const runFd = openSync(input.runDir, 'r');
  try {
    fsyncSync(runFd);
  } finally {
    closeSync(runFd);
  }
  const intent = intentSchema.parse({
    version: 'v1',
    id,
    effect: 'process-spawn',
    epoch: input.epoch,
    ...(input.epochKey === undefined ? {} : { epochKey: input.epochKey }),
    owner: input.owner,
    operationId: input.operationId,
    processToken,
    capsule: input.capsule,
    createdAtMs: input.nowMs,
    bindDeadlineMs: input.nowMs + input.bindWithinMs,
  });
  mkdirSync(stageDir, { mode: 0o700 });
  try {
    const fd = openSync(join(stageDir, 'intent.v1.json'), 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(intent)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const stageFd = openSync(stageDir, 'r');
    try {
      fsyncSync(stageFd);
    } finally {
      closeSync(stageFd);
    }
    renameSync(stageDir, dir);
    const ledgerFd = openSync(ledgerDir, 'r');
    try {
      fsyncSync(ledgerFd);
    } finally {
      closeSync(ledgerFd);
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
  return ticket;
}

export function parseCustodyProcessTicket(value: string): CustodyProcessTicket {
  return ticketSchema.parse(JSON.parse(value) as unknown);
}

/** A child must bind the exact pre-minted token before starting external work. */
export function bindCustodyProcessTicket(
  ticket: CustodyProcessTicket,
  process: Readonly<{ pid: number; incarnation: string }>,
  nowMs: number,
  allowExistingAfterDeadline = false,
): void {
  const dir = join(ticket.runDir, 'custody.v1', ticket.intentId);
  const intent = intentSchema.parse(JSON.parse(readFileSync(join(dir, 'intent.v1.json'), 'utf8')) as unknown);
  if (
    intent.id !== ticket.intentId ||
    intent.processToken !== ticket.processToken ||
    intent.epoch !== ticket.epoch ||
    intent.epochKey !== ticket.epochKey
  ) {
    throw new Error('Custody process ticket is invalid.');
  }
  if (nowMs > intent.bindDeadlineMs && !allowExistingAfterDeadline) {
    throw new Error('Custody process ticket expired before binding.');
  }
  const binding = bindingSchema.parse({
    version: 'v1',
    intentId: intent.id,
    processToken: intent.processToken,
    operationId: intent.operationId,
    process: { ...process, processGroupId: ticket.processGroupId ?? process.pid },
    capsule: intent.capsule,
    observedAtMs: nowMs,
  });
  const path = join(dir, 'binding.v1.json');
  const existing = (): z.infer<typeof bindingSchema> | null => {
    try {
      return bindingSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const acceptExisting = (): boolean => {
    const prior = existing();
    if (prior === null) return false;
    if (
      prior.intentId !== binding.intentId ||
      prior.processToken !== binding.processToken ||
      prior.operationId !== binding.operationId ||
      prior.capsule !== binding.capsule ||
      JSON.stringify(prior.process) !== JSON.stringify(binding.process)
    ) {
      throw new Error('Custody intent is bound to a different process.');
    }
    return true;
  };
  if (acceptExisting()) return;
  if (nowMs > intent.bindDeadlineMs) throw new Error('Custody process ticket expired before binding.');
  const stage = `${path}.stage.${process.pid}.${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(stage, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(binding)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(stage, path);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') || !acceptExisting()) throw error;
      return;
    }
    const directoryFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(stage, { force: true });
  }
}
