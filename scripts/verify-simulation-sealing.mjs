import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const SIMULATION_ROOT = resolve(REPO_ROOT, 'tools', 'simulation');
const MANIFEST_PATH = resolve(REPO_ROOT, 'sealed-inventory.json');
const SIMULATION_CORE_ROOT = 'tools/simulation/core/backend.ts';
const SERVER_ROOT = 'src/coordinator/bootstrap.ts';

function toPosixPath(filePath) {
  return filePath.split(sep).join('/');
}

function toCanonicalRepoPath(filePath) {
  return toPosixPath(relative(REPO_ROOT, filePath));
}

function listSourceFiles(dirPath) {
  const files = [];

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '_legacy') {
        continue;
      }

      files.push(...listSourceFiles(entryPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts')) {
      continue;
    }

    files.push(entryPath);
  }

  return files.sort();
}

function getRelativeModuleSpecifier(moduleSpecifier) {
  if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
    return null;
  }

  return moduleSpecifier.text.startsWith('.') ? moduleSpecifier.text : null;
}

function getRelativeImportTypeSpecifier(node) {
  if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal)) {
    return null;
  }

  return node.argument.literal.text.startsWith('.') ? node.argument.literal.text : null;
}

function resolveRelativeSourcePath(sourceFilePath, sourceCanonicalPath, specifier, productionFiles) {
  const resolvedBase = resolve(dirname(sourceFilePath), specifier);
  const extension = extname(resolvedBase);
  const candidates =
    extension === '.js'
      ? [resolvedBase.slice(0, -3) + '.ts']
      : extension === '.ts'
        ? [resolvedBase]
        : extension === ''
          ? [`${resolvedBase}.ts`, join(resolvedBase, 'index.ts')]
          : [];

  for (const candidate of candidates) {
    const canonicalCandidate = toCanonicalRepoPath(candidate);
    if (productionFiles.has(canonicalCandidate)) {
      return canonicalCandidate;
    }
  }

  throw new Error(`Unable to resolve ${specifier} from ${sourceCanonicalPath} to a production src/*.ts file`);
}

function classifyImportDeclaration(node) {
  const clause = node.importClause;

  if (!clause) {
    return { runtime: true, typeOnly: false };
  }

  if (clause.isTypeOnly) {
    return { runtime: false, typeOnly: true };
  }

  let runtime = Boolean(clause.name);
  let typeOnly = false;

  const bindings = clause.namedBindings;
  if (!bindings) {
    return { runtime, typeOnly };
  }

  if (ts.isNamespaceImport(bindings)) {
    return { runtime: true, typeOnly };
  }

  if (bindings.elements.length === 0) {
    return { runtime: true, typeOnly };
  }

  runtime ||= bindings.elements.some((element) => !element.isTypeOnly);
  typeOnly ||= bindings.elements.some((element) => element.isTypeOnly);

  return { runtime, typeOnly };
}

function classifyExportDeclaration(node) {
  if (node.isTypeOnly) {
    return { runtime: false, typeOnly: true };
  }

  const clause = node.exportClause;
  if (!clause) {
    return { runtime: true, typeOnly: false };
  }

  if (ts.isNamespaceExport(clause)) {
    return { runtime: true, typeOnly: false };
  }

  if (clause.elements.length === 0) {
    return { runtime: true, typeOnly: false };
  }

  return {
    runtime: clause.elements.some((element) => !element.isTypeOnly),
    typeOnly: clause.elements.some((element) => element.isTypeOnly),
  };
}

