import { readDurableCliExecutionReceipt } from '../../jobs/durable-cli-execution.js';
import { durableCliFailureDomainName } from '../../infra/failure-domain.js';
import { readDurableCliPreReadyOwnershipEvidence } from '../../jobs/runtime-meta-store.js';
import type { RecordedProcessIdentity } from '../../infra/process-containment.js';
import type { FailureDomainContainment } from '../../infra/failure-domain.js';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import type { SqliteDatabasePort } from '../../infra/port-types.js';

/** A historical execution must be identified by its exact process incarnation. */
export function durableCliFailureDomain(
  runtime: Pick<Runtime, 'process'>,
  db: Database | SqliteDatabasePort,
  jobId: string,
  identity?: RecordedProcessIdentity,
  expectedPid = identity?.pid,
): FailureDomainContainment | undefined {
  if (runtime.process.failureDomainRoot.kind !== 'placed') return undefined;
  let subject = identity;
  let addressedDomain: FailureDomainContainment | undefined;
  let addressedExecution: number | null = null;
  let entered = false;
  const resolveDomain = (): FailureDomainContainment | undefined => {
    if (addressedDomain !== undefined) return addressedDomain;
    if (subject === undefined) {
      if (expectedPid === undefined) throw new Error('recorded process identity unavailable');
      const evidence = readDurableCliPreReadyOwnershipEvidence(db as Database, jobId, expectedPid);
      if (evidence.kind === 'current' || evidence.kind === 'provisional') subject = evidence.record;
    }
    if (subject === undefined) throw new Error('execution identity unavailable');
    const receipt = readDurableCliExecutionReceipt(db, jobId, subject);
    const execution = receipt?.execution ?? null;
    // A receipt must precede every job leaf creation.
    if (execution === null) return undefined;
    addressedExecution = execution;
    entered = receipt?.phase === 'entered';
    addressedDomain = runtime.process.failureDomainContainment(durableCliFailureDomainName(jobId, execution));
    return addressedDomain;
  };
  try {
    if (resolveDomain() === undefined) return undefined;
  } catch {
    // Unresolved metadata must retain an observation owner that can see repairs.
  }
  return {
    hasEntered: () => {
      if (entered) return true;
      try {
        resolveDomain();
        if (subject === undefined || addressedExecution === null) return false;
        const receipt = readDurableCliExecutionReceipt(db, jobId, subject);
        entered = receipt?.execution === addressedExecution && receipt.phase === 'entered';
        return entered;
      } catch {
        return false;
      }
    },
    observe: () => {
      try {
        return resolveDomain()?.observe() ?? { kind: 'missing' };
      } catch {
        return { kind: 'unresolved', reason: 'execution identity unavailable' };
      }
    },
    kill: () => {
      try {
        return resolveDomain()?.kill() ?? { kind: 'refused', errno: 'EPERM' };
      } catch {
        return { kind: 'refused', errno: 'EPERM' };
      }
    },
  };
}
