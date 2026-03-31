/**
 * Adversarial tests for the Claude JSON-RPC broker server (AC2, AC3, AC8, AC9, AC10).
 *
 * Files targeted: src/providers/claude-appserver/server.ts,
 *                 src/providers/claude-appserver/session.ts,
 *                 src/providers/claude-appserver/protocol.ts
 *
 * The broker is a state machine that owns one persistent Claude child process.
 * These tests attack the race conditions and invariant boundaries the implementer
 * is most likely to miss:
 *
 *   - duplicate turn/start while a turn is pending or active
 *   - turn/interrupt before turn/start acknowledgement (no brokerTurnId yet)
 *   - turn/interrupt after terminal completion (stale brokerTurnId)
 *   - session/ensure during an active turn (must be a read, not a respawn)
 *   - session/ensure bootstrap-signature mismatch against a live child
 *   - broker crash mid-turn (child exits before turn completes)
 *   - child exit before the first session_id emission
 *   - initialize-once enforcement across multiple turns
 *   - permission auto-allow for can_use_tool: must emit progress then continue
 *   - permission auto-allow must NOT fire for an unknown control_request subtype
 *
 * These tests are written against the expected public interface of the broker
 * module (Phase 1B). They will fail until those modules exist — intentional.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── mock Claude child process ─────────────────────────────────────────────

/**
 * A minimal fake Claude child that speaks NDJSON on stdin/stdout.
 * Tests control the emission of stdout lines to simulate Claude responses.
 */
interface FakeClaudeChild {
  writeLine(line: string): void;
  emitSessionId(sessionId: string): void;
  emitAssistantText(text: string): void;
  emitResult(result: string, sessionId?: string, costUsd?: number): void;
  emitControlRequest(subtype: string, requestId: string, extra?: Record<string, unknown>): void;
  crash(exitCode?: number): void;
  getStdinLines(): string[];
}

function makeFakeClaudeChild(): FakeClaudeChild {
  const stdinLines: string[] = [];
  let stdoutHandler: ((line: string) => void) | null = null;
  let exitHandler: ((code: number | null) => void) | null = null;

  const child = {
    // simulates what the broker writes to Claude's stdin
    onStdin(handler: (line: string) => void) {
      stdoutHandler = handler;
    },
    onExit(handler: (code: number | null) => void) {
      exitHandler = handler;
    },
    // Called by test to push lines out of Claude's stdout
    writeLine(line: string) {
      stdoutHandler?.(line);
    },
    emitSessionId(sessionId: string) {
      this.writeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
    },
    emitAssistantText(text: string) {
      this.writeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
    },
    emitResult(result: string, sessionId = 'sess-1', costUsd = 0.01) {
      this.writeLine(
        JSON.stringify({ type: 'result', result, session_id: sessionId, total_cost_usd: costUsd }),
      );
    },
    emitControlRequest(subtype: string, requestId: string, extra: Record<string, unknown> = {}) {
      this.writeLine(JSON.stringify({ type: 'control_request', subtype, request_id: requestId, ...extra }));
    },
    crash(exitCode: number | null = 1) {
      exitHandler?.(exitCode);
    },
    getStdinLines() {
      return stdinLines;
    },
  };

  return child;
}

// ─── broker factory helper ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — module not yet implemented
import { createBrokerSession } from '../../claude-appserver/session.js';

interface BrokerSession {
  sessionEnsure(params: {
    cwd: string;
    systemPromptHash: string;
    permissionMode: string;
    conversationRef?: string;
  }): Promise<{ bootstrapSignature: Record<string, unknown>; sessionId: string | null }>;

  turnStart(params: {
    brokerTurnId: string;
    prompt: string;
    model?: string;
    maxThinkingTokens?: number;
  }): Promise<{ brokerTurnId: string }>;

  turnInterrupt(params: { brokerTurnId?: string }): Promise<void>;

  subscribeNotifications(
    handler: (notification: { method: string; params: Record<string, unknown> }) => void,
  ): () => void;
}

const BOOTSTRAP = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:abc123',
  permissionMode: 'bypass',
};

// ─── duplicate turn/start ──────────────────────────────────────────────────

