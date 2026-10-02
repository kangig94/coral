import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = `${resolve(REPO_ROOT, 'src')}/`;

/**
 * Paths — repo-relative or absolute — mapped to source text that shadows whatever is on disk. An
 * overlay path need not exist on disk, nor need its directories: the host reports every ancestor
 * directory of an overlay as existing, because module resolution skips a directory it believes is
 * absent and would then resolve an overlay only while some unrelated empty directory happens to be
 * left there. An overlay is a root of every program it is given to, whatever else that program roots.
 */
type Overlays = ReadonlyMap<string, string>;

const NO_OVERLAYS: Overlays = new Map();

let parsedConfig: ts.ParsedCommandLine | undefined;

function parseProductionConfig(): ts.ParsedCommandLine {
  if (parsedConfig === undefined) {
    const configPath = resolve(REPO_ROOT, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }
    parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT, undefined, configPath);
    if (parsedConfig.errors.length > 0) {
      throw new Error(
        parsedConfig.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
      );
    }
  }
  return parsedConfig;
}

/**
 * The options an invariant checks production under are the build's own, so that a checker answer here
 * cannot differ from what `tsc` accepts. `rootDir` must widen to the repository and may not be dropped:
 * overlays and fixtures live outside `src/`, which the build's `rootDir` reports as TS6059, while no
 * `rootDir` at all makes the project root ambiguous and every `#src/*` import-map entry unresolvable
 * (TS2210). Emit must stay off in every shape it can be requested, so that a per-file diagnostic query
 * and `getPreEmitDiagnostics(program, sourceFile)` cannot disagree over a declaration-emit error.
 */
function productionCompilerOptions(): ts.CompilerOptions {
  return {
    ...parseProductionConfig().options,
    composite: false,
    declaration: false,
    incremental: false,
    noEmit: true,
    rootDir: REPO_ROOT,
    tsBuildInfoFile: undefined,
  };
}

function productionRootFiles(): readonly string[] {
  return parseProductionConfig().fileNames.filter((fileName) => fileName.startsWith(SRC_ROOT));
}

function overlayDirectories(overlayPaths: Iterable<string>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const overlayPath of overlayPaths) {
    for (let directory = dirname(overlayPath); directory.startsWith(REPO_ROOT); directory = dirname(directory)) {
      directories.add(directory);
    }
  }
  return directories;
}

/**
 * On-disk files parsed once per worker and handed to every program built there. Reuse is sound only
 * because every program in this module is built from identical option values (`productionCompilerOptions`):
 * the binder records `locals` on the file it binds and skips a file that already carries them
 * (`bindSourceFile` in typescript 5.9.3), so two programs may share a parsed file exactly while they
 * would bind it identically. An overlay never enters this cache — its path is
 * answered from `overlays` first, so the same path can be overlaid in one program and real in the next.
 * Reparsing instead measured 256ms against 25ms per overlay program (10-core Apple M-series, 2026-09-17).
 */
const parsedDiskFiles = new Map<string, ts.SourceFile>();

function buildProgram(rootNames: readonly string[], requestedOverlays: Overlays): ts.Program {
  const options = productionCompilerOptions();
  const overlays = new Map([...requestedOverlays].map(([path, source]) => [resolve(REPO_ROOT, path), source] as const));
  const directories = overlayDirectories(overlays.keys());
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  host.readFile = (fileName) => overlays.get(fileName) ?? readFile(fileName);
  host.fileExists = (fileName) => overlays.has(fileName) || fileExists(fileName);
  host.directoryExists = (directoryName) =>
    directories.has(directoryName) || (directoryExists?.(directoryName) ?? false);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const overlay = overlays.get(fileName);
    if (overlay !== undefined) {
      return ts.createSourceFile(fileName, overlay, languageVersion, true, ts.ScriptKind.TS);
    }
    if (shouldCreateNewSourceFile === true) {
      return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    const cached = parsedDiskFiles.get(fileName);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (parsed !== undefined) {
      parsedDiskFiles.set(fileName, parsed);
    }
    return parsed;
  };
  host.writeFile = () => {
    throw new Error('Invariant TypeScript programs are read-only.');
  };
  return ts.createProgram({ rootNames: [...rootNames, ...overlays.keys()], options, host });
}

export function createProductionProgram(overlays: Overlays = NO_OVERLAYS): ts.Program {
  return buildProgram(productionRootFiles(), overlays);
}

/**
 * A program over a chosen root set. TypeScript pulls in each root's import closure, so a file reached
 * through an import need not be named — but a file neither rooted nor imported is absent from the
 * program, and `sourceFileDiagnostics` throws when asked about it.
 */
export function createProgramOver(roots: readonly string[], overlays: Overlays = NO_OVERLAYS): ts.Program {
  return buildProgram(roots, overlays);
}

let memoizedProgram: ts.Program | undefined;

/**
 * A memoized program may not outlive the sources it was built from; vitest's per-file isolation
 * (`isolate`, on by default) is what guarantees that, by giving each test file its own worker.
 */
export function productionProgram(): ts.Program {
  memoizedProgram ??= createProductionProgram();
  return memoizedProgram;
}

/**
 * Diagnostics for one file, and there is deliberately no whole-program counterpart in this module,
 * so the expensive form has nowhere to live. Answering a one-file question by type-checking all of
 * `src/` measured 9.8s against 0.3s for identical diagnostics (10-core Apple M-series, 2026-09-17),
 * and proving production type-checks at all belongs to the gate (`typecheck:tests` in package.json).
 */
export function sourceFileDiagnostics(program: ts.Program, path: string): readonly ts.Diagnostic[] {
  const fileName = resolve(REPO_ROOT, path);
  const sourceFile = program.getSourceFile(fileName);
  if (sourceFile === undefined) {
    throw new Error(`TypeScript program omitted '${path}'.`);
  }
  return [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
}

export function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  return `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
}

/** Whether the program itself is well-formed; this checks no file's types. */
export function configDiagnostics(program: ts.Program): readonly ts.Diagnostic[] {
  return [...program.getConfigFileParsingDiagnostics(), ...program.getOptionsDiagnostics()];
}
