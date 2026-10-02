import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeStoreFormat, PersistedCodecRegistry } from '#src/store/format-fingerprint.js';

function ddlFor(...codecNames: readonly string[]): string {
  return codecNames.map((name, index) => `value_${index} TEXT -- JSON @persisted-codec ${name}`).join('\n');
}

describe('StoreFormatFingerprint', () => {
  it('is independent of codec registration order', () => {
    const left = new PersistedCodecRegistry();
    left.registerZod('store.alpha', z.object({ value: z.string() }).strict());
    left.registerZod('store.beta', z.array(z.number().int()));

    const right = new PersistedCodecRegistry();
    right.registerZod('store.beta', z.array(z.number().int()));
    right.registerZod('store.alpha', z.object({ value: z.string() }).strict());

    const ddl = ddlFor('store.alpha', 'store.beta');
    expect(describeStoreFormat(ddl, left).fingerprint).toBe(describeStoreFormat(ddl, right).fingerprint);
  });

  it('changes when a registered structural codec contract changes', () => {
    const before = new PersistedCodecRegistry();
    before.registerZod('store.value', z.object({ value: z.string().min(1) }).strict());

    const after = new PersistedCodecRegistry();
    after.registerZod('store.value', z.object({ value: z.number().int() }).strict());

    const ddl = ddlFor('store.value');
    expect(describeStoreFormat(ddl, before).fingerprint).not.toBe(describeStoreFormat(ddl, after).fingerprint);
  });
});