describe('broker: duplicate turn/start rejection', () => {
  it('rejects a second turn/start while the first turn is pending acknowledgement', async () => {
    // The implementer will add a "busy" flag after the RPC resolves.
    // But what about the window BETWEEN the first turn/start call and its
    // resolution? A second call arriving in that window must also be rejected.
    const child = makeFakeClaudeChild();
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((r) => (resolveFirst = r));

    // Simulate a broker that acknowledges turn/start only after we signal it.
    const session = (await createBrokerSession({
      child,
      onTurnStarted: () => {
        resolveFirst();
        // intentionally delay acknowledgement
        return new Promise<void>((r) => setTimeout(r, 50));
      },
    })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);

    // Fire both turn/start calls concurrently — both arrive before the first
    // acknowledgement returns.
    const first = session.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
    await firstStarted; // ensure first is in-flight
    const second = session.turnStart({ brokerTurnId: 'turn-2', prompt: 'world' });

    // The second must reject with a stable busy error, not start a new turn.
    await expect(second).rejects.toMatchObject({
      code: expect.any(Number),
      message: expect.stringMatching(/busy/i),
    });

    // Clean up the first
    await first.catch(() => {});
  });

  it('rejects turn/start while a turn is actively in progress (post-ack)', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-active');

    // Start a turn and let it acknowledge.
    const first = session.turnStart({ brokerTurnId: 'turn-1', prompt: 'compute' });
    // turn-1 is now acknowledged but not completed (no result event yet)

    const second = session.turnStart({ brokerTurnId: 'turn-2', prompt: 'overlap' });

    await expect(second).rejects.toMatchObject({ message: expect.stringMatching(/busy/i) });

    // Resolve the first normally.
    child.emitResult('done', 'sess-active');
    await first;
  });

  it('accepts a new turn/start after the previous turn completes', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-seq');

    const first = session.turnStart({ brokerTurnId: 'turn-1', prompt: 'first' });
    child.emitResult('first done', 'sess-seq');
    await first;

    // Second turn after completion must succeed.
    const second = session.turnStart({ brokerTurnId: 'turn-2', prompt: 'second' });
    child.emitResult('second done', 'sess-seq');
    await expect(second).resolves.toMatchObject({ brokerTurnId: 'turn-2' });
  });
});

// ─── turn/interrupt timing ─────────────────────────────────────────────────

describe('broker: turn/interrupt timing contracts', () => {
  it('interrupt before turn/start acknowledgement — no brokerTurnId — resolves without error', async () => {
    // AC2: callers may omit brokerTurnId before turn/start acknowledgement.
    // The broker must record a pending interrupt and resolve idempotently.
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;
    await session.sessionEnsure(BOOTSTRAP);

    // Do NOT start a turn — interrupt with no active turn.
    await expect(session.turnInterrupt({})).resolves.toBeUndefined();
  });

  it('interrupt with omitted brokerTurnId while a turn is in-flight queues the interrupt', async () => {
    const child = makeFakeClaudeChild();
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = (await createBrokerSession({ child })) as BrokerSession;
    session.subscribeNotifications((n) => notifications.push(n));

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-inflight');

    const turn = session.turnStart({ brokerTurnId: 'turn-1', prompt: 'long task' });

    // Interrupt without brokerTurnId — targets the session's single pending turn.
    await session.turnInterrupt({});

    // Broker must write an interrupt control_request to Claude's stdin.
    const stdinLines = child.getStdinLines();
    const hasInterrupt = stdinLines.some((line) => {
      try {
        const msg = JSON.parse(line) as { type?: string };
        return msg.type === 'control_request';
      } catch {
        return false;
      }
    });
    expect(hasInterrupt).toBe(true);

    // Simulate Claude acknowledging the interrupt with a result.
    child.emitResult('interrupted', 'sess-inflight');
    await turn;
  });

  it('interrupt after terminal completion with the last brokerTurnId is idempotent', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;
    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-done');

    const turn = session.turnStart({ brokerTurnId: 'turn-1', prompt: 'compute' });
    child.emitResult('completed', 'sess-done');
    await turn;

    // Interrupting after completion with the stale turn ID must succeed without
    // mutating completed state.
    await expect(session.turnInterrupt({ brokerTurnId: 'turn-1' })).resolves.toBeUndefined();

    // The broker must NOT write another interrupt to Claude after completion.
    const stdinAfterCompletion = child.getStdinLines();
    const interruptCount = stdinAfterCompletion.filter((line) => {
      try {
        const msg = JSON.parse(line) as { type?: string };
        return msg.type === 'control_request';
      } catch {
        return false;
      }
    }).length;
    // At most zero new interrupts should have been sent after completion.
    // (There may have been zero interrupts total if no prior interrupt was sent.)
    expect(interruptCount).toBe(0);
  });

  it('interrupt with wrong brokerTurnId is rejected cleanly without crashing broker', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;
    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-wrong');

    session.turnStart({ brokerTurnId: 'turn-real', prompt: 'work' });

    // Interrupt targeting a completely different turn ID.
    await expect(session.turnInterrupt({ brokerTurnId: 'turn-stale-from-previous-life' })).resolves.toBeUndefined();

    child.emitResult('done', 'sess-wrong');
  });
});

