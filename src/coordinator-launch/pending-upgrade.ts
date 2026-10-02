import { join } from 'node:path';

import { readUpgradeIntent, retryUpgradeIntentCas, type UpgradeIntent } from '../infra/upgrade-intent.js';
import { targetValidation } from './executable.js';

export function pendingIntent(runDir: string): UpgradeIntent | null {
  const observed = readUpgradeIntent(runDir);
  return observed.kind === 'readable' &&
    observed.intent.legacyRetirement === true &&
    (observed.intent.disposition === 'pending' ||
      observed.intent.disposition === 'deferred' ||
      observed.intent.disposition === 'attempting')
    ? observed.intent
    : null;
}

export function pendingExecutable(intent: UpgradeIntent): string {
  return join(intent.target.pluginRootLabel, 'bridge', 'coral-backend.cjs');
}

export async function closeUnavailableLegacyRequest(runDir: string, requestId: string): Promise<void> {
  await retryUpgradeIntentCas(runDir, (observed) => {
    if (observed.kind !== 'readable') return { kind: 'settle', value: undefined };
    const intent = observed.intent;
    if (
      intent.requestId !== requestId ||
      intent.legacyRetirement !== true ||
      intent.disposition === 'closed' ||
      intent.disposition === 'completed' ||
      intent.attemptId !== null ||
      intent.attemptChild !== null ||
      targetValidation(pendingExecutable(intent)) !== 'absent'
    )
      return { kind: 'settle', value: undefined };
    return {
      kind: 'write',
      expectedRevision: intent.revision,
      change: { ...intent, disposition: 'closed' as const, retryCondition: null },
      settle: () => undefined,
    };
  });
}
