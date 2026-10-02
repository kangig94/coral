// @flaky — process scheduling and /proc visibility vary under shared CI hosts.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CUSTODY_PROCESS_TICKET_ENV,
  custodyProcessArgument,
  observeCustodyProcessToken,
} from '../../src/infra/custody-process-ticket.js';
import { durableWrapperEntrypoint } from '../../src/runtime/wrapper-entrypoint.js';
import { createRealRuntime } from '../../src/runtime/real.js';
import { readCustodyLedger, reconcileCustodyLedger, recordCustodyIntent } from '../../src/store/custody-ledger.js';

describe('custody crash recovery', { retry: 2 }, () => {
  it('makes a provider host wrapper bind before provider work and self-fence on an expired ticket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-custody-host-'));
    const runDir = join(root, 'run');
    const runtime = createRealRuntime('prod', { baseDir: root });
    try {
      for (const expired of [false, true]) {
        const nowMs = Date.now();
        const intent = recordCustodyIntent(runtime, runDir, {
          effect: 'process-spawn',
          epoch: 'epoch-8',
          owner: 'provider-host',
          operationId: expired ? 'expired-host' : 'live-host',
          capsule: null,
          bindWithinMs: 10_000,
          nowMs: expired ? nowMs - 20_000 : nowMs,
        });
        const ticket = {
          runDir,
          epoch: intent.epoch,
          intentId: intent.id,
          processToken: intent.processToken,
          processGroupId: null,
        };
        const child = spawn(
          process.execPath,
          [
            durableWrapperEntrypoint(),
            '--provider-host',
            process.execPath,
            '-e',
            'process.stdout.write("provider-started")',
            custodyProcessArgument(intent.processToken),
          ],
          {
            env: { ...process.env, [CUSTODY_PROCESS_TICKET_ENV]: JSON.stringify(ticket) },
          },
        );
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        const [exitCode] = await once(child, 'exit');
        expect(stdout).toBe(expired ? '' : 'provider-started');
        expect(exitCode).toBe(expired ? 1 : 0);
      }
      expect(
        readCustodyLedger(runtime, runDir)
          .map((entry) => entry.kind)
          .sort(),
      ).toEqual(['bound', 'holding']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a spawned but unbound live process on hold through T plus grace', async () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'coral-custody-crash-'));
    const runDir = join(root, 'run');
    const runtime = createRealRuntime('prod', { baseDir: root });
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: 'epoch-7',
      owner: 'durable-cli',
      operationId: 'job-7',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: 100,
    });
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)', '--', custodyProcessArgument(intent.processToken)],
      { stdio: 'ignore' },
    );
    try {
      await once(child, 'spawn');
      let observed = observeCustodyProcessToken(intent.processToken);
      for (let attempt = 0; observed !== 'alive' && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observed = observeCustodyProcessToken(intent.processToken);
      }
      expect(observed).toBe('alive');
      const observe = () => {
        const process = observeCustodyProcessToken(intent.processToken);
        return process === 'absent'
          ? { kind: 'absent' as const, processToken: intent.processToken, evidence: 'process token absent' }
          : { kind: process };
      };
      expect(reconcileCustodyLedger(runtime, runDir, 1_199, 100, observe)).toMatchObject([{ kind: 'holding' }]);
      expect(reconcileCustodyLedger(runtime, runDir, 1_200, 100, observe)).toMatchObject([{ kind: 'holding' }]);
      child.kill('SIGTERM');
      await once(child, 'exit');
      const finalObservation = observeCustodyProcessToken(intent.processToken);
      const expected = finalObservation === 'absent' ? 'absent' : 'holding';
      expect(reconcileCustodyLedger(runtime, runDir, 1_201, 100, observe)).toMatchObject([{ kind: expected }]);
      expect(readCustodyLedger(runtime, runDir)).toMatchObject([{ kind: expected }]);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
