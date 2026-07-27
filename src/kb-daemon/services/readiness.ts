import type { Backed, FtsRetrieval, KbCorpusSnapshot, KbRuntime } from '../../kb/contract.js';
import type { VectorRetrieval } from '../../kb/search/contract.js';
import type { RegisteredKbCapability } from '../../kb/capability/contract.js';
import { KB_FTS_CAPABILITY, KB_VECTOR_CAPABILITY } from '../../kb/capability/constants.js';
import type { SourceImportReadiness } from '../../jobs/launch.js';
import { CoralSetupError, documentedCoralSetupError } from '../../runtime/errors.js';

function isTrustedCorpusCapability(record: RegisteredKbCapability): boolean {
  if (record.origin !== 'builtin') {
    return false;
  }
  const { name } = record.descriptor;
  return name === KB_FTS_CAPABILITY || name === KB_VECTOR_CAPABILITY;
}

// Bundled Orama always binds kb.fts; external engines may bind kb.vector when
// equipped. Unbound capabilities throw 'binding_empty' from `read()`; skip them
// so 'all-equipped' is best-effort over currently equipped corpus consumers.
function readBoundCorpusConsumerIds(kb: Pick<KbRuntime, 'capabilityRegistry'>): string[] {
  const runtimeView = kb.capabilityRegistry.runtimeView();
  const ids: string[] = [];
  for (const record of runtimeView.list()) {
    if (!isTrustedCorpusCapability(record)) {
      continue;
    }
    try {
      ids.push(runtimeView.read<Backed<FtsRetrieval | VectorRetrieval>>(record.descriptor.name).consumer.id);
    } catch {
      // binding_empty; corpus consumer not currently equipped.
    }
  }
  return ids;
}

export type CorpusSnapshotWaiter = (params: {
  consumerId: string;
  snapshot: KbCorpusSnapshot;
  timeoutMs: number;
}) => Promise<void>;

function isBindingEmpty(error: unknown): boolean {
  return error instanceof CoralSetupError && error.code === 'binding_empty';
}

// Spec §6.4 readiness contract for daemon-owned source import/reindex completion.
export async function waitForCorpusReadiness(params: {
  kb: Pick<KbRuntime, 'capabilityRegistry'>;
  readiness: SourceImportReadiness;
  snapshot: KbCorpusSnapshot;
  timeoutMs: number;
  waitFresh: CorpusSnapshotWaiter;
}): Promise<void> {
  const { kb, readiness, snapshot, timeoutMs, waitFresh } = params;
  switch (readiness) {
    case 'commit':
      return;
    case 'base-search': {
      let consumerId: string;
      try {
        consumerId = kb.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).consumer.id;
      } catch (error) {
        if (isBindingEmpty(error)) {
          throw documentedCoralSetupError('kb_unavailable', { readiness, binding: 'kb.fts' });
        }
        throw error;
      }
      await waitFresh({ consumerId, snapshot, timeoutMs });
      return;
    }
    case 'active-vector': {
      let consumerId: string;
      try {
        consumerId = kb.capabilityRegistry.runtimeView().read<Backed<VectorRetrieval>>(KB_VECTOR_CAPABILITY)
          .consumer.id;
      } catch (error) {
        if (isBindingEmpty(error)) {
          throw documentedCoralSetupError('kb_unavailable', { readiness, binding: 'kb.vector' });
        }
        throw error;
      }
      await waitFresh({ consumerId, snapshot, timeoutMs });
      return;
    }
    case 'all-equipped': {
      const corpusConsumerIds = readBoundCorpusConsumerIds(kb);
      await Promise.all(corpusConsumerIds.map((consumerId) => waitFresh({ consumerId, snapshot, timeoutMs })));
      return;
    }
  }
}
