import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { nowIsoString } from '../shared/mcp-utils.js'
import { FRONTMATTER_BLOCK, serializeSourceFrontmatter } from './frontmatter.js'
import { kbRuntimeDir, sourceImportStageDir } from './paths.js'
import type { KbSourceFrontmatter } from './types.js'
import { assertNonEmptyText, assertSourceSlug } from './validation.js'

const execFileP = promisify(execFile)
const LOCAL_BIN_DIR = join(homedir(), '.local', 'bin')

const LEADING_ATX_H1 = /^#(?!#)\s+(.+?)\s*#*\s*(?:\r?\n+|$)/
const LEADING_SETEXT_H1 = /^([^\r\n]+)\r?\n=+\s*(?:\r?\n+|$)/
const HTML_TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i
const HTML_H1_PATTERN = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i
const HTML_BODY_PATTERN = /<body\b[^>]*>([\s\S]*?)<\/body>/i

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

export type ConversionResult = {
  markdown: string
  title: string
}

export type PreparedSourceImport = {
  stagedPath: string
  slug: string
  meta: KbSourceFrontmatter
}

type TurndownServiceLike = {
  turndown(input: string): string
}

type TurndownConstructor = new (options?: Record<string, unknown>) => TurndownServiceLike

type MammothLike = {
  convertToHtml(input: { path: string }): Promise<{ value: string }>
}

// CLI-only source import converters. Keep npm conversion dependencies isolated here.
export interface Converter {
  isAvailable(): Promise<boolean>
  install(log: (msg: string) => void): Promise<void>
  convert(filePath: string): Promise<ConversionResult>
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [LOCAL_BIN_DIR, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
  }
}

async function resolveCommandPath(command: string): Promise<string | undefined> {
  const locator = process.platform === 'win32' ? 'where' : 'which'

  try {
    const { stdout } = await execFileP(locator, [command], {
      encoding: 'utf8',
      env: commandEnv(),
      timeout: 10_000,
    })
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommandPath(command)) !== undefined
}

async function runCommand(command: string, args: string[], displayName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      reject(error)
    })
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      reject(new Error(output ? `${displayName} failed: ${output}` : `${displayName} exited with code ${code}`))
    })
  })
}

async function findFirstMarkdownFile(root: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      return join(root, entry.name)
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const nestedMarkdown = await findFirstMarkdownFile(join(root, entry.name))
    if (nestedMarkdown) {
      return nestedMarkdown
    }
  }

  return undefined
}

function normalizeTextInput(text: string): string {
  return text.replace(/^\uFEFF/, '')
}

function normalizeTitle(value: string): string {
  return assertNonEmptyText(value.replace(/\s+/g, ' '), 'title')
}

function titleFromFilename(filePath: string): string {
  const filename = basename(filePath)
  const extension = extname(filename)
  const stem = extension ? filename.slice(0, -extension.length) : filename
  return normalizeTitle(stem)
}

export function toKebabCase(value: string): string {
  return normalizeTitle(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function stripLeadingFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_BLOCK, '')
}

function splitLeadingMarkdownTitle(markdown: string): { title?: string; body: string } {
  const trimmed = markdown.trimStart()
  const atxMatch = trimmed.match(LEADING_ATX_H1)
  if (atxMatch) {
    return {
      title: normalizeTitle(atxMatch[1]),
      body: trimmed.slice(atxMatch[0].length).trim(),
    }
  }

  const setextMatch = trimmed.match(LEADING_SETEXT_H1)
  if (setextMatch) {
    return {
      title: normalizeTitle(setextMatch[1]),
      body: trimmed.slice(setextMatch[0].length).trim(),
    }
  }

  return { body: trimmed.trim() }
}

function decodeHtmlEntity(entity: string): string {
  const normalized = entity.toLowerCase()
  if (normalized.startsWith('#x')) {
    const codePoint = Number.parseInt(normalized.slice(2), 16)
    if (!Number.isInteger(codePoint)) {
      return `&${entity};`
    }
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return `&${entity};`
    }
  }

  if (normalized.startsWith('#')) {
    const codePoint = Number.parseInt(normalized.slice(1), 10)
    if (!Number.isInteger(codePoint)) {
      return `&${entity};`
    }
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return `&${entity};`
    }
  }

  return HTML_ENTITIES[normalized] ?? `&${entity};`
}

function htmlFragmentToText(fragment: string): string | undefined {
  const withoutComments = fragment.replace(/<!--[\s\S]*?-->/g, ' ')
  const withoutTags = withoutComments.replace(/<[^>]+>/g, ' ')
  const decoded = withoutTags.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (_, entity: string) =>
    decodeHtmlEntity(entity),
  )
  const normalized = decoded.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

