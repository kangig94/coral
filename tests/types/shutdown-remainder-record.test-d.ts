import type { ShutdownRemainderRecord } from '../../src/infra/shutdown-remainder-record.js';
import type { ShutdownRemainderSubject } from '../../src/infra/shutdown-contract.js';

declare const subject: ShutdownRemainderSubject;
// @ts-expect-error decoded durable facts are immutable.
subject.source = 'another-source';

declare const record: ShutdownRemainderRecord;
// @ts-expect-error decoded durable facts are immutable.
record.instanceId = 'another-instance';
