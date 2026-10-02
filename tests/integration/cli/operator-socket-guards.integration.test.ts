import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireOperatorSocketGuard } from '#src/cli/operator-socket-guard.js';
import { serializeCoralSetupError } from '#src/runtime/errors.js';
import { createRealRuntime } from '#src/runtime/real.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'coral-operator-socket-bind-'));
  roots.push(value);
  return value;
}

function publishSocket(runtime: ReturnType<typeof createRealRuntime>, socketPath: string): void {
  mkdirSync(dirname(runtime.paths.coral.coordinator.infoFile), { recursive: true });
  writeFileSync(
    runtime.paths.coral.coordinator.infoFile,
    JSON.stringify({
      pid: process.pid,
      port: 1,
      socketPath,
      bundleHash: 'published-bundle',
      flavor: runtime.flavor,
      namespace: 'operator-socket-guard-test',
      startedAt: 1,
      token: 'operator-token',
      bootToken: 'boot-token',
    }),
    'utf-8',
  );
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('operator coordinator socket bind failures', () => {
  it('does not create parents for a published address outside Coral namespace', async () => {
    const runtime = createRealRuntime('prod', {
      baseDir: join(root(), 'state-root-long-enough-to-relocate-'.repeat(4)),
    });
    const outsideParent = join(root(), 'outside', 'missing');
    const publishedSocketPath = join(outsideParent, 'sentinel');
    publishSocket(runtime, publishedSocketPath);

    let refusal: unknown;
    try {
      await acquireOperatorSocketGuard({ runtime, operation: 'store reset', retryCommand: 'retry' });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({
      code: 'coordinator_record_unreadable',
      context: { detail: expect.stringContaining("outside Coral's coordinator namespace") },
    });
    expect(existsSync(outsideParent)).toBe(false);
  });

  it('does not delete an existing published path outside Coral namespace', async () => {
    const runtime = createRealRuntime('prod', {
      baseDir: join(root(), 'state-root-long-enough-to-relocate-'.repeat(4)),
    });
    const publishedSocketPath = join(root(), 'sentinel');
    writeFileSync(publishedSocketPath, 'sentinel', 'utf-8');
    publishSocket(runtime, publishedSocketPath);

    let refusal: unknown;
    try {
      await acquireOperatorSocketGuard({ runtime, operation: 'store reset', retryCommand: 'retry' });
    } catch (error: unknown) {
      refusal = error;
    }

    expect(serializeCoralSetupError(refusal)).toMatchObject({ code: 'coordinator_record_unreadable' });
    expect(existsSync(publishedSocketPath)).toBe(true);
  });
});
