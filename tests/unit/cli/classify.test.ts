import { describe, expect, it } from 'vitest';

import {
  collectCommandCoverage,
  commandClassExemptions,
  commandClassMap,
  commandContainerPaths,
} from '#src/cli/classify.js';
import { buildProgram } from '#src/cli/program.js';
import { classifyHandoffRoutingStatusOperatorInvocation } from '#src/coordinator/handoff-repair-operation.js';

describe('command class coverage', () => {
  it('classifies every transport-routed leaf command directly or through provider-family resolution', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const leafEntries = coverage.filter((entry) => entry.isLeaf);

    expect(leafEntries.filter((entry) => entry.resolution.kind === 'unclassified')).toEqual([]);
    expect(leafEntries.filter((entry) => entry.resolution.kind === 'container')).toEqual([]);

    const mappedCommandPaths = coverage
      .filter((entry) => entry.resolution.kind === 'class' && entry.resolution.source === 'map')
      .map((entry) => entry.path)
      .sort();
    expect(mappedCommandPaths).toEqual(Object.keys(commandClassMap).sort());

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
      .filter((entry) => !entry.isLeaf && entry.resolution.kind === 'container')
      .map((entry) => ({ path: entry.path, kind: entry.resolution.kind }))
      .sort((left, right) => left.path.localeCompare(right.path));

    expect(containerEntries).toEqual(
      [...commandContainerPaths].sort().map((path) => ({
        path,
        kind: 'container',
      })),
    );
  });

  it('classifies every registered routing-status leaf for lifecycle exclusion', () => {
    const classifications = collectCommandCoverage(buildProgram())
      .filter((entry) => entry.isLeaf && entry.path.startsWith('backend routing-status '))
      .map((entry) => ({
        path: entry.path,
        classification: classifyHandoffRoutingStatusOperatorInvocation(['node', 'coral-cli', ...entry.path.split(' ')]),
      }));

    expect(classifications).toEqual([
      {
        path: 'backend routing-status resolve',
        classification: { kind: 'operator', command: 'resolve', repairOperation: null },
      },
      {
        path: 'backend routing-status discard',
        classification: { kind: 'operator', command: 'discard' },
      },
      {
        path: 'backend routing-status quarantine list',
        classification: { kind: 'operator', command: 'quarantine-list' },
      },
      {
        path: 'backend routing-status quarantine clear',
        classification: { kind: 'operator', command: 'quarantine-clear' },
      },
    ]);
  });

  it('allows executable parent commands to also expose subcommands', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const executableParents = coverage
      .filter((entry) => !entry.isLeaf && entry.resolution.kind === 'class')
      .map((entry) => ({
        path: entry.path,
        commandClass: entry.resolution.kind === 'class' ? entry.resolution.commandClass : null,
      }));

    expect(executableParents).toEqual([
      { path: 'jobs', commandClass: 'directRead' },
      { path: 'abort', commandClass: 'mutate' },
    ]);
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
      { path: 'expansion info', isLeaf: true, kind: 'class', commandClass: 'directRead' },
      { path: 'expansion list', isLeaf: true, kind: 'class', commandClass: 'directRead' },
      { path: 'expansion remove-catalog', isLeaf: true, kind: 'class', commandClass: 'mutate' },
      { path: 'expansion unequip', isLeaf: true, kind: 'class', commandClass: 'mutate' },
      { path: 'expansion update', isLeaf: true, kind: 'class', commandClass: 'mutate' },
    ]);
  });

  it('classifies kb search as servedRead and non-search reads as directRead', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const kbEntries = coverage
      .filter((entry) => entry.path.startsWith('kb '))
      .filter((entry) => entry.resolution.kind === 'class')
      .map((entry) => ({
        path: entry.path,
        commandClass: entry.resolution.kind === 'class' ? entry.resolution.commandClass : null,
      }));

    expect(kbEntries.find((entry) => entry.path === 'kb search')).toEqual({
      path: 'kb search',
      commandClass: 'servedRead',
    });
    expect(
      kbEntries
        .filter((entry) => entry.commandClass === 'directRead')
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([
      'kb community list-stale',
      'kb community summary-input',
      'kb diagnose',
      'kb memo list',
      'kb principles',
      'kb read',
      'kb source list',
      'kb wake-up',
      'kb wiki list',
    ]);
  });

  it('classifies provider-host reads separately from destructive eviction', () => {
    const entries = collectCommandCoverage(buildProgram())
      .filter((entry) => entry.path.startsWith('backend provider-host '))
      .map((entry) => ({
        path: entry.path,
        commandClass: entry.resolution.kind === 'class' ? entry.resolution.commandClass : null,
      }));

    expect(entries).toEqual([
      { path: 'backend provider-host list', commandClass: 'servedRead' },
      { path: 'backend provider-host inspect', commandClass: 'servedRead' },
      { path: 'backend provider-host evict', commandClass: 'mutate' },
    ]);
  });
});