function parseSourceEdges(sourceFilePath, productionFiles) {
  const sourceCanonicalPath = toCanonicalRepoPath(sourceFilePath);
  const sourceText = readFileSync(sourceFilePath, 'utf-8');
  const sourceFile = ts.createSourceFile(sourceFilePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges = new Map();

  function recordEdge(specifier, via, contribution) {
    if (!specifier) {
      return;
    }

    const target = resolveRelativeSourcePath(sourceFilePath, sourceCanonicalPath, specifier, productionFiles);
    const edge = edges.get(target) ?? {
      source: sourceCanonicalPath,
      target,
      runtimeVia: new Set(),
      typeOnlyVia: new Set(),
    };

    if (contribution.runtime) {
      edge.runtimeVia.add(via);
    }

    if (contribution.typeOnly) {
      edge.typeOnlyVia.add(via);
    }

    edges.set(target, edge);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      recordEdge(getRelativeModuleSpecifier(node.moduleSpecifier), 'ImportDeclaration', classifyImportDeclaration(node));
    } else if (ts.isExportDeclaration(node)) {
      recordEdge(getRelativeModuleSpecifier(node.moduleSpecifier), 'ExportDeclaration', classifyExportDeclaration(node));
    } else if (ts.isImportTypeNode(node)) {
      recordEdge(getRelativeImportTypeSpecifier(node), 'ImportTypeNode', { runtime: false, typeOnly: true });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return [...edges.values()].sort((left, right) => left.target.localeCompare(right.target));
}

function loadManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

  if (!manifest || typeof manifest !== 'object') {
    throw new Error('sealed-inventory.json must contain an object');
  }

  if (!Array.isArray(manifest.roots) || manifest.roots.some((value) => typeof value !== 'string')) {
    throw new Error('sealed-inventory.json must declare roots as a string array');
  }

  if (!Array.isArray(manifest.forbidden) || manifest.forbidden.some((value) => typeof value !== 'string')) {
    throw new Error('sealed-inventory.json must declare forbidden as a string array');
  }

  if ('allowTypeOnly' in manifest && typeof manifest.allowTypeOnly !== 'boolean') {
    throw new Error('sealed-inventory.json allowTypeOnly must be a boolean when present');
  }

  return {
    roots: manifest.roots,
    forbidden: manifest.forbidden,
    allowTypeOnly: manifest.allowTypeOnly === true,
  };
}

function validateManifestPaths(manifest, productionFiles) {
  for (const root of manifest.roots) {
    if (!productionFiles.has(root)) {
      throw new Error(`Manifest root ${root} does not resolve to a production src/*.ts file`);
    }
  }

  if (!productionFiles.has(SIMULATION_CORE_ROOT)) {
    throw new Error(`Expected ${SIMULATION_CORE_ROOT} to exist`);
  }

  if (!productionFiles.has(SERVER_ROOT)) {
    throw new Error(`Expected ${SERVER_ROOT} to exist`);
  }
}

function createForbiddenMatchers(forbiddenEntries) {
  return forbiddenEntries.map((entry) => ({
    entry,
    isPrefix: entry.endsWith('/'),
  }));
}

function matchForbiddenPath(targetPath, matchers) {
  return matchers.find((matcher) => {
    return matcher.isPrefix ? targetPath.startsWith(matcher.entry) : targetPath === matcher.entry;
  }) ?? null;
}

function buildRuntimeReachability(root, edgeGraph) {
  const runtimeClosure = new Set([root]);
  const runtimeParents = new Map();
  const encounteredTypeOnlyEdges = [];
  const queue = [root];

  while (queue.length > 0) {
    const source = queue.shift();
    const outgoingEdges = edgeGraph.get(source) ?? [];

    for (const edge of outgoingEdges) {
      if (edge.typeOnlyVia.size > 0) {
        encounteredTypeOnlyEdges.push(edge);
      }

      if (edge.runtimeVia.size === 0 || runtimeClosure.has(edge.target)) {
        continue;
      }

      runtimeClosure.add(edge.target);
      runtimeParents.set(edge.target, { source, edge });
      queue.push(edge.target);
    }
  }

  return { runtimeClosure, runtimeParents, encounteredTypeOnlyEdges };
}

function buildRuntimeChain(root, target, runtimeParents) {
  const chain = [];
  let current = target;

  while (current !== root) {
    const step = runtimeParents.get(current);
    if (!step) {
      throw new Error(`Missing runtime parent while reconstructing ${root} -> ${target}`);
    }

    chain.push(step.edge);
    current = step.source;
  }

  return chain.reverse();
}

function formatVia(viaKinds) {
  return [...viaKinds].sort().join(', ');
}

function formatRuntimeChain(root, chain) {
  const parts = [root];

  for (const edge of chain) {
    parts.push(`${edge.target} [${formatVia(edge.runtimeVia)}]`);
  }

  return parts.join(' -> ');
}

function findDirectEdge(source, target, edgeGraph) {
  const edges = edgeGraph.get(source) ?? [];
  return edges.find((edge) => edge.target === target) ?? null;
}

function main() {
  const manifest = loadManifest();
  const productionFilePaths = [
    ...listSourceFiles(SRC_ROOT),
    ...listSourceFiles(SIMULATION_ROOT),
  ].sort();
  const productionFiles = new Set(productionFilePaths.map((filePath) => toCanonicalRepoPath(filePath)));

  validateManifestPaths(manifest, productionFiles);

  const edgeGraph = new Map(
    productionFilePaths.map((filePath) => {
      const canonicalPath = toCanonicalRepoPath(filePath);
      return [canonicalPath, parseSourceEdges(filePath, productionFiles)];
    }),
  );
  const forbiddenMatchers = createForbiddenMatchers(manifest.forbidden);
  const violations = [];

  const directServerImport = findDirectEdge(SIMULATION_CORE_ROOT, SERVER_ROOT, edgeGraph);
  if (directServerImport && (directServerImport.runtimeVia.size > 0 || directServerImport.typeOnlyVia.size > 0)) {
    violations.push(
      `Direct import edge is forbidden: ${SIMULATION_CORE_ROOT} -> ${SERVER_ROOT} ` +
        `(runtime via ${formatVia(directServerImport.runtimeVia) || 'none'}; ` +
        `type-only via ${formatVia(directServerImport.typeOnlyVia) || 'none'})`,
    );
  }

  for (const root of [...manifest.roots].sort()) {
    const { runtimeClosure, runtimeParents, encounteredTypeOnlyEdges } = buildRuntimeReachability(root, edgeGraph);

    for (const target of [...runtimeClosure].sort()) {
      const forbiddenMatch = matchForbiddenPath(target, forbiddenMatchers);
      if (!forbiddenMatch || target === root) {
        continue;
      }

      const chain = buildRuntimeChain(root, target, runtimeParents);
      violations.push(
        `Forbidden runtime import from ${root} reaches ${target} via ${forbiddenMatch.entry}: ` +
          formatRuntimeChain(root, chain),
      );
    }

    if (!manifest.allowTypeOnly) {
      for (const edge of encounteredTypeOnlyEdges) {
        const forbiddenMatch = matchForbiddenPath(edge.target, forbiddenMatchers);
        if (!forbiddenMatch) {
          continue;
        }

        violations.push(
          `Forbidden type-only import from ${edge.source} reaches ${edge.target} via ${forbiddenMatch.entry} ` +
            `[${formatVia(edge.typeOnlyVia)}]`,
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error('Simulation sealing verification failed:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(
    `Simulation sealing verified for ${manifest.roots.length} roots ` +
      `(allowTypeOnly=${String(manifest.allowTypeOnly)}).`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error('Simulation sealing verification failed with an internal error:');
  console.error(message);
  process.exit(1);
}
