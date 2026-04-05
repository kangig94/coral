/** MCP tool descriptor shape used by bridge and backend-tool. */
export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
