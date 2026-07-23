import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStoreResetIncidentDiagnosticRunner,
  superviseStoreResetDiagnosticChild,
  type StoreResetDiagnosticChild,
  type StoreResetDiagnosticSupervisorPort,
} from '#src/store/reset-incident-diagnostic.js';
import { createStoreResetInspectionFs } from '#src/infra/store-reset-inspection-fs.js';
import type { StoreResetInspectionFs } from '#src/store/reset-incident-inspection-fs.js';
import type { StoreResetIncidentManifestV2 } from '#src/store/reset-incident.js';
import { scriptedStoreResetInspectionFs } from '#tests/helpers/store-reset-inspection-fs.js';

const INCIDENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const roots: string[] = [];

class FakeDiagnosticChild implements StoreResetDiagnosticChild {
  readonly kills: boolean[] = [];
  pipesDestroyed = 0;
  disposed = 0;
  unrefed = 0;
  private readonly stdoutListeners: Array<(chunk: Uint8Array) => void> = [];
  private readonly stderrListeners: Array<(chunk: Uint8Array) => void> = [];
  private readonly closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly errorListeners: Array<() => void> = [];

  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.stdoutListeners.push(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.stderrListeners.push(listener);
  }

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: () => void): void {
    this.errorListeners.push(listener);
  }

  terminate(force: boolean): void {
    this.kills.push(force);
  }

  destroyPipes(): void {
    this.pipesDestroyed += 1;
  }

  dispose(): void {
    this.disposed += 1;
    this.stdoutListeners.length = 0;
    this.stderrListeners.length = 0;
    this.closeListeners.length = 0;
    this.errorListeners.length = 0;
  }

  unref(): void {
    this.unrefed += 1;
  }

  stdout(value: string | Uint8Array): void {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    for (const listener of [...this.stdoutListeners]) listener(bytes);
  }

  stderr(value: string | Uint8Array): void {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    for (const listener of [...this.stderrListeners]) listener(bytes);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.closeListeners]) listener(code, signal);
  }

  error(): void {
    for (const listener of [...this.errorListeners]) listener();
  }
}

