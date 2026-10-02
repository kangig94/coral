import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

import type {
  SuccessionInterposition,
  SuccessionInterpositionPoint,
} from '#src/coordinator/succession/interposition.js';

const failuresOnFirstAttempt: Partial<Record<SuccessionInterpositionPoint, string>> = {
  'successor-writer-fence': 'CORAL_TEST_SUCCESSION_FENCE_FAILURE',
  'successor-committed-open': 'CORAL_TEST_SUCCESSION_OPEN_FAILURE',
  'incumbent-reclaim': 'CORAL_TEST_SUCCESSION_RECLAIM_FAILURE',
};
const failuresOnEveryAttempt: Partial<Record<SuccessionInterpositionPoint, string>> = {
  'successor-retirement-mint': 'CORAL_TEST_RETIREMENT_MINT_FAILURE',
  'successor-retirement-generation': 'CORAL_TEST_RETIREMENT_GENERATION_FAILURE',
  'successor-serving-acknowledgment': 'CORAL_TEST_SUCCESSION_DROP_SERVING_ACK',
  'retirement-protection': 'CORAL_TEST_RETIREMENT_PROTECTION_FAILURE',
  'retirement-authorization': 'CORAL_TEST_RETIREMENT_AUTHORIZATION_FAILURE',
};

const SHARED_OPENER_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true, timeout: 5000 });
db.exec('BEGIN; SELECT count(*) FROM sqlite_schema');
process.stdout.write('held\\n');
setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, Number(process.argv[2]));
`;

/** Another process opens the epoch the way a direct store reader does, and resolves once it holds the lock. */
function holdSharedOpener(lockPath: string, holdMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const opener = spawn(process.execPath, ['-e', SHARED_OPENER_SCRIPT, lockPath, String(holdMs)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    opener.once('error', reject);
    opener.once('exit', (code) => reject(new Error(`shared opener exited before holding the lock (${code})`)));
    opener.stdout.setEncoding('utf8').once('data', () => resolve());
  });
}

/** Claims a one-shot fault: only the first process to create the marker receives it. */
function claimOnce(marker: string | undefined): boolean {
  if (marker === undefined || marker === '') return false;
  try {
    writeFileSync(marker, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A fault plan read from the process environment, which every succession child inherits: a plan set on the
 * incumbent reaches the successor it launches. A first-attempt fault spares same-build recovery children.
 */
export function successionInterpositionFromEnvironment(env: NodeJS.ProcessEnv = process.env): SuccessionInterposition {
  const enabled = (name: string): boolean => env[name] === '1';
  const delayMs = (name: string): number => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    at: async (point, { recovery }) => {
      if (point === 'retirement-protection' && env.CORAL_TEST_RETIREMENT_OPENER_LOCK !== undefined) {
        await holdSharedOpener(env.CORAL_TEST_RETIREMENT_OPENER_LOCK, delayMs('CORAL_TEST_RETIREMENT_OPENER_HOLD_MS'));
      }
      if (point === 'successor-before-serving') {
        if (!recovery && env.CORAL_TEST_SUCCESSION_SERVING_GATE !== undefined) {
          const gate = env.CORAL_TEST_SUCCESSION_SERVING_GATE;
          writeFileSync(gate, String(process.pid));
          while (existsSync(gate)) await sleep(10);
        }
        await sleep(delayMs('CORAL_TEST_SUCCESSION_SERVING_DELAY_MS'));
        if (claimOnce(env.CORAL_TEST_SUCCESSION_MISS_DEADLINE_ONCE)) {
          await sleep(delayMs('CORAL_TEST_SUCCESSION_MISS_DEADLINE_MS'));
        }
        if (!recovery && enabled('CORAL_TEST_SUCCESSION_CRASH_BEFORE_SERVING')) process.exit(82);
      }
      if (point === 'incumbent-release') {
        await sleep(delayMs('CORAL_TEST_SUCCESSION_RELEASE_DELAY_MS'));
        if (enabled('CORAL_TEST_SUCCESSION_RELEASE_FAILURE')) throw new Error('injected succession release failure');
      }
      const firstAttemptFault = failuresOnFirstAttempt[point];
      if (!recovery && firstAttemptFault !== undefined && enabled(firstAttemptFault)) {
        throw new Error(`injected ${point} failure`);
      }
      const everyAttemptFault = failuresOnEveryAttempt[point];
      if (everyAttemptFault !== undefined && enabled(everyAttemptFault)) throw new Error(`injected ${point} failure`);
    },
  };
}
