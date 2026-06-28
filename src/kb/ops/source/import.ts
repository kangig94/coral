import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { writeAuditEvent } from '../../../infra/audit-log.js';
import { nowIsoString } from '../../../infra/time.js';
import { throwIfAborted } from '../../../runtime/abort.js';
import type { EnvPort, StoragePort, TimePort } from '../../../infra/port-types.js';
import type { ResourceBinding } from '../../../security/principal.js';
import type { IdPort, ProcessPort } from '../../../runtime/ports.js';
import { FRONTMATTER_BLOCK, serializeSourceFrontmatter } from '../../corpus/frontmatter.js';
import { assertWithin, sourceImportStageDir } from '../../paths.js';
import type { KbSourceFrontmatter } from '../../entry-types.js';
import { assertNonEmptyText, assertSourceSlug } from '../../validation.js';
import { convertSourceInWorker } from './conversion-worker.js';

const LEADING_ATX_H1 = /^#(?!#)\s+(.+?)\s*#*\s*(?:\r?\n+|$)/;
const LEADING_SETEXT_H1 = /^([^\r\n]+)\r?\n=+\s*(?:\r?\n+|$)/;

export const USER_SOURCE_IMPORT_MAX_BYTES = 128 * 1024 * 1024;
export const ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT = USER_SOURCE_IMPORT_MAX_BYTES;
export const SOURCE_IMPORT_MARKDOWN_OUTPUT_MAX_BYTES = 128 * 1024 * 1024;
export const SOURCE_IMPORT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV = 'CORAL_KB_IMPORT_MAX_BYTES';
export const SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS_ENV = 'CORAL_KB_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS';
export const SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS_ENV = 'CORAL_KB_IMPORT_CONVERSION_TIMEOUT_MAX_MS';
export const SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB_ENV = 'CORAL_KB_IMPORT_CONVERSION_WORKER_MAX_OLD_MB';
export const SOURCE_IMPORT_MARKER_DEVICE_ENV = 'CORAL_KB_IMPORT_MARKER_DEVICE';
export const SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS_ENV = 'CORAL_KB_IMPORT_MARKER_INSTALL_TIMEOUT_MS';
export const SOURCE_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS_ENV = 'CORAL_KB_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS';
export const SOURCE_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS_ENV = 'CORAL_KB_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS';
export const SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS_ENV = 'CORAL_KB_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS';
export const SOURCE_IMPORT_MARKER_GPU_TIMEOUT_MAX_MS_ENV = 'CORAL_KB_IMPORT_MARKER_GPU_TIMEOUT_MAX_MS';
export const SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
export const SOURCE_IMPORT_MARKER_CPU_TIMEOUT_BASE_MS = 10 * 60 * 1000;
export const SOURCE_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS = 20 * 1000;
export const SOURCE_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS = 45 * 60 * 1000;
export const SOURCE_IMPORT_MARKER_GPU_TIMEOUT_BASE_MS = 3 * 60 * 1000;
export const SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS = 5 * 1000;
export const SOURCE_IMPORT_MARKER_GPU_TIMEOUT_MAX_MS = 15 * 60 * 1000;
export const SOURCE_IMPORT_MARKER_GPU_DETECT_TIMEOUT_MS = 2_000;
export const SOURCE_IMPORT_CONVERSION_TIMEOUT_BASE_MS = 2 * 60 * 1000;
export const SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS = 10 * 1000;
export const SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS = 30 * 60 * 1000;
export const SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB = 512;

const BYTES_PER_MIB = 1024 * 1024;

export type ConversionResult = {
  markdown: string;
  title: string;
};

export type PreparedSourceImport = {
  stagedPath: string;
  slug: string;
  meta: KbSourceFrontmatter;
};

export type SourceImportRuntime = {
  env: Pick<EnvPort, 'fullSnapshot' | 'homedir' | 'platform'>;
  process: Pick<ProcessPort, 'exec'>;
  ids: Pick<IdPort, 'uuid'>;
  time: Pick<TimePort, 'now'>;
  storage: Pick<
    StoragePort,
    'mkdirSync' | 'readFile' | 'readdirSync' | 'realpathSync' | 'rmSync' | 'statSync' | 'writeFileSync'
  >;
};