function extractHtmlTitle(html: string): string | undefined {
  const titleMatch = html.match(HTML_TITLE_PATTERN)?.[1]
  const titleText = titleMatch ? htmlFragmentToText(titleMatch) : undefined
  if (titleText) {
    return normalizeTitle(titleText)
  }

  const h1Match = html.match(HTML_H1_PATTERN)?.[1]
  const h1Text = h1Match ? htmlFragmentToText(h1Match) : undefined
  if (h1Text) {
    return normalizeTitle(h1Text)
  }

  return undefined
}

function extractFirstHtmlH1(html: string): string | undefined {
  const h1Match = html.match(HTML_H1_PATTERN)?.[1]
  const h1Text = h1Match ? htmlFragmentToText(h1Match) : undefined
  return h1Text ? normalizeTitle(h1Text) : undefined
}

function extractHtmlBody(html: string): string {
  return html.match(HTML_BODY_PATTERN)?.[1] ?? html
}

function missingPackages(packageNames: string[]): string[] {
  return packageNames.filter((packageName) => {
    try {
      require.resolve(packageName)
      return false
    } catch {
      return true
    }
  })
}

function assertPackagesInstalled(packageNames: string[], log?: (msg: string) => void): void {
  const missing = missingPackages(packageNames)
  if (missing.length === 0) {
    return
  }

  if (log) {
    log(`Missing npm dependencies: ${missing.join(', ')}`)
    log('Run npm install to install the declared source-import converter packages.')
  }

  throw new Error(`Missing npm dependencies: ${missing.join(', ')}`)
}

async function loadTurndownService(): Promise<TurndownConstructor> {
  assertPackagesInstalled(['turndown'])
  const loaded = await import('turndown') as { default?: unknown }
  const candidate = (loaded.default ?? loaded) as TurndownConstructor
  if (typeof candidate !== 'function') {
    throw new Error('turndown did not export a constructor')
  }
  return candidate
}

async function loadMammoth(): Promise<MammothLike> {
  assertPackagesInstalled(['mammoth'])
  const loaded = await import('mammoth') as { default?: unknown; convertToHtml?: unknown }
  const candidate = (loaded.default ?? loaded) as Partial<MammothLike>
  if (typeof candidate.convertToHtml !== 'function') {
    throw new Error('mammoth did not export convertToHtml')
  }
  return candidate as MammothLike
}

async function htmlToMarkdownBody(html: string): Promise<string> {
  const TurndownService = await loadTurndownService()
  const turndown = new TurndownService({ headingStyle: 'atx' })
  const markdown = turndown.turndown(extractHtmlBody(html))
  return splitLeadingMarkdownTitle(markdown).body
}

function inferSourceType(ext: string): KbSourceFrontmatter['type'] {
  switch (ext.toLowerCase()) {
    case '.html':
    case '.htm':
      return 'blog'
    default:
      return 'internal'
  }
}

function renderSourceMarkdown(meta: KbSourceFrontmatter, body: string): string {
  const heading = `# ${meta.title}`
  const normalizedBody = body.trim()
  const frontmatter = serializeSourceFrontmatter(meta)

  if (!normalizedBody) {
    return `${frontmatter}${heading}\n`
  }

  return `${frontmatter}${heading}\n\n${normalizedBody}\n`
}

async function stagePreparedSourceMarkdown(stageRoot: string, markdown: string): Promise<string> {
  await mkdir(stageRoot, { recursive: true })
  const stagedPath = join(stageRoot, `${randomUUID()}.md`)
  await writeFile(stagedPath, markdown, 'utf8')
  return stagedPath
}

export async function prepareSourceImport(
  filePath: string,
  slug?: string,
  log: (msg: string) => void = () => {},
  runtimeRoot: string = kbRuntimeDir(),
): Promise<PreparedSourceImport> {
  const ext = extname(filePath).toLowerCase()
  const converter = resolveConverter(ext)

  log(`Converting ${filePath}`)
  if (!(await converter.isAvailable())) {
    log(`Installing converter dependencies for ${ext || 'source'} import`)
    await converter.install(log)
  }

  const converted = await converter.convert(filePath)
  const meta: KbSourceFrontmatter = {
    title: converted.title,
    type: inferSourceType(ext),
    tags: [],
    importedAt: nowIsoString(),
  }
  const normalizedSlug = assertSourceSlug(slug ?? toKebabCase(meta.title), 'source')

  log('Staging converted markdown for backend import')
  const stagedPath = await stagePreparedSourceMarkdown(
    sourceImportStageDir(runtimeRoot),
    renderSourceMarkdown(meta, converted.markdown),
  )

  return {
    stagedPath,
    slug: normalizedSlug,
    meta,
  }
}