function supervisor(
  child: FakeDiagnosticChild,
  onSpawn?: (executable: string, args: readonly string[]) => void,
  signal?: AbortSignal,
): StoreResetDiagnosticSupervisorPort {
  return {
    ...(signal === undefined ? {} : { signal }),
    spawn(executable, args) {
      onSpawn?.(executable, args);
      return child;
    },
    setTimeout(callback, milliseconds) {
      return setTimeout(callback, milliseconds);
    },
    clearTimeout(handle) {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };
}

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function diagnosticFixture(): {
  readonly incidentPath: string;
  readonly tempRoot: string;
  readonly evidence: Uint8Array;
  readonly manifest: StoreResetIncidentManifestV2;
} {
  const base = root('coral-reset-diagnostic-');
  const incidentPath = join(base, INCIDENT_ID);
  const tempRoot = join(base, 'tmp');
  mkdirSync(incidentPath, { mode: 0o700 });
  mkdirSync(tempRoot, { mode: 0o700 });
  const evidence = Buffer.from('bounded sqlite evidence');
  const evidencePath = join(incidentPath, 'store.db');
  writeFileSync(evidencePath, evidence, { mode: 0o600 });
  const stat = createStoreResetInspectionFs().lstat(evidencePath);
  if (stat === null) throw new Error('fixture evidence missing');
  return {
    incidentPath,
    tempRoot,
    evidence,
    manifest: {
      schemaVersion: 2,
      incidentId: INCIDENT_ID,
      resetAt: '2026-07-23T01:02:03.004Z',
      reason: 'mismatch',
      storedFingerprint: `sha256:${'a'.repeat(64)}`,
      expectedFingerprint: `sha256:${'b'.repeat(64)}`,
      build: {
        version: '0.9.16',
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        backendBundleHash: '0123456789abcdef',
        flavor: 'prod',
      },
      runtime: {
        namespace: 'unit',
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        processId: process.pid,
      },
      handoff: { acquiredViaHandoff: false },
      files: [
        {
          name: 'store.db',
          sizeBytes: Number(stat.size),
          mtimeMs: Number(stat.mtimeNs) / 1_000_000,
          sha256: sha256(evidence),
        },
      ],
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('store-reset SQLite child supervision', () => {
  it.each(['ok', 'failed', 'unavailable'] as const)(
    'accepts only the fixed %s token after a clean close',
    async (token) => {
      const child = new FakeDiagnosticChild();
      const result = superviseStoreResetDiagnosticChild(supervisor(child), '/node', '/private/store.db');
      child.stdout(token);
      child.close(0, null);

      await expect(result).resolves.toEqual({ integrity: token, termination: 'completed' });
      expect(child.disposed).toBe(1);
    },
  );

  it('maps malformed output, stderr, errors, and non-zero closes to bounded states', async () => {
    const malformedChild = new FakeDiagnosticChild();
    const malformed = superviseStoreResetDiagnosticChild(supervisor(malformedChild), '/node', '/private/store.db');
    malformedChild.stdout('sensitive output');
    malformedChild.close(0, null);
    await expect(malformed).resolves.toEqual({ integrity: 'unavailable', termination: 'completed' });

    const stderrChild = new FakeDiagnosticChild();
    const stderrResult = superviseStoreResetDiagnosticChild(supervisor(stderrChild), '/node', '/private/store.db');
    stderrChild.stderr('sensitive stderr');
    stderrChild.close(0, null);
    await expect(stderrResult).resolves.toEqual({ integrity: 'unavailable', termination: 'completed' });

    const errorChild = new FakeDiagnosticChild();
    const errorResult = superviseStoreResetDiagnosticChild(supervisor(errorChild), '/node', '/private/store.db');
    errorChild.error();
    errorChild.close(null, 'SIGTERM');
    await expect(errorResult).resolves.toEqual({ integrity: 'unavailable', termination: 'terminated' });
  });

  it('terminates on raw output overflow without forwarding child bytes', async () => {
    const stdoutChild = new FakeDiagnosticChild();
    const stdoutResult = superviseStoreResetDiagnosticChild(supervisor(stdoutChild), '/node', '/private/store.db');
    stdoutChild.stdout(new Uint8Array(65));
    expect(stdoutChild.pipesDestroyed).toBe(1);
    expect(stdoutChild.kills).toEqual([false]);
    stdoutChild.close(null, 'SIGTERM');
    await expect(stdoutResult).resolves.toEqual({ integrity: 'unavailable', termination: 'terminated' });

    const stderrChild = new FakeDiagnosticChild();
    const stderrResult = superviseStoreResetDiagnosticChild(supervisor(stderrChild), '/node', '/private/store.db');
    stderrChild.stderr(new Uint8Array(4097));
    expect(stderrChild.pipesDestroyed).toBe(1);
    expect(stderrChild.kills).toEqual([false]);
    stderrChild.close(null, 'SIGTERM');
    await expect(stderrResult).resolves.toEqual({ integrity: 'unavailable', termination: 'terminated' });
  });

  it('owns shutdown of the diagnostic child when the CLI abort signal fires', async () => {
    const controller = new AbortController();
    const child = new FakeDiagnosticChild();
    const result = superviseStoreResetDiagnosticChild(
      supervisor(child, undefined, controller.signal),
      '/node',
      '/private/store.db',
    );

    controller.abort();
    expect(child.kills).toEqual([false]);
    child.close(null, 'SIGTERM');

    await expect(result).resolves.toEqual({ integrity: 'unavailable', termination: 'terminated' });
    expect(child.disposed).toBe(1);
  });

  it('detaches a child that never closes after the terminal seven-second bound', async () => {
    vi.useFakeTimers();
    const child = new FakeDiagnosticChild();
    const result = superviseStoreResetDiagnosticChild(supervisor(child), '/node', '/private/store.db');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kills).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kills).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({
      integrity: 'unavailable',
      termination: 'termination_unconfirmed',
    });
    expect(child.pipesDestroyed).toBe(1);
    expect(child.disposed).toBe(1);
    expect(child.unrefed).toBe(1);
  });
});

describe('store-reset SQLite evidence staging', () => {
  it('copies through partial I/O, passes only the staged DB, rehashes evidence, and cleans up', async () => {
    const fixture = diagnosticFixture();
    const child = new FakeDiagnosticChild();
    let stagedPath = '';
    const runner = createStoreResetIncidentDiagnosticRunner({
      tempRoot: fixture.tempRoot,
      platform: process.platform,
      executable: '/node',
      supervisor: supervisor(child, (_executable, args) => {
        stagedPath = args.at(-1) ?? '';
        expect(stagedPath.startsWith(fixture.tempRoot)).toBe(true);
        expect(stagedPath.startsWith(fixture.incidentPath)).toBe(false);
        expect(readFileSync(stagedPath)).toEqual(fixture.evidence);
        queueMicrotask(() => {
          child.stdout('ok');
          child.close(0, null);
        });
      }),
    });
    const fs = scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), {
      maxReadBytes: 1,
      maxWriteBytes: 1,
    });

    await expect(
      runner({
        fs,
        incidentPath: fixture.incidentPath,
        manifest: fixture.manifest,
      }),
    ).resolves.toEqual({
      integrity: 'ok',
      termination: 'completed',
      cleanup: 'removed',
    });
    expect(readFileSync(join(fixture.incidentPath, 'store.db'))).toEqual(fixture.evidence);
    expect(createStoreResetInspectionFs().lstat(stagedPath)).toBeNull();
  });

  it.each([
    ['zero read', { zeroReadCall: 1 }],
    ['zero write', { zeroWriteCall: 1 }],
    ['descriptor close failure', { failFileClose: true }],
  ] as const)('fails closed on %s', async (_name, script) => {
    const fixture = diagnosticFixture();
    const child = new FakeDiagnosticChild();
    const runner = createStoreResetIncidentDiagnosticRunner({
      tempRoot: fixture.tempRoot,
      platform: process.platform,
      executable: '/node',
      supervisor: supervisor(child),
    });

    await expect(
      runner({
        fs: scriptedStoreResetInspectionFs(createStoreResetInspectionFs(), script),
        incidentPath: fixture.incidentPath,
        manifest: fixture.manifest,
      }),
    ).resolves.toMatchObject({
      integrity: 'unavailable',
      termination: 'not_started',
    });
  });

  it('rejects a cumulative diagnostic budget before copying or spawning', async () => {
    const fixture = diagnosticFixture();
    const child = new FakeDiagnosticChild();
    let spawns = 0;
    const runner = createStoreResetIncidentDiagnosticRunner({
      tempRoot: fixture.tempRoot,
      platform: process.platform,
      executable: '/node',
      supervisor: supervisor(child, () => {
        spawns += 1;
      }),
    });
    const perFile = 130 * 1024 * 1024;
    const manifest: StoreResetIncidentManifestV2 = {
      ...fixture.manifest,
      files: [
        { ...fixture.manifest.files[0], sizeBytes: perFile },
        {
          name: 'store.db-wal',
          sizeBytes: perFile,
          mtimeMs: Date.now(),
          sha256: 'b'.repeat(64),
        },
      ],
    };

    await expect(
      runner({
        fs: createStoreResetInspectionFs(),
        incidentPath: fixture.incidentPath,
        manifest,
      }),
    ).resolves.toEqual({
      integrity: 'unavailable',
      termination: 'not_started',
      cleanup: 'not_required',
    });
    expect(spawns).toBe(0);
  });

  it('never recursively cleans a temp directory still possibly held by an unconfirmed child', async () => {
    vi.useFakeTimers();
    const fixture = diagnosticFixture();
    const child = new FakeDiagnosticChild();
    let cleanupCalls = 0;
    const baseFs = createStoreResetInspectionFs();
    const fs: StoreResetInspectionFs = {
      ...baseFs,
      removeTreeGuarded(path, expected) {
        cleanupCalls += 1;
        return baseFs.removeTreeGuarded(path, expected);
      },
    };
    const runner = createStoreResetIncidentDiagnosticRunner({
      tempRoot: fixture.tempRoot,
      platform: process.platform,
      executable: '/node',
      supervisor: supervisor(child),
    });
    const result = runner({
      fs,
      incidentPath: fixture.incidentPath,
      manifest: fixture.manifest,
    });

    await vi.advanceTimersByTimeAsync(7_000);
    await expect(result).resolves.toEqual({
      integrity: 'unavailable',
      termination: 'termination_unconfirmed',
      cleanup: 'cleanup_unavailable',
    });
    expect(cleanupCalls).toBe(0);
  });

  it('cannot report success when guarded cleanup fails', async () => {
    const fixture = diagnosticFixture();
    const child = new FakeDiagnosticChild();
    const baseFs = createStoreResetInspectionFs();
    const runner = createStoreResetIncidentDiagnosticRunner({
      tempRoot: fixture.tempRoot,
      platform: process.platform,
      executable: '/node',
      supervisor: supervisor(child, () => {
        queueMicrotask(() => {
          child.stdout('ok');
          child.close(0, null);
        });
      }),
    });

    await expect(
      runner({
        fs: { ...baseFs, removeTreeGuarded: () => false },
        incidentPath: fixture.incidentPath,
        manifest: fixture.manifest,
      }),
    ).resolves.toEqual({
      integrity: 'unavailable',
      termination: 'completed',
      cleanup: 'cleanup_unavailable',
    });
  });
});
