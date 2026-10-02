import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  buildClaudeChildArgs,
  buildClaudePrintChildArgs,
  createClaudeBrokerServer,
} from '#src/providers/claude/appserver/server.js';
import type {
  BrokerShutdownDisposition,
  ClaudeBrokerSession,
  SpawnClaudeChildOptions,
  SpawnClaudePrintChildOptions,
} from '#src/providers/claude/appserver/session-contract.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';

async function waitForOutput(lines: string[], length: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (lines.length >= length) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for Claude broker output.');
}

function spawnOptions(overrides: Partial<SpawnClaudeChildOptions> = {}): SpawnClaudeChildOptions {
  return {
    cwd: '/workspace',
    conversationRef: TEST_SESSION_ID,
    resume: false,
    permissionMode: 'default',
    ...overrides,
  };
}

function printSpawnOptions(overrides: Partial<SpawnClaudePrintChildOptions> = {}): SpawnClaudePrintChildOptions {
  return {
    cwd: '/workspace',
    resume: false,
    permissionMode: 'default',
    ...overrides,
  };
}

describe('claude appserver PTY child args', () => {
  it('resumes existing sessions and carries bootstrap options at process start', () => {
    expect(
      buildClaudeChildArgs(
        spawnOptions({
          conversationRef: 'session-existing',
          resume: true,
          systemPrompt: 'Stay concise.',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          permissionMode: 'acceptEdits',
        }),
      ),
    ).toEqual([
      '--resume',
      'session-existing',
      '--append-system-prompt',
      'Stay concise.',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
    ]);
  });
});

describe('claude appserver print child args', () => {
  it('resumes existing print-mode sessions and carries bootstrap options', () => {
    expect(
      buildClaudePrintChildArgs(
        printSpawnOptions({
          conversationRef: 'session-existing',
          resume: true,
          systemPrompt: 'Stay concise.',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          permissionMode: 'acceptEdits',
        }),
      ),
    ).toEqual([
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--resume',
      'session-existing',
      '--append-system-prompt',
      'Stay concise.',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
    ]);
  });
});

describe('Claude broker shutdown disposition', () => {
  it('returns a reachable hold response and exits only after observed child absence', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    let pendingOutput = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      pendingOutput += chunk;
      const complete = pendingOutput.split('\n');
      pendingOutput = complete.pop() ?? '';
      lines.push(...complete);
    });
    const observedAbsent = { kind: 'observed-absent', observation: 'absent' } as const;
    const held: BrokerShutdownDisposition = {
      kind: 'held-unobservable',
      observation: 'unobservable',
      subjects: [{ kind: 'claude-child', controller: 'print', generation: 1 }],
      successor: { kind: 'accepted', owner: 'broker-session-pool' },
      settled: new Promise(() => {}),
      retry: async () => observedAbsent,
      operatorExit: { kind: 'retry-broker-shutdown' },
    };
    const shutdown = vi
      .fn<() => Promise<BrokerShutdownDisposition>>()
      .mockResolvedValueOnce(held)
      .mockResolvedValueOnce(observedAbsent);
    const session = {
      closed: new Promise<Error | void>(() => {}),
      shutdown,
      subscribeNotifications: () => () => {},
    } as unknown as ClaudeBrokerSession;
    const exit = vi.fn<(code: number) => void>();
    const server = createClaudeBrokerServer({ input, output, session, exit });
    server.start();

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'broker/shutdown' })}\n`);
    await waitForOutput(lines, 1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      result: {
        ok: false,
        disposition: 'held-unobservable',
        subjects: [{ kind: 'claude-child', controller: 'print', generation: 1 }],
        successor: { kind: 'accepted', owner: 'broker-session-pool' },
        operatorExit: { kind: 'retry-broker-shutdown' },
      },
    });
    expect(exit).not.toHaveBeenCalled();

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'broker/shutdown' })}\n`);
    await waitForOutput(lines, 2);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
      result: { ok: true, disposition: 'observed-absent' },
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