// ─── session/ensure during an active turn ──────────────────────────────────

describe('broker: session/ensure during active turn is a read, not a respawn', () => {
  it('returns current bootstrap state without restarting the child', async () => {
    const child = makeFakeClaudeChild();
    const spawnCount = { count: 0 };
    const session = (await createBrokerSession({
      child,
      onSpawn: () => {
        spawnCount.count++;
      },
    })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-concurrent');
    const initialSpawnCount = spawnCount.count;

    session.turnStart({ brokerTurnId: 'turn-1', prompt: 'busy' });

    // session/ensure while a turn is in-flight.
    const ensureResult = await session.sessionEnsure(BOOTSTRAP);

    // Must not have spawned a new child.
    expect(spawnCount.count).toBe(initialSpawnCount);
    // Must return the current bootstrap state.
    expect(ensureResult.sessionId).toBe('sess-concurrent');

    child.emitResult('done', 'sess-concurrent');
  });

  it('returns mismatch error when bootstrap signature drifts, even during active turn', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-drift');

    session.turnStart({ brokerTurnId: 'turn-1', prompt: 'running' });

    // Different cwd — must be rejected.
    await expect(
      session.sessionEnsure({ ...BOOTSTRAP, cwd: '/different/path' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/mismatch|drift|immutable/i) });

    child.emitResult('done', 'sess-drift');
  });
});

// ─── initialize-once enforcement ───────────────────────────────────────────

describe('broker: initialize sent exactly once per child lifecycle', () => {
  it('sends initialize only on the first session/ensure, not on subsequent calls', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-init');

    // Second session/ensure on the same child.
    await session.sessionEnsure(BOOTSTRAP);

    const stdinLines = child.getStdinLines();
    const initializeCount = stdinLines.filter((line) => {
      try {
        const msg = JSON.parse(line) as { type?: string };
        return msg.type === 'initialize';
      } catch {
        return false;
      }
    }).length;

    expect(initializeCount).toBe(1);
  });

  it('sends initialize again only after a child respawn (resume path)', async () => {
    const child1 = makeFakeClaudeChild();
    let activeChild = child1;
    let sessionUnderTest!: BrokerSession;

    // On respawn, the broker should use child2.
    const child2 = makeFakeClaudeChild();
    const session = (await createBrokerSession({
      child: activeChild,
      onRespawn: () => {
        activeChild = child2;
        return child2;
      },
    })) as BrokerSession;
    sessionUnderTest = session;

    await sessionUnderTest.sessionEnsure(BOOTSTRAP);
    activeChild.emitSessionId('sess-first');

    // Crash the child to trigger respawn.
    child1.crash(1);

    // session/ensure with a conversationRef triggers a respawn using --resume.
    await sessionUnderTest.sessionEnsure({ ...BOOTSTRAP, conversationRef: 'sess-first' }).catch(() => {});

    // The second child must have received its own initialize.
    const child2StdinLines = child2.getStdinLines();
    const initCount2 = child2StdinLines.filter((line) => {
      try {
        return (JSON.parse(line) as { type?: string }).type === 'initialize';
      } catch {
        return false;
      }
    }).length;
    expect(initCount2).toBe(1);
  });
});

// ─── broker crash mid-turn ─────────────────────────────────────────────────

