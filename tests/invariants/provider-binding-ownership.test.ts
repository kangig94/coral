import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  parseSourceSubpathImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from '#tests/helpers/ts-import-scanner.js';

const ROOT = new URL('../../', import.meta.url);

describe('provider binding ownership', () => {
  it('keeps provider-private binding codecs behind provider definitions and the registry boundary', () => {
    const files = listProductionSourceFiles(new URL('src/', ROOT).pathname);
    const violations: string[] = [];
    const edges: Pick<ParsedImportEdge, 'source' | 'target'>[] = [
      ...parseProductionImportEdges(ROOT.pathname, files),
      ...files.flatMap((file) => parseSourceSubpathImportEdges(ROOT.pathname, file)),
    ];
    for (const edge of edges) {
      if (bindingImportViolation(edge.source, edge.target) !== null) {
        violations.push(bindingImportViolation(edge.source, edge.target)!);
      }
    }
    for (const file of files) {
      const canonical = toCanonicalSrcPath(ROOT.pathname, file);
      const source = readFileSync(file, 'utf-8');
      if (source.includes('runtime/provider-credentials')) {
        violations.push(`${canonical}: imports the removed runtime account model`);
      }
      if (canonical !== 'src/providers/registry.ts' && source.includes('.binding.decode(')) {
        violations.push(`${canonical}: decodes a private binding outside ProviderRegistry`);
      }
      if (canonical !== 'src/providers/registry.ts' && source.includes('registeredBindingBoundary')) {
        violations.push(`${canonical}: reads registration-time codec authority outside ProviderRegistry`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('detects cross-provider and non-registration imports independent of alias spelling', () => {
    expect(bindingImportViolation('src/providers/beta/execution.ts', 'src/providers/alpha/binding.ts')).toContain(
      'cross-provider',
    );
    expect(bindingImportViolation('src/coordinator/provider.ts', 'src/providers/fixture/binding.ts')).toContain(
      'outside its owner',
    );
    expect(bindingImportViolation('src/providers/fixture/execution.ts', 'src/providers/fixture/binding.ts')).toBeNull();
    expect(bindingImportViolation('src/providers/bootstrap.ts', 'src/providers/future/binding.ts')).toContain(
      'outside its owner',
    );
    expect(bindingImportViolation('src/providers/registry.ts', 'src/providers/contracts/binding.ts')).toBeNull();
  });
});

function bindingImportViolation(source: string, target: string): string | null {
  const match = /^src\/providers\/([^/]+)\/binding\.ts$/u.exec(target);
  if (match === null) return null;
  const provider = match[1];
  if (provider === 'contracts') return null;
  if (source.startsWith(`src/providers/${provider}/`)) return null;
  if (/^src\/providers\/[^/]+\//u.test(source)) {
    return `${source}: cross-provider import of ${target}`;
  }
  return `${source}: imports ${target} outside its owner or registration root`;
}
