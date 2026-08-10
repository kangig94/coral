import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { z } from 'zod';

const STALE_BUILD_DIAGNOSTIC = 'clients/build is stale; run npm run build:dev';
const FULL_SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_INPUTS = [
  'package.json',
  'scripts/build-server.mjs',
  'scripts/server-esbuild-options.mjs',
  'tsconfig.json',
] as const;

const outputSchema = <Path extends string>(path: Path) =>
  z
    .object({
      path: z.literal(path),
      sha256: z.string().regex(FULL_SHA256),
    })
    .strict();

const bundleFreshnessReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal('sha256'),
    flavor: z.enum(['dev', 'prod']),
    sourceSha256: z.string().regex(FULL_SHA256),
    inputs: z.array(z.string()),
    outputs: z
      .object({
        backend: outputSchema('clients/build/coral-backend.cjs'),
        cli: outputSchema('clients/build/coral-cli.cjs'),
        claudeAppserver: outputSchema('clients/build/coral-claude-appserver.cjs'),
        manifest: outputSchema('clients/build/manifest.json'),
      })
      .strict(),
  })
  .strict();

export type BundleFreshnessReceiptV1 = Readonly<{
  schemaVersion: 1;
  algorithm: 'sha256';
  flavor: 'dev' | 'prod';
  sourceSha256: string;
  inputs: readonly string[];
  outputs: Readonly<{
    backend: Readonly<{ path: 'clients/build/coral-backend.cjs'; sha256: string }>;
    cli: Readonly<{ path: 'clients/build/coral-cli.cjs'; sha256: string }>;
    claudeAppserver: Readonly<{ path: 'clients/build/coral-claude-appserver.cjs'; sha256: string }>;
    manifest: Readonly<{ path: 'clients/build/manifest.json'; sha256: string }>;
  }>;
}>;

function isCanonicalRepositoryInput(repositoryRoot: string, input: string): boolean {
  if (
    input.length === 0 ||
    input === '.' ||
    input.includes('\\') ||
    posix.isAbsolute(input) ||
    posix.normalize(input) !== input ||
    input.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return false;
  }

  const resolved = resolve(repositoryRoot, input);
  const repositoryRelative = relative(repositoryRoot, resolved);
  return repositoryRelative !== '' && !repositoryRelative.startsWith('..') && !isAbsolute(repositoryRelative);
}

function assertCanonicalInputs(repositoryRoot: string, inputs: readonly string[]): void {
  if (
    inputs.length === 0 ||
    inputs.some((input) => !isCanonicalRepositoryInput(repositoryRoot, input)) ||
    inputs.some((input, index) => index > 0 && inputs[index - 1] >= input) ||
    REQUIRED_INPUTS.some((input) => !inputs.includes(input))
  ) {
    throw new Error('invalid build receipt inputs');
  }
}

export function lifecycleBundleSourceSha256(repositoryRoot: string, inputs: readonly string[]): string {
  const digest = createHash('sha256');
  for (const input of inputs) {
    const pathBytes = Buffer.from(input, 'utf8');
    const content = readFileSync(resolve(repositoryRoot, input));
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(content.length));
    digest.update(pathLength).update(pathBytes).update(contentLength).update(content);
  }
  return digest.digest('hex');
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertLifecycleBundleSetFresh(repositoryRoot = process.cwd()): void {
  try {
    const receiptPath = resolve(repositoryRoot, 'clients/build/build-receipt.json');
    const receipt = bundleFreshnessReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, 'utf8')));
    assertCanonicalInputs(repositoryRoot, receipt.inputs);

    if (lifecycleBundleSourceSha256(repositoryRoot, receipt.inputs) !== receipt.sourceSha256) {
      throw new Error('build source digest mismatch');
    }

    for (const output of Object.values(receipt.outputs)) {
      if (fileSha256(resolve(repositoryRoot, output.path)) !== output.sha256) {
        throw new Error('build output digest mismatch');
      }
    }
  } catch {
    throw new Error(STALE_BUILD_DIAGNOSTIC);
  }
}