export type SourceImportContext = {
  runtime: SourceImportRuntime;
  runtimeRoot: string;
  fileSizeLimitBytes: number | null;
  conversionOutputMaxBytes?: number | null;
  limitExceededHint?: string;
  signal?: AbortSignal;
};

export type SourceImportOptions = {
  signal?: AbortSignal;
  maxMarkdownOutputBytes?: number | null;
  limitExceededHint?: string;
};

export type SourceImportReadPolicy =
  | { kind: 'sandboxed'; root: string; maxBytes: number }
  | { kind: 'unrestricted'; resolveBase: string; maxBytes: number | null };

export type ResolvedSourceImportFile = { path: string };

// CLI-only source import converters. Keep npm conversion dependencies isolated here.
export interface Converter {
  isAvailable(ctx: SourceImportContext): Promise<boolean>;
  install(log: (msg: string) => void, ctx: SourceImportContext): Promise<void>;
  convert(filePath: string, ctx: SourceImportContext): Promise<ConversionResult>;
}

type MarkerDevice = 'auto' | 'cpu' | 'cuda' | 'mps';
type MarkerTimeoutProfile = 'cpu' | 'cuda' | 'mps';

type SourceImportCommandOptions = {
  readonly timeoutMs?: number;
  readonly envAdditions?: Record<string, string>;
  readonly timeoutRemediation?: string;
};

function commandEnv(runtime: SourceImportRuntime, envAdditions: Record<string, string> = {}): Record<string, string> {
  const env = { ...runtime.env.fullSnapshot() };
  const homeDir = runtime.env.homedir();
  const localBinDir = homeDir === undefined ? undefined : join(homeDir, '.local', 'bin');
  const path = env.PATH ?? '';
  let pathEnv = path;
  if (localBinDir !== undefined && localBinDir.length > 0) {
    pathEnv = path.length === 0 ? localBinDir : `${localBinDir}${delimiter}${path}`;
  }
  return {
    ...env,
    PATH: pathEnv,
    ...envAdditions,
  };
}

