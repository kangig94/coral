import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
} from '#src/providers/contract.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import { codexTurnKernel } from '#src/providers/codex/thread-kernel.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_CODEX_PLAN } from '#tests/helpers/provider-credentials.js';

const RPC_BOUND_MS = 2_000;
const TEARDOWN_BOUND_MS = 2_000;

function appServer(lockPath: string) {
  const child = childProcess.spawn(
    process.execPath,
    [fileURLToPath(new URL('../../../fixtures/writer-lock-codex-appserver.cjs', import.meta.url)), lockPath],
    { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
  );
  const stdin = child.stdin ?? null;
  const stdout = child.stdout ?? null;
  const stderr = child.stderr ?? null;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const methods: string[] = [];
  let nextId = 0;
  let failure: Error | null = null;
  const fail = (error: Error): void => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
  };
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => {
      if (child.pid === undefined) resolve();
    });
  });
  child.once('exit', (code, signal) => fail(new Error(`Fixture app-server exited (code=${code}, signal=${signal}).`)));
  child.on('error', fail);
  stdin?.on('error', fail);
  stderr?.resume();
  if (stdin === null || stdout === null || stderr === null) fail(new Error('Fixture stdio unavailable.'));
  const reader = stdout === null ? null : createInterface({ input: stdout });
  reader?.on('line', (line) => {
    const message = JSON.parse(line) as { id: number; result?: unknown; error?: { code: number; message: string } };
    const request = pending.get(message.id);
    if (request === undefined) return;
    if (message.error === undefined) request.resolve(message.result);
    else request.reject(new Error(`${message.error.message} [code=${message.error.code}]`));
  });
  const lease: AppServerSession = {
    rpc: <Result>(method: string, params: Record<string, unknown>) =>
      new Promise<Result>((resolve, reject) => {
        if (failure !== null || stdin === null) {
          reject(failure ?? new Error('Fixture stdin unavailable.'));
          return;
        }
        const id = ++nextId;
        methods.push(method);
        const finish = () => {
          clearTimeout(timer);
          pending.delete(id);
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error(`Fixture RPC '${method}' did not reply within ${RPC_BOUND_MS} ms.`));
        }, RPC_BOUND_MS);
        pending.set(id, {
          resolve: (value) => {
            finish();
            resolve(value as Result);
          },
          reject: (error) => {
            finish();
            reject(error);
          },
        });
        stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error !== null && error !== undefined) fail(error);
        });
      }),
    subscribe: () => () => {},
    closed: exited,
    interrupt: async () => ({ kind: 'not-accepted', reason: 'No active fixture turn' }),
  };
  let closing: Promise<void> | undefined;
  return {
    child,
    lease,
    methods,
    close() {
      closing ??= (async () => {
        fail(new Error('Fixture app-server is closing.'));
        if (stdin !== null && !stdin.destroyed) stdin.end();
        if (child.connected) child.disconnect();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Fixture teardown exceeded its bound.')), TEARDOWN_BOUND_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          reader?.close();
          stdin?.destroy();
          stdout?.destroy();
          stderr?.destroy();
        }
      })();
      return closing;
    },
  };
}

async function withAppServers(
  run: (a: ReturnType<typeof appServer>, b: ReturnType<typeof appServer>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-thread-writer-test-'));
  const servers: ReturnType<typeof appServer>[] = [];
  let failure: Error | null = null;
  try {
    const a = appServer(join(directory, 'writer.lock'));
    servers.push(a);
    const b = appServer(join(directory, 'writer.lock'));
    servers.push(b);
    await run(a, b);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  const closed = await Promise.allSettled(servers.map((server) => server.close()));
  rmSync(directory, { recursive: true, force: true });
  const failures = closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(failure === null ? failures : [failure, ...failures], 'Fixture cleanup failed.');
  }
  if (failure !== null) throw failure;
}

function runtime(lease: AppServerSession): ProviderAppServerRuntime<CodexExecutionPlan> {
  return {
    transport: 'app-server',
    appServerSession: lease,
    signal: new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    storage: {
      existsSync: () => false,
      statSync: () => {
        throw Object.assign(new Error('Missing fixture config'), { code: 'ENOENT' });
      },
    } as unknown as ProviderAppServerRuntime<CodexExecutionPlan>['storage'],
    continuityBridge: { checkpoint: () => {}, transportClosed: () => {} },
    onProviderTurnTerminal: () => {},
    kbRoot: '/mock/kb',
    executionPlan: TEST_CODEX_PLAN,
  };
}

async function execute(lease: AppServerSession, action: 'exec' | 'resume'): Promise<ProviderEventBody[]> {
  const request: ProviderRequest = {
    action,
    jobId: 'job-cross-host',
    name: 'codex',
    prompt: 'Continue',
    ...(action === 'resume' ? { conversationRef: 'thread-shared' } : {}),
    cwd: fixtureCanonicalWorkDir('/workspace'),
    bypassPermissions: false,
    coralEnv: {},
  };
  const events: ProviderEventBody[] = [];
  for await (const event of codexTurnKernel(request, runtime(lease))) events.push(event);
  return events;
}

it('resumes execution N+1 on host B while host A stays alive after releasing execution N', async () => {
  await withAppServers(async (a, b) => {
    const first = await execute(a.lease, 'exec');
    expect(first.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
    });
    const next = await execute(b.lease, 'resume');
    expect(next.find((event) => event.kind === 'terminal')).toMatchObject({
      terminal: { outcome: { kind: 'completed' } },
    });
    expect(a.child.exitCode).toBeNull();
    expect(b.child.exitCode).toBeNull();
    expect(await a.lease.rpc('fixture/state', {})).toEqual({ loaded: false });
    expect(a.methods.filter((method) => method === 'thread/unsubscribe')).toHaveLength(1);
    expect(b.methods.filter((method) => method === 'thread/resume').length).toBeGreaterThanOrEqual(1);
    expect(b.methods.filter((method) => method === 'thread/resume').length).toBeLessThanOrEqual(4);
  });
});
