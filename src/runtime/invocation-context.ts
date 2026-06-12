export type Authority = 'admin' | 'user';

export type InvocationContext = {
  projectRoot: string;
  pluginRoot: string;
  coralEnv: Record<string, string>;
  authority: Authority;
};
