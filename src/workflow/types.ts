import type { SessionProvider } from '../runner/types.js';

export type PipeAtom = {
  namespace?: string;
  agent: string;
  provider?: SessionProvider;
};

export type PipeStep = PipeAtom[];

export type PipelineAST = PipeStep[];
