import { basename, delimiter, extname, join } from 'node:path';
import { nowIsoString } from '../../infra/time.js';
import { throwIfAborted } from '../../runtime/abort.js';
import { createRealRuntime } from '../../runtime/real.js';
import type { EnvPort, IdPort, ProcessPort, StoragePort, TimePort } from '../../runtime/ports.js';
import { FRONTMATTER_BLOCK, serializeSourceFrontmatter } from '../corpus/frontmatter.js';
import { sourceImportStageDir } from '../paths.js';
import type { KbSourceFrontmatter } from '../entry-types.js';
import { assertNonEmptyText, assertSourceSlug } from '../validation.js';

const LEADING_ATX_H1 = /^#(?!#)\s+(.+?)\s*#*\s*(?:\r?\n+|$)/;
const LEADING_SETEXT_H1 = /^([^\r\n]+)\r?\n=+\s*(?:\r?\n+|$)/;
const HTML_TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const HTML_H1_PATTERN = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const HTML_BODY_PATTERN = /<body\b[^>]*>([\s\S]*?)<\/body>/i;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

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
  storage: Pick<StoragePort, 'mkdirSync' | 'readFileSync' | 'readdirSync' | 'rmSync' | 'writeFileSync'>;
};

export type SourceImportContext = {
  runtime: SourceImportRuntime;
  runtimeRoot: string;
};

type TurndownServiceLike = {
  turndown(input: string): string;
};

type TurndownConstructor = new (options?: Record<string, unknown>) => TurndownServiceLike;

type MammothLike = {
  convertToHtml(input: { path: string }): Promise<{ value: string }>;
};

// CLI-only source import converters. Keep npm conversion dependencies isolated here.
export interface Converter {
  isAvailable(ctx: SourceImportContext): Promise<boolean>;
  install(log: (msg: string) => void, ctx: SourceImportContext): Promise<void>;
  convert(filePath: string, ctx: SourceImportContext): Promise<ConversionResult>;
}

function createDefaultSourceImportRuntime(): SourceImportRuntime {
  // SourceImportRuntime only needs env/process/ids/time — no path-flavor dependency,
  // so 'prod' is a safe placeholder.
  const runtime = createRealRuntime('prod');
  return {
    env: runtime.env,
    process: runtime.process,
    ids: runtime.ids,
    time: runtime.time,
    storage: runtime.storage,
  };
}

function commandEnv(runtime: SourceImportRuntime): Record<string, string> {
  const env = { ...runtime.env.fullSnapshot() };
  const homeDir = runtime.env.homedir();
  const localBinDir = homeDir === undefined ? undefined : join(homeDir, '.local', 'bin');
  return {
    ...env,
    PATH: [localBinDir, env.PATH ?? ''].filter(Boolean).join(delimiter),
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
    const { stdout } = result;
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
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
): Promise<void> {
  const result = await ctx.runtime.process.exec(command, args, {
    encoding: 'utf-8',
    env: commandEnv(ctx.runtime),
    inheritEnv: false,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status === 0) {
    return;
  }

  const output = [result.stderr.trim(), result.stdout.trim(), result.error?.message].filter(Boolean).join('\n');
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

function decodeHtmlEntity(entity: string): string {
  const normalized = entity.toLowerCase();
  if (normalized.startsWith('#x')) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    if (!Number.isInteger(codePoint)) {
      return `&${entity};`;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return `&${entity};`;
    }
  }

  if (normalized.startsWith('#')) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint)) {
      return `&${entity};`;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return `&${entity};`;
    }
  }

  return HTML_ENTITIES[normalized] ?? `&${entity};`;
}

function htmlFragmentToText(fragment: string): string | undefined {
  const withoutComments = fragment.replace(/<!--[\s\S]*?-->/g, ' ');
  const withoutTags = withoutComments.replace(/<[^>]+>/g, ' ');
  const decoded = withoutTags.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (_, entity: string) =>
    decodeHtmlEntity(entity),
  );
  const normalized = decoded.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function extractHtmlTitle(html: string): string | undefined {
  const titleMatch = html.match(HTML_TITLE_PATTERN)?.[1];
  const titleText = titleMatch ? htmlFragmentToText(titleMatch) : undefined;
  if (titleText) {
    return normalizeTitle(titleText);
  }

  return extractFirstHtmlH1(html);
}

function extractFirstHtmlH1(html: string): string | undefined {
  const h1Match = html.match(HTML_H1_PATTERN)?.[1];
  const h1Text = h1Match ? htmlFragmentToText(h1Match) : undefined;
  return h1Text ? normalizeTitle(h1Text) : undefined;
}

function extractHtmlBody(html: string): string {
  return html.match(HTML_BODY_PATTERN)?.[1] ?? html;
}

