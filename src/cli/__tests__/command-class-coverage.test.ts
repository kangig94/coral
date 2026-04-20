import { describe, expect, it } from 'vitest';

import {
  collectCommandCoverage,
  commandClassExemptions,
  commandClassMap,
  commandContainerPaths,
} from '../command-class-map.js';
import { buildProgram } from '../main.js';

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
      [...commandContainerPaths]
        .sort()
        .map((path) => ({
          path,
          kind: 'container',
        })),
    );
  });
});
