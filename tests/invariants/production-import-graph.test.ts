import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');

function findProductionStronglyConnectedComponents(): string[][] {
  const productionFilePaths = listProductionSourceFiles(SRC_ROOT);
  const productionFiles = productionFilePaths.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath));
  const edges = parseProductionImportEdges(REPO_ROOT, productionFilePaths);
  const graph = new Map(productionFiles.map((filePath) => [filePath, [] as string[]]));

  for (const edge of edges) {
    // Type-only edges are erased by tsc and never form a runtime cycle, so
    // they cannot drive a recursive-load deadlock. The architectural rule we
    // care about here is acyclic *runtime* dependency.
    if (!edge.runtime) {
      continue;
    }
    if (graph.has(edge.source) && graph.has(edge.target)) {
      graph.get(edge.source)?.push(edge.target);
    }
  }

  let nextIndex = 0;
  const stack: string[] = [];
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const sccs: string[][] = [];

  function strongConnect(node: string): void {
    indices.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of graph.get(node) ?? []) {
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(neighbor)!));
      }
    }

    if (lowlink.get(node) !== indices.get(node)) {
      return;
    }

    const component: string[] = [];
    while (true) {
      const current = stack.pop();
      if (!current) {
        throw new Error(`Tarjan traversal underflow while visiting ${node}`);
      }
      onStack.delete(current);
      component.push(current);
      if (current === node) {
        break;
      }
    }

    if (component.length > 1) {
      sccs.push(component.sort());
    }
  }

  for (const filePath of productionFiles) {
    if (!indices.has(filePath)) {
      strongConnect(filePath);
    }
  }

  return sccs.sort((left, right) => left[0].localeCompare(right[0]));
}

describe('production import graph invariants', () => {
  it('is acyclic across production source files', () => {
    expect(findProductionStronglyConnectedComponents()).toEqual([]);
  });
});
