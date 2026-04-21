import { spawn } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import type { ProviderCliRequest, ProviderCliRunner } from '../runner-port.js';
import { executeClaudeOneShot, executeClaudeResume } from '../claude/claude-executor.js';

const runCli: ProviderCliRunner = (request: ProviderCliRequest) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string is not a valid cwd
      cwd: request.cwd || undefined,
      env: { ...process.env, ...request.extraEnv, CORAL_CHILD: '1' },
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (!request.onEvent) return;
      lineBuffer += chunk;
      const parts = lineBuffer.split('\n');
      lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim()) request.onEvent(line);
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to spawn ${request.command}: ${error.message}`));
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code, aborted: false });
    });

    if (request.prompt) child.stdin.write(request.prompt);
    child.stdin.end();
  });

// Env-gated smoke per plan Phase 6 acceptance ("Real-CLI E2E moved to cleanup").
// Set CORAL_SMOKE_TEST=1 to run against a real Claude CLI install.
describe.skipIf(!process.env.CORAL_SMOKE_TEST)('claude-executor smoke', () => {
  it('runs one-shot execution using stdin prompt transport', async () => {
    const result = await executeClaudeOneShot('Reply with exactly: OK', { environment: {}, runCli });

    expect(result.response.length).toBeGreaterThan(0);
  }, 120_000);

  it('supports --resume with --append-system-prompt', async () => {
    const first = await executeClaudeOneShot('Reply with exactly: READY', { environment: {}, runCli });

    expect(first.sessionId).toBeTruthy();

    const resumed = await executeClaudeResume(first.sessionId!, 'Reply with exactly: CONTINUE', {
      environment: {},
      runCli,
      systemPrompt: 'You are a test assistant. Output exactly one token.',
    });

    expect(resumed.response.length).toBeGreaterThan(0);
  }, 120_000);
});
