import type { ShutdownRemainderRecord, ShutdownRemainderSubject } from '../../src/infra/shutdown-remainder-record.js';

declare const subject: ShutdownRemainderSubject;
// @ts-expect-error decoded durable facts are immutable.
subject.source = 'another-source';

declare const record: ShutdownRemainderRecord;
// @ts-expect-error decoded durable facts are immutable.
record.instanceId = 'another-instance';
