import { join } from 'node:path';
import { z } from 'zod';
import type { Runtime } from '../../runtime/ports.js';

import { strictBundleManifestSchema, type StrictBundleManifest } from '../../infra/bundle-manifest.js';
import { SUCCESSION_CAPABILITIES_FILE, SUCCESSION_CAPABILITY_VERSION } from '../../infra/bundle-manifest-address.js';
import { jsonValueSchema } from '../../infra/json-value.js';
import { SUCCESSION_PROTOCOL_VERSION } from '../../infra/succession-address.js';

const acceptanceSchema = z.object({ owner: z.string().min(1), generation: z.number().int().positive() }).passthrough();

export const successionCapabilitiesSchema = z
  .object({
    version: z.literal(SUCCESSION_CAPABILITY_VERSION),
    buildSetId: z.string().min(1),
    bundleHash: z.string().min(1),
    protocols: z.array(z.string().min(1)),
    accepts: z.array(acceptanceSchema),
  })
  .passthrough();

export type SuccessionCapabilities = z.infer<typeof successionCapabilitiesSchema>;

export const successionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    target: z
      .object({
        build: strictBundleManifestSchema,
        pluginRootLabel: z.string().min(1),
      })
      .passthrough(),
  })
  .strict();

export const successionPrepareSchema = z.object({ requestId: z.string().min(1) }).strict();
export const successionCommitSchema = z.object({ attemptId: z.string().min(1) }).strict();
export const successionAbortSchema = z.object({ attemptId: z.string().min(1) }).strict();
export const successionStatusSchema = z.object({ requestId: z.string().min(1).optional() }).strict();

export const successionReadySchema = z
  .object({
    attemptId: z.string().min(1),
    successorPid: z.number().int().positive(),
    targetKey: z.string().min(1),
    epochKey: z.string().min(1),
    admissionRevision: z.number().int().nonnegative(),
    receiptIds: z.array(z.string().min(1)),
  })
  .strict();

export type SuccessionReady = z.infer<typeof successionReadySchema>;

export const successionTransferReceiptSchema = z
  .object({
    owner: z.string().min(1),
    generation: z.number().int().positive(),
    attemptId: z.string().min(1),
    receiptId: z.string().min(1),
    recoveryGrantId: z.string().min(1),
    payload: jsonValueSchema,
  })
  .strict();

export const successionPreparationSchema = z
  .object({
    version: z.literal(SUCCESSION_PROTOCOL_VERSION),
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    incumbentInstanceId: z.string().min(1),
    incumbentPid: z.number().int().positive(),
    incumbentKey: z.string().min(1),
    targetKey: z.string().min(1),
    capabilitiesKey: z.string().min(1),
    epochKey: z.string().min(1),
    admissionRevision: z.number().int().nonnegative(),
    accepts: z.array(z.object({ owner: z.string().min(1), generation: z.number().int().positive() }).strict()),
    receipts: z.array(successionTransferReceiptSchema),
    stage: z.enum(['prepared', 'ready', 'committing']),
    ready: successionReadySchema.nullable(),
  })
  .strict();

export type SuccessionPreparation = z.infer<typeof successionPreparationSchema>;

export function readSuccessionCapabilities(
  runtime: Pick<Runtime, 'storage'>,
  bundleDir: string,
  manifest: StrictBundleManifest,
): { kind: 'declared'; capabilities: SuccessionCapabilities } | { kind: 'absent' | 'invalid' } {
  const path = join(bundleDir, SUCCESSION_CAPABILITIES_FILE);
  let raw: string;
  try {
    const stat = runtime.storage.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || runtime.storage.statSync(path).size > 16 * 1024)
      return { kind: 'invalid' };
    raw = runtime.storage.readFileSync(path, 'utf-8');
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'invalid' };
  }
  try {
    const parsed = successionCapabilitiesSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return { kind: 'invalid' };
    const capabilities = parsed.data;
    if (capabilities.buildSetId !== manifest.buildSetId || capabilities.bundleHash !== manifest.bundleHash) {
      return { kind: 'invalid' };
    }
    if (new Set(capabilities.protocols).size !== capabilities.protocols.length) return { kind: 'invalid' };
    if (
      new Set(capabilities.accepts.map(({ owner, generation }) => `${owner}:${generation}`)).size !==
      capabilities.accepts.length
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'declared', capabilities };
  } catch {
    return { kind: 'invalid' };
  }
}
