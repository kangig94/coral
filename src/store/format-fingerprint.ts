import type { z } from 'zod';

import { sha256Hex } from '../infra/hash.js';
import {
  canonicalContractJson,
  canonicalizeContractValue,
  compareText,
  zodPersistedContract,
  type CanonicalContractValue,
} from '../infra/persisted-contract.js';

export type PersistedCodecManifestEntry = {
  readonly name: string;
  readonly persistence: 'boundary' | 'component';
  readonly contract: CanonicalContractValue;
};

export type PersistedDdlFragment = {
  readonly name: string;
  readonly ddl: string;
};

export type StoreFormatManifest = {
  readonly kind: 'coral-store-format';
  readonly ddl: string;
  readonly codecs: readonly PersistedCodecManifestEntry[];
};

export type StoreFormatFingerprintDescription = {
  readonly manifest: StoreFormatManifest;
  readonly canonicalManifest: string;
  readonly fingerprint: StoreFormatFingerprint;
};

export type StoreFormatDescription = StoreFormatFingerprintDescription & {
  readonly productVersion: string;
};

export type StoreFormatFingerprint = `sha256:${string}`;

type CurrentStoreFormatIdentity = {
  readonly currentFingerprint: StoreFormatFingerprint;
  readonly currentProductVersion: string;
};

type StoredStoreFormatIdentity = CurrentStoreFormatIdentity & {
  readonly storedFingerprint: StoreFormatFingerprint;
  readonly storedProductVersion: string;
};

/**
 * Classification of an on-disk store against the current executable contract:
 * `absent` has no database file; `fresh` has no user tables; `compatible` has
 * the current fingerprint and a valid non-newer version; `legacy-adoptable`
 * has the current fingerprint but no product-version row; `older-incompatible`
 * and `newer-incompatible` have valid versions on the corresponding side of
 * current SemVer precedence; `corrupt-or-unsupported` covers missing, malformed,
 * or equal-version/different-fingerprint metadata that cannot be ordered safely.
 */
export type StoreFormatClassification =
  | { readonly kind: 'absent' }
  | { readonly kind: 'fresh' }
  | (StoredStoreFormatIdentity & { readonly kind: 'compatible' })
  | (CurrentStoreFormatIdentity & {
      readonly kind: 'legacy-adoptable';
      readonly storedFingerprint: StoreFormatFingerprint;
    })
  | (StoredStoreFormatIdentity & { readonly kind: 'older-incompatible' })
  | (StoredStoreFormatIdentity & { readonly kind: 'newer-incompatible' })
  | (CurrentStoreFormatIdentity & {
      readonly kind: 'corrupt-or-unsupported';
      readonly storedFingerprint: string | null;
      readonly storedProductVersion: string | null;
    });

export const STORE_FORMAT_FINGERPRINT_META_KEY = 'store_format_fingerprint';
export const STORE_PRODUCT_VERSION_META_KEY = 'store_product_version';

const STORE_FORMAT_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isStoreFormatFingerprint(value: unknown): value is StoreFormatFingerprint {
  return typeof value === 'string' && STORE_FORMAT_FINGERPRINT_PATTERN.test(value);
}

