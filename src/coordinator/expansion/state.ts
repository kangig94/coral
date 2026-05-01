import type { Database, Statement } from '../../store/db.js';

export type ExpansionStateRow = {
  id: string;
  version: string;
  installed_at: string;
};

export class ExpansionStateStore {
  private readonly insertStmt: Statement<[string, string, string]>;
  private readonly deleteStmt: Statement<[string]>;
  private readonly listStmt: Statement<[], ExpansionStateRow>;
  private readonly getStmt: Statement<[string], ExpansionStateRow>;

  constructor(db: Database) {
    this.insertStmt = db.prepare<[string, string, string]>(
      `
        INSERT INTO expansion_state (id, version, installed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          installed_at = excluded.installed_at
      `,
    );
    this.deleteStmt = db.prepare<[string]>('DELETE FROM expansion_state WHERE id = ?');
    this.listStmt = db.prepare<[], ExpansionStateRow>('SELECT id, version, installed_at FROM expansion_state');
    this.getStmt = db.prepare<[string], ExpansionStateRow>(
      'SELECT id, version, installed_at FROM expansion_state WHERE id = ?',
    );
  }

  insert(row: ExpansionStateRow): void {
    this.insertStmt.run(row.id, row.version, row.installed_at);
  }

  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  list(): ExpansionStateRow[] {
    return this.listStmt.all();
  }

  get(id: string): ExpansionStateRow | undefined {
    return this.getStmt.get(id) ?? undefined;
  }
}
