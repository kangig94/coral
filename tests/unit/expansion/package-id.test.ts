import { describe, expect, it } from 'vitest';

import { validateCanonicalExpansionPackageId, validateExpansionPackageId } from '#src/expansion/package-id.js';
import { parseDeclarativeEngineManifest } from '#src/expansion/manifest/schema.js';
import { KB_RUNTIME_EXACT_AUTHORITIES, KB_RUNTIME_PATTERNED_AUTHORITIES } from '#src/runtime/kb-runtime-authority.js';

const manifest = (id: string, tier: 'bundled' | 'installed' = 'installed') => ({
  id,
  version: '1.0.0',
  specifier: `data:text/javascript,export default function ${id.replaceAll('-', '_')}(){}`,
  tier,
  description: 'test expansion',
});

describe('expansion package ids', () => {
  it.each(['vector', 'vector-v2', 'a1', 'a-b-2'])('accepts canonical safe id %s', (id) => {
    expect(validateCanonicalExpansionPackageId(id)).toEqual({ ok: true, id });
    expect(validateExpansionPackageId(id)).toEqual({ ok: true, id });
  });

  it.each([
    '',
    '.',
    '..',
    'Vector',
    'vector_2',
    'vector--2',
    '-vector',
    'vector-',
    'vector/other',
    String.raw`vector\other`,
    '/vector',
    String.raw`C:\vector`,
    'vector:stream',
    'vector.',
    'vector ',
    'vector\0',
    'con',
    'com1',
    'lpt9',
  ])('rejects unsafe or aliased id %j', (id) => {
    expect(validateCanonicalExpansionPackageId(id)).toMatchObject({ ok: false, reason: 'unsafe' });
  });

  it('rejects every exact and patterned KB runtime authority', () => {
    for (const id of KB_RUNTIME_EXACT_AUTHORITIES) {
      const result = validateExpansionPackageId(id);
      expect(result.ok).toBe(false);
      if (validateCanonicalExpansionPackageId(id).ok) {
        expect(result).toMatchObject({ reason: 'reserved' });
      }
    }
    expect(KB_RUNTIME_PATTERNED_AUTHORITIES).toHaveLength(1);
    expect(validateExpansionPackageId('wiki-touches-orphan-fixture-jsonl')).toEqual({
      ok: true,
      id: 'wiki-touches-orphan-fixture-jsonl',
    });
    expect(validateExpansionPackageId('wiki-touches.orphan.fixture.jsonl')).toMatchObject({
      ok: false,
      reason: 'unsafe',
    });
    expect(validateExpansionPackageId('source-import')).toMatchObject({ ok: false, reason: 'reserved' });
  });

  it('rejects reserved installed manifests while retaining the bundled Orama authority', () => {
    expect(() => parseDeclarativeEngineManifest(manifest('orama'))).toThrow(/expansion_package_id_reserved/u);
    expect(parseDeclarativeEngineManifest(manifest('orama', 'bundled')).id).toBe('orama');
  });
});
