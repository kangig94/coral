import type { CurateHandle } from './curate/scheduler.js';
import type { KbRuntime } from './contract.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';

export type KnowledgeBaseRuntime = {
  kb: KbRuntime;
  readDb: ReadonlyDatabase;
  curateScheduler: CurateHandle;
};

export type KbToolRuntime = {
  storage: Pick<
    Runtime['storage'],
    | 'existsSync'
    | 'readFileSync'
    | 'readdirSync'
    | 'statSync'
    | 'mkdirSync'
    | 'writeFileSync'
    | 'renameSync'
    | 'rmSync'
    | 'unlinkSync'
  >;
  ids: Pick<Runtime['ids'], 'uuid'>;
  time: Pick<TimePort, 'now'>;
  paths: Pick<Runtime['paths'], 'projectData' | 'projectSource'>;
};
