import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies to isolate the adapter under test
vi.mock('../../../execution/engine.js', () => ({
  spawnCli: vi.fn(),
}));

vi.mock('../../cli-detection.js', () => ({
  detectClaudeCli: vi.fn(async () => ({
    available: true,
    version: '1.0.0',
    authState: 'authenticated',
  })),
}));

vi.mock('../../inject.js', () => ({
  resolveInjectMd: vi.fn(() => null),
}));

async function loadProvider() {
  vi.resetModules();
  return import('../adapter.js');
}

describe('claude adapter recovery contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-recovery-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('finalizes from stdout file with valid stream-JSON output', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    const streamOutput = [
      '{"type":"assistant","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Recovered answer"}]}}',
      '{"type":"result","result":"Recovered answer","session_id":"sess-recovered","total_cost_usd":0.05,"duration_ms":3200}',
    ].join('\n');
    writeFileSync(stdoutPath, streamOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
    });

    expect(result.content).toBe('Recovered answer');
    expect(result.conversationRef).toBe('sess-recovered');
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.usage?.costUsd).toBe(0.05);
    expect(result.durationMs).toBe(3200);
  });

  it('falls back to raw content for unparseable stdout', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    const rawContent = 'This is not stream-JSON, just plain text.';
    writeFileSync(stdoutPath, rawContent, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 1,
      signal: null,
    });

    expect(result.content).toBe(rawContent);
    expect(result.exitCode).toBe(1);
  });

  it('includes kill signal notice in raw fallback', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    writeFileSync(stdoutPath, 'raw output', 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: null,
      signal: 'SIGKILL',
    });

    expect(result.content).toBe('raw output');
    expect(result.notice).toBe('killed by SIGKILL');
  });

  it('uses fallbackConversationRef when stream-JSON lacks session_id', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    // stream-JSON result with no session_id
    const streamOutput = '{"type":"result","result":"No session output"}\n';
    writeFileSync(stdoutPath, streamOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
      fallbackConversationRef: 'fallback-sess',
    });

    expect(result.content).toBe('No session output');
    expect(result.conversationRef).toBe('fallback-sess');
  });

  it('falls back to assistant text when result response is missing', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    const streamOutput = [
      '{"type":"assistant","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"assistant text"}]}}',
      '{"type":"result","session_id":"sess-fallback","total_cost_usd":0.01}',
    ].join('\n');
    writeFileSync(stdoutPath, streamOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
    });

    expect(result.content).toBe('assistant text');
    expect(result.conversationRef).toBe('sess-fallback');
  });

  it('handles empty stdout as raw fallback', async () => {
    const { claudeProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.json');
    const stderrPath = join(tmpDir, 'stderr.log');
    writeFileSync(stdoutPath, '', 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await claudeProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
    });

    // Empty stdout → parser returns isError=true, no response → raw fallback
    expect(result.content).toBe('');
  });
});
