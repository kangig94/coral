import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

import {
  createProductionFileIndex,
  listProductionSourceFiles,
  resolveRelativeSourcePath,
  toCanonicalSrcPath,
} from './ts-import-scanner.js';

export type ExecutionResidueObjectLiteral = {
  keys: string[];
  discriminants: Record<string, string>;
};

export type ExecutionResidueFacts = {
  file: string;
  imports: string[];
  memberAccesses: string[];
  identifiers: string[];
  literalStrings: string[];
  callees: string[];
  memberCallees: string[];
  objectLiterals: ExecutionResidueObjectLiteral[];
};

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function isModuleSpecifierLiteral(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;

  return (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
  ) || (ts.isImportTypeNode(parent) && ts.isLiteralTypeNode(parent.argument) && parent.argument.literal === node);
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

function captureObjectLiteral(node: ts.ObjectLiteralExpression): ExecutionResidueObjectLiteral {
  const keys = new Set<string>();
  const discriminants: Record<string, string> = {};

  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const key = propertyNameText(property.name);
      if (!key) {
        continue;
      }

      keys.add(key);
      if (ts.isStringLiteralLike(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)) {
        discriminants[key] = property.initializer.text;
      }
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      keys.add(property.name.text);
      continue;
    }

    if (ts.isMethodDeclaration(property)) {
      const key = propertyNameText(property.name);
      if (key) {
        keys.add(key);
      }
    }
  }

  return {
    keys: [...keys].sort(),
    discriminants,
  };
}

function canonicalizeImport(
  sourceFilePath: string,
  sourceCanonicalPath: string,
  specifier: string,
  productionFiles: Set<string>,
): string {
  if (!specifier.startsWith('.')) {
    return specifier;
  }

  return resolveRelativeSourcePath(REPO_ROOT, sourceFilePath, sourceCanonicalPath, specifier, productionFiles);
}

function scanFile(filePath: string, productionFiles: Set<string>): ExecutionResidueFacts {
  const file = toCanonicalSrcPath(REPO_ROOT, filePath);
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set<string>();
  const memberAccesses = new Set<string>();
  const identifiers = new Set<string>();
  const literalStrings = new Set<string>();
  const callees = new Set<string>();
  const memberCallees = new Set<string>();
  const objectLiterals: ExecutionResidueObjectLiteral[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.add(canonicalizeImport(filePath, file, node.moduleSpecifier.text, productionFiles));
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        imports.add(canonicalizeImport(filePath, file, node.argument.literal.text, productionFiles));
      }
    } else if (ts.isIdentifier(node)) {
      identifiers.add(node.text);
    } else if (ts.isPropertyAccessExpression(node)) {
      memberAccesses.add(node.getText(sourceFile));
    } else if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifierLiteral(node)) {
        literalStrings.add(node.text);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        callees.add(node.expression.getText(sourceFile));
        if (ts.isPropertyAccessExpression(node.expression)) {
          memberCallees.add(node.expression.name.text);
        }
      }
    } else if (ts.isNewExpression(node)) {
      callees.add(node.expression.getText(sourceFile));
      if (ts.isPropertyAccessExpression(node.expression)) {
        memberCallees.add(node.expression.name.text);
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      objectLiterals.push(captureObjectLiteral(node));
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    file,
    imports: [...imports].sort(),
    memberAccesses: [...memberAccesses].sort(),
    identifiers: [...identifiers].sort(),
    literalStrings: [...literalStrings].sort(),
    callees: [...callees].sort(),
    memberCallees: [...memberCallees].sort(),
    objectLiterals,
  };
}

export function scanExecutionResidue(rootDir = 'src/execution'): Map<string, ExecutionResidueFacts> {
  const productionFiles = listProductionSourceFiles(join(REPO_ROOT, 'src'));
  const productionIndex = createProductionFileIndex(REPO_ROOT, productionFiles);
  const executionFiles = listProductionSourceFiles(join(REPO_ROOT, rootDir));

  return new Map(
    executionFiles.map((filePath) => {
      const facts = scanFile(filePath, productionIndex);
      return [facts.file, facts] as const;
    }),
  );
}
