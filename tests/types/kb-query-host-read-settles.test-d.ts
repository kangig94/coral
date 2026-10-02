import { readWithKbQueryHost } from '../../src/read-model/kb-query-runtime.js';

declare const context: Parameters<typeof readWithKbQueryHost>[0];

const settled: { entries: number } = readWithKbQueryHost(context, () => ({ entries: 1 }));

// @ts-expect-error a read that returns a promise would settle after the host's store is closed.
void readWithKbQueryHost(context, async () => ({ entries: 1 }));

void settled;
