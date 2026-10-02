import type { EpochClosureCapability } from '#src/store/epoch/index.js';
import { retirementMintDisposition, type StoreMintDisposition } from '#src/store/epoch/index.js';

const minted: StoreMintDisposition = retirementMintDisposition('unopenable', 'epoch-key');
void minted;

// @ts-expect-error a structurally matching literal must not authorize a store mint.
const forgedMint: StoreMintDisposition = { kind: 'initial', incumbentEpochKey: null };
void forgedMint;

// @ts-expect-error a structurally matching literal must not authorize an epoch deletion.
const forgedClosure: EpochClosureCapability = { epochKey: 'epoch-key', executionDischarge: 'certified' };
void forgedClosure;
