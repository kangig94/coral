import { describe, expect, it } from 'vitest';

import {
  collectCommandCoverage,
  commandClassExemptions,
  commandClassMap,
  commandContainerPaths,
} from '#src/cli/classify.js';
import { buildProgram } from '#src/cli/program.js';

describe('command class coverage', () => {
  it('classifies every transport-routed leaf command directly or through provider-family resolution', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const leafEntries = coverage.filter((entry) => entry.isLeaf);

    expect(leafEntries.filter((entry) => entry.resolution.kind === 'unclassified')).toEqual([]);
    expect(leafEntries.filter((entry) => entry.resolution.kind === 'container')).toEqual([]);

    const mappedLeafPaths = leafEntries
      .filter((entry) => entry.resolution.kind === 'class' && entry.resolution.source === 'map')
      .map((entry) => entry.path)
      .sort();
    expect(mappedLeafPaths).toEqual(Object.keys(commandClassMap).sort());

    const providerLeafPaths = leafEntries
      .filter((entry) => entry.resolution.kind === 'class' && entry.resolution.source === 'provider-family')
      .map((entry) => entry.path)
      .sort();
    expect(providerLeafPaths).toEqual(['claude', 'codex']);

    const exemptLeafPaths = leafEntries
      .filter((entry) => entry.resolution.kind === 'exempt')
      .map((entry) => entry.path)
      .sort();
    expect(exemptLeafPaths).toEqual(Object.keys(commandClassExemptions).sort());
  });

  it('treats structural grouping nodes as explicit containers', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const containerEntries = coverage
      .filter((entry) => !entry.isLeaf)
      .map((entry) => ({ path: entry.path, kind: entry.resolution.kind }))
      .sort((left, right) => left.path.localeCompare(right.path));

    expect(containerEntries).toEqual(
      [...commandContainerPaths].sort().map((path) => ({
        path,
        kind: 'container',
      })),
    );
  });

  it('classifies the expansion command family with the declared read/mutate split', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const expansionEntries = coverage
      .filter((entry) => entry.path === 'expansion' || entry.path.startsWith('expansion '))
      .map((entry) => ({
        path: entry.path,
        isLeaf: entry.isLeaf,
        kind: entry.resolution.kind,
        commandClass: entry.resolution.kind === 'class' ? entry.resolution.commandClass : null,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    expect(expansionEntries).toEqual([
      { path: 'expansion', isLeaf: false, kind: 'container', commandClass: null },
      { path: 'expansion equip', isLeaf: true, kind: 'class', commandClass: 'mutate' },
      { path: 'expansion info', isLeaf: true, kind: 'class', commandClass: 'read' },
      { path: 'expansion list', isLeaf: true, kind: 'class', commandClass: 'read' },
      { path: 'expansion unequip', isLeaf: true, kind: 'class', commandClass: 'mutate' },
      { path: 'expansion update', isLeaf: true, kind: 'class', commandClass: 'mutate' },
    ]);
  });
});
