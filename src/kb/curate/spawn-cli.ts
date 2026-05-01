/**
 * SpawnCli surface for KB-domain orchestrators (curate scheduler, repair auto-fix).
 *
 * Lives in its own file (not `pipeline-types.ts`) so `kb/contract.ts` can reference it
 * without dragging in `kb/curate/state/*` — that path closes the cycle
 * `contract → pipeline-types → state/index → state/store → contract`.
 */
export type SpawnCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type SpawnCliFn = (options: {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  pool?: 'default' | 'discuss' | 'curate';
  signal?: AbortSignal;
}) => Promise<SpawnCliResult>;
