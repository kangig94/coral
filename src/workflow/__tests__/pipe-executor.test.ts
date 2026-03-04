import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as runnerProgress from '../../runner/progress.js';
import {
  appendProgressEvent,
  createSessionDir,
  PROGRESS_FILE,
  writeSessionError,
  writeSessionResult,
} from '../../runner/progress.js';
import type { SessionProvider } from '../../runner/types.js';
import { jsonResult, textResult } from '../../shared/mcp-utils.js';
import { parseExpression } from '../pipe-parser.js';
import {
  BOOTSTRAP_TIMEOUT_MS,
  BUSY_PREFIX,
  SIBLING_DRAIN_TIMEOUT_MS,
  executePipeline,
  formatStepOutput,
  readLaunchBootstrapStatus,
  waitForAllAtoms,
  type AtomDispatchFn,
  type LaunchedAtom,
} from '../pipe-executor.js';

const dirsToClean = new Set<string>();

afterEach(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirsToClean.clear();
  vi.restoreAllMocks();
});

function registerSession(
  label: string,
  provider: SessionProvider,
  output?: string,
): { session: string; session_dir: string } {
  const { id, dir } = createSessionDir(label, provider);
  dirsToClean.add(dir);
  if (output !== undefined) {
    writeSessionResult(dir, output, { session_name: label });
  }
  return { session: id, session_dir: dir };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLaunchedAtom(
  session: { session: string; session_dir: string },
  agent: string,
  stepIndex = 0,
): LaunchedAtom {
  return {
    session: session.session,
    sessionDir: session.session_dir,
    agent,
    tagName: agent,
    providerTool: 'codex',
    stepIndex,
    resumeOp: `coral:${agent}`,
  };
}

describe('workflow pipe executor', () => {
  it('formatStepOutput returns unwrapped output for one atom', () => {
    expect(formatStepOutput([{ tagName: 'architect', output: 'hello' }])).toBe('hello');
  });

  it('formatStepOutput wraps multiple outputs in xml tags', () => {
    expect(formatStepOutput([
      { tagName: 'architect', output: 'A' },
      { tagName: 'critic', output: 'B' },
    ])).toBe('<architect>\nA\n</architect>\n\n<critic>\nB\n</critic>');
  });

  it('executes a single-step pipeline', async () => {
    const dispatchCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const dispatch: AtomDispatchFn = async (tool, args) => {
      dispatchCalls.push({ tool, args });
      return jsonResult(registerSession('architect', tool, 'architect output'));
    };

    const output = await executePipeline(parseExpression('architect'), 'hello', 'codex', dispatch);

    expect(output).toBe('architect output');
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].tool).toBe('codex');
    expect(dispatchCalls[0].args).toMatchObject({ op: 'coral:architect', prompt: 'hello' });
  });

  it('chains step output into the next step prompt', async () => {
    const prompts: string[] = [];
    const dispatch: AtomDispatchFn = async (tool, args) => {
      const op = String(args.op);
      prompts.push(String(args.prompt));
      if (op === 'coral:architect') {
        return jsonResult(registerSession('architect', tool, 'step-1-output'));
      }
      return jsonResult(registerSession('resolver', tool, 'step-2-output'));
    };

    const output = await executePipeline(parseExpression('architect -> resolver'), 'seed prompt', 'codex', dispatch);

    expect(output).toBe('step-2-output');
    expect(prompts).toEqual(['seed prompt', 'step-1-output']);
  });

  it('formats parallel output and passes xml-wrapped content to downstream steps', async () => {
    let resolverPrompt = '';
    const dispatch: AtomDispatchFn = async (tool, args) => {
      const op = String(args.op);
      if (op === 'coral:architect') {
        return jsonResult(registerSession('architect', tool, 'ARCH'));
      }
      if (op === 'coral:critic') {
        return jsonResult(registerSession('critic', tool, 'CRIT'));
      }
      resolverPrompt = String(args.prompt);
      return jsonResult(registerSession('resolver', tool, 'FINAL'));
    };

    const output = await executePipeline(parseExpression('(architect, critic) -> resolver'), 'seed', 'codex', dispatch);

    expect(output).toBe('FINAL');
    expect(resolverPrompt).toContain('<architect>\nARCH\n</architect>');
    expect(resolverPrompt).toContain('<critic>\nCRIT\n</critic>');
  });

  it('honors per-atom provider override', async () => {
    const providers: string[] = [];
    const dispatch: AtomDispatchFn = async (tool, args) => {
      providers.push(tool);
      const op = String(args.op);
      if (op === 'coral:architect') return jsonResult(registerSession('architect', tool, 'A'));
      return jsonResult(registerSession('resolver', tool, 'B'));
    };

    await executePipeline(parseExpression('architect@claude -> resolver'), 'seed', 'codex', dispatch);

    expect(providers).toEqual(['claude', 'codex']);
  });

  it('dispatches prompt atom with op coral:workflow-literal', async () => {
    const dispatch = vi.fn<AtomDispatchFn>(async (tool, _args) =>
      jsonResult(registerSession('workflow-literal', tool, 'literal output')));

    const output = await executePipeline(parseExpression('\'summarize\''), 'seed', 'codex', dispatch);

    expect(output).toBe('literal output');
    expect(dispatch).toHaveBeenCalledWith('codex', expect.objectContaining({
      op: 'coral:workflow-literal',
      prompt: 'summarize',
    }));
  });

  it('prompt atom uses literal text only for first step (no previous output)', async () => {
    const prompts: string[] = [];
    const dispatch: AtomDispatchFn = async (tool, args) => {
      prompts.push(String(args.prompt));
      return jsonResult(registerSession('workflow-literal', tool, 'literal output'));
    };

    await executePipeline(parseExpression('\'summarize\''), 'seed context', 'codex', dispatch);

    expect(prompts).toEqual(['summarize']);
  });

  it('prompt atom prepends literal before previous output for middle step', async () => {
    let promptLiteralPrompt = '';
    const dispatch: AtomDispatchFn = async (tool, args) => {
      const op = String(args.op);
      if (op === 'coral:architect') {
        return jsonResult(registerSession('architect', tool, 'ARCH_OUTPUT'));
      }
      promptLiteralPrompt = String(args.prompt);
      return jsonResult(registerSession('workflow-literal', tool, 'SUMMARIZED'));
    };

    await executePipeline(parseExpression('architect -> \'summarize\''), 'seed', 'codex', dispatch);

    expect(promptLiteralPrompt).toBe('summarize\n\nARCH_OUTPUT');
  });

  it('formats prompt atom output with step-result tag in parallel group', async () => {
    let resolverPrompt = '';
    const dispatch: AtomDispatchFn = async (tool, args) => {
      const op = String(args.op);
      if (op === 'coral:architect') {
        return jsonResult(registerSession('architect', tool, 'ARCH'));
      }
      if (op === 'coral:workflow-literal') {
        return jsonResult(registerSession('workflow-literal', tool, 'SUM'));
      }
      resolverPrompt = String(args.prompt);
      return jsonResult(registerSession('resolver', tool, 'FINAL'));
    };

    await executePipeline(parseExpression('(architect, \'summarize\') -> resolver'), 'seed', 'codex', dispatch);

    expect(resolverPrompt).toContain('<architect>\nARCH\n</architect>');
    expect(resolverPrompt).toContain('<step-result>\nSUM\n</step-result>');
  });

  it('prompt atom respects @provider override', async () => {
    const providers: string[] = [];
    const dispatch: AtomDispatchFn = async (tool, _args) => {
      providers.push(tool);
      return jsonResult(registerSession('workflow-literal', tool, 'done'));
    };

    await executePipeline(parseExpression('\'text\'@claude'), 'seed', 'codex', dispatch);

    expect(providers).toEqual(['claude']);
  });

  it('uses prompt diagnostic labels in progress messages', async () => {
    const progress: string[] = [];
    let attempts = 0;
    const dispatch: AtomDispatchFn = async (tool) => {
      attempts += 1;
      if (attempts === 1) {
        return textResult(`Error: ${BUSY_PREFIX}1/1 total, 1/1 for ${tool})`, true);
      }
      return jsonResult(registerSession('workflow-literal', tool, 'done'));
    };

    await executePipeline(parseExpression('\'abcdefghijklmnopqrstuvwxyz\''), 'seed', 'codex', dispatch, {
      onProgress: (message) => progress.push(message),
    });

    expect(progress.some((message) =>
      message.includes('atom prompt#1(abcdefghijklmnopqrst...) busy (attempt 1), retrying'))).toBe(true);
  });

  it('rejects non-coral namespaces in v1', async () => {
    const dispatch: AtomDispatchFn = async () => jsonResult(registerSession('noop', 'codex', 'x'));
    await expect(
      executePipeline(parseExpression('some-plugin:agent'), 'seed', 'codex', dispatch),
    ).rejects.toThrow('unsupported namespace');
  });

  it('fails with launch diagnostics when nested dispatch returns isError', async () => {
    const dispatch: AtomDispatchFn = async () => textResult('Error: launch failed', true);
    await expect(
      executePipeline(parseExpression('architect'), 'seed', 'codex', dispatch),
    ).rejects.toThrow("Step 1, atom 'architect' launch failed");
  });

  it('fails with launch diagnostics when nested launch payload is malformed', async () => {
    const dispatch: AtomDispatchFn = async () => jsonResult({ session: 'only-session' });
    await expect(
      executePipeline(parseExpression('architect'), 'seed', 'codex', dispatch),
    ).rejects.toThrow('missing session/session_dir');
  });

  it('forwards execution args into nested dispatch payload', async () => {
    const dispatch = vi.fn<AtomDispatchFn>(async (tool, _args) => {
      return jsonResult(registerSession('architect', tool, 'done'));
    });

    await executePipeline(
      parseExpression('architect'),
      'seed',
      'codex',
      dispatch,
      {
        args: {
          architect: {
            model: 'o4-mini',
            working_directory: '/tmp/workflow-test',
            effort: 'high',
          },
        },
      },
    );

    expect(dispatch).toHaveBeenCalledWith('codex', expect.objectContaining({
      op: 'coral:architect',
      model: 'o4-mini',
      working_directory: '/tmp/workflow-test',
      effort: 'high',
    }));
  });

  it('injects files, flags, and extra args into atom prompt context', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'workflow-exec-context-'));
    dirsToClean.add(tmp);
    const filePath = join(tmp, 'note.txt');
    writeFileSync(filePath, 'note content', 'utf-8');

    let receivedPrompt = '';
    const dispatch: AtomDispatchFn = async (tool, args) => {
      receivedPrompt = String(args.prompt);
      return jsonResult(registerSession('architect', tool, 'done'));
    };

    await executePipeline(
      parseExpression('architect'),
      'seed',
      'codex',
      dispatch,
      {
        args: {
          architect: {
            files: [filePath],
            flags: ['--a', '--b'],
            ticket: 7,
          },
        },
      },
    );

    expect(receivedPrompt).toContain(`<file path="${filePath}">\nnote content\n</file>`);
    expect(receivedPrompt).toContain('Flags: --a --b');
    expect(receivedPrompt).toContain('"ticket": 7');
  });

  it('rejects bypass inside args in v1', async () => {
    const dispatch: AtomDispatchFn = async () => jsonResult(registerSession('architect', 'codex', 'done'));
    await expect(
      executePipeline(
        parseExpression('architect'),
        'seed',
        'codex',
        dispatch,
        { args: { architect: { bypass: true } } },
      ),
    ).rejects.toThrow('args.architect.bypass');
  });

  it('retries immediate busy launches and succeeds', async () => {
    let attempts = 0;
    const progress: string[] = [];
    const dispatch: AtomDispatchFn = async (tool) => {
      attempts += 1;
      if (attempts === 1) {
        return textResult(`Error: ${BUSY_PREFIX}1/1 total, 1/1 for ${tool})`, true);
      }
      return jsonResult(registerSession('architect', tool, 'done'));
    };

    const output = await executePipeline(parseExpression('architect'), 'seed', 'codex', dispatch, {
      onProgress: (message) => progress.push(message),
    });

    expect(output).toBe('done');
    expect(attempts).toBe(2);
    expect(progress.some((message) => message.includes('busy (attempt 1), retrying'))).toBe(true);
  });

  it('retries async bootstrap busy errors and succeeds', async () => {
    let attempts = 0;
    const dispatch: AtomDispatchFn = async (tool) => {
      attempts += 1;
      if (attempts === 1) {
        const launch = registerSession('architect-busy', tool);
        writeSessionError(launch.session_dir, `${BUSY_PREFIX}2/10 total, 2/6 for ${tool})`);
        return jsonResult(launch);
      }
      return jsonResult(registerSession('architect', tool, 'done'));
    };

    const output = await executePipeline(parseExpression('architect'), 'seed', 'codex', dispatch);

    expect(output).toBe('done');
    expect(attempts).toBe(2);
  });

  it('fails deterministically after busy retry exhaustion', async () => {
    const dispatch: AtomDispatchFn = async (tool) =>
      textResult(`Error: ${BUSY_PREFIX}10/10 total, 6/6 for ${tool})`, true);

    await expect(
      executePipeline(parseExpression('architect'), 'seed', 'codex', dispatch),
    ).rejects.toThrow('capacity busy after 3 attempts');
  });

  it('waitForAllAtoms aborts siblings after first failure and throws first error', async () => {
    const failed = registerSession('failed', 'codex');
    const sibling = registerSession('sibling', 'codex');

    setTimeout(() => {
      writeSessionError(failed.session_dir, 'primary failure');
    }, 20);

    const atoms: LaunchedAtom[] = [
      {
        session: failed.session,
        sessionDir: failed.session_dir,
        agent: 'architect',
        tagName: 'architect',
        providerTool: 'codex',
        stepIndex: 0,
        resumeOp: 'coral:architect',
      },
      {
        session: sibling.session,
        sessionDir: sibling.session_dir,
        agent: 'critic',
        tagName: 'critic',
        providerTool: 'codex',
        stepIndex: 0,
        resumeOp: 'coral:critic',
      },
    ];

    const requestAbort = vi.fn(async ({ session }: { session: string }) => {
      if (session === sibling.session) {
        writeSessionError(sibling.session_dir, 'abort requested');
      }
    });

    await expect(
      waitForAllAtoms(atoms, undefined, () => {}, requestAbort),
    ).rejects.toThrow("Step 1, atom 'architect' failed: primary failure");

    expect(requestAbort).toHaveBeenCalledWith(expect.objectContaining({
      session: sibling.session,
      agent: 'critic',
    }));
  });

  it('reports progress for step and atom lifecycle events', async () => {
    const progress: string[] = [];
    const dispatch: AtomDispatchFn = async (tool) => jsonResult(registerSession('architect', tool, 'done'));

    await executePipeline(parseExpression('architect'), 'seed', 'codex', dispatch, {
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toContain('step 1 started');
    expect(progress).toContain('step 1 atom architect completed');
    expect(progress).toContain('step 1 completed');
  });

  it('handles mixed parallel and sequential stages', async () => {
    const seenPrompts: string[] = [];
    const dispatch: AtomDispatchFn = async (tool, args) => {
      const op = String(args.op);
      if (op === 'coral:a') return jsonResult(registerSession('a', tool, 'A'));
      if (op === 'coral:b') return jsonResult(registerSession('b', tool, 'B'));
      if (op === 'coral:c') {
        seenPrompts.push(String(args.prompt));
        return jsonResult(registerSession('c', tool, 'C'));
      }
      seenPrompts.push(String(args.prompt));
      return jsonResult(registerSession('d', tool, 'D'));
    };

    const output = await executePipeline(parseExpression('(a, b) -> c -> d'), 'seed', 'codex', dispatch);

    expect(output).toBe('D');
    expect(seenPrompts[0]).toContain('<a>\nA\n</a>');
    expect(seenPrompts[0]).toContain('<b>\nB\n</b>');
    expect(seenPrompts[1]).toBe('C');
  });

  it('starts parallel atom launches concurrently', async () => {
    const callTimes: number[] = [];
    let firstResolveAt = Number.POSITIVE_INFINITY;

    const dispatch: AtomDispatchFn = async (tool, args) => {
      callTimes.push(Date.now());
      await sleep(60);
      const launch = registerSession(String(args.op), tool, String(args.op));
      firstResolveAt = Math.min(firstResolveAt, Date.now());
      return jsonResult(launch);
    };

    await executePipeline(parseExpression('(architect, critic)'), 'seed', 'codex', dispatch);

    expect(callTimes).toHaveLength(2);
    expect(callTimes[1]).toBeLessThanOrEqual(firstResolveAt);
  });

  it('readLaunchBootstrapStatus returns aborted when signal is aborted', async () => {
    const launch = registerSession('bootstrap-abort', 'codex');
    const controller = new AbortController();
    controller.abort();

    const result = await readLaunchBootstrapStatus(launch.session_dir, controller.signal);
    expect(result).toEqual({ kind: 'error', error: 'aborted during bootstrap' });
  });

  it('readLaunchBootstrapStatus treats long-running bootstrap as running after timeout', async () => {
    const launch = registerSession('bootstrap-running', 'codex');
    const started = Date.now();
    const status = await readLaunchBootstrapStatus(launch.session_dir);

    expect(status).toEqual({ kind: 'running' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(BOOTSTRAP_TIMEOUT_MS - 50);
  }, BOOTSTRAP_TIMEOUT_MS + 500);

  it('formatStepOutput returns empty string for empty results array', () => {
    expect(formatStepOutput([])).toBe('');
  });

  it('formatStepOutput wraps empty output string in xml tags for multiple results', () => {
    const result = formatStepOutput([
      { tagName: 'a', output: '' },
      { tagName: 'b', output: 'X' },
    ]);
    expect(result).toBe('<a>\n\n</a>\n\n<b>\nX\n</b>');
  });

  it('formatStepOutput passes through empty string output for a single result', () => {
    expect(formatStepOutput([{ tagName: 'a', output: '' }])).toBe('');
  });

  it('waitForAllAtoms throws abort error immediately when signal is already aborted', async () => {
    const completed = registerSession('done', 'codex', 'output');
    const atoms: LaunchedAtom[] = [{
      session: completed.session,
      sessionDir: completed.session_dir,
      agent: 'a',
      tagName: 'a',
      providerTool: 'codex',
      stepIndex: 0,
      resumeOp: 'coral:a',
    }];
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForAllAtoms(atoms, controller.signal, () => {}, async () => {}),
    ).rejects.toThrow('Pipeline aborted');
  });

  it('waitForAllAtoms throws firstFailure when siblings settle naturally before drain deadline', async () => {
    const failed = registerSession('settle-fail', 'codex');
    const sibling = registerSession('settle-sibling', 'codex');
    writeSessionError(failed.session_dir, 'atom-failure');

    const atoms: LaunchedAtom[] = [
      {
        session: failed.session,
        sessionDir: failed.session_dir,
        agent: 'fail-agent',
        tagName: 'fail-agent',
        providerTool: 'codex',
        stepIndex: 2,
        resumeOp: 'coral:fail-agent',
      },
      {
        session: sibling.session,
        sessionDir: sibling.session_dir,
        agent: 'sibling-agent',
        tagName: 'sibling-agent',
        providerTool: 'codex',
        stepIndex: 2,
        resumeOp: 'coral:sibling-agent',
      },
    ];

    const requestAbort = vi.fn(async () => {
      writeSessionError(sibling.session_dir, 'sibling aborted');
    });

    await expect(
      waitForAllAtoms(atoms, undefined, () => {}, requestAbort),
    ).rejects.toThrow("Step 3, atom 'fail-agent' failed: atom-failure");
  });

  it('waitForAllAtoms throws firstFailure when drain deadline expires with sibling still pending', async () => {
    const failed = registerSession('deadline-fail', 'codex');
    const hanging = registerSession('deadline-hang', 'codex');
    writeSessionError(failed.session_dir, 'primary-fail');

    const atoms: LaunchedAtom[] = [
      {
        session: failed.session,
        sessionDir: failed.session_dir,
        agent: 'failed',
        tagName: 'failed',
        providerTool: 'codex',
        stepIndex: 0,
        resumeOp: 'coral:failed',
      },
      {
        session: hanging.session,
        sessionDir: hanging.session_dir,
        agent: 'hanging',
        tagName: 'hanging',
        providerTool: 'codex',
        stepIndex: 0,
        resumeOp: 'coral:hanging',
      },
    ];

    // Mock Date.now to advance past SIBLING_DRAIN_TIMEOUT_MS after abort is triggered
    let callCount = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount += 1;
      if (callCount > 6) return realNow() + SIBLING_DRAIN_TIMEOUT_MS + 1_000;
      return realNow();
    });

    try {
      await expect(
        waitForAllAtoms(atoms, undefined, () => {}, async () => {}),
      ).rejects.toThrow("Step 1, atom 'failed' failed: primary-fail");
    } finally {
      nowSpy.mockRestore();
    }
  });

  describe('atom progress forwarding', () => {
    it('forwards atom progress with agent-prefixed messages', async () => {
      const completed = registerSession('forward-progress', 'codex');
      appendProgressEvent(join(completed.session_dir, PROGRESS_FILE), 'item.completed', 'inner message');
      writeSessionResult(completed.session_dir, 'done', { session_name: 'forward-progress' });

      const progress: string[] = [];
      const finalOverlay = await waitForAllAtoms(
        [makeLaunchedAtom(completed, 'architect')],
        undefined,
        (message) => progress.push(message),
        async () => {},
      );

      expect(progress).toContain('atom architect: inner message');
      expect(progress).toContain('step 1 atom architect completed');
      expect(finalOverlay.get('architect')).toEqual({
        session: completed.session,
        sessionDir: completed.session_dir,
      });
    });
  });

  describe('atom progress forwarding (no progress.jsonl)', () => {
    it('ignores missing progress file and still completes', async () => {
      const completed = registerSession('forward-missing-file', 'codex');
      rmSync(join(completed.session_dir, PROGRESS_FILE), { force: true });
      writeSessionResult(completed.session_dir, 'done', { session_name: 'forward-missing-file' });

      const progress: string[] = [];
      await waitForAllAtoms(
        [makeLaunchedAtom(completed, 'architect')],
        undefined,
        (message) => progress.push(message),
        async () => {},
      );

      expect(progress.some((message) => message.startsWith('atom architect:'))).toBe(false);
      expect(progress).toContain('step 1 atom architect completed');
    });
  });

  describe('terminal-tail progress read', () => {
    it('forwards final events before terminal removal', async () => {
      const completed = registerSession('terminal-tail', 'codex');
      writeSessionResult(completed.session_dir, 'done', { session_name: 'terminal-tail' });

      let readCount = 0;
      vi.spyOn(runnerProgress, 'readProgressEvents').mockImplementation(() => {
        readCount += 1;
        if (readCount === 2) {
          return [{ ts: 1, event: 'item.completed', message: 'tail message' }];
        }
        return [];
      });

      const progress: string[] = [];
      await waitForAllAtoms(
        [makeLaunchedAtom(completed, 'architect')],
        undefined,
        (message) => progress.push(message),
        async () => {},
      );

      const tailIndex = progress.indexOf('atom architect: tail message');
      const terminalIndex = progress.indexOf('step 1 atom architect completed');
      expect(tailIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThanOrEqual(0);
      expect(tailIndex).toBeLessThan(terminalIndex);
    });
  });

  describe('stale atom detection', () => {
    it('triggers abort after stale timeout', async () => {
      const stale = registerSession('stale-detect', 'codex');
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) {
          writeSessionError(stale.session_dir, 'stale abort');
        }
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () => textResult('cannot resume', true));

      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(stale, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' resume failed: non-resumable session");

      expect(requestAbort).toHaveBeenCalledWith(expect.objectContaining({
        session: stale.session,
        agent: 'architect',
      }));
    });
  });

  describe('stale atom resume', () => {
    it('resumes with a new session and returns updated overlay', async () => {
      const stale = registerSession('stale-resume-old', 'codex');
      const resumed = registerSession('stale-resume-new', 'codex');

      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) {
          writeSessionError(stale.session_dir, 'stale abort');
        }
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () => {
        setTimeout(() => {
          writeSessionResult(resumed.session_dir, 'done', { session_name: 'stale-resume-new' });
        }, 20);
        return jsonResult({ session: resumed.session, session_dir: resumed.session_dir, status: 'running' });
      });

      const progress: string[] = [];
      const finalOverlay = await waitForAllAtoms(
        [makeLaunchedAtom(stale, 'architect')],
        undefined,
        (message) => progress.push(message),
        requestAbort,
        { staleTimeoutMs: 10, dispatch },
      );

      expect(progress).toContain('atom architect resuming (attempt 1)');
      expect(dispatch).toHaveBeenCalledWith('codex', expect.objectContaining({
        op: 'coral:architect',
        session: stale.session,
        prompt: 'Your previous execution timed out due to inactivity. Continue where you left off.',
      }));
      expect(finalOverlay.get('architect')).toEqual({
        session: resumed.session,
        sessionDir: resumed.session_dir,
      });
    });
  });

  describe('stale timeout disabled', () => {
    it('does not trigger abort or resume when staleTimeoutMs is zero', async () => {
      const running = registerSession('stale-disabled', 'codex');
      setTimeout(() => {
        writeSessionResult(running.session_dir, 'done', { session_name: 'stale-disabled' });
      }, 20);

      const requestAbort = vi.fn(async () => {});
      const dispatch = vi.fn<AtomDispatchFn>(async () => jsonResult(registerSession('unexpected', 'codex', 'done')));

      await waitForAllAtoms(
        [makeLaunchedAtom(running, 'architect')],
        undefined,
        () => {},
        requestAbort,
        { staleTimeoutMs: 0, dispatch },
      );

      expect(requestAbort).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('stale expected-abort isolation', () => {
    it('does not abort siblings when stale recovery succeeds', async () => {
      const stale = registerSession('stale-isolation-old', 'codex');
      const sibling = registerSession('stale-isolation-sibling', 'codex');
      const resumed = registerSession('stale-isolation-new', 'codex');

      const abortedSessions: string[] = [];
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        abortedSessions.push(session);
        if (session === stale.session) {
          writeSessionError(stale.session_dir, 'stale abort');
        }
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () => {
        setTimeout(() => {
          writeSessionResult(resumed.session_dir, 'done', { session_name: 'stale-isolation-new' });
          writeSessionResult(sibling.session_dir, 'done', { session_name: 'stale-isolation-sibling' });
        }, 20);
        return jsonResult({ session: resumed.session, session_dir: resumed.session_dir, status: 'running' });
      });

      const finalOverlay = await waitForAllAtoms(
        [makeLaunchedAtom(stale, 'architect'), makeLaunchedAtom(sibling, 'critic')],
        undefined,
        () => {},
        requestAbort,
        { staleTimeoutMs: 10, dispatch },
      );

      expect(abortedSessions).toEqual([stale.session]);
      expect(finalOverlay.get('architect')).toEqual({
        session: resumed.session,
        sessionDir: resumed.session_dir,
      });
      expect(finalOverlay.get('critic')).toEqual({
        session: sibling.session,
        sessionDir: sibling.session_dir,
      });
    });
  });

  describe('stale resume failure stops workflow', () => {
    it('throws when resume dispatch reports non-resumable session', async () => {
      const stale = registerSession('stale-resume-fail', 'codex');
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) {
          writeSessionError(stale.session_dir, 'stale abort');
        }
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () => textResult('resume failed', true));

      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(stale, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' resume failed: non-resumable session");
    });
  });

  describe('stale max retries stops workflow', () => {
    it('throws after two recovery attempts are exhausted', async () => {
      const first = registerSession('stale-retry-0', 'codex');
      const second = registerSession('stale-retry-1', 'codex');
      const third = registerSession('stale-retry-2', 'codex');

      const sessionDirs = new Map<string, string>([
        [first.session, first.session_dir],
        [second.session, second.session_dir],
        [third.session, third.session_dir],
      ]);
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        const dir = sessionDirs.get(session);
        if (dir) writeSessionError(dir, 'stale abort');
      });

      let resumeCount = 0;
      const dispatch = vi.fn<AtomDispatchFn>(async () => {
        resumeCount += 1;
        if (resumeCount === 1) {
          return jsonResult({ session: second.session, session_dir: second.session_dir, status: 'running' });
        }
        return jsonResult({ session: third.session, session_dir: third.session_dir, status: 'running' });
      });

      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(first, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' stale after 2 recovery attempts");

      expect(dispatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('stale resume response validation', () => {
    it('throws explicit error for malformed resume JSON response', async () => {
      const stale = registerSession('stale-resume-malformed', 'codex');
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) {
          writeSessionError(stale.session_dir, 'stale abort');
        }
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () => textResult('not-json'));

      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(stale, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' resume returned malformed JSON");
    });
  });

  it('rejects bypass: false (property presence triggers rejection, not truthiness)', async () => {
    const dispatch: AtomDispatchFn = async () => jsonResult(registerSession('a', 'codex', 'done'));
    await expect(
      executePipeline(parseExpression('a'), 'seed', 'codex', dispatch, { args: { a: { bypass: false } } }),
    ).rejects.toThrow('bypass');
  });

  it('accepts empty files array without injecting file context into prompt', async () => {
    let capturedPrompt = '';
    const dispatch: AtomDispatchFn = async (tool, args) => {
      capturedPrompt = String(args.prompt);
      return jsonResult(registerSession('a', tool, 'done'));
    };

    await executePipeline(parseExpression('a'), 'seed', 'codex', dispatch, { args: { a: { files: [] } } });

    expect(capturedPrompt).not.toContain('<file');
    expect(capturedPrompt).toBe('seed');
  });

  it('accepts empty flags array without injecting Flags section into prompt', async () => {
    let capturedPrompt = '';
    const dispatch: AtomDispatchFn = async (tool, args) => {
      capturedPrompt = String(args.prompt);
      return jsonResult(registerSession('a', tool, 'done'));
    };

    await executePipeline(parseExpression('a'), 'seed', 'codex', dispatch, { args: { a: { flags: [] } } });

    expect(capturedPrompt).not.toContain('Flags:');
    expect(capturedPrompt).toBe('seed');
  });

  it('rejects mixed-type array for files arg', async () => {
    const dispatch: AtomDispatchFn = async () => jsonResult(registerSession('a', 'codex', 'done'));
    await expect(
      executePipeline(parseExpression('a'), 'seed', 'codex', dispatch, { args: { a: { files: ['readme.txt', 42] } } }),
    ).rejects.toThrow('args.files must be an array of strings');
  });

  it('applies args to all occurrences of the same atom name across sequential steps', async () => {
    const capturedModels: Array<string | undefined> = [];
    const dispatch: AtomDispatchFn = async (tool, args) => {
      capturedModels.push(args.model as string | undefined);
      const op = String(args.op);
      if (op === 'coral:a') return jsonResult(registerSession('a1', tool, 'step1'));
      return jsonResult(registerSession('a2', tool, 'step2'));
    };

    await executePipeline(parseExpression('a -> a'), 'seed', 'codex', dispatch, { args: { a: { model: 'o4-mini' } } });

    expect(capturedModels).toHaveLength(2);
    expect(capturedModels[0]).toBe('o4-mini');
    expect(capturedModels[1]).toBe('o4-mini');
  });

  it('readLaunchBootstrapStatus returns running immediately when session is already completed', async () => {
    const s = registerSession('already-done', 'codex', 'output');
    const result = await readLaunchBootstrapStatus(s.session_dir);
    expect(result).toEqual({ kind: 'running' });
  });

  it('readLaunchBootstrapStatus returns busy when error message starts with BUSY_PREFIX', async () => {
    const s = registerSession('busy-bootstrap', 'codex');
    writeSessionError(s.session_dir, `${BUSY_PREFIX}1/1 total, 1/1 for codex)`);
    const result = await readLaunchBootstrapStatus(s.session_dir);
    expect(result).toEqual({ kind: 'busy' });
  });

  it('readLaunchBootstrapStatus returns error for non-busy bootstrap failures', async () => {
    const s = registerSession('err-bootstrap', 'codex');
    writeSessionError(s.session_dir, 'disk full');
    const result = await readLaunchBootstrapStatus(s.session_dir);
    expect(result).toEqual({ kind: 'error', error: 'disk full' });
  });

  describe('waitForAllAtoms — empty atoms array', () => {
    it('returns an empty Map immediately when given zero atoms', async () => {
      const result = await waitForAllAtoms([], undefined, () => {}, async () => {});
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('waitForAllAtoms — returned overlay completeness', () => {
    it('overlay contains all launched atoms even when no stale recovery occurred', async () => {
      const s1 = registerSession('overlay-a', 'codex', 'out-a');
      const s2 = registerSession('overlay-b', 'codex', 'out-b');
      const overlay = await waitForAllAtoms(
        [makeLaunchedAtom(s1, 'alpha'), makeLaunchedAtom(s2, 'beta')],
        undefined,
        () => {},
        async () => {},
      );
      expect(overlay.get('alpha')).toEqual({ session: s1.session, sessionDir: s1.session_dir });
      expect(overlay.get('beta')).toEqual({ session: s2.session, sessionDir: s2.session_dir });
    });
  });

  describe('waitForAllAtoms — multiple events in one poll batch', () => {
    it('forwards all events from a single-read batch', async () => {
      const s = registerSession('multi-event', 'codex');
      appendProgressEvent(join(s.session_dir, PROGRESS_FILE), 'e', 'first event');
      appendProgressEvent(join(s.session_dir, PROGRESS_FILE), 'e', 'second event');
      writeSessionResult(s.session_dir, 'done', { session_name: 'multi-event' });
      const messages: string[] = [];
      await waitForAllAtoms(
        [makeLaunchedAtom(s, 'worker')],
        undefined,
        (msg) => messages.push(msg),
        async () => {},
      );
      expect(messages).toContain('atom worker: first event');
      expect(messages).toContain('atom worker: second event');
    });
  });

  describe('waitForAllAtoms — resume dispatch receives OLD session UUID', () => {
    it('passes the pre-recovery session UUID to the resume dispatch', async () => {
      const stale = registerSession('stale-old-uuid', 'codex');
      const resumed = registerSession('stale-new-uuid', 'codex');
      const capturedResumeArgs: Record<string, unknown>[] = [];
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) writeSessionError(stale.session_dir, 'stale abort');
      });
      const dispatch = vi.fn<AtomDispatchFn>(async (_tool, args) => {
        capturedResumeArgs.push({ ...args });
        setTimeout(() => {
          writeSessionResult(resumed.session_dir, 'done', { session_name: 'stale-new-uuid' });
        }, 20);
        return jsonResult({ session: resumed.session, session_dir: resumed.session_dir, status: 'running' });
      });
      await waitForAllAtoms(
        [makeLaunchedAtom(stale, 'architect')],
        undefined,
        () => {},
        requestAbort,
        { staleTimeoutMs: 10, dispatch },
      );
      expect(capturedResumeArgs).toHaveLength(1);
      expect(capturedResumeArgs[0].session).toBe(stale.session);
      expect(capturedResumeArgs[0].session).not.toBe(resumed.session);
    });
  });

  describe('waitForAllAtoms — second stale on same atom increments counter correctly', () => {
    it('throws after second recovery without a third dispatch call', async () => {
      const first = registerSession('second-stale-0', 'codex');
      const second = registerSession('second-stale-1', 'codex');
      const third = registerSession('second-stale-2', 'codex');
      const sessionDirMap = new Map([
        [first.session, first.session_dir],
        [second.session, second.session_dir],
        [third.session, third.session_dir],
      ]);
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        const dir = sessionDirMap.get(session);
        if (dir) writeSessionError(dir, 'stale abort');
      });
      let dispatchCount = 0;
      const dispatch = vi.fn<AtomDispatchFn>(async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          return jsonResult({ session: second.session, session_dir: second.session_dir, status: 'running' });
        }
        return jsonResult({ session: third.session, session_dir: third.session_dir, status: 'running' });
      });
      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(first, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' stale after 2 recovery attempts");
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('waitForAllAtoms — expectedStaleAbortSessions cleanup on abort mid-recovery', () => {
    it('cleans up when pipeline signal aborts after requestAbort', async () => {
      const stale = registerSession('mid-abort-stale', 'codex');
      const controller = new AbortController();
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) {
          writeSessionError(stale.session_dir, 'stale abort');
          controller.abort();
        }
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () =>
        jsonResult({ session: 'new-session', session_dir: '/tmp/new', status: 'running' }),
      );
      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(stale, 'architect')],
          controller.signal,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow('Pipeline aborted');
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('waitForAllAtoms — resume response validation edge cases', () => {
    it('throws when resume JSON has session field missing', async () => {
      const stale = registerSession('resume-no-session', 'codex');
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) writeSessionError(stale.session_dir, 'stale abort');
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () =>
        textResult(JSON.stringify({ session_dir: '/tmp/dir' })),
      );
      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(stale, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' resume returned invalid response");
    });

    it('throws when resume JSON has session_dir field missing', async () => {
      const stale = registerSession('resume-no-session-dir', 'codex');
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) writeSessionError(stale.session_dir, 'stale abort');
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () =>
        textResult(JSON.stringify({ session: 'abc-uuid' })),
      );
      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(stale, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' resume returned invalid response");
    });

    it('throws empty-response error when resume result has empty content array', async () => {
      const stale = registerSession('resume-empty-content', 'codex');
      const requestAbort = vi.fn(async ({ session }: { session: string }) => {
        if (session === stale.session) writeSessionError(stale.session_dir, 'stale abort');
      });
      const dispatch = vi.fn<AtomDispatchFn>(async () => ({
        content: [] as unknown as [{ type: 'text'; text: string }],
        isError: false,
      }));
      await expect(
        waitForAllAtoms(
          [makeLaunchedAtom(stale, 'architect')],
          undefined,
          () => {},
          requestAbort,
          { staleTimeoutMs: 10, dispatch },
        ),
      ).rejects.toThrow("Step 1, atom 'architect' resume returned empty response");
    });
  });
});
