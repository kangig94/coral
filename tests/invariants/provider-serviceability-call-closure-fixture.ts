import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  createCallableClosureContext,
  type CallableClosureContext,
} from './provider-serviceability-decision-inventory.js';

export const SERVICEABILITY_MUTATION_ENV = 'CORAL_SERVICEABILITY_INVARIANT_MUTATION';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/provider-serviceability-call-closure/', import.meta.url));

function fixtureSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return fixtureSourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts.txt') ? [path] : [];
  });
}

export function serviceabilityMutationFixtureContext(): CallableClosureContext {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
  };
  const sources = new Map(
    fixtureSourceFiles(join(FIXTURE_ROOT, 'src')).map((fixturePath) => [
      resolve(fixturePath.slice(0, -'.txt'.length)),
      readFileSync(fixturePath, 'utf8'),
    ]),
  );
  const host = ts.createCompilerHost(options);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => sources.has(resolve(fileName)) || defaultFileExists(fileName);
  host.readFile = (fileName) => sources.get(resolve(fileName)) ?? defaultReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sources.get(resolve(fileName));
    return source === undefined
      ? defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS);
  };
  host.writeFile = () => {
    throw new Error('Serviceability mutation fixture Programs are read-only.');
  };
  const rootNames = [...sources.keys()];
  const program = ts.createProgram({ rootNames, options, host });
  return createCallableClosureContext(FIXTURE_ROOT, rootNames, program);
}

export function activeServiceabilityMutation(): string | undefined {
  const selected = process.env[SERVICEABILITY_MUTATION_ENV];
  return selected === undefined || selected.length === 0 ? undefined : selected;
}

export function fixturePath(fileName: string): string {
  return `src/${fileName}`;
}