const CODEC_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PERSISTED_CODEC_ANNOTATION = /@persisted-codec\s+([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)/g;
const JSON_BOUNDARY_COMMENT = /--[^\r\n]*\bJSON\b/i;

export class PersistedCodecRegistry {
  readonly #entries = new Map<string, Omit<PersistedCodecManifestEntry, 'name'>>();

  register(
    name: string,
    contract: unknown,
    persistence: PersistedCodecManifestEntry['persistence'] = 'boundary',
  ): void {
    if (!CODEC_NAME.test(name)) {
      throw new TypeError(`Invalid persisted codec name '${name}'.`);
    }
    if (this.#entries.has(name)) {
      throw new Error(`Persisted codec '${name}' is registered twice.`);
    }
    this.#entries.set(name, { persistence, contract: canonicalizeContractValue(contract, `$.codecs.${name}`) });
  }

  registerZod(name: string, schema: z.ZodTypeAny): void {
    this.register(name, zodPersistedContract(schema));
  }

  registerZodComponent(name: string, schema: z.ZodTypeAny): void {
    this.register(name, zodPersistedContract(schema), 'component');
  }

  entries(): readonly PersistedCodecManifestEntry[] {
    return [...this.#entries.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, entry]) => Object.freeze({ name, ...entry }));
  }
}

export function persistedCodecNamesFromDdl(ddl: string): readonly string[] {
  for (const [index, line] of ddl.split(/\r?\n/u).entries()) {
    const declaresJson = JSON_BOUNDARY_COMMENT.test(line);
    const declaresCodec = new RegExp(PERSISTED_CODEC_ANNOTATION.source, 'u').test(line);
    if (declaresJson && !declaresCodec) {
      throw new Error(`DDL JSON boundary on line ${index + 1} has no @persisted-codec declaration.`);
    }
    if (declaresCodec && !declaresJson) {
      throw new Error(`DDL persisted codec on line ${index + 1} is not declared as a JSON boundary.`);
    }
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of ddl.matchAll(PERSISTED_CODEC_ANNOTATION)) {
    const name = match[1];
    if (name === undefined) continue;
    if (seen.has(name)) {
      throw new Error(`DDL declares persisted codec '${name}' more than once.`);
    }
    seen.add(name);
    names.push(name);
  }
  return names.sort(compareText);
}

function assertCodecCoverage(ddl: string, entries: readonly PersistedCodecManifestEntry[]): void {
  const declared = persistedCodecNamesFromDdl(ddl);
  const registered = entries.filter((entry) => entry.persistence === 'boundary').map((entry) => entry.name);
  const missing = declared.filter((name) => !registered.includes(name));
  const orphaned = registered.filter((name) => !declared.includes(name));
  if (missing.length === 0 && orphaned.length === 0) return;
  throw new Error(
    `Persisted codec coverage mismatch: missing=[${missing.join(', ')}] orphaned=[${orphaned.join(', ')}]`,
  );
}

function canonicalDdl(ddl: string): string {
  return `${ddl.replaceAll('\r\n', '\n').trimEnd()}\n`;
}

function completeDdl(primaryDdl: string, fragments: readonly PersistedDdlFragment[]): string {
  const seen = new Set<string>();
  const normalizedFragments = [...fragments]
    .map((fragment) => {
      if (!CODEC_NAME.test(fragment.name)) {
        throw new TypeError(`Invalid persisted DDL fragment name '${fragment.name}'.`);
      }
      if (seen.has(fragment.name)) {
        throw new Error(`Persisted DDL fragment '${fragment.name}' is registered twice.`);
      }
      seen.add(fragment.name);
      return fragment;
    })
    .sort((left, right) => compareText(left.name, right.name));

  return canonicalDdl(
    [primaryDdl, ...normalizedFragments.map(({ name, ddl }) => `-- @persisted-ddl ${name}\n${ddl}`)].join('\n'),
  );
}

export function describeStoreFormat(
  ddl: string,
  codecs: PersistedCodecRegistry,
  ddlFragments: readonly PersistedDdlFragment[] = [],
): StoreFormatFingerprintDescription {
  const entries = codecs.entries();
  const completeStoreDdl = completeDdl(ddl, ddlFragments);
  assertCodecCoverage(completeStoreDdl, entries);
  const manifest: StoreFormatManifest = Object.freeze({
    kind: 'coral-store-format',
    ddl: completeStoreDdl,
    codecs: entries,
  });
  const canonicalManifest = canonicalContractJson(manifest);
  return Object.freeze({
    manifest,
    canonicalManifest,
    fingerprint: `sha256:${sha256Hex(canonicalManifest)}`,
  });
}
