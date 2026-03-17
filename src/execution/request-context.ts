export type CallerContext = {
  projectRoot: string;
  pluginRoot: string;
  coralEnv?: Record<string, string>;
};

export type ToolRequest = {
  name: string;
  args: Record<string, unknown>;
  context: CallerContext;
};
