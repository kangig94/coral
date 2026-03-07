export type AgentAtom = {
  kind: 'agent';
  namespace?: string;
  agent: string;
  provider?: string;
};

export type PromptAtom = {
  kind: 'prompt';
  text: string;
  provider?: string;
};

export type PipeAtom = AgentAtom | PromptAtom;

export type PipeStep = PipeAtom[];

export type PipelineAST = PipeStep[];
