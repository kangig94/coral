export interface EquippedToolSummary {
  readonly id: string;
  readonly summary: string;
  readonly guidance?: readonly string[];
}

export interface EquippedAgentTool extends EquippedToolSummary {
  readonly bin: string;
  readonly standardBinDir: string;
}

interface ToolEnvironment {
  get(name: string): string | undefined;
  homedir(): string;
  cwd(): string;
  platform(): string;
}

interface ToolStorage {
  statSync(path: string): { isFile(): boolean };
  assertExecutableSync(path: string): void;
}

export const CODEBASE_MEMORY_TOOL: EquippedAgentTool;
export const EQUIP_AGENT_TOOLS: readonly EquippedAgentTool[];
export function standardToolPath(tool: EquippedAgentTool, home: string): string;
export function isExecutableFile(storage: ToolStorage, path: string): boolean;
export function findEquippedTool(
  tool: EquippedAgentTool,
  env: ToolEnvironment,
  storage: ToolLookupStorage,
  excludedPath?: string,
): string | null;
interface ToolLookupStorage extends ToolStorage {
  readFileSync(path: string, encoding: 'utf-8'): string;
  lstatSync(path: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
}

export function resolveEquippedTools(env?: ToolEnvironment, storage?: ToolLookupStorage): EquippedToolSummary[];