describe('broker: child crash during active turn produces terminal failure, not a hung promise', () => {
  it('rejects the active turn/start promise when the child exits unexpectedly', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-crash');

    const turn = session.turnStart({ brokerTurnId: 'turn-crash', prompt: 'long op' });

    // Child crashes before emitting a result.
    child.crash(1);

    // The promise must reject (not hang indefinitely).
    await expect(turn).rejects.toThrow();
  }, 3000);

  it('emits a turn/failed notification when the child exits mid-turn', async () => {
    const child = makeFakeClaudeChild();
    const notifications: Array<{ method: string }> = [];
    const session = (await createBrokerSession({ child })) as BrokerSession;
    session.subscribeNotifications((n) => notifications.push(n));

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-crash-notify');

    session.turnStart({ brokerTurnId: 'turn-crash', prompt: 'work' }).catch(() => {});

    child.crash(1);

    // Wait briefly for async propagation.
    await new Promise<void>((r) => setTimeout(r, 20));

    const failNotification = notifications.find((n) => n.method === 'turn/failed');
    expect(failNotification).toBeDefined();
  });
});

// ─── child exit before first session_id ───────────────────────────────────

describe('broker: child exits before first session_id emission', () => {
  it('session/ensure rejects when child exits during bootstrap before session_id', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    const ensurePromise = session.sessionEnsure(BOOTSTRAP);

    // Child crashes immediately — no session_id was ever emitted.
    child.crash(1);

    await expect(ensurePromise).rejects.toThrow();
  }, 3000);

  it('does not permanently lock the broker after bootstrap failure', async () => {
    // If the broker erroneously sets "bootstrapping = true" and never resets it,
    // a subsequent session/ensure call will hang forever.
    const child1 = makeFakeClaudeChild();
    const child2 = makeFakeClaudeChild();
    let spawnedChild: FakeClaudeChild = child1;

    const session = (await createBrokerSession({
      child: spawnedChild,
      onRespawn: () => {
        spawnedChild = child2;
        return child2;
      },
    })) as BrokerSession;

    const firstEnsure = session.sessionEnsure(BOOTSTRAP);
    child1.crash(1);
    await firstEnsure.catch(() => {});

    // A second ensure attempt after the failed bootstrap must not hang.
    const secondEnsure = session.sessionEnsure(BOOTSTRAP);
    child2.emitSessionId('sess-recovered');

    await expect(secondEnsure).resolves.toMatchObject({ sessionId: 'sess-recovered' });
  }, 3000);
});

// ─── permission auto-allow ─────────────────────────────────────────────────

describe('broker: permission auto-allow for can_use_tool', () => {
  it('sends a control_response allow when Claude emits can_use_tool', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;
    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-perm');

    session.turnStart({ brokerTurnId: 'turn-perm', prompt: 'use tools' });

    // Claude asks permission for a tool.
    child.emitControlRequest('can_use_tool', 'req-tool-1', { tool_name: 'Bash' });

    await new Promise<void>((r) => setTimeout(r, 20));

    const stdinLines = child.getStdinLines();
    const responseLines = stdinLines.filter((line) => {
      try {
        const msg = JSON.parse(line) as { type?: string; subtype?: string; request_id?: string };
        return msg.type === 'control_response' && msg.request_id === 'req-tool-1';
      } catch {
        return false;
      }
    });

    expect(responseLines).toHaveLength(1);
    const response = JSON.parse(responseLines[0]) as { allow?: boolean; decision?: string };
    // The response must explicitly allow the tool.
    const isAllow = response.allow === true || response.decision === 'allow';
    expect(isAllow).toBe(true);

    child.emitResult('done', 'sess-perm');
  });

  it('emits a turn/progress notification with tool name when auto-allowing', async () => {
    const child = makeFakeClaudeChild();
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = (await createBrokerSession({ child })) as BrokerSession;
    session.subscribeNotifications((n) => notifications.push(n));

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-perm-notify');

    session.turnStart({ brokerTurnId: 'turn-perm', prompt: 'use tools' });
    child.emitControlRequest('can_use_tool', 'req-tool-2', { tool_name: 'Write' });

    await new Promise<void>((r) => setTimeout(r, 20));

    const progressNotifs = notifications.filter((n) => n.method === 'turn/progress');
    expect(progressNotifs.length).toBeGreaterThan(0);
    // At least one progress notification should mention the tool name.
    const mentionsWriteTool = progressNotifs.some(
      (n) =>
        typeof n.params.message === 'string' && n.params.message.includes('Write'),
    );
    expect(mentionsWriteTool).toBe(true);

    child.emitResult('done', 'sess-perm-notify');
  });

  it('does NOT auto-allow an unknown control_request subtype', async () => {
    // AC9: auto-allow only for compatible can_use_tool. Unknown subtypes must
    // not receive a spurious allow response — this would be a security hole.
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;
    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-unknown-ctrl');

    session.turnStart({ brokerTurnId: 'turn-1', prompt: 'work' });
    child.emitControlRequest('request_file_access', 'req-unknown-1', { path: '/etc/passwd' });

    await new Promise<void>((r) => setTimeout(r, 20));

    const stdinLines = child.getStdinLines();
    const unexpectedAllow = stdinLines.some((line) => {
      try {
        const msg = JSON.parse(line) as { type?: string; request_id?: string; allow?: boolean; decision?: string };
        if (msg.type !== 'control_response') return false;
        if (msg.request_id !== 'req-unknown-1') return false;
        return msg.allow === true || msg.decision === 'allow';
      } catch {
        return false;
      }
    });
    expect(unexpectedAllow).toBe(false);

    child.emitResult('done', 'sess-unknown-ctrl');
  });
});

