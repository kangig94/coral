import { describe, expect, it } from 'vitest';

import { USER_SOURCE_IMPORT_MAX_BYTES, deriveSourceImportReadPolicy } from '#src/kb/ops/source/import.js';
import type { Capability } from '#src/security/capability.js';
import type { ResourceBinding } from '#src/security/principal.js';
import { attenuate } from '#src/security/attenuate.js';
import { authorize } from '#src/security/policy/authorize.js';
import { resolveRequestBinding } from '#src/transport/dispatch.js';
import { rpcCatalog, type RpcMethodSpec } from '#src/transport/rpc/catalog.js';
import { operationalRouteSpecs, type OperationalRouteSpec } from '#src/transport/rpc/operational-catalog.js';
import { testPrincipal, testProjectPrincipal } from '../helpers/principal.js';
import { fixtureCanonicalWorkDir } from '../helpers/canonical-work-dir.js';

function envWith(value?: string): { get(key: string): string | undefined } {
  return {
    get: (key) => (key === 'CORAL_KB_IMPORT_MAX_BYTES' ? value : undefined),
  };
}

function rpcSpec(name: (typeof rpcCatalog)[number]['name']): RpcMethodSpec<unknown, unknown> {
  const spec = rpcCatalog.find((candidate) => candidate.name === name);
  if (!spec) {
    throw new Error(`Missing RPC spec: ${name}`);
  }
  return spec;
}

function operationalSpec(id: OperationalRouteSpec['id']): OperationalRouteSpec {
  const spec = operationalRouteSpecs.find((candidate) => candidate.id === id);
  if (!spec) {
    throw new Error(`Missing operational spec: ${id}`);
  }
  return spec;
}

function expectAllProjectReadPolicy(requires: Capability, requestedBinding: ResourceBinding): void {
  expect(requestedBinding).toEqual({ kind: 'unbound' });
  expect(
    authorize(testPrincipal({ subject: 'operator', binding: { kind: 'unbound' } }), requires, requestedBinding),
  ).toEqual({ ok: true });
  expect(
    authorize(testPrincipal({ subject: 'system', binding: { kind: 'unbound' } }), requires, requestedBinding),
  ).toEqual({ ok: true });
  expect(
    authorize(testPrincipal({ subject: 'agent', binding: { kind: 'unbound' } }), requires, requestedBinding),
  ).toMatchObject({ ok: false, reason: 'resource_unbound' });
  expect(
    authorize(testProjectPrincipal('/workspace/project', { subject: 'agent' }), requires, requestedBinding),
  ).toMatchObject({ ok: false, reason: 'resource_unbound' });
}

describe('principal request binding invariants', () => {
  it('derives a project binding from parsed HTTP source-import input before read-policy selection', () => {
    const spec = rpcSpec('kb.source.create');
    const parsed = spec.requestSchema.parse({
      projectRoot: '/workspace/project',
      filePath: 'paper.md',
    }) as { projectRoot: string };
    const binding = resolveRequestBinding(spec.requestBinding, fixtureCanonicalWorkDir(parsed.projectRoot));

    expect(binding).toEqual({ kind: 'project', root: '/workspace/project' });
    expect(deriveSourceImportReadPolicy(binding, parsed.projectRoot, envWith('8192'))).toEqual({
      kind: 'sandboxed',
      root: '/workspace/project',
      maxBytes: USER_SOURCE_IMPORT_MAX_BYTES,
    });
    expect(deriveSourceImportReadPolicy({ kind: 'unbound' }, parsed.projectRoot, envWith('8192'))).toEqual({
      kind: 'unrestricted',
      resolveBase: '/workspace/project',
      maxBytes: 8192,
    });
  });

  it('keeps jobs.list all-project reads available only to unbound operator/system principals', () => {
    const spec = rpcSpec('jobs.list');

    expect(spec.requestBinding).toEqual({ kind: 'projectRoot', projectRoot: 'optional-all-projects' });
    expectAllProjectReadPolicy(spec.requires, resolveRequestBinding(spec.requestBinding, undefined));

    const projectBinding = resolveRequestBinding(spec.requestBinding, fixtureCanonicalWorkDir('/workspace/project'));
    expect(projectBinding).toEqual({ kind: 'project', root: '/workspace/project' });
    expect(
      authorize(testProjectPrincipal('/workspace/project', { subject: 'agent' }), spec.requires, projectBinding),
    ).toEqual({ ok: true });
  });

  it('declares event-stream all-project reads as optional-project bindings with child denial', () => {
    const spec = operationalSpec('http.events.stream');

    expect(spec.requestBinding).toEqual({ kind: 'projectRoot', projectRoot: 'optional-all-projects' });
    expectAllProjectReadPolicy(spec.requires, resolveRequestBinding(spec.requestBinding, undefined));

    const projectBinding = resolveRequestBinding(spec.requestBinding, fixtureCanonicalWorkDir('/workspace/project'));
    expect(projectBinding).toEqual({ kind: 'project', root: '/workspace/project' });
    expect(
      authorize(testProjectPrincipal('/workspace/project', { subject: 'agent' }), spec.requires, projectBinding),
    ).toEqual({ ok: true });
  });

  it('keeps a project-bound child on sandboxed source-import and denies all-project reads', () => {
    const projectRoot = '/workspace/project';
    const child = attenuate(testProjectPrincipal(projectRoot), ['kb:source:import', 'jobs:read']);
    const sourceSpec = rpcSpec('kb.source.create');
    const sourceRequest = sourceSpec.requestSchema.parse({ projectRoot, filePath: 'paper.md' }) as {
      projectRoot: string;
    };
    const sourceBinding = resolveRequestBinding(
      sourceSpec.requestBinding,
      fixtureCanonicalWorkDir(sourceRequest.projectRoot),
    );

    expect(authorize(child, sourceSpec.requires, sourceBinding)).toEqual({ ok: true });
    expect(deriveSourceImportReadPolicy(child.binding, sourceRequest.projectRoot, envWith('8192')).kind).toBe(
      'sandboxed',
    );

    const jobsSpec = rpcSpec('jobs.list');
    expect(
      authorize(child, jobsSpec.requires, resolveRequestBinding(jobsSpec.requestBinding, undefined)),
    ).toMatchObject({ ok: false, reason: 'resource_unbound' });

    const eventsSpec = operationalSpec('http.events.stream');
    expect(
      authorize(child, eventsSpec.requires, resolveRequestBinding(eventsSpec.requestBinding, undefined)),
    ).toMatchObject({ ok: false, reason: 'resource_unbound' });
  });
});
