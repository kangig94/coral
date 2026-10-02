import { z } from 'zod';

import type { Database } from '../store/db.js';

export type ChildPrincipalCredentialRecord = Readonly<{
  credentialId: string;
  issuer: string;
  parentJobId: string;
  parentSessionId: string;
  namespace: string;
  principalWire: DurablePrincipalWire;
  expiresAtMs: number;
  publicKey: string;
}>;

export type ChildPrincipalCredentialRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'valid'; record: ChildPrincipalCredentialRecord }>;

export type ChildPrincipalCredentialStore = Readonly<{
  write(record: ChildPrincipalCredentialRecord): void;
  read(credentialId: string): ChildPrincipalCredentialRead;
  /** Unreadable rows are never removed here: their denial is the only visible trace of the damage. */
  deleteWhere(matches: (record: ChildPrincipalCredentialRecord) => boolean): void;
}>;

const KEY_PREFIX = 'child_principal_credential.v1:';
const KEY_PREFIX_END = 'child_principal_credential.v1;';

/** Pinned, never derived from the live capability vocabulary: a stored record keeps the set it was written with. */
const durablePrincipalWireSchema = z
  .object({
    subject: z.enum(['operator', 'agent', 'system']),
    binding: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unbound') }).passthrough(),
      z.object({ kind: z.literal('project'), root: z.string().min(1) }).passthrough(),
    ]),
    attenuatedCaps: z
      .array(
        z.enum([
          'liveness',
          'kb:read',
          'kb:write',
          'kb:source:import',
          'jobs:read',
          'jobs:control',
          'discuss:participate',
          'expansion:manage',
          'system:shutdown',
          'system:debug',
        ]),
      )
      .optional(),
  })
  .passthrough();

type DurablePrincipalWire = z.infer<typeof durablePrincipalWireSchema>;

const recordSchema = z
  .object({
    credentialId: z.string().min(1),
    issuer: z.string().min(1),
    parentJobId: z.string().min(1),
    parentSessionId: z.string().min(1),
    namespace: z.string().min(1),
    principalWire: durablePrincipalWireSchema,
    expiresAtMs: z.number().int().positive(),
    publicKey: z.string().min(1),
  })
  .passthrough();

function decodeRecord(credentialId: string, raw: string): ChildPrincipalCredentialRecord | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.credentialId === credentialId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createStoreChildPrincipalCredentials(db: () => Database): ChildPrincipalCredentialStore {
  return {
    write(record) {
      db()
        .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run(`${KEY_PREFIX}${record.credentialId}`, JSON.stringify(record));
    },
    read(credentialId) {
      const row = db()
        .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
        .get(`${KEY_PREFIX}${credentialId}`);
      if (row === undefined) return { kind: 'absent' };
      const record = decodeRecord(credentialId, row.value);
      return record === null ? { kind: 'unreadable' } : { kind: 'valid', record };
    },
    deleteWhere(matches) {
      const handle = db();
      const rows = handle
        .prepare<
          [string, string],
          { key: string; value: string }
        >('SELECT key, value FROM meta WHERE key >= ? AND key < ?')
        .all(KEY_PREFIX, KEY_PREFIX_END);
      const remove = handle.prepare<[string, string]>('DELETE FROM meta WHERE key = ? AND value = ?');
      for (const row of rows) {
        const record = decodeRecord(row.key.slice(KEY_PREFIX.length), row.value);
        if (record !== null && matches(record)) remove.run(row.key, row.value);
      }
    },
  };
}
