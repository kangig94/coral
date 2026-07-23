export const STORE_RESET_INCIDENT_SCHEMA_VERSION = 2 as const;
export const STORE_RESET_MANIFEST_FILE_NAME = 'reset-manifest.json';

export const MAX_RESET_MANIFEST_BYTES = 64 * 1024;
export const MAX_RESET_MANIFEST_JSON_DEPTH = 8;
export const MAX_INCIDENT_ROOT_ENTRIES = 4_096;
export const MAX_INCIDENT_DIR_ENTRIES = 5;
export const MAX_REPORT_HASH_BYTES = 1024 * 1024 * 1024;
export const MAX_SQLITE_DIAGNOSTIC_BYTES = 256 * 1024 * 1024;
export const SQLITE_EXECUTION_DEADLINE_MS = 5_000;
export const SQLITE_TERMINATION_GRACE_MS = 1_000;
export const SQLITE_FORCE_CLOSE_DEADLINE_MS = 1_000;
export const SQLITE_CHILD_STDOUT_MAX_BYTES = 64;
export const SQLITE_CHILD_STDERR_MAX_BYTES = 4 * 1024;

export const STORE_RESET_EVIDENCE_FILE_NAMES = ['store.db', 'store.db-wal', 'store.db-shm', 'store.db.format'] as const;

export type StoreResetEvidenceFileName = (typeof STORE_RESET_EVIDENCE_FILE_NAMES)[number];
export type StoreResetReason = 'missing' | 'mismatch';
export type StoreResetBuildFlavor = 'dev' | 'prod';

export type StoreResetIncidentFile = {
  readonly name: StoreResetEvidenceFileName;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly sha256: string;
};

export type StoreResetIncidentManifestV2 = {
  readonly schemaVersion: typeof STORE_RESET_INCIDENT_SCHEMA_VERSION;
  readonly incidentId: string;
  readonly resetAt: string;
  readonly reason: StoreResetReason;
  readonly storedFingerprint: string | null;
  readonly expectedFingerprint: string;
  readonly build: {
    readonly version: string;
    readonly buildSetId: string;
    readonly backendBundleHash: string;
    readonly flavor: StoreResetBuildFlavor;
  };
  readonly runtime: {
    readonly namespace: string;
    readonly nodeVersion: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly processId: number;
  };
  readonly handoff: {
    readonly acquiredViaHandoff: boolean;
  };
  readonly files: readonly StoreResetIncidentFile[];
};

export type StoreResetHashVerification = 'match' | 'mismatch' | 'missing' | 'unavailable_limit' | 'unavailable';

export type StoreResetDiagnosticIntegrity = 'ok' | 'failed' | 'unavailable';
export type StoreResetDiagnosticTermination = 'completed' | 'terminated' | 'termination_unconfirmed';
export type StoreResetDiagnosticCleanup = 'removed' | 'cleanup_unavailable';

export type StoreResetIncidentLocalReport = {
  readonly manifest: StoreResetIncidentManifestV2;
  readonly fileVerification: readonly {
    readonly name: StoreResetEvidenceFileName;
    readonly status: StoreResetHashVerification;
  }[];
  readonly diagnostic: {
    readonly integrity: StoreResetDiagnosticIntegrity;
    readonly termination: StoreResetDiagnosticTermination;
    readonly cleanup: StoreResetDiagnosticCleanup;
  };
};

export type StoreResetIncidentListEntry =
  | {
      readonly incidentId: string;
      readonly state: 'ready';
      readonly resetAt: string;
      readonly reason: StoreResetReason;
      readonly fileCount: number;
    }
  | {
      readonly incidentId: string;
      readonly state: 'malformed' | 'unsupported' | 'build_mismatch' | 'unsafe' | 'unavailable';
      readonly resetAt: null;
      readonly reason: null;
      readonly fileCount: null;
    };

export type StoreResetIncidentListResult = {
  readonly incidents: readonly StoreResetIncidentListEntry[];
};

