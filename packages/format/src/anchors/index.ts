// Anchors: extraction + hashing (format-spec §5). Public surface of the anchors subsystem.
export { languageForFile, parseTree, loadLanguage, type TsNode, type TsTree } from './engine.js';
export {
  blake3Hash,
  structuralHash,
  structuralString,
  fileHash,
  docHash,
  collectComments,
} from './hash.js';
export {
  extractSymbols,
  findSymbol,
  anchorFor,
  type ExtractedSymbol,
  type AnchorTier,
} from './extract.js';