function readPositiveIntegerEnv(env: Readonly<Record<string, string>>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredMarkerDevice(env: Readonly<Record<string, string>>): MarkerDevice {
  const normalized = env[SOURCE_IMPORT_MARKER_DEVICE_ENV]?.trim().toLowerCase();
  if (normalized === 'cpu' || normalized === 'cuda' || normalized === 'auto') {
    return normalized;
  }
  if (normalized === 'mps' || normalized === 'metal') {
    return 'mps';
  }
  return 'auto';
}

function cudaVisibleDevicesAllowsGpu(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== '-1' && normalized !== 'none' && normalized !== 'void';
}

async function markerTimeoutProfile(
  ctx: SourceImportContext,
  env: Readonly<Record<string, string>>,
  device: MarkerDevice,
): Promise<MarkerTimeoutProfile> {
  if (device === 'cpu' || device === 'cuda' || device === 'mps') {
    return device;
  }
  const torchDevice = env.TORCH_DEVICE?.trim().toLowerCase();
  if (torchDevice === 'cpu') {
    return 'cpu';
  }
  if (torchDevice === 'cuda' || torchDevice?.startsWith('cuda:')) {
    return 'cuda';
  }
  if (torchDevice === 'mps' || torchDevice === 'metal') {
    return 'mps';
  }
  if (cudaVisibleDevicesAllowsGpu(env.CUDA_VISIBLE_DEVICES)) {
    return 'cuda';
  }
  if (env.CUDA_VISIBLE_DEVICES === undefined && (await detectNvidiaGpu(ctx))) {
    return 'cuda';
  }
  return (await detectAppleMetalGpu(ctx)) ? 'mps' : 'cpu';
}

function markerDeviceEnvAdditions(
  env: Readonly<Record<string, string>>,
  profile: MarkerTimeoutProfile,
): Record<string, string> {
  if (profile === 'cpu') {
    return {
      TORCH_DEVICE: 'cpu',
      CUDA_VISIBLE_DEVICES: '',
    };
  }
  if (profile === 'mps') {
    return {
      TORCH_DEVICE: 'mps',
    };
  }
  return {
    TORCH_DEVICE: 'cuda',
    CUDA_VISIBLE_DEVICES: cudaVisibleDevicesAllowsGpu(env.CUDA_VISIBLE_DEVICES) ? env.CUDA_VISIBLE_DEVICES : '0',
    PYTORCH_CUDA_ALLOC_CONF: env.PYTORCH_CUDA_ALLOC_CONF ?? 'expandable_segments:True',
  };
}

function markerTimeoutMsForProfile(
  env: Readonly<Record<string, string>>,
  profile: MarkerTimeoutProfile,
  fileSizeBytes: number,
): number {
  const sizeMiB = Math.max(1, Math.ceil(fileSizeBytes / BYTES_PER_MIB));
  if (profile !== 'cpu') {
    const perMiBMs = readPositiveIntegerEnv(
      env,
      SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS_ENV,
      SOURCE_IMPORT_MARKER_GPU_TIMEOUT_PER_MIB_MS,
    );
    const maxMs = readPositiveIntegerEnv(
      env,
      SOURCE_IMPORT_MARKER_GPU_TIMEOUT_MAX_MS_ENV,
      SOURCE_IMPORT_MARKER_GPU_TIMEOUT_MAX_MS,
    );
    return Math.min(maxMs, SOURCE_IMPORT_MARKER_GPU_TIMEOUT_BASE_MS + sizeMiB * perMiBMs);
  }

  const perMiBMs = readPositiveIntegerEnv(
    env,
    SOURCE_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS_ENV,
    SOURCE_IMPORT_MARKER_CPU_TIMEOUT_PER_MIB_MS,
  );
  const maxMs = readPositiveIntegerEnv(
    env,
    SOURCE_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS_ENV,
    SOURCE_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS,
  );
  return Math.min(maxMs, SOURCE_IMPORT_MARKER_CPU_TIMEOUT_BASE_MS + sizeMiB * perMiBMs);
}

function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m${remainingSeconds}s`;
}

function markerTimeoutRemediation(profile: MarkerTimeoutProfile): string {
  const timeoutMaxEnv =
    profile === 'cpu' ? SOURCE_IMPORT_MARKER_CPU_TIMEOUT_MAX_MS_ENV : SOURCE_IMPORT_MARKER_GPU_TIMEOUT_MAX_MS_ENV;
  return [
    'For large or scanned PDFs, retry as an async import, split the file,',
    `or increase ${timeoutMaxEnv}.`,
    `Set ${SOURCE_IMPORT_MARKER_DEVICE_ENV}=cuda or ${SOURCE_IMPORT_MARKER_DEVICE_ENV}=mps before starting the Coral daemon to force GPU conversion when enough VRAM is available.`,
  ].join(' ');
}

async function detectNvidiaGpu(ctx: SourceImportContext): Promise<boolean> {
  try {
    const result = await ctx.runtime.process.exec(
      'nvidia-smi',
      ['--query-gpu=index', '--format=csv,noheader,nounits'],
      {
        encoding: 'utf-8',
        env: commandEnv(ctx.runtime),
        inheritEnv: false,
        maxBuffer: 1024 * 1024,
        timeout: SOURCE_IMPORT_MARKER_GPU_DETECT_TIMEOUT_MS,
      },
    );
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function detectAppleMetalGpu(ctx: SourceImportContext): Promise<boolean> {
  if (ctx.runtime.env.platform() !== 'darwin') {
    return false;
  }
  try {
    const result = await ctx.runtime.process.exec('sysctl', ['-n', 'hw.optional.arm64'], {
      encoding: 'utf-8',
      env: commandEnv(ctx.runtime),
      inheritEnv: false,
      maxBuffer: 1024 * 1024,
      timeout: SOURCE_IMPORT_MARKER_GPU_DETECT_TIMEOUT_MS,
    });
    return result.status === 0 && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}

async function resolveMarkerCommandOptions(
  ctx: SourceImportContext,
  fileSizeBytes: number,
): Promise<Required<Pick<SourceImportCommandOptions, 'timeoutMs' | 'envAdditions' | 'timeoutRemediation'>>> {
  const env = ctx.runtime.env.fullSnapshot();
  const device = configuredMarkerDevice(env);
  const profile = await markerTimeoutProfile(ctx, env, device);
  return {
    timeoutMs: markerTimeoutMsForProfile(env, profile, fileSizeBytes),
    envAdditions: markerDeviceEnvAdditions(env, profile),
    timeoutRemediation: markerTimeoutRemediation(profile),
  };
}

async function resolveCommandPath(command: string, ctx: SourceImportContext): Promise<string | undefined> {
  const locator = ctx.runtime.env.platform() === 'win32' ? 'where' : 'which';

  try {
    const result = await ctx.runtime.process.exec(locator, [command], {
      encoding: 'utf-8',
      env: commandEnv(ctx.runtime),
      inheritEnv: false,
      timeout: 10_000,
    });
    if (result.status !== 0) {
      return undefined;
    }
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length > 0) {
        return line;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function commandExists(command: string, ctx: SourceImportContext): Promise<boolean> {
  return (await resolveCommandPath(command, ctx)) !== undefined;
}

async function runCommand(
  command: string,
  args: string[],
  displayName: string,
  ctx: SourceImportContext,
  options: SourceImportCommandOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SOURCE_IMPORT_COMMAND_TIMEOUT_MS;
  const result = await ctx.runtime.process.exec(command, args, {
    encoding: 'utf-8',
    env: commandEnv(ctx.runtime, options.envAdditions),
    inheritEnv: false,
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.status === 0) {
    return;
  }
  if (result.status === null && result.error?.message.startsWith('timeout:')) {
    const remediation = options.timeoutRemediation === undefined ? '' : ` ${options.timeoutRemediation}`;
    writeAuditEvent(
      'source_import_command_timeout',
      {
        displayName,
        command: basename(command),
        timeoutMs,
        argCount: args.length,
      },
      'warn',
    );
    throw new Error(`${displayName} timed out after ${formatDuration(timeoutMs)}.${remediation}`);
  }

  const outputLines: string[] = [];
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    outputLines.push(stderr);
  }
  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    outputLines.push(stdout);
  }
  if (result.error !== undefined && result.error.message.length > 0) {
    outputLines.push(result.error.message);
  }
  const output = outputLines.join('\n');
  const code = result.status === null ? 'unknown' : String(result.status);
  throw new Error(output ? `${displayName} failed: ${output}` : `${displayName} exited with code ${code}`);
}

function createPdfOutputDir(ctx: SourceImportContext): string {
  const pdfTempRoot = join(ctx.runtimeRoot, 'source-import-pdf');
  ctx.runtime.storage.mkdirSync(pdfTempRoot, { recursive: true });
  // Random suffix via runtime.ids.uuid(); UUID collision is effectively zero,
  // so a single mkdir suffices instead of mkdtemp's retry loop.
  const outputDir = join(pdfTempRoot, `marker-${ctx.runtime.ids.uuid()}`);
  ctx.runtime.storage.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function stagePreparedSourceMarkdown(stageRoot: string, markdown: string, runtime: SourceImportRuntime): string {
  runtime.storage.mkdirSync(stageRoot, { recursive: true });
  const stagedPath = join(stageRoot, `${runtime.ids.uuid()}.md`);
  runtime.storage.writeFileSync(stagedPath, markdown, { encoding: 'utf-8' });
  return stagedPath;
}

export function cleanupSourceImportRuntimeArtifacts(runtimeRoot: string, runtime: SourceImportRuntime): void {
  runtime.storage.rmSync(sourceImportStageDir(runtimeRoot), { recursive: true, force: true });
  runtime.storage.rmSync(join(runtimeRoot, 'source-import-pdf'), { recursive: true, force: true });
}

export function hasParentPathSegment(filePath: string): boolean {
  return filePath.split(/[\\/]+/u).some((segment) => segment === '..');
}

export function sourceImportAdminLimitExceededHint(): string {
  return `Set ${ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV}=<bytes> to allow larger admin source imports, or set ${ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV}=unlimited to disable the cap.`;
}

export function resolveAdminSourceImportCap(env: Pick<EnvPort, 'get'>): number | null {
  const raw = env.get(ADMIN_SOURCE_IMPORT_MAX_BYTES_ENV);
  if (raw === undefined) {
    return ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'unlimited') {
    return null;
  }
  if (!/^\d+$/u.test(normalized)) {
    return ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : ADMIN_SOURCE_IMPORT_MAX_BYTES_DEFAULT;
}

export function deriveSourceImportReadPolicy(
  binding: ResourceBinding,
  projectRoot: string,
  env: Pick<EnvPort, 'get'>,
): SourceImportReadPolicy {
  if (binding.kind === 'project') {
    return { kind: 'sandboxed', root: binding.root, maxBytes: USER_SOURCE_IMPORT_MAX_BYTES };
  }
  return { kind: 'unrestricted', resolveBase: projectRoot, maxBytes: resolveAdminSourceImportCap(env) };
}

function assertSourceImportFileSize(
  filePath: string,
  storage: SourceImportRuntime['storage'],
  limitBytes: number | null,
  label: string,
  limitExceededHint?: string,
): number {
  const stat = storage.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} must be a file`);
  }
  if (limitBytes !== null && stat.size > limitBytes) {
    const message = `${label} exceeds maximum source import size (${stat.size} bytes > ${limitBytes} bytes)`;
    throw new Error(limitExceededHint === undefined ? message : `${message}. ${limitExceededHint}`);
  }
  return stat.size;
}

