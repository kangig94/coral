import { z } from 'zod';
import type { TimePort } from '../../infra/port-types.js';
import type { AppServerSession, ProviderTurnSettlement, ProviderTurnTerminalEvidence } from '../contract.js';
import type { AppServerResponse } from './protocol.js';

const terminalStatusSchema = z.enum(['completed', 'failed', 'interrupted']);
const turnSchema = z.object({ id: z.string(), status: z.string() });
const threadReadSchema = z.object({ thread: z.object({ id: z.string(), turns: z.array(turnSchema) }) });
const completedNotificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string().optional(),
  turn: turnSchema,
});
const OBSERVATION_BOUND_MS = 2_000;
const OBSERVATION_INTERVAL_MS = 250;
const INTERRUPT_CONFIRMATION_MS = 1_000;

export function observeCodexTurnSettlement(
  lease: AppServerSession,
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>,
  threadId: string,
  turnId: string,
): ProviderTurnSettlement {
  let evidence: ProviderTurnTerminalEvidence | null = null;
  let closed = false;
  void lease.closed.then(() => {
    closed = true;
  });
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
      return await Promise.race([operation, timeout, lease.closed.then(() => null)]);
    } finally {
      time.clearTimeout(timer);
    }
  };

  const readStatus = async (ms: number): Promise<string | null> => {
    const response = await bounded(
      lease.rpc<AppServerResponse<'thread/read'>>('thread/read', { threadId, includeTurns: true }).catch(() => null),
      ms,
    );
    const parsed = threadReadSchema.safeParse(response);
    const status =
      parsed.success && parsed.data.thread.id === threadId
        ? (parsed.data.thread.turns.find((turn) => turn.id === turnId)?.status ?? null)
        : null;
    if (status !== null) recordTerminal(status);
    return status;
  };

  return {
    settle: async () => {
      if (evidence !== null) return evidence;
      const deadline = time.now() + OBSERVATION_BOUND_MS;
      let status: string | null = null;
      // Give late notifications priority, then re-read under the retained host lease.
      await bounded(terminal, OBSERVATION_INTERVAL_MS);
      while (evidence === null && !closed && time.now() < deadline) {
        status = await readStatus(Math.min(OBSERVATION_INTERVAL_MS, deadline - time.now()));
        if (evidence !== null) return evidence;
        await bounded(terminal, Math.min(OBSERVATION_INTERVAL_MS, Math.max(0, deadline - time.now())));
      }
      if (evidence !== null) return evidence;
      if (closed || status !== 'inProgress') return null;
      status = await readStatus(OBSERVATION_INTERVAL_MS);
      if (evidence !== null) return evidence;
      if (closed || status !== 'inProgress') return null;
      await bounded(
        lease.interrupt({ threadId, turnId }).catch(() => null),
        OBSERVATION_INTERVAL_MS,
      );
      if (evidence !== null) return evidence;
      return bounded(terminal, INTERRUPT_CONFIRMATION_MS);
    },
    close: unsubscribe,
  };
}
