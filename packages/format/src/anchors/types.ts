// Shared anchor types, in their own module so extractors can depend on them without cycling.
export type AnchorTier = 'symbol' | 'block' | 'file';

/** One extracted anchor unit: a symbol/block/file with its computed hashes and line span. */
export interface ExtractedSymbol {
  symbol?: string;
  tier: AnchorTier;
  span: [number, number]; // 1-based inclusive line range
  hash: string;
  dochash?: string;
}
