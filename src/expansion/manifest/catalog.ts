import type { Database, Statement } from '../../store/db.js';
import type { ReadonlyDatabase } from '../../store/read-port.js';
import { BUNDLED_ENGINES } from '../bundled.js';
import type { EngineManifest } from '../contract.js';
import { parseDeclarativeEngineManifest } from './schema.js';

type ManifestCatalogReadDb = Pick<ReadonlyDatabase, 'prepare'>;
type ManifestCatalogWriteDb = Pick<Database, 'prepare'>;

type ManifestCatalogRow = {
  id: string;
  manifest_json: string;
  updated_at: string;
};

export type ExpansionManifestCatalogEntry = {
  readonly manifest: EngineManifest;
  readonly source: 'static' | 'installed';
};

export interface ExpansionManifestCatalogOptions {
  readonly db?: ManifestCatalogWriteDb;
  readonly readDb?: ManifestCatalogReadDb;
  readonly staticManifests?: readonly EngineManifest[];
  readonly now?: () => string;
}

function optionalArray<T>(values: readonly T[] | undefined): readonly T[] | undefined {
  return values === undefined || values.length === 0 ? undefined : values;
}

function toDeclarativeManifest(manifest: EngineManifest): EngineManifest {
  return parseDeclarativeEngineManifest({
    id: manifest.id,
    version: manifest.version,
    specifier: manifest.specifier,
    tier: manifest.tier,
    description: manifest.description,
    ...(optionalArray(manifest.onboarding) === undefined ? {} : { onboarding: manifest.onboarding }),
    ...(optionalArray(manifest.fills) === undefined ? {} : { fills: manifest.fills }),
    ...(manifest.provides === undefined ? {} : { provides: manifest.provides }),
  });
}

function parsePersistedManifest(row: ManifestCatalogRow): EngineManifest {
  try {
    const manifest = parseDeclarativeEngineManifest(JSON.parse(row.manifest_json) as unknown);
    if (manifest.id !== row.id) {
      throw new Error(`row id '${row.id}' does not match manifest id '${manifest.id}'`);
    }
    if (manifest.tier !== 'installed') {
      throw new Error(`persisted manifest '${row.id}' must have tier 'installed'`);
    }
    return manifest;
  } catch (error) {
    throw new Error(`Invalid expansion manifest catalog row '${row.id}'`, { cause: error });
  }
}

function readRows(db: ManifestCatalogReadDb): ManifestCatalogRow[] {
  return db
    .prepare<[], ManifestCatalogRow>('SELECT id, manifest_json, updated_at FROM expansion_manifest_catalog ORDER BY id')
    .all();
}

export class ExpansionManifestCatalog {
  private readonly staticEntries: readonly EngineManifest[];
  private readonly staticIds: ReadonlySet<string>;
  private readonly installed = new Map<string, EngineManifest>();
  private readonly upsertStmt?: Statement<[string, string, string]>;
  private readonly deleteStmt?: Statement<[string]>;
  private readonly selectInstalledByIdStmt?: Statement<[string], ManifestCatalogRow>;
  private readonly now: () => string;

  constructor(options: ExpansionManifestCatalogOptions = {}) {
    this.staticEntries = options.staticManifests ?? BUNDLED_ENGINES;
    const staticIds = new Set<string>();
    for (const entry of this.staticEntries) {
      staticIds.add(entry.id);
    }
    this.staticIds = staticIds;
    this.now = options.now ?? (() => new Date().toISOString());
    const db = options.db;
    if (db !== undefined) {
      this.upsertStmt = db.prepare<[string, string, string]>(
        `
          INSERT INTO expansion_manifest_catalog (id, manifest_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            manifest_json = excluded.manifest_json,
            updated_at = excluded.updated_at
        `,
      );
      this.deleteStmt = db.prepare<[string]>('DELETE FROM expansion_manifest_catalog WHERE id = ?');
      this.selectInstalledByIdStmt = db.prepare<[string], ManifestCatalogRow>(
        'SELECT id, manifest_json, updated_at FROM expansion_manifest_catalog WHERE id = ?',
      );
    }

    const readDb = options.readDb ?? options.db;
    if (readDb !== undefined) {
      for (const row of readRows(readDb)) {
        const manifest = parsePersistedManifest(row);
        if (this.staticIds.has(row.id)) {
          throw new Error(`Persisted expansion manifest '${row.id}' collides with a static catalog entry`);
        }
        this.installed.set(row.id, manifest);
      }
    }
  }

  listEntries(): readonly ExpansionManifestCatalogEntry[] {
    const entries: ExpansionManifestCatalogEntry[] = [];
    for (const manifest of this.staticEntries) {
      entries.push({ manifest, source: 'static' });
    }
    for (const manifest of this.installed.values()) {
      entries.push({ manifest, source: 'installed' });
    }
    return Object.freeze(entries);
  }

  listManifests(): readonly EngineManifest[] {
    const manifests: EngineManifest[] = [];
    for (const manifest of this.staticEntries) {
      manifests.push(manifest);
    }
    for (const manifest of this.installed.values()) {
      manifests.push(manifest);
    }
    return Object.freeze(manifests);
  }

  listDeclarativeEntries(): readonly EngineManifest[] {
    const manifests: EngineManifest[] = [];
    for (const manifest of this.staticEntries) {
      manifests.push(toDeclarativeManifest(manifest));
    }
    for (const manifest of this.installed.values()) {
      manifests.push(toDeclarativeManifest(manifest));
    }
    return Object.freeze(manifests);
  }

  getManifest(id: string): EngineManifest | undefined {
    return this.staticEntries.find((entry) => entry.id === id) ?? this.installed.get(id);
  }

  isStatic(id: string): boolean {
    return this.staticIds.has(id);
  }

  hasCurrentEntry(id: string): boolean {
    if (this.staticIds.has(id)) {
      return true;
    }
    const row = this.selectInstalledByIdStmt?.get(id);
    if (row === undefined) {
      return this.selectInstalledByIdStmt === undefined && this.installed.has(id);
    }
    parsePersistedManifest(row);
    return true;
  }

  upsertInstalledEntry(manifest: EngineManifest): EngineManifest {
    if (this.staticIds.has(manifest.id)) {
      throw new Error(`Installed expansion manifest '${manifest.id}' collides with a static catalog entry`);
    }
    if (manifest.tier !== 'installed') {
      throw new Error(`Installed expansion manifest '${manifest.id}' must have tier 'installed'`);
    }
    const declarative = toDeclarativeManifest(manifest);
    this.installed.set(declarative.id, declarative);
    this.upsertStmt?.run(declarative.id, JSON.stringify(declarative), this.now());
    return declarative;
  }

  removeInstalledEntry(id: string): 'removed' | 'immutable' | 'missing' {
    if (this.staticIds.has(id)) {
      return 'immutable';
    }
    const existed = this.installed.delete(id);
    if (!existed) {
      return 'missing';
    }
    this.deleteStmt?.run(id);
    return 'removed';
  }
}

export function createExpansionManifestCatalog(
  options: ExpansionManifestCatalogOptions = {},
): ExpansionManifestCatalog {
  return new ExpansionManifestCatalog(options);
}
