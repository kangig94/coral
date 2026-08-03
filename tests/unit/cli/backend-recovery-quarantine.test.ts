import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRecoveryQuarantineCommandOperations,
  listRecoveryQuarantineLocal,
  registerBackendCommands,
  type RecoveryQuarantineCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import { collectCommandCoverage } from '#src/cli/classify.js';
import { formatRecoveryQuarantineClear, formatRecoveryQuarantineList } from '#src/cli/format/backend.js';
import { buildProgram } from '#src/cli/program.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, classifyStoreFile, openStoreDatabase } from '#src/store/db.js';
import * as ipcEnsure from '#src/transport/ipc/ensure.js';

const storeReset: StoreResetCommandOperations = {
  list: () => ({ incidents: [] }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
};

const tempDirectories: string[] = [];
let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function programWith(recoveryQuarantine: RecoveryQuarantineCommandOperations): Command {
  const program = new Command();
  program.exitOverride();
  registerBackendCommands(program, { storeReset, recoveryQuarantine });
  return program;
}

describe('backend recovery-quarantine commands', () => {
  it('should list retained rows directly while no daemon exists', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-cli-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openStoreDatabase({
      path: dbPath,
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
    });
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    quarantine.upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-1', revision: { kind: 'fingerprint', value: 'revision-1' } },
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'failed to hydrate persisted workflow',
      detail: 'retained for operator retry',
    });
    quarantine.upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-literal-sentinel', revision: { kind: 'fingerprint', value: 'until-cleared' } },
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'literal sentinel fingerprint',
      detail: 'must remain representable',
    });
    quarantine.upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-unversioned', revision: { kind: 'until-cleared' } },
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'until cleared',
      detail: 'sentinel revision',
    });
    db.close();

    const entries = listRecoveryQuarantineLocal(runtime);
    const clear = vi.fn();
    await programWith({ list: () => entries, clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'list',
    ]);

    expect(clear).not.toHaveBeenCalled();
    expect(entries).toHaveLength(3);
    expect(stdout).toBe(`${formatRecoveryQuarantineList(entries)}\n`);
    expect(stdout).toContain(
      '- boundary="workflow-recovery" key="workflow-1" revision="fingerprint:revision-1" state=active stage=hydrate',
    );
    expect(stdout).toContain('key="workflow-literal-sentinel" revision="fingerprint:until-cleared"');
    expect(stdout).toContain('key="workflow-unversioned" revision="until-cleared"');
    expect(stderr).toBe('');
  });

  it('should round-trip a fingerprint equal to the until-cleared sentinel', async () => {
    const clear = vi.fn(async (request) => ({
      boundary: request.boundary,
      key: request.key,
      revision: request.revision,
      disposition: 'advanced' as const,
    }));

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      'workflow-literal-sentinel',
      '--revision',
      'fingerprint:until-cleared',
    ]);

    expect(clear).toHaveBeenCalledWith({
      boundary: 'workflow-recovery',
      key: 'workflow-literal-sentinel',
      revision: 'until-cleared',
    });
    expect(stdout).toContain('revision="fingerprint:until-cleared"');
  });

  it('should treat an unequivocally older store as having no recovery quarantine yet', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-older-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const current = currentCoralStoreFormat();
    const olderFormat: typeof current = {
      ...current,
      productVersion: '0.0.0-0',
      fingerprint: `sha256:${'0'.repeat(64)}`,
    };
    const db = openStoreDatabase({
      path: runtime.paths.coral.store.dbFile,
      storage: runtime.storage,
      storeFormat: olderFormat,
      flavor: runtime.flavor,
    });
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_format_fingerprint'").run(olderFormat.fingerprint);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_product_version'").run(olderFormat.productVersion);
    db.close();

    expect(
      classifyStoreFile(runtime.paths.coral.store.dbFile, runtime.storage, currentCoralStoreFormat()),
    ).toMatchObject({ kind: 'older-incompatible' });
    expect(listRecoveryQuarantineLocal(runtime)).toEqual([]);
  });

  it('should state the daemon-down limitation for an ambiguous store format', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-unsupported-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const current = currentCoralStoreFormat();
    const unsupportedFormat: typeof current = {
      ...current,
      fingerprint: `sha256:${'0'.repeat(64)}`,
    };
    const db = openStoreDatabase({
      path: runtime.paths.coral.store.dbFile,
      storage: runtime.storage,
      storeFormat: unsupportedFormat,
      flavor: runtime.flavor,
    });
    db.close();

    expect(() => listRecoveryQuarantineLocal(runtime)).toThrow(
      /cannot be inspected while the local store is corrupt-or-unsupported.*coral-cli backend status/,
    );
  });

  it.each([
    ['advanced', 'resolved and removed', ''],
    ['quarantined', 'still quarantined', 'recovery-quarantine list'],
    ['continuation', 'partial progress', 'Run clear again'],
  ] as const)('should render %s as an actionable operator outcome', (disposition, outcome, recovery) => {
    const formatted = formatRecoveryQuarantineClear({
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
      disposition,
    });

    expect(formatted).toContain(outcome);
    if (recovery.length > 0) expect(formatted).toContain(recovery);
  });

  it('should report the exact retry disposition returned by the coordinator', async () => {
    const clear = vi.fn(async () => ({
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
      disposition: 'continuation' as const,
    }));
    const expected = await clear();
    clear.mockClear();

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      'workflow-1',
      '--revision',
      'revision-1',
    ]);

    expect(clear).toHaveBeenCalledWith({
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
    });
    expect(stdout).toBe(`${formatRecoveryQuarantineClear(expected)}\n`);
    expect(stdout).toContain('partial progress');
    expect(stdout).toContain('Run clear again');
    expect(stderr).toBe('');
  });

  it('should refuse clear when coordinator authority is unavailable', async () => {
    vi.spyOn(ipcEnsure, 'ensure').mockRejectedValue(new Error('connect ENOENT'));
    const recoveryQuarantine = createRecoveryQuarantineCommandOperations();
    const clear = vi.spyOn(recoveryQuarantine, 'clear');

    await programWith(recoveryQuarantine).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      'workflow-1',
      '--revision',
      'revision-1',
    ]);

    expect(clear).toHaveBeenCalledOnce();
    expect(stdout).toBe('');
    expect(stderr).toContain('Recovery quarantine clear requires the canonical coordinator');
    expect(stderr).toContain('coral-cli backend status');
    expect(process.exitCode).toBe(69);
  });

  it('should use the ensured IPC catalog client for clear', async () => {
    const result = {
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
      disposition: 'advanced' as const,
    };
    const request = vi.fn().mockResolvedValue(result);
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({ request } as never);

    await expect(
      createRecoveryQuarantineCommandOperations().clear({
        boundary: 'workflow-recovery',
        key: 'workflow-1',
        revision: 'revision-1',
      }),
    ).resolves.toEqual(result);

    expect(request).toHaveBeenCalledWith(
      'coordinator.recovery_quarantine.clear',
      { boundary: 'workflow-recovery', key: 'workflow-1', revision: 'revision-1' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('should report coordinator contract drift without calling it unreachable', async () => {
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({
      request: vi.fn().mockResolvedValue({ disposition: 'advanced' }),
    } as never);

    await programWith(createRecoveryQuarantineCommandOperations()).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      'workflow-1',
      '--revision',
      'revision-1',
    ]);

    expect(stderr).toContain('invalid recovery quarantine retry result');
    expect(stderr).not.toContain('not reachable');
  });

  it('should report an IPC timeout without calling it unreachable', async () => {
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({
      request: vi.fn().mockRejectedValue(new Error('IPC request timed out after 30000ms')),
    } as never);

    await programWith(createRecoveryQuarantineCommandOperations()).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      'workflow-1',
      '--revision',
      'revision-1',
    ]);

    expect(stderr).toContain('timed out before the coordinator returned a result');
    expect(stderr).not.toContain('not reachable');
  });

  it('should reject an invalid exact coordinate before invoking clear', async () => {
    const clear = vi.fn();

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      '',
      '--key',
      'workflow-1',
      '--revision',
      'revision-1',
    ]);

    expect(clear).not.toHaveBeenCalled();
    expect(stderr).toContain('Recovery boundary is required');
    expect(stderr).toContain('coral-cli backend recovery-quarantine list');
    expect(process.exitCode).toBe(2);
  });

  it('should wire registration, program construction, and command classes', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const recoveryEntries = coverage
      .filter((entry) => entry.path.startsWith('backend recovery-quarantine'))
      .map((entry) => ({
        path: entry.path,
        isLeaf: entry.isLeaf,
        kind: entry.resolution.kind,
        commandClass: entry.resolution.kind === 'class' ? entry.resolution.commandClass : null,
      }));

    expect(recoveryEntries).toEqual([
      {
        path: 'backend recovery-quarantine',
        isLeaf: false,
        kind: 'container',
        commandClass: null,
      },
      {
        path: 'backend recovery-quarantine list',
        isLeaf: true,
        kind: 'class',
        commandClass: 'directRead',
      },
      {
        path: 'backend recovery-quarantine clear',
        isLeaf: true,
        kind: 'class',
        commandClass: 'mutate',
      },
    ]);
  });
});
