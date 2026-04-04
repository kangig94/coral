import type { ExecutionService } from '../execution/service.js';

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

export interface WorkflowExecutionPort {
  coralDispatch: ExecutionService['coralDispatch'];
  resume: ExecutionService['resume'];
  abort: ExecutionService['abort'];
  awaitLaunch: ExecutionService['awaitLaunch'];
  waitStream: ExecutionService['waitStream'];
  getConversationRef: ExecutionService['getConversationRef'];
  waitForJobTerminal: ExecutionService['waitForJobTerminal'];
}