const STORE_RESET_PUBLIC_REPORT_BRAND: unique symbol = Symbol('StoreResetPublicReport');

export type StoreResetPublicReport = {
  readonly incidentId: string;
  readonly resetAt: string;
  readonly reason: StoreResetReason;
  readonly storedFingerprint: string | null;
  readonly expectedFingerprint: string;
  readonly build: {
    readonly version: string;
    readonly buildSetId: string;
    readonly backendBundleHash: string;
    readonly flavor: StoreResetBuildFlavor;
  };
  readonly handoff: {
    readonly acquiredViaHandoff: boolean;
  };
  readonly files: readonly {
    readonly name: StoreResetEvidenceFileName;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly verification: StoreResetHashVerification;
  }[];
  readonly diagnostic: {
    readonly integrity: StoreResetDiagnosticIntegrity;
    readonly termination: StoreResetDiagnosticTermination;
    readonly cleanup: StoreResetDiagnosticCleanup;
  };
  readonly [STORE_RESET_PUBLIC_REPORT_BRAND]: true;
};

export type StoreResetManifestDecodeErrorCode =
  | 'manifest_too_large'
  | 'manifest_invalid_utf8'
  | 'manifest_invalid_json'
  | 'manifest_depth_exceeded'
  | 'manifest_duplicate_key'
  | 'manifest_invalid_schema';

export class StoreResetManifestDecodeError extends Error {
  readonly code: StoreResetManifestDecodeErrorCode;

  constructor(code: StoreResetManifestDecodeErrorCode) {
    super('Store reset incident manifest is invalid.');
    this.name = 'StoreResetManifestDecodeError';
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

type ObjectFrame = {
  readonly kind: 'object';
  readonly value: JsonObject;
  readonly keys: Set<string>;
  state: 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end';
  key: string | null;
};

type ArrayFrame = {
  readonly kind: 'array';
  readonly value: unknown[];
  state: 'value-or-end' | 'value' | 'comma-or-end';
};

type JsonFrame = ObjectFrame | ArrayFrame;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUNDLE_HASH_PATTERN = /^[0-9a-f]{16}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NAMESPACE_PATTERN = /^[0-9A-Za-z._-]+$/;
const NODE_VERSION_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ALLOWED_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
]);

const ALLOWED_ARCHITECTURES = new Set([
  'arm',
  'arm64',
  'ia32',
  'loong64',
  'mips',
  'mipsel',
  'ppc',
  'ppc64',
  'riscv64',
  's390',
  's390x',
  'x64',
]);

function fail(code: StoreResetManifestDecodeErrorCode): never {
  throw new StoreResetManifestDecodeError(code);
}

export function isCanonicalStoreResetIncidentId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

class BoundedJsonReader {
  readonly #text: string;
  #offset = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): unknown {
    const frames: JsonFrame[] = [];
    let root: unknown;
    let hasRoot = false;

