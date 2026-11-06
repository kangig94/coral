import { custodyPayloadEntered } from '../../../infra/custody-process-ticket.js';
import { hostFailureDomainName, type FailureDomainContainment } from '../../../infra/failure-domain.js';
import type { Runtime } from '../../../runtime/ports.js';
import { readCustodyBinding, type CustodyEntry } from '../../../store/custody-ledger.js';
import { sameEpoch } from '../../../store/epoch/identity.js';

/** A group-member host needs its durable proxy owner before ENOENT can permit legacy fallback. */
export function recordedHostFailureDomain(
  runtime: Runtime,
  runDir: string,
  host: Extract<CustodyEntry, { kind: 'bound' }>,
  entries: readonly CustodyEntry[],
): FailureDomainContainment | undefined {
  if (runtime.process.failureDomainRoot.kind !== 'placed') return undefined;
  const unknown: FailureDomainContainment = {
    observe: () => ({ kind: 'unknown', reason: 'host failure-domain owner is unobservable' }),
    kill: () => ({ kind: 'refused', errno: 'EPERM' }),
  };
  const process = host.binding.process;
  if (process === null) return unknown;
  const contain = (name: string) => {
    const domain = runtime.process.failureDomainContainment(name);
    return domain === undefined
      ? undefined
      : {
          ...domain,
          hasEntered: () =>
            custodyPayloadEntered(
              { runDir, intentId: host.intent.id, processToken: host.intent.processToken },
              process,
              (path) => runtime.storage.readFileSync(path, 'utf-8'),
            ),
        };
  };
  if (process.processGroupId === process.pid) return contain(hostFailureDomainName(host.intent.processToken, null));
  if (entries.some((entry) => entry.kind === 'unreadable')) return unknown;
  const owners = new Set<string>();
  try {
    for (const entry of entries) {
      if (entry.kind !== 'bound' && entry.kind !== 'absent') continue;
      if (entry.intent.owner !== 'provider-proxy-set') continue;
      const instance = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):proxy$/.exec(
        entry.intent.operationId,
      )?.[1];
      if (instance === undefined || entry.intent.createdAtMs > host.intent.createdAtMs) continue;
      const sameOwnerEpoch =
        host.intent.epochKey === undefined && entry.intent.epochKey === undefined
          ? host.intent.epoch === entry.intent.epoch
          : host.intent.epochKey !== undefined &&
            entry.intent.epochKey !== undefined &&
            sameEpoch(host.intent.epochKey, entry.intent.epochKey);
      if (!sameOwnerEpoch) continue;
      const binding = entry.kind === 'bound' ? entry.binding : readCustodyBinding(runtime, runDir, entry.intent);
      if (binding?.process?.pid === process.processGroupId && binding.process.processGroupId === process.processGroupId)
        owners.add(instance);
    }
  } catch {
    return unknown;
  }
  if (owners.size !== 1) return unknown;
  const [instance] = owners;
  return contain(hostFailureDomainName(host.intent.processToken, instance));
}
