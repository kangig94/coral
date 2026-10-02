import { describe, expect, it } from 'vitest';
import { parseDeclarativeEngineManifest } from '#src/expansion/manifest/schema.js';

const manifest = (id: string, tier: 'bundled' | 'installed' = 'installed') => ({
  id,
  version: '1.0.0',
  specifier: `data:text/javascript,export default function ${id.replaceAll('-', '_')}(){}`,
  tier,
  description: 'test expansion',
});

describe('expansion package ids', () => {
  it('rejects reserved installed manifests while retaining the bundled Orama authority', () => {
    expect(() => parseDeclarativeEngineManifest(manifest('orama'))).toThrow(/expansion_package_id_reserved/u);
    expect(parseDeclarativeEngineManifest(manifest('orama', 'bundled')).id).toBe('orama');
  });
});