    const acceptValue = (value: unknown): void => {
      const parent = frames.at(-1);
      if (parent === undefined) {
        if (hasRoot) {
          fail('manifest_invalid_json');
        }
        root = value;
        hasRoot = true;
        return;
      }

      if (parent.kind === 'object') {
        if (parent.state !== 'value' || parent.key === null) {
          fail('manifest_invalid_json');
        }
        Object.defineProperty(parent.value, parent.key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
        parent.key = null;
        parent.state = 'comma-or-end';
        return;
      }

      if (parent.state !== 'value' && parent.state !== 'value-or-end') {
        fail('manifest_invalid_json');
      }
      parent.value.push(value);
      parent.state = 'comma-or-end';
    };

    const readValue = (): void => {
      this.#skipWhitespace();
      const character = this.#peek();
      if (character === '{') {
        this.#offset += 1;
        const value = Object.create(null) as JsonObject;
        acceptValue(value);
        this.#pushFrame(frames, {
          kind: 'object',
          value,
          keys: new Set(),
          state: 'key-or-end',
          key: null,
        });
        return;
      }
      if (character === '[') {
        this.#offset += 1;
        const value: unknown[] = [];
        acceptValue(value);
        this.#pushFrame(frames, { kind: 'array', value, state: 'value-or-end' });
        return;
      }
      if (character === '"') {
        acceptValue(this.#readString());
        return;
      }
      if (character === 't') {
        this.#readLiteral('true');
        acceptValue(true);
        return;
      }
      if (character === 'f') {
        this.#readLiteral('false');
        acceptValue(false);
        return;
      }
      if (character === 'n') {
        this.#readLiteral('null');
        acceptValue(null);
        return;
      }
      if (character === '-' || (character >= '0' && character <= '9')) {
        acceptValue(this.#readNumber());
        return;
      }
      fail('manifest_invalid_json');
    };

    this.#skipWhitespace();
    readValue();

    while (frames.length > 0) {
      const frame = frames.at(-1);
      if (frame === undefined) {
        fail('manifest_invalid_json');
      }
      this.#skipWhitespace();

      if (frame.kind === 'object') {
        if (frame.state === 'key-or-end') {
          if (this.#consume('}')) {
            frames.pop();
          } else {
            frame.state = 'key';
          }
          continue;
        }
        if (frame.state === 'key') {
          if (this.#peek() !== '"') {
            fail('manifest_invalid_json');
          }
          const key = this.#readString();
          if (frame.keys.has(key)) {
            fail('manifest_duplicate_key');
          }
          frame.keys.add(key);
          frame.key = key;
          frame.state = 'colon';
          continue;
        }
        if (frame.state === 'colon') {
          if (!this.#consume(':')) {
            fail('manifest_invalid_json');
          }
          frame.state = 'value';
          continue;
        }
        if (frame.state === 'value') {
          readValue();
          continue;
        }
        if (this.#consume(',')) {
          frame.state = 'key';
          continue;
        }
        if (this.#consume('}')) {
          frames.pop();
          continue;
        }
        fail('manifest_invalid_json');
      }

      if (frame.state === 'value-or-end') {
        if (this.#consume(']')) {
          frames.pop();
        } else {
          frame.state = 'value';
        }
        continue;
      }
      if (frame.state === 'value') {
        readValue();
        continue;
      }
      if (this.#consume(',')) {
        frame.state = 'value';
        continue;
      }
      if (this.#consume(']')) {
        frames.pop();
        continue;
      }
      fail('manifest_invalid_json');
    }

    this.#skipWhitespace();
    if (!hasRoot || this.#offset !== this.#text.length) {
      fail('manifest_invalid_json');
    }
    return root;
  }

  #pushFrame(frames: JsonFrame[], frame: JsonFrame): void {
    if (frames.length >= MAX_RESET_MANIFEST_JSON_DEPTH) {
      fail('manifest_depth_exceeded');
    }
    frames.push(frame);
  }

  #peek(): string {
    return this.#text[this.#offset] ?? '';
  }

  #consume(expected: string): boolean {
    if (this.#peek() !== expected) {
      return false;
    }
    this.#offset += 1;
    return true;
  }

  #skipWhitespace(): void {
    while (this.#offset < this.#text.length) {
      const character = this.#text[this.#offset];
      if (character !== ' ' && character !== '\n' && character !== '\r' && character !== '\t') {
        return;
      }
      this.#offset += 1;
    }
  }

  #readLiteral(literal: string): void {
    if (this.#text.slice(this.#offset, this.#offset + literal.length) !== literal) {
      fail('manifest_invalid_json');
    }
    this.#offset += literal.length;
  }

  #readString(): string {
    const start = this.#offset;
    this.#offset += 1;
    let escaped = false;
    while (this.#offset < this.#text.length) {
      const character = this.#text[this.#offset];
      this.#offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(this.#text.slice(start, this.#offset)) as string;
        } catch {
          fail('manifest_invalid_json');
        }
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) {
        fail('manifest_invalid_json');
      }
    }
    fail('manifest_invalid_json');
  }

  #readNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.#text.slice(this.#offset));
    if (match === null) {
      fail('manifest_invalid_json');
    }
    this.#offset += match[0].length;
    return Number(match[0]);
  }
}

function decodeManifestBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_RESET_MANIFEST_BYTES) {
    fail('manifest_too_large');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('manifest_invalid_utf8');
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    fail('manifest_invalid_schema');
  }
  return value;
}

function requiredValue(object: JsonObject, key: string): unknown {
  if (!Object.hasOwn(object, key)) {
    fail('manifest_invalid_schema');
  }
  return object[key];
}

function exactString(value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    fail('manifest_invalid_schema');
  }
  return value;
}

function safeNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('manifest_invalid_schema');
  }
  return value;
}

function finiteNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    fail('manifest_invalid_schema');
  }
  return value;
}

function validateResetAt(value: unknown): string {
  const resetAt = exactString(value, UTC_ISO_PATTERN, 24);
  const parsed = new Date(resetAt);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== resetAt) {
    fail('manifest_invalid_schema');
  }
  return resetAt;
}

function validatePlatform(value: unknown): NodeJS.Platform {
  if (typeof value !== 'string' || !ALLOWED_PLATFORMS.has(value as NodeJS.Platform)) {
    fail('manifest_invalid_schema');
  }
  return value as NodeJS.Platform;
}

function validateArchitecture(value: unknown): string {
  if (typeof value !== 'string' || !ALLOWED_ARCHITECTURES.has(value)) {
    fail('manifest_invalid_schema');
  }
  return value;
}

function validateManifest(value: unknown): StoreResetIncidentManifestV2 {
  const root = objectValue(value);
  if (requiredValue(root, 'schemaVersion') !== STORE_RESET_INCIDENT_SCHEMA_VERSION) {
    fail('manifest_invalid_schema');
  }

  const incidentId = exactString(requiredValue(root, 'incidentId'), UUID_PATTERN, 36);
  const resetAt = validateResetAt(requiredValue(root, 'resetAt'));
  const reasonValue = requiredValue(root, 'reason');
  if (reasonValue !== 'missing' && reasonValue !== 'mismatch') {
    fail('manifest_invalid_schema');
  }

  const storedFingerprintValue = requiredValue(root, 'storedFingerprint');
  const storedFingerprint =
    storedFingerprintValue === null ? null : exactString(storedFingerprintValue, FINGERPRINT_PATTERN, 71);
  const expectedFingerprint = exactString(requiredValue(root, 'expectedFingerprint'), FINGERPRINT_PATTERN, 71);

  const buildValue = objectValue(requiredValue(root, 'build'));
  const version = exactString(requiredValue(buildValue, 'version'), SEMVER_PATTERN, 128);
  const buildSetId = exactString(requiredValue(buildValue, 'buildSetId'), UUID_PATTERN, 36);
  const backendBundleHash = exactString(requiredValue(buildValue, 'backendBundleHash'), BUNDLE_HASH_PATTERN, 16);
  const flavorValue = requiredValue(buildValue, 'flavor');
  if (flavorValue !== 'dev' && flavorValue !== 'prod') {
    fail('manifest_invalid_schema');
  }

  const runtimeValue = objectValue(requiredValue(root, 'runtime'));
  const namespace = exactString(requiredValue(runtimeValue, 'namespace'), NAMESPACE_PATTERN, 128);
  const nodeVersion = exactString(requiredValue(runtimeValue, 'nodeVersion'), NODE_VERSION_PATTERN, 64);
  const platform = validatePlatform(requiredValue(runtimeValue, 'platform'));
  const architecture = validateArchitecture(requiredValue(runtimeValue, 'architecture'));
  const processId = safeNonNegativeInteger(requiredValue(runtimeValue, 'processId'));
  if (processId === 0) {
    fail('manifest_invalid_schema');
  }

  const handoffValue = objectValue(requiredValue(root, 'handoff'));
  const acquiredViaHandoff = requiredValue(handoffValue, 'acquiredViaHandoff');
  if (typeof acquiredViaHandoff !== 'boolean') {
    fail('manifest_invalid_schema');
  }

  const filesValue = requiredValue(root, 'files');
  if (
    !Array.isArray(filesValue) ||
    filesValue.length === 0 ||
    filesValue.length > STORE_RESET_EVIDENCE_FILE_NAMES.length
  ) {
    fail('manifest_invalid_schema');
  }
  let previousFileIndex = -1;
  const files = filesValue.map((entry): StoreResetIncidentFile => {
    const fileValue = objectValue(entry);
    const nameValue = requiredValue(fileValue, 'name');
    const fileIndex =
      typeof nameValue === 'string'
        ? STORE_RESET_EVIDENCE_FILE_NAMES.indexOf(nameValue as StoreResetEvidenceFileName)
        : -1;
    if (fileIndex <= previousFileIndex) {
      fail('manifest_invalid_schema');
    }
    previousFileIndex = fileIndex;
    if (fileIndex < 0) {
      fail('manifest_invalid_schema');
    }
    return Object.freeze({
      name: STORE_RESET_EVIDENCE_FILE_NAMES[fileIndex],
      sizeBytes: safeNonNegativeInteger(requiredValue(fileValue, 'sizeBytes')),
      mtimeMs: finiteNonNegativeNumber(requiredValue(fileValue, 'mtimeMs')),
      sha256: exactString(requiredValue(fileValue, 'sha256'), SHA256_PATTERN, 64),
    });
  });

  return Object.freeze({
    schemaVersion: STORE_RESET_INCIDENT_SCHEMA_VERSION,
    incidentId,
    resetAt,
    reason: reasonValue,
    storedFingerprint,
    expectedFingerprint,
    build: Object.freeze({
      version,
      buildSetId,
      backendBundleHash,
      flavor: flavorValue,
    }),
    runtime: Object.freeze({
      namespace,
      nodeVersion,
      platform,
      architecture,
      processId,
    }),
    handoff: Object.freeze({ acquiredViaHandoff }),
    files: Object.freeze(files),
  });
}