function missingPackages(packageNames: string[]): string[] {
  return packageNames.filter((packageName) => {
    try {
      require.resolve(packageName);
      return false;
    } catch {
      return true;
    }
  });
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

async function loadTurndownService(): Promise<TurndownConstructor> {
  assertPackagesInstalled(['turndown']);
  const loaded = (await import('turndown')) as { default?: unknown };
  const candidate = (loaded.default ?? loaded) as TurndownConstructor;
  if (typeof candidate !== 'function') {
    throw new Error('turndown did not export a constructor');
  }
  return candidate;
}

async function loadMammoth(): Promise<MammothLike> {
  assertPackagesInstalled(['mammoth']);
  const loaded = (await import('mammoth')) as { default?: unknown; convertToHtml?: unknown };
  const candidate = (loaded.default ?? loaded) as Partial<MammothLike>;
  if (typeof candidate.convertToHtml !== 'function') {
    throw new Error('mammoth did not export convertToHtml');
  }
  return candidate as MammothLike;
}

async function htmlToMarkdownBody(html: string): Promise<string> {
  const TurndownService = await loadTurndownService();
  const turndown = new TurndownService({ headingStyle: 'atx' });
  const markdown = turndown.turndown(extractHtmlBody(html));
  return splitLeadingMarkdownTitle(markdown).body;
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

export async function prepareSourceImport(
  filePath: string,
  slug: string | undefined,
  log: (msg: string) => void,
  runtimeRoot: string,
  runtime: SourceImportRuntime = createDefaultSourceImportRuntime(),
  options?: { signal?: AbortSignal },
): Promise<PreparedSourceImport> {
  // Honor the caller's AbortSignal at the two checkpoints that bound the
  // long-running phases of source import: `'convert'` (before invoking the
  // converter, which may shell out to pandoc/uv etc.) and `'persist'`
  // (before staging the converted markdown to disk). The signal is threaded
  // from the KB job's coordinator-owned AbortRegistry; on `coral-cli abort`
  // the registry calls `controller.abort('user_abort')`, which this throw
  // propagates up to the surrounding KB-job recorder where it maps to a
  // `terminal { outcome: 'aborted', reason: 'user_abort' }`.
  const signal = options?.signal;
  const ext = extname(filePath).toLowerCase();
  const ctx: SourceImportContext = { runtime, runtimeRoot };
  const converter = resolveConverter(ext);

  if (signal !== undefined) throwIfAborted(signal, 'convert');
  log(`Converting ${filePath}`);
  if (!(await converter.isAvailable(ctx))) {
    log(`Installing converter dependencies for ${ext || 'source'} import`);
    await converter.install(log, ctx);
  }

  const converted = await converter.convert(filePath, ctx);
  const meta: KbSourceFrontmatter = {
    title: converted.title,
    type: inferSourceType(ext),
    tags: [],
    importedAt: nowIsoString(runtime.time),
  };
  const normalizedSlug = assertSourceSlug(slug ?? toKebabCase(meta.title), 'source');

  if (signal !== undefined) throwIfAborted(signal, 'persist');
  log('Staging converted markdown for backend import');
  const stagedPath = stagePreparedSourceMarkdown(
    sourceImportStageDir(runtimeRoot),
    renderSourceMarkdown(meta, converted.markdown),
    runtime,
  );

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
    const rawMarkdown = normalizeTextInput(ctx.runtime.storage.readFileSync(filePath, 'utf-8'));
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
    const html = normalizeTextInput(ctx.runtime.storage.readFileSync(filePath, 'utf-8'));
    const title = extractHtmlTitle(html);
    if (!title) {
      throw new Error('HTML import requires a <title> or first <h1>');
    }

    return {
      markdown: await htmlToMarkdownBody(html),
      title,
    };
  }
}

export class DocxMammothConverter implements Converter {
  async isAvailable(_ctx: SourceImportContext): Promise<boolean> {
    return missingPackages(['mammoth', 'turndown']).length === 0;
  }

  async install(log: (msg: string) => void, _ctx: SourceImportContext): Promise<void> {
    assertPackagesInstalled(['mammoth', 'turndown'], log);
  }

  async convert(filePath: string, _ctx: SourceImportContext): Promise<ConversionResult> {
    const mammoth = await loadMammoth();
    const result = await mammoth.convertToHtml({ path: filePath });
    const html = normalizeTextInput(result.value);
    const title = extractFirstHtmlH1(html);
    if (!title) {
      throw new Error('DOCX import requires the first Heading 1 to provide a title');
    }

    return {
      markdown: await htmlToMarkdownBody(html),
      title,
    };
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
    await runCommand(
      uvCommand,
      ['tool', 'install', 'marker-pdf', '--python', '3.12'],
      'uv tool install marker-pdf',
      ctx,
    );

    if (!(await commandExists('marker_single', ctx))) {
      throw new Error('marker_single was not found after installing marker-pdf');
    }
  }

  async convert(filePath: string, ctx: SourceImportContext): Promise<ConversionResult> {
    const markerCommand = await resolveCommandPath('marker_single', ctx);
    if (!markerCommand) {
      throw new Error('marker_single is not available');
    }

    const outputDir = createPdfOutputDir(ctx);

    try {
      await runCommand(markerCommand, [filePath, '--output_dir', outputDir], 'marker_single', ctx);
      const markdownPath = findFirstMarkdownFile(outputDir, ctx.runtime.storage);
      if (!markdownPath) {
        throw new Error('marker_single did not produce a markdown file');
      }

      const rawMarkdown = normalizeTextInput(ctx.runtime.storage.readFileSync(markdownPath, 'utf-8'));
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
