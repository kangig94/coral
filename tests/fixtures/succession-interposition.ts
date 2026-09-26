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
      if (point === 'successor-before-serving') {
        await sleep(delayMs('CORAL_TEST_SUCCESSION_SERVING_DELAY_MS'));
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
