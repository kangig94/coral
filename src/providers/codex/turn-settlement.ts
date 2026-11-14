import { observePromise, raceObserved, raceWithSignal } from '../../infra/promise-signal.js';
import { z } from 'zod';
import type { TimePort } from '../../infra/port-types.js';
import type { AppServerSession, ProviderTurnSettlement, ProviderTurnTerminalEvidence } from '../contract.js';
import { observeCodexThreadRead } from './thread-read.js';

const terminalStatusSchema = z.enum(['completed', 'failed', 'interrupted']);
const turnSchema = z.object({ id: z.string(), status: z.string() });
const threadReadSchema = z.object({ thread: z.object({ id: z.string(), turns: z.array(turnSchema) }) });
const completedNotificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string().optional(),
  turn: turnSchema,
});
const PASSIVE_OBSERVATION_MS = 2_000;
const OBSERVATION_INTERVAL_MS = 250;
const PRE_INTERRUPT_OBSERVATION_MS = 32_000;
const INTERRUPT_CONFIRMATION_MS = 30_000;

export function observeCodexTurnSettlement(
  lease: AppServerSession,
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
  threadId: string,
  turnId: string,
): ProviderTurnSettlement {
  let evidence: ProviderTurnTerminalEvidence | null = null;
  const closed = new AbortController();
  const stopped = AbortSignal.any([observePromise(lease.closed).signal, closed.signal]);
  let stopRead: (() => void) | null = null;
  let resolveTerminal!: (value: ProviderTurnTerminalEvidence) => void;
  const terminal = new Promise<ProviderTurnTerminalEvidence>((resolve) => {
    resolveTerminal = resolve;
  });
  const recordTerminal = (status: string): void => {
    const parsed = terminalStatusSchema.safeParse(status);
    if (!parsed.success || evidence !== null) return;
    evidence = { kind: 'provider-turn-terminal', providerTurnId: turnId, status: parsed.data };
    resolveTerminal(evidence);
  };
  const unsubscribe = lease.subscribe((message) => {
    if (message.method !== 'turn/completed') return;
    const parsed = completedNotificationSchema.safeParse(message.params);
    if (!parsed.success) return;
    const notification = parsed.data;
    if (notification.threadId !== threadId || notification.turn.id !== turnId) return;
    if (notification.turnId !== undefined && notification.turnId !== turnId) return;
    recordTerminal(notification.turn.status);
  });

  const bounded = async <Value>(operation: Promise<Value>, ms: number): Promise<Value | null> => {
    let timer!: ReturnType<TimePort['setTimeout']>;
    const timeout = new Promise<null>((resolve) => {
      timer = time.setTimeout(() => resolve(null), ms);
    });
    try {
      return await raceWithSignal(raceObserved([operation, timeout]), stopped, () => null);
    } finally {
      time.clearTimeout(timer);
    }
  };

  const readStatus = (): Promise<string | null> =>
    new Promise((resolve) => {
      stopRead = observeCodexThreadRead(lease, threadId, (response) => {
        stopRead = null;
        const parsed = threadReadSchema.safeParse(response);
        const status =
          parsed.success && parsed.data.thread.id === threadId
            ? (parsed.data.thread.turns.find((turn) => turn.id === turnId)?.status ?? null)
            : null;
        if (status !== null) recordTerminal(status);
        resolve(status);
      });
    });

  const settle = async (): Promise<ProviderTurnTerminalEvidence | null> => {
    if (evidence !== null) return evidence;
    let expired = false;
    let interruptAllowed = false;
    let interruptRequested = false;
    let deadlineTimer!: ReturnType<TimePort['setTimeout']>;
    let deadline = new Promise<null>((resolve) => {
      deadlineTimer = time.setTimeout(() => {
        expired = true;
        resolve(null);
      }, PRE_INTERRUPT_OBSERVATION_MS);
    });
    const passiveTimer = time.setTimeout(() => {
      interruptAllowed = true;
    }, PASSIVE_OBSERVATION_MS);
    const terminalObserved = terminal.then(() => null);
    try {
      await raceObserved([bounded(terminal, OBSERVATION_INTERVAL_MS), deadline]);
      while (evidence === null && !stopped.aborted && !expired) {
        const status = await raceWithSignal(
          raceObserved([readStatus(), terminalObserved, deadline]),
          stopped,
          () => null,
        );
        if (evidence !== null || expired) break;
        if (status === 'inProgress' && interruptAllowed && !interruptRequested) {
          interruptRequested = true;
          time.clearTimeout(deadlineTimer);
          deadline = new Promise<null>((resolve) => {
            deadlineTimer = time.setTimeout(() => {
              expired = true;
              resolve(null);
            }, INTERRUPT_CONFIRMATION_MS);
          });
          await raceObserved([
            bounded(
              lease.interrupt({ threadId, turnId }).catch(() => null),
              OBSERVATION_INTERVAL_MS,
            ),
            deadline,
          ]);
        }
        if (evidence === null && !expired) await raceObserved([bounded(terminal, OBSERVATION_INTERVAL_MS), deadline]);
      }
      return evidence;
    } finally {
      stopRead?.();
      stopRead = null;
      time.clearTimeout(deadlineTimer);
      time.clearTimeout(passiveTimer);
    }
  };
  let settlement: Promise<ProviderTurnTerminalEvidence | null> | null = null;
  return {
    providerTurnId: turnId,
    settle: () => {
      if (evidence !== null) return Promise.resolve(evidence);
      settlement ??= settle();
      return settlement;
    },
    close: () => {
      unsubscribe();
      closed.abort();
      stopRead?.();
      stopRead = null;
    },
  };
}
