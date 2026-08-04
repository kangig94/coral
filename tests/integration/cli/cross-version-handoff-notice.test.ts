import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHandoffNotice } from '#src/cli/handoff-notice.js';
import { runHandoff } from '#src/coordinator/handoff-runner.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator, type ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import { createRealRuntime } from '#src/runtime/real.js';

const fixtureRoots: string[] = [];
const validateForeignTarget = createForeignTargetValidator();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function createTarget(): ValidatedHandoffTarget {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-notice-'));
  const bundleDir = join(fixtureRoot, 'bundle');
  fixtureRoots.push(fixtureRoot);
  mkdirSync(bundleDir);

  const cliBundle = [
    "const { appendFileSync } = require('node:fs');",
    "appendFileSync(process.env.CORAL_HANDOFF_NOTICE_TRACE, 'delegated operation finished\\n');",
    'process.exit(Number(process.env.CORAL_HANDOFF_NOTICE_EXIT_CODE));',
  ].join('\n');
  const backendBundle = 'handoff notice backend fixture';
  const claudeAppserverBundle = 'handoff notice claude appserver fixture';
  const manifest: StrictBundleManifest = {
    version: '2.3.4',
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    bundleHash: sha256(backendBundle),
    cliBundleHash: sha256(cliBundle),
    claudeAppserverBundleHash: sha256(claudeAppserverBundle),
    flavor: 'prod',
    storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
  };

  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  const result = validateForeignTarget(bundleDir, manifest);
  if (result.kind !== 'validated') {
    throw new Error(`Fixture target failed validation: ${result.evidence.failure}`);
  }
  return result.target;
}

async function runDelegatedOperation(tracePath: string, exitCode: number) {
  return runHandoff({
    runtime: createRealRuntime('prod'),
    target: createTarget(),
    operation: {
      entrypoint: 'cli',
      args: [],
      envAdditions: {
        CORAL_HANDOFF_NOTICE_TRACE: tracePath,
        CORAL_HANDOFF_NOTICE_EXIT_CODE: String(exitCode),
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-version-handoff-notice', () => {
  it('should render once on stderr after a delegated operation succeeds, leaving its stdout intact', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-notice-trace-'));
    const tracePath = join(traceRoot, 'trace.txt');
    fixtureRoots.push(traceRoot);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      const text = chunk.toString();
      stderr += text;
      appendFileSync(tracePath, text);
      return true;
    }) as typeof process.stderr.write);
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((() => true) as typeof process.stdout.write);

    const outcome = await runDelegatedOperation(tracePath, 0);
    if (outcome.kind !== 'handoff-success') {
      throw new Error(`Expected handoff success, received ${outcome.kind}`);
    }
    // Both CLI delegation seams (V1.3 pre-flight, V1.4 mid-follow) report through this one renderer;
    // the latch, not caller discipline, is what keeps the notice to one line.
    renderHandoffNotice(outcome);
    renderHandoffNotice(outcome);

    const notice = 'handed off to 2.3.4; use that version from now on\n';
    expect(stderr).toBe(notice);
    expect(process.stderr.write).toHaveBeenCalledOnce();
    // The child owns stdout through inherited stdio; the notice must not append to the answer it produced,
    // or every `-f json` / `wait --embed` caller breaks the moment a handoff happens.
    expect(stdoutWrite).not.toHaveBeenCalled();
    // The child's own line landed first, and the notice followed it — ordering the trace file still proves.
    expect(readFileSync(tracePath, 'utf8')).toBe(`delegated operation finished\n${notice}`);
  });

  it('should attach no notice or guidance to a delegated operation failure', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-notice-trace-'));
    const tracePath = join(traceRoot, 'trace.txt');
    fixtureRoots.push(traceRoot);
    let written = '';
    const capture = ((chunk: string | Uint8Array) => {
      written += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);

    const outcome = await runDelegatedOperation(tracePath, 23);

    // The runner reports the failure as a value; it neither prints nor advises on either stream.
    expect(outcome).toEqual({ kind: 'handoff-exit', exitCode: 23 });
    expect(written).toBe('');
    expect(readFileSync(tracePath, 'utf8')).toBe('delegated operation finished\n');
  });
});
