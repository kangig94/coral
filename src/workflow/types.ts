import type { SessionProvider } from '../runner/types.js';

export type AgentAtom = {
  kind: 'agent';
  namespace?: string;
  agent: string;
  provider?: SessionProvider;
};

export type PromptAtom = {
  kind: 'prompt';
  text: string;
  provider?: SessionProvider;
};

export type PipeAtom = AgentAtom | PromptAtom;

export type PipeStep = PipeAtom[];

export type PipelineAST = PipeStep[];
