import type { Database } from 'better-sqlite3';

import { commit, type AppendContext, type AppendInput, type AppendedEvent } from '#src/store/append.js';

export type { AppendContext };

export function commitInputs(db: Database, inputs: readonly AppendInput[], ctx: AppendContext): AppendedEvent[] {
  return commit(
    db,
    (c) => {
      for (const input of inputs) {
        c.append(input);
      }
      return undefined;
    },
    ctx,
  );
}
