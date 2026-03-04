import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionDir, writeSessionError, writeSessionResult } from '../../runner/progress.js';
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
            reasoning_effort: 'high',
          },
        },
      },
    );

    expect(dispatch).toHaveBeenCalledWith('codex', expect.objectContaining({
      op: 'coral:architect',
      model: 'o4-mini',
      working_directory: '/tmp/workflow-test',
      reasoning_effort: 'high',
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
      },
      {
        session: sibling.session,
        sessionDir: sibling.session_dir,
        agent: 'critic',
        tagName: 'critic',
        providerTool: 'codex',
        stepIndex: 0,
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
      },
      {
        session: sibling.session,
        sessionDir: sibling.session_dir,
        agent: 'sibling-agent',
        tagName: 'sibling-agent',
        providerTool: 'codex',
        stepIndex: 2,
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
      },
      {
        session: hanging.session,
        sessionDir: hanging.session_dir,
        agent: 'hanging',
        tagName: 'hanging',
        providerTool: 'codex',
        stepIndex: 0,
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
});
