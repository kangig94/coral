import type { CoordinatorServerController } from '../../src/coordinator/index.js';
import type { LifecycleController } from '../../src/coordinator/lifecycle.js';
import type { IdleTimer } from '../../src/coordinator/live/idle.js';
import type { ShutdownReason } from '../../src/infra/shutdown-contract.js';
import type { IpcListener } from '../../src/transport/ipc/server.js';
import type { SimulationController } from '../../tools/simulation/core/backend.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

type _LifecycleReason = Expect<Equal<Parameters<LifecycleController['shutdown']>[0], ShutdownReason>>;
type _CoordinatorReason = Expect<Equal<Parameters<CoordinatorServerController['shutdown']>[0], ShutdownReason>>;
type _SimulationReason = Expect<Equal<Parameters<SimulationController['shutdown']>[0], ShutdownReason>>;

declare const lifecycle: LifecycleController;
declare const idleTimer: IdleTimer;
declare const ipc: IpcListener;

void lifecycle.shutdown('test-teardown');
// @ts-expect-error Shutdown reasons are a closed coordinator contract.
void lifecycle.shutdown('fatal');

idleTimer.startWatching(
  () => true,
  (reason) => {
    const _reason: ShutdownReason = reason;
    void _reason;
  },
);

ipc.onShutdownRequest?.('replaced');
// @ts-expect-error IPC shutdown emits only its typed replacement reason.
ipc.onShutdownRequest?.('fatal');