async function readUtf8FileWithinSourceImportLimit(
  filePath: string,
  ctx: SourceImportContext,
  label: string,
): Promise<string> {
  assertSourceImportFileSize(filePath, ctx.runtime.storage, ctx.fileSizeLimitBytes, label, ctx.limitExceededHint);
  return await ctx.runtime.storage.readFile(filePath, 'utf-8');
}

export function resolveSourceImportFile(
  filePath: string,
  policy: SourceImportReadPolicy,
  storage: SourceImportRuntime['storage'],
): ResolvedSourceImportFile {
  if (policy.kind === 'sandboxed') {
    if (hasParentPathSegment(filePath)) {
      throw new Error('KB source import file path must not contain ".." path segments');
    }

    const canonicalRoot = storage.realpathSync(resolve(policy.root));
    const candidate = isAbsolute(filePath) ? filePath : resolve(canonicalRoot, filePath);
    const canonicalCandidate = storage.realpathSync(candidate);
    const resolvedCandidate = assertWithin(canonicalRoot, canonicalCandidate, 'KB source import file path');

    assertSourceImportFileSize(resolvedCandidate, storage, policy.maxBytes, 'KB source import file path');
    return { path: resolvedCandidate };
  }

  const candidate = isAbsolute(filePath) ? filePath : resolve(policy.resolveBase, filePath);
  const canonicalCandidate = storage.realpathSync(candidate);

  assertSourceImportFileSize(
    canonicalCandidate,
    storage,
    policy.maxBytes,
    'KB source import file path',
    sourceImportAdminLimitExceededHint(),
  );
  return { path: canonicalCandidate };
}