// ─── bootstrap signature mismatch ─────────────────────────────────────────

describe('broker: session/ensure bootstrap signature mismatch', () => {
  it('rejects session/ensure when cwd drifts against an already-live child', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-live');

    await expect(
      session.sessionEnsure({ ...BOOTSTRAP, cwd: '/completely/different' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/mismatch|drift|immutable/i) });
  });

  it('rejects session/ensure when systemPromptHash drifts against a live child', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-hash-live');

    await expect(
      session.sessionEnsure({ ...BOOTSTRAP, systemPromptHash: 'sha256:differenthash' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/mismatch|drift|immutable/i) });
  });

  it('does not respawn the child when mismatch is detected', async () => {
    const child = makeFakeClaudeChild();
    const spawnCount = { count: 1 }; // starts at 1 — child already provided
    const session = (await createBrokerSession({
      child,
      onSpawn: () => {
        spawnCount.count++;
      },
    })) as BrokerSession;

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-no-respawn');
    const countBefore = spawnCount.count;

    await session.sessionEnsure({ ...BOOTSTRAP, cwd: '/drift' }).catch(() => {});

    expect(spawnCount.count).toBe(countBefore);
  });
});

// ─── costUsd extraction in turn/completed ─────────────────────────────────

describe('broker: turn/completed notification carries cost metadata (AC10)', () => {
  it('includes costUsd from Claude result event in turn/completed params', async () => {
    const child = makeFakeClaudeChild();
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = (await createBrokerSession({ child })) as BrokerSession;
    session.subscribeNotifications((n) => notifications.push(n));

    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-cost');

    session.turnStart({ brokerTurnId: 'turn-cost', prompt: 'expensive' });
    child.emitResult('answer', 'sess-cost', 0.123);

    await new Promise<void>((r) => setTimeout(r, 20));

    const completedNotif = notifications.find((n) => n.method === 'turn/completed');
    expect(completedNotif).toBeDefined();
    expect(completedNotif?.params.costUsd).toBe(0.123);
  });

  it('does not crash when result event omits total_cost_usd', async () => {
    const child = makeFakeClaudeChild();
    const session = (await createBrokerSession({ child })) as BrokerSession;
    await session.sessionEnsure(BOOTSTRAP);
    child.emitSessionId('sess-nocost');

    const turn = session.turnStart({ brokerTurnId: 'turn-nocost', prompt: 'work' });
    // Emit result with no cost field.
    child.writeLine(JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-nocost' }));

    await expect(turn).resolves.toBeDefined();
  });
});

// ─── lease.closed transport signal ────────────────────────────────────────

describe('broker: transport-close signal (AC7 lease.closed)', () => {
  // NOTE: This test block targets the ProviderServerLease.closed promise
  // exposed by the engine when the broker process dies. The broker session
  // itself surfaces transport closure; the lease wraps it.
  // These tests are written at the session level — the engine-level wrapping
  // is tested in red-adapter-persistent.test.ts.

  it('the broker session exposes a closed promise that resolves on child crash', async () => {
    const child = makeFakeClaudeChild();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const { session, closed } = await createBrokerSession({ child, exposeClosed: true });

    (session as BrokerSession).sessionEnsure(BOOTSTRAP).catch(() => {});
    child.crash(1);

    // closed must resolve (with an Error on abnormal close).
    const result = await Promise.race([
      closed,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 500)),
    ]);
    expect(result).not.toBe('timeout');
  }, 2000);
});
