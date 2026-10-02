import { join } from 'node:path';
import { readDiscoveryRecordDisposition } from '../../infra/backend-discovery.js';
import { tryAcquireExclusiveFileLockSync, type FileLockLease } from '../../infra/fs-lock.js';
import {
  parseUpgradeIntentSnapshot,
  readCompletedSuccessionReceipts,
  readUpgradeIntent,
} from '../../infra/upgrade-intent.js';
import { createRecordedProcessObserver } from '../../infra/node-process.js';
import type { Runtime } from '../../runtime/ports.js';
import { inspectCurrentStore, listStoreEpochHolders } from '../../store/epoch.js';
import { knownProtectedEpochAddresses } from '../../store/epoch-protection.js';
import { recoverSuccessionWriterGeneration } from '../../store/succession-writer-generation.js';
import { controllerWriterRecoveryGenerations } from './controller-open.js';

/** Startup owns no writable store yet. An exclusive guard alone only proves write turns drained. */
export function recoverDamagedStartupWriter(runtime: Runtime): void {
  recoverSuccessionWriterGeneration(runtime, () => {
    const leases: FileLockLease[] = [];
    const release = () => {
      for (const lease of leases.reverse()) lease();
    };
    try {
      const current = inspectCurrentStore(runtime);
      if (current.kind !== 'current') throw new Error('Writer recovery awaits a proven store epoch.');
      const store = current.epoch;
      for (const holder of listStoreEpochHolders(runtime)) {
        if (holder.pid === null || runtime.process.observeLiveness(holder.pid) !== 'absent') {
          throw new Error('Writer recovery awaits absent epoch holders.');
        }
      }
      const observe = createRecordedProcessObserver({
        readIncarnation: (pid) =>
          runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform),
        observeLiveness: (pid) => runtime.process.observeLiveness(pid),
      });
      const discovery = readDiscoveryRecordDisposition(runtime);
      if (discovery.kind === 'undecodable' || (discovery.kind === 'record' && observe(discovery.record) !== 'absent')) {
        throw new Error('Writer recovery awaits an absent coordinator.');
      }
      const runDir = runtime.paths.coral.coordinator.runDir;
      const intent = readUpgradeIntent(runDir);
      if (intent.kind !== 'absent' && intent.kind !== 'readable')
        throw new Error('Writer recovery awaits readable succession evidence.');
      const history = readCompletedSuccessionReceipts(runDir);
      if (history.kind !== 'readable' && history.kind !== 'absent')
        throw new Error('Writer recovery awaits readable receipt history.');
      const receipts = history.kind === 'readable' ? history.receipts : [];
      const intents = intent.kind === 'readable' ? [intent.intent] : [];
      for (let index = 0; index < intents.length; index++) {
        const superseded = intents[index].supersededAttempts;
        if (superseded === undefined) continue;
        if (!Array.isArray(superseded)) throw new Error('Writer recovery awaits readable archived attempts.');
        for (const raw of superseded) {
          const parsed = parseUpgradeIntentSnapshot(raw);
          if (parsed === null) throw new Error('Writer recovery awaits readable archived attempts.');
          intents.push(parsed);
        }
      }
      const records = intents.flatMap((entry) => [
        entry.incumbent,
        entry.attemptChild,
        entry.completionReceipt?.successor,
      ]);
      for (const record of [
        ...records,
        ...receipts.flatMap(({ incumbent, receipt }) => [incumbent, receipt.successor]),
      ]) {
        if (
          record !== null &&
          record !== undefined &&
          observe({ pid: record.pid, ...(record.incarnation === null ? {} : { incarnation: record.incarnation }) }) !==
            'absent'
        ) {
          throw new Error('Writer recovery awaits absent succession writers.');
        }
      }
      const epochDirectories = runtime.storage
        .readdirSync(store.storeRoot)
        .filter((name) => /^epoch-[1-9]\d*$/u.test(name))
        .map((name) => join(store.storeRoot, name));
      epochDirectories.push(
        ...knownProtectedEpochAddresses(runtime, store.storeRoot).map((address) => address.protectedPath),
      );
      for (const directory of epochDirectories) {
        const lock = tryAcquireExclusiveFileLockSync(join(directory, '.lock'));
        if (lock === null) throw new Error(`Writer recovery awaits an unheld epoch: ${directory}.`);
        leases.push(lock);
      }
      const controllerGenerations = controllerWriterRecoveryGenerations(runtime);
      const servingReceipts = receipts.map(({ receipt }) => receipt);
      if (intent.kind === 'readable' && intent.intent.completionReceipt !== null)
        servingReceipts.push(intent.intent.completionReceipt);
      const servings = servingReceipts.map((receipt) => ({
        attemptId: receipt.attemptId,
        epochKey: receipt.epochKey,
        successorInstanceId: receipt.successor.instanceId,
        controlGeneration: receipt.controlGeneration,
        recordedAt: receipt.recordedAt,
      }));
      return {
        store,
        generations: [...controllerGenerations, ...servings.map((serving) => serving.controlGeneration)],
        servings,
        release,
      };
    } catch (error: unknown) {
      release();
      throw error;
    }
  });
}
