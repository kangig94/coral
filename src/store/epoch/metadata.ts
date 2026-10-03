import { type StrictBundleManifest } from '../../infra/bundle-manifest.js';
import { truncate } from '../../infra/text.js';
import { type StoragePort } from '../../infra/port-types.js';
import { join } from 'node:path';
import {
  type StoreEpoch,
  type StoreEpochClassification,
  type StoreEpochMetadata,
  type StoreEpochMetadataDisposition,
} from './types.js';
import {
  STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH,
  STORE_EPOCH_METADATA_FILE_NAME,
  MAX_STORE_EPOCH_METADATA_BYTES,
} from './constants.js';
import { errorCode } from './classification.js';

export function metadataFor(
  supersedes: StoreEpoch | null,
  classification: StoreEpochClassification,
  build: StrictBundleManifest,
  publishedAt: string,
): StoreEpochMetadata {
  return {
    supersedes,
    classification,
    build: {
      version: build.version,
      buildSetId: build.buildSetId,
      bundleHash: build.bundleHash,
      flavor: build.flavor,
      storeFormatFingerprint: build.storeFormatFingerprint,
    },
    publishedAt,
  };
}

function serializeEpochMetadata(metadata: StoreEpochMetadata): string {
  const boundedClassification = JSON.parse(
    JSON.stringify(metadata.classification, (key, value: unknown) =>
      key !== 'kind' && typeof value === 'string'
        ? truncate(value, STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH)
        : value,
    ),
  ) as StoreEpochClassification;
  return `${JSON.stringify({ ...metadata, classification: boundedClassification })}\n`;
}

export function writeEpochMetadata(storage: StoragePort, mint: string, metadata: StoreEpochMetadata): void {
  const serialized = serializeEpochMetadata(metadata);
  if (
    !storage.writeAtomicDurableSync(join(mint, STORE_EPOCH_METADATA_FILE_NAME), serialized, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  ) {
    throw new Error(`Failed to publish ${STORE_EPOCH_METADATA_FILE_NAME} in '${mint}'.`);
  }
  if (!storage.syncDirectoryDurableSync(mint)) {
    throw new Error(`Failed to durably sync store mint '${mint}'.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyMetadataText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

export function parseStoreEpochMetadata(value: unknown): StoreEpochMetadata | null {
  if (!isRecord(value)) return null;
  const supersedes =
    value.supersedes === null
      ? null
      : typeof value.supersedes === 'string' && /^[1-9]\d*$/.test(value.supersedes)
        ? value.supersedes
        : typeof value.supersedes === 'number' && Number.isSafeInteger(value.supersedes) && value.supersedes >= 1
          ? String(value.supersedes)
          : undefined;
  if (supersedes === undefined) return null;
  if (!isRecord(value.classification) || !nonEmptyMetadataText(value.classification.kind)) return null;
  if (!isRecord(value.build) || !nonEmptyMetadataText(value.build.version)) return null;
  if (
    typeof value.publishedAt !== 'string' ||
    Number.isNaN(Date.parse(value.publishedAt)) ||
    new Date(value.publishedAt).toISOString() !== value.publishedAt
  )
    return null;
  const build = value.build;
  if (
    !nonEmptyMetadataText(build.buildSetId) ||
    !nonEmptyMetadataText(build.bundleHash) ||
    (build.flavor !== 'prod' && build.flavor !== 'dev') ||
    !nonEmptyMetadataText(build.storeFormatFingerprint)
  ) {
    return null;
  }
  return { ...value, supersedes } as StoreEpochMetadata;
}

export function readEpochMetadata(
  storage: Pick<StoragePort, 'lstatSync' | 'readFileSync'>,
  directory: string,
): StoreEpochMetadataDisposition {
  const metadataPath = join(directory, STORE_EPOCH_METADATA_FILE_NAME);
  try {
    const directoryEntry = storage.lstatSync(directory, { bigint: true });
    const entry = storage.lstatSync(metadataPath, { bigint: true });
    if (
      !entry.isFile() ||
      entry.nlink !== 1n ||
      entry.dev !== directoryEntry.dev ||
      entry.size > BigInt(MAX_STORE_EPOCH_METADATA_BYTES)
    ) {
      return { kind: 'malformed' };
    }
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    const parsed = parseStoreEpochMetadata(JSON.parse(storage.readFileSync(metadataPath, 'utf-8')));
    return parsed === null ? { kind: 'malformed' } : { kind: 'valid', value: parsed };
  } catch (error: unknown) {
    return error instanceof SyntaxError ? { kind: 'malformed' } : { kind: 'unreadable' };
  }
}