function findFirstMarkdownFile(root: string, storage: SourceImportRuntime['storage']): string | undefined {
  const entries = storage.readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      return join(root, entry.name);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nestedMarkdown = findFirstMarkdownFile(join(root, entry.name), storage);
    if (nestedMarkdown) {
      return nestedMarkdown;
    }
  }

  return undefined;
}

function normalizeTextInput(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

function normalizeTitle(value: string): string {
  return assertNonEmptyText(value.replace(/\s+/g, ' '), 'title');
}

function titleFromFilename(filePath: string): string {
  const filename = basename(filePath);
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return normalizeTitle(stem);
}

export function toKebabCase(value: string): string {
  return normalizeTitle(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripLeadingFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_BLOCK, '');
}

function splitLeadingMarkdownTitle(markdown: string): { title?: string; body: string } {
  const trimmed = markdown.trimStart();
  const atxMatch = trimmed.match(LEADING_ATX_H1);
  if (atxMatch) {
    return {
      title: normalizeTitle(atxMatch[1]),
      body: trimmed.slice(atxMatch[0].length).trim(),
    };
  }

  const setextMatch = trimmed.match(LEADING_SETEXT_H1);
  if (setextMatch) {
    return {
      title: normalizeTitle(setextMatch[1]),
      body: trimmed.slice(setextMatch[0].length).trim(),
    };
  }

  return { body: trimmed.trim() };
}

function missingPackages(packageNames: string[]): string[] {
  const missing: string[] = [];
  for (const packageName of packageNames) {
    try {
      require.resolve(packageName);
    } catch {
      missing.push(packageName);
    }
  }
  return missing;
}

function assertPackagesInstalled(packageNames: string[], log?: (msg: string) => void): void {
  const missing = missingPackages(packageNames);
  if (missing.length === 0) {
    return;
  }

  if (log) {
    log(`Missing npm dependencies: ${missing.join(', ')}`);
    log('Run npm install to install the declared source-import converter packages.');
  }

  throw new Error(`Missing npm dependencies: ${missing.join(', ')}`);
}

function inferSourceType(ext: string): KbSourceFrontmatter['type'] {
  switch (ext.toLowerCase()) {
    case '.html':
    case '.htm':
      return 'blog';
    default:
      return 'internal';
  }
}

function renderSourceMarkdown(meta: KbSourceFrontmatter, body: string): string {
  const heading = `# ${meta.title}`;
  const normalizedBody = body.trim();
  const frontmatter = serializeSourceFrontmatter(meta);

  if (!normalizedBody) {
    return `${frontmatter}${heading}\n`;
  }

  return `${frontmatter}${heading}\n\n${normalizedBody}\n`;
}

function resolveSourceImportMarkdownOutputMaxBytes(
  fileSizeLimitBytes: number | null,
  options: SourceImportOptions,
): number | null {
  if (options.maxMarkdownOutputBytes !== undefined) {
    return options.maxMarkdownOutputBytes;
  }
  return fileSizeLimitBytes;
}

function assertSourceImportMarkdownOutputSize(
  markdown: string,
  maxBytes: number | null,
  limitExceededHint?: string,
): void {
  if (maxBytes === null) {
    return;
  }
  const observedBytes = Buffer.byteLength(markdown, 'utf-8');
  if (observedBytes > maxBytes) {
    const message = `KB source import markdown output exceeds maximum size (${observedBytes} bytes > ${maxBytes} bytes)`;
    throw new Error(limitExceededHint === undefined ? message : `${message}. ${limitExceededHint}`);
  }
}

function sourceImportConversionOutputMaxBytes(ctx: SourceImportContext): number | null {
  return ctx.conversionOutputMaxBytes === undefined ? ctx.fileSizeLimitBytes : ctx.conversionOutputMaxBytes;
}

export function sourceImportConversionTimeoutMs(env: Readonly<Record<string, string>>, fileSizeBytes: number): number {
  const sizeMiB = Math.max(1, Math.ceil(fileSizeBytes / BYTES_PER_MIB));
  const perMiBMs = readPositiveIntegerEnv(
    env,
    SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS_ENV,
    SOURCE_IMPORT_CONVERSION_TIMEOUT_PER_MIB_MS,
  );
  const maxMs = readPositiveIntegerEnv(
    env,
    SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS_ENV,
    SOURCE_IMPORT_CONVERSION_TIMEOUT_MAX_MS,
  );
  return Math.min(maxMs, SOURCE_IMPORT_CONVERSION_TIMEOUT_BASE_MS + sizeMiB * perMiBMs);
}

export function sourceImportConversionWorkerMaxOldMb(env: Readonly<Record<string, string>>): number {
  return readPositiveIntegerEnv(
    env,
    SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB_ENV,
    SOURCE_IMPORT_CONVERSION_WORKER_MAX_OLD_MB,
  );
}

function sourceImportConversionWorkerOptions(
  ctx: SourceImportContext,
  fileSizeBytes: number,
): Parameters<typeof convertSourceInWorker>[1] {
  const env = ctx.runtime.env.fullSnapshot();
  return {
    timeoutMs: sourceImportConversionTimeoutMs(env, fileSizeBytes),
    resourceLimits: {
      maxOldGenerationSizeMb: sourceImportConversionWorkerMaxOldMb(env),
    },
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
}

export async function prepareSourceImport(
  sourceFile: ResolvedSourceImportFile,
  slug: string | undefined,
  fileSizeLimitBytes: number | null,
  log: (msg: string) => void,
  runtimeRoot: string,
  runtime: SourceImportRuntime,
  options: SourceImportOptions,
): Promise<PreparedSourceImport> {
  // Honor the caller's AbortSignal at the two checkpoints that bound the
  // long-running phases of source import: `'convert'` (before invoking the
  // converter, which may shell out to pandoc/uv etc.) and `'persist'`
  // (before staging the converted markdown to disk). The signal is threaded
  // from the KB job's coordinator-owned AbortRegistry; on `coral-cli abort`
  // the registry calls `controller.abort('user_abort')`, which this throw
  // propagates up to the surrounding KB-job recorder where it maps to a
  // `terminal { outcome: 'aborted', reason: 'user_abort' }`.
  const signal = options.signal;
  const sourceFilePath = sourceFile.path;
  const ext = extname(sourceFilePath).toLowerCase();
  const markdownOutputMaxBytes = resolveSourceImportMarkdownOutputMaxBytes(fileSizeLimitBytes, options);
  const ctx: SourceImportContext = {
    runtime,
    runtimeRoot,
    fileSizeLimitBytes,
    conversionOutputMaxBytes: markdownOutputMaxBytes,
    ...(options.limitExceededHint === undefined ? {} : { limitExceededHint: options.limitExceededHint }),
    ...(signal === undefined ? {} : { signal }),
  };
  const converter = resolveConverter(ext);

  if (signal !== undefined) throwIfAborted(signal, 'convert');
  log(`Converting ${sourceFilePath}`);
  if (!(await converter.isAvailable(ctx))) {
    log(`Installing converter dependencies for ${ext || 'source'} import`);
    await converter.install(log, ctx);
  }

  const converted = await converter.convert(sourceFilePath, ctx);
  const meta: KbSourceFrontmatter = {
    title: converted.title,
    type: inferSourceType(ext),
    tags: [],
    importedAt: nowIsoString(runtime.time),
  };
  const normalizedSlug = assertSourceSlug(slug ?? toKebabCase(meta.title), 'source');

  if (signal !== undefined) throwIfAborted(signal, 'persist');
  log('Staging converted markdown for backend import');
  const renderedMarkdown = renderSourceMarkdown(meta, converted.markdown);
  assertSourceImportMarkdownOutputSize(renderedMarkdown, markdownOutputMaxBytes, options.limitExceededHint);
  const stagedPath = stagePreparedSourceMarkdown(sourceImportStageDir(runtimeRoot), renderedMarkdown, runtime);

  return {
    stagedPath,
    slug: normalizedSlug,
    meta,
  };
}

export class MarkdownCopyConverter implements Converter {
  async isAvailable(_ctx: SourceImportContext): Promise<boolean> {
    return true;
  }

  async install(log: (msg: string) => void, _ctx: SourceImportContext): Promise<void> {
    void log;
  }

  async convert(filePath: string, ctx: SourceImportContext): Promise<ConversionResult> {
    const rawMarkdown = normalizeTextInput(
      await readUtf8FileWithinSourceImportLimit(filePath, ctx, 'KB source import markdown file'),
    );
    const withoutFrontmatter = stripLeadingFrontmatter(rawMarkdown);
    const { title, body } = splitLeadingMarkdownTitle(withoutFrontmatter);

    return {
      markdown: body,
      title: title ?? titleFromFilename(filePath),
    };
  }
}

export class HtmlTurndownConverter implements Converter {
  async isAvailable(_ctx: SourceImportContext): Promise<boolean> {
    return missingPackages(['turndown']).length === 0;
  }

  async install(log: (msg: string) => void, _ctx: SourceImportContext): Promise<void> {
    assertPackagesInstalled(['turndown'], log);
  }

  async convert(filePath: string, ctx: SourceImportContext): Promise<ConversionResult> {
    const html = await readUtf8FileWithinSourceImportLimit(filePath, ctx, 'KB source import HTML file');
    return await convertSourceInWorker(
      {
        kind: 'html',
        html,
        outputMaxBytes: sourceImportConversionOutputMaxBytes(ctx),
        ...(ctx.limitExceededHint === undefined ? {} : { limitExceededHint: ctx.limitExceededHint }),
      },
      sourceImportConversionWorkerOptions(ctx, Buffer.byteLength(html, 'utf-8')),
    );
  }
}

export class DocxMammothConverter implements Converter {
  async isAvailable(_ctx: SourceImportContext): Promise<boolean> {
    return missingPackages(['mammoth', 'turndown']).length === 0;
  }

  async install(log: (msg: string) => void, _ctx: SourceImportContext): Promise<void> {
    assertPackagesInstalled(['mammoth', 'turndown'], log);
  }

  async convert(filePath: string, ctx: SourceImportContext): Promise<ConversionResult> {
    const fileSizeBytes = assertSourceImportFileSize(
      filePath,
      ctx.runtime.storage,
      ctx.fileSizeLimitBytes,
      'KB source import DOCX file',
      ctx.limitExceededHint,
    );
    return await convertSourceInWorker(
      {
        kind: 'docx',
        filePath,
        outputMaxBytes: sourceImportConversionOutputMaxBytes(ctx),
        ...(ctx.limitExceededHint === undefined ? {} : { limitExceededHint: ctx.limitExceededHint }),
      },
      sourceImportConversionWorkerOptions(ctx, fileSizeBytes),
    );
  }
}

export class PdfMarkerConverter implements Converter {
  async isAvailable(ctx: SourceImportContext): Promise<boolean> {
    return commandExists('marker_single', ctx);
  }

  async install(log: (msg: string) => void, ctx: SourceImportContext): Promise<void> {
    let uvCommand = await resolveCommandPath('uv', ctx);

    if (!uvCommand) {
      log('Installing uv...');
      if (ctx.runtime.env.platform() === 'win32') {
        await runCommand('powershell', ['-c', 'irm https://astral.sh/uv/install.ps1 | iex'], 'uv installer', ctx);
      } else {
        await runCommand('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], 'uv installer', ctx);
      }

      uvCommand = await resolveCommandPath('uv', ctx);
      if (!uvCommand) {
        throw new Error('uv was not found after installation');
      }
    }

    log('Installing Python 3.12 + Marker...');
    const installEnv = ctx.runtime.env.fullSnapshot();
    await runCommand(
      uvCommand,
      ['tool', 'install', 'marker-pdf', '--python', '3.12'],
      'uv tool install marker-pdf',
      ctx,
      {
        timeoutMs: readPositiveIntegerEnv(
          installEnv,
          SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS_ENV,
          SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS,
        ),
        timeoutRemediation: `Check network access and retry, or increase ${SOURCE_IMPORT_MARKER_INSTALL_TIMEOUT_MS_ENV}.`,
      },
    );

    if (!(await commandExists('marker_single', ctx))) {
      throw new Error('marker_single was not found after installing marker-pdf');
    }
  }

  async convert(filePath: string, ctx: SourceImportContext): Promise<ConversionResult> {
    const fileSizeBytes = assertSourceImportFileSize(
      filePath,
      ctx.runtime.storage,
      ctx.fileSizeLimitBytes,
      'KB source import PDF file',
    );
    const markerCommand = await resolveCommandPath('marker_single', ctx);
    if (!markerCommand) {
      throw new Error('marker_single is not available');
    }

    const outputDir = createPdfOutputDir(ctx);

    try {
      const commandOptions = await resolveMarkerCommandOptions(ctx, fileSizeBytes);
      await runCommand(
        markerCommand,
        [filePath, '--output_dir', outputDir, '--disable_tqdm'],
        'marker_single',
        ctx,
        commandOptions,
      );
      const markdownPath = findFirstMarkdownFile(outputDir, ctx.runtime.storage);
      if (!markdownPath) {
        throw new Error('marker_single did not produce a markdown file');
      }

      const rawMarkdown = normalizeTextInput(
        await readUtf8FileWithinSourceImportLimit(markdownPath, ctx, 'Marker output markdown file'),
      );
      const { title, body } = splitLeadingMarkdownTitle(rawMarkdown);
      if (!title) {
        throw new Error('PDF import requires Marker output to begin with a top-level heading');
      }

      return {
        markdown: body,
        title,
      };
    } finally {
      ctx.runtime.storage.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

export function resolveConverter(ext: string): Converter {
  switch (ext.toLowerCase()) {
    case '.md':
      return new MarkdownCopyConverter();
    case '.html':
    case '.htm':
      return new HtmlTurndownConverter();
    case '.docx':
      return new DocxMammothConverter();
    case '.pdf':
      return new PdfMarkerConverter();
    default:
      throw new Error(`Unsupported source import extension: ${ext}`);
  }
}
