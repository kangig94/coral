const storeMintDispositionBrand: unique symbol = Symbol('StoreMintDisposition');

/** A mint is authorized only by a disposition from `retirementMintDisposition`, never by a matching literal. */
export type StoreMintDisposition = Readonly<{
  kind: 'initial' | 'retired' | 'unopenable';
  incumbentEpochKey: string | null;
  [storeMintDispositionBrand]: true;
}>;

export function retirementMintDisposition(
  kind: StoreMintDisposition['kind'],
  incumbentEpochKey: string | null,
): StoreMintDisposition {
  return { kind, incumbentEpochKey, [storeMintDispositionBrand]: true };
}
