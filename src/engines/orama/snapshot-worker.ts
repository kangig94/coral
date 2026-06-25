import * as timers from 'node:timers';
import { Worker } from 'node:worker_threads';

import type { RawData } from '@orama/orama';

import type { OramaEntryManifest, OramaProjectionMetadata, OramaProjectionMetadataBase } from './artifact-port.js';

export const ORAMA_SNAPSHOT_SERIALIZE_WORKER_TIMEOUT_MS = 60_000;

export type SerializedOramaSnapshotArtifact = {
  readonly artifactRaw: string;
  readonly artifactDigest: string;
  readonly entryManifest: OramaEntryManifest;
};

export type SerializedOramaProjectionArtifact = {
  readonly artifactRaw: string;
  readonly metadataRaw: string;
  readonly metadata: OramaProjectionMetadata;
};

export type SerializeOramaSnapshotArtifactOptions = {
  readonly timeoutMs?: number;
};

type WorkerSuccessMessage = {
  readonly ok: true;
  readonly artifactRaw: string;
  readonly artifactDigest: string;
  readonly entryManifest?: OramaEntryManifest;
  readonly metadataRaw?: string;
  readonly metadata?: OramaProjectionMetadata;
};

type WorkerFailureMessage = {
  readonly ok: false;
  readonly error: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
  };
};

type WorkerMessage = WorkerSuccessMessage | WorkerFailureMessage;

const ORAMA_SNAPSHOT_SERIALIZE_WORKER_SOURCE = `
const { createHash } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOramaEntryKind(value) {
  return value === 'note' || value === 'source' || value === 'community' || value === 'wiki';
}

function isOramaFreshness(value) {
  return value === 'fresh' || value === 'stale';
}

function readStringField(document, field) {
  const value = document[field];
  return typeof value === 'string' ? value : null;
}

function createOramaEntryManifestFromArtifact(artifact) {
  if (!isRecord(artifact) || !isRecord(artifact.docs) || !isRecord(artifact.docs.docs)) {
    throw new Error('projection artifact is missing the Orama document store');
  }

  const manifest = {};
  for (const document of Object.values(artifact.docs.docs)) {
    if (!isRecord(document)) {
      throw new Error('projection artifact document store contains a malformed document');
    }

    const entryId = readStringField(document, 'entryId');
    const documentId = readStringField(document, 'id');
    const contentHash = readStringField(document, 'contentHash');
    const metadataHash = readStringField(document, 'metadataHash');
    const { kind, freshness } = document;
    if (
      entryId === null ||
      documentId === null ||
      contentHash === null ||
      metadataHash === null ||
      !isOramaEntryKind(kind) ||
      !isOramaFreshness(freshness)
    ) {
      throw new Error('projection artifact document store contains a document missing manifest fields');
    }

    manifest[entryId] = {
      documentId,
      contentHash,
      metadataHash,
      kind,
      freshness,
    };
  }

  return manifest;
}

try {
  const artifact = workerData.snapshot;
  const artifactRaw = \`\${JSON.stringify(artifact, null, 2)}\\n\`;
  const artifactDigest = createHash('sha256').update(artifactRaw).digest('hex');
  const entryManifest = createOramaEntryManifestFromArtifact(artifact);
  if (workerData.metadataBase !== undefined) {
    const metadata = { ...workerData.metadataBase, artifactDigest, entryManifest };
    const metadataRaw = \`\${JSON.stringify(metadata, null, 2)}\\n\`;
    parentPort.postMessage({ ok: true, artifactRaw, artifactDigest, metadataRaw, metadata });
  } else {
    parentPort.postMessage({ ok: true, artifactRaw, artifactDigest, entryManifest });
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) },
  });
}
`;

function workerErrorFromMessage(message: WorkerFailureMessage): Error {
  const error = new Error(message.error.message);
  error.name = message.error.name ?? 'Error';
  if (message.error.stack !== undefined) {
    error.stack = message.error.stack;
  }
  return error;
}

async function runOramaSnapshotSerializeWorker(
  snapshot: RawData,
  options: SerializeOramaSnapshotArtifactOptions & { metadataBase?: OramaProjectionMetadataBase } = {},
): Promise<WorkerSuccessMessage> {
  const timeoutMs = options.timeoutMs ?? ORAMA_SNAPSHOT_SERIALIZE_WORKER_TIMEOUT_MS;
  return await new Promise<WorkerSuccessMessage>((resolve, reject) => {
    const worker = new Worker(ORAMA_SNAPSHOT_SERIALIZE_WORKER_SOURCE, {
      eval: true,
      workerData: { snapshot, metadataBase: options.metadataBase },
    });
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      timers.clearTimeout(timeout);
      callback();
    };

    const timeout = timers.setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new Error(`Orama snapshot serialization worker timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    worker.once('message', (message: WorkerMessage) => {
      finish(() => {
        void worker.terminate();
        if (message.ok) {
          resolve(message);
          return;
        }
        reject(workerErrorFromMessage(message));
      });
    });

    worker.once('error', (error) => {
      finish(() => {
        reject(error);
      });
    });

    worker.once('exit', (code) => {
      if (!settled) {
        finish(() => {
          const message =
            code === 0
              ? 'Orama snapshot serialization worker exited before returning a response'
              : `Orama snapshot serialization worker exited with code ${code}`;
          reject(new Error(message));
        });
      }
    });
  });
}

export async function serializeOramaSnapshotArtifactInWorker(
  snapshot: RawData,
  options: SerializeOramaSnapshotArtifactOptions = {},
): Promise<SerializedOramaSnapshotArtifact> {
  const message = await runOramaSnapshotSerializeWorker(snapshot, options);
  if (message.entryManifest === undefined) {
    throw new Error('Orama snapshot serialization worker returned no entry manifest');
  }
  return {
    artifactRaw: message.artifactRaw,
    artifactDigest: message.artifactDigest,
    entryManifest: message.entryManifest,
  };
}

export async function serializeOramaProjectionArtifactInWorker(
  snapshot: RawData,
  metadataBase: OramaProjectionMetadataBase,
  options: SerializeOramaSnapshotArtifactOptions = {},
): Promise<SerializedOramaProjectionArtifact> {
  const message = await runOramaSnapshotSerializeWorker(snapshot, { ...options, metadataBase });
  if (message.metadata === undefined || message.metadataRaw === undefined) {
    throw new Error('Orama snapshot serialization worker returned no projection metadata');
  }
  return {
    artifactRaw: message.artifactRaw,
    metadataRaw: message.metadataRaw,
    metadata: message.metadata,
  };
}