export class MarkdownCopyConverter implements Converter {
  async isAvailable(): Promise<boolean> {
    return true
  }

  async install(log: (msg: string) => void): Promise<void> {
    void log
  }

  async convert(filePath: string): Promise<ConversionResult> {
    const rawMarkdown = normalizeTextInput(await readFile(filePath, 'utf8'))
    const withoutFrontmatter = stripLeadingFrontmatter(rawMarkdown)
    const { title, body } = splitLeadingMarkdownTitle(withoutFrontmatter)

    return {
      markdown: body,
      title: title ?? titleFromFilename(filePath),
    }
  }
}

export class HtmlTurndownConverter implements Converter {
  async isAvailable(): Promise<boolean> {
    return missingPackages(['turndown']).length === 0
  }

  async install(log: (msg: string) => void): Promise<void> {
    assertPackagesInstalled(['turndown'], log)
  }

  async convert(filePath: string): Promise<ConversionResult> {
    const html = normalizeTextInput(await readFile(filePath, 'utf8'))
    const title = extractHtmlTitle(html)
    if (!title) {
      throw new Error('HTML import requires a <title> or first <h1>')
    }

    return {
      markdown: await htmlToMarkdownBody(html),
      title,
    }
  }
}

export class DocxMammothConverter implements Converter {
  async isAvailable(): Promise<boolean> {
    return missingPackages(['mammoth', 'turndown']).length === 0
  }

  async install(log: (msg: string) => void): Promise<void> {
    assertPackagesInstalled(['mammoth', 'turndown'], log)
  }

  async convert(filePath: string): Promise<ConversionResult> {
    const mammoth = await loadMammoth()
    const result = await mammoth.convertToHtml({ path: filePath })
    const html = normalizeTextInput(result.value)
    const title = extractFirstHtmlH1(html)
    if (!title) {
      throw new Error('DOCX import requires the first Heading 1 to provide a title')
    }

    return {
      markdown: await htmlToMarkdownBody(html),
      title,
    }
  }
}

export class PdfMarkerConverter implements Converter {
  async isAvailable(): Promise<boolean> {
    return commandExists('marker_single')
  }

  async install(log: (msg: string) => void): Promise<void> {
    let uvCommand = await resolveCommandPath('uv')

    if (!uvCommand) {
      log('Installing uv...')
      if (process.platform === 'win32') {
        await runCommand('powershell', ['-c', 'irm https://astral.sh/uv/install.ps1 | iex'], 'uv installer')
      } else {
        await runCommand('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], 'uv installer')
      }

      uvCommand = await resolveCommandPath('uv')
      if (!uvCommand) {
        throw new Error('uv was not found after installation')
      }
    }

    log('Installing Python 3.12 + Marker...')
    await runCommand(uvCommand, ['tool', 'install', 'marker-pdf', '--python', '3.12'], 'uv tool install marker-pdf')

    if (!(await commandExists('marker_single'))) {
      throw new Error('marker_single was not found after installing marker-pdf')
    }
  }

  async convert(filePath: string): Promise<ConversionResult> {
    const markerCommand = await resolveCommandPath('marker_single')
    if (!markerCommand) {
      throw new Error('marker_single is not available')
    }

    const outputDir = await mkdtemp(join(tmpdir(), 'coral-kb-pdf-'))

    try {
      await runCommand(markerCommand, [filePath, '--output_dir', outputDir], 'marker_single')
      const markdownPath = await findFirstMarkdownFile(outputDir)
      if (!markdownPath) {
        throw new Error('marker_single did not produce a markdown file')
      }

      const rawMarkdown = normalizeTextInput(await readFile(markdownPath, 'utf8'))
      const { title, body } = splitLeadingMarkdownTitle(rawMarkdown)
      if (!title) {
        throw new Error('PDF import requires Marker output to begin with a top-level heading')
      }

      return {
        markdown: body,
        title,
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  }
}

export function resolveConverter(ext: string): Converter {
  switch (ext.toLowerCase()) {
    case '.md':
      return new MarkdownCopyConverter()
    case '.html':
    case '.htm':
      return new HtmlTurndownConverter()
    case '.docx':
      return new DocxMammothConverter()
    case '.pdf':
      return new PdfMarkerConverter()
    default:
      throw new Error(`Unsupported source import extension: ${ext}`)
  }
}
