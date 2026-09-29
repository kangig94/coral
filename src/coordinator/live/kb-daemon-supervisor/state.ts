import type { Runtime } from '../../../runtime/ports.js';
import type { ResolvedStoreEpoch } from '../../../store/epoch.js';
import type { SerializedCoralSetupError } from '../../../runtime/errors.js';
import type { KbDaemonWireTypes } from '../kb-daemon-supervisor.js';
type KbDaemonKbReadHealth = KbDaemonWireTypes['readHealth'];
type KbDaemonResponseMessage = KbDaemonWireTypes['responseMessage'];
import type {
  DaemonProcessLike,
  KbDaemonExit,
  KbDaemonHealthSnapshot,
  KbDaemonPhase,
} from '../kb-daemon-supervisor.js';

type PendingRequest = {
  generation: number;
  timeout: ReturnType<Runtime['time']['setTimeout']>;
  resolve: (response: KbDaemonResponseMessage) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

export type KbDaemonSupervisorState = {
  phase: KbDaemonPhase;
  generation: number;
  daemonProcess: DaemonProcessLike | null;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  lastExit: KbDaemonExit | undefined;
  lastError: string | undefined;
  lastSetupError: SerializedCoralSetupError | undefined;
  operation: Promise<unknown> | null;
  probeOperation: Promise<KbDaemonHealthSnapshot> | null;
  stderrBuffer: string;
  lastStderrLine: string | null;
  repeatedStderrLines: number;
  nextRequestId: number;
  pendingRequests: Map<string, PendingRequest>;
  activeParentRequests: Map<string, { generation: number; controller: AbortController }>;
  lastHeartbeatAt: number | undefined;
  lastHeartbeatLatencyMs: number | undefined;
  daemonUptimeMs: number | undefined;
  kbReadHealth: KbDaemonKbReadHealth | undefined;
  kbWriteHealth: KbDaemonKbReadHealth | undefined;
  requestRecoveryEnabled: boolean;
  disposed: boolean;
  openedStore: ResolvedStoreEpoch | undefined;
  exitListeners: Set<(snapshot: KbDaemonHealthSnapshot) => void>;
};

export function createKbDaemonSupervisorState(): KbDaemonSupervisorState {
  return {
    phase: 'stopped',
    generation: 0,
    daemonProcess: null,
    pid: null,
    startedAt: null,
    readyAt: null,
    lastExit: undefined,
    lastError: undefined,
    lastSetupError: undefined,
    operation: null,
    probeOperation: null,
    stderrBuffer: '',
    lastStderrLine: null,
    repeatedStderrLines: 0,
    nextRequestId: 1,
    pendingRequests: new Map<string, PendingRequest>(),
    activeParentRequests: new Map<string, { generation: number; controller: AbortController }>(),
    lastHeartbeatAt: undefined,
    lastHeartbeatLatencyMs: undefined,
    daemonUptimeMs: undefined,
    kbReadHealth: undefined,
    kbWriteHealth: undefined,
    requestRecoveryEnabled: true,
    disposed: false,
    openedStore: undefined,
    exitListeners: new Set<(snapshot: KbDaemonHealthSnapshot) => void>(),
  };
}