export function parseStoreResetIncidentManifest(bytes: Uint8Array): StoreResetIncidentManifestV2 {
  const text = decodeManifestBytes(bytes);
  const parsed = new BoundedJsonReader(text).parse();
  return validateManifest(parsed);
}

export function serializeStoreResetIncidentManifest(manifest: StoreResetIncidentManifestV2): string {
  const validated = validateManifest(manifest);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function projectStoreResetPublicReport(local: StoreResetIncidentLocalReport): StoreResetPublicReport {
  const verificationByName = new Map(local.fileVerification.map((entry) => [entry.name, entry.status]));
  const manifest = local.manifest;
  return Object.freeze({
    incidentId: manifest.incidentId,
    resetAt: manifest.resetAt,
    reason: manifest.reason,
    storedFingerprint: manifest.storedFingerprint,
    expectedFingerprint: manifest.expectedFingerprint,
    build: Object.freeze({
      version: manifest.build.version,
      buildSetId: manifest.build.buildSetId,
      backendBundleHash: manifest.build.backendBundleHash,
      flavor: manifest.build.flavor,
    }),
    handoff: Object.freeze({
      acquiredViaHandoff: manifest.handoff.acquiredViaHandoff,
    }),
    files: Object.freeze(
      manifest.files.map((file) =>
        Object.freeze({
          name: file.name,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          verification: verificationByName.get(file.name) ?? 'unavailable',
        }),
      ),
    ),
    diagnostic: Object.freeze({
      integrity: local.diagnostic.integrity,
      termination: local.diagnostic.termination,
      cleanup: local.diagnostic.cleanup,
    }),
    [STORE_RESET_PUBLIC_REPORT_BRAND]: true as const,
  });
}
