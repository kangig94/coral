import type { UpgradeIntent } from '../../../infra/upgrade-intent.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type { IncumbentWriterPorts, SuccessionCommitPorts } from './index.js';

const CONNECTION_HANDOVER_MS = 500;

export function createCommitAuthority(ports: SuccessionCommitPorts) {
  const incumbentOwner = (): NonNullable<UpgradeIntent['attemptOwner']> => {
    const { instanceId, pid, incarnation } = ports.reconciler().incumbent();
    return { kind: 'incumbent', instanceId, pid, incarnation };
  };

  const writersOrThrow = (): IncumbentWriterPorts => {
    const writers = ports.writers();
    if (writers === null) throw new Error('Incumbent writer park capabilities are unavailable.');
    return writers;
  };

  async function handOverOpenConnections(attempt: SuccessionAttempt): Promise<void> {
    ports.waitHandover.abort();
    await attempt.drainIncumbentConnections(ports.listener(), CONNECTION_HANDOVER_MS);
  }

  const releaseToSuccessor = (attempt: SuccessionAttempt): Promise<never> =>
    writersOrThrow().releaseAuthority({ kind: 'successor', handOver: () => handOverOpenConnections(attempt) });

  return { incumbentOwner, writersOrThrow, handOverOpenConnections, releaseToSuccessor };
}
