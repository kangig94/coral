export const OUTSIDE_ROOT_STORE_BYPASS = String.raw`
  import { DatabaseSync } from 'node:sqlite';
  new DatabaseSync(path);
`;
