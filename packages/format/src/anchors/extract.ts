// Symbol extraction with three-tier degradation (format-spec §5.1, decision 51):
//   1. symbol — nearest named container (function/method/class/const; for YAML, the key path)
//   2. block  — language parses but yields no named symbols → top-level AST blocks
//   3. file   — unknown format → whole-file hash, symbol omitted (UI marks `file-anchored`)
// The scanner must prefer the narrowest available tier.
import type { Anchor } from '../schema.js';
import { languageForFile, parseTree, type TsNode } from './engine.js';
import { docHash, fileHash, structuralHash } from './hash.js';
import { extractYamlSymbols } from './extract-yaml.js';
import type { AnchorTier, ExtractedSymbol } from './types.js';

export type { AnchorTier, ExtractedSymbol } from './types.js';

const oneBased = (node: TsNode): [number, number] => [
  node.startPosition.row + 1,
  node.endPosition.row + 1,
];

function toSymbol(node: TsNode, tier: AnchorTier, name?: string): ExtractedSymbol {
  const dh = docHash(node);
  return {
    ...(name !== undefined ? { symbol: name } : {}),
    tier,
    span: oneBased(node),
    hash: structuralHash(node),
    ...(dh !== undefined ? { dochash: dh } : {}),
  };
}

// ── TS / JS ────────────────────────────────────────────────────────────────
// Definition node types whose nearest named ancestor forms the symbol FQN.
const TSJS_DEFS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'method_definition',
  'public_field_definition',
]);

function tsjsName(node: TsNode): string | undefined {
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;
  // const foo = () => …  /  const foo = function () {}
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const decl = node.namedChildren.find((c) => c.type === 'variable_declarator');
    return decl?.childForFieldName('name')?.text;
  }
  return undefined;
}

function isTsjsValueDecl(node: TsNode): boolean {
  if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') return false;
  const decl = node.namedChildren.find((c) => c.type === 'variable_declarator');
  const value = decl?.childForFieldName('value');
  return value?.type === 'arrow_function' || value?.type === 'function_expression';
}

function extractTsjs(root: TsNode): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const walk = (node: TsNode, prefix: string): void => {
    const isDef = TSJS_DEFS.has(node.type) || isTsjsValueDecl(node);
    let childPrefix = prefix;
    if (isDef) {
      const name = tsjsName(node);
      if (name) {
        const fqn = prefix ? `${prefix}.${name}` : name;
        out.push(toSymbol(node, 'symbol', fqn));
        // methods/fields are nested under their class name
        if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
          childPrefix = fqn;
        }
      }
    }
    for (const child of node.namedChildren) walk(child, childPrefix);
  };
  walk(root, '');
  return out;
}

// ── Python ───────────────────────────────────────────────────────────────
const PY_DEFS = new Set(['function_definition', 'class_definition']);

function extractPython(root: TsNode): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const walk = (node: TsNode, prefix: string): void => {
    let childPrefix = prefix;
    const target = node.type === 'decorated_definition' ? node.namedChildren.at(-1) : node;
    if (target && PY_DEFS.has(target.type)) {
      const name = target.childForFieldName('name')?.text;
      if (name) {
        const fqn = prefix ? `${prefix}.${name}` : name;
        // hash the decorated_definition when present so decorators count as part of the symbol
        out.push(toSymbol(node, 'symbol', fqn));
        if (target.type === 'class_definition') childPrefix = fqn;
      }
    }
    for (const child of node.namedChildren) walk(child, childPrefix);
  };
  walk(root, '');
  return out;
}

const EXTRACTORS: Record<string, (root: TsNode) => ExtractedSymbol[]> = {
  typescript: extractTsjs,
  tsx: extractTsjs,
  javascript: extractTsjs,
  python: extractPython,
};

const fileTier = (source: string): ExtractedSymbol[] => [
  { tier: 'file', span: [1, Math.max(1, source.split('\n').length)], hash: fileHash(source) },
];

/**
 * Extract anchor units from a source file, preferring the narrowest tier. Falls back to a
 * top-level block tier if a parseable file yields no named symbols, and to a whole-file hash
 * for unknown formats.
 */
export async function extractSymbols(path: string, source: string): Promise<ExtractedSymbol[]> {
  const lang = languageForFile(path);
  if (lang === 'yaml') {
    const symbols = extractYamlSymbols(source);
    return symbols.length > 0 ? symbols : fileTier(source);
  }
  if (!lang || !EXTRACTORS[lang]) return fileTier(source);
  const tree = await parseTree(lang, source);
  const symbols = EXTRACTORS[lang](tree.rootNode);
  if (symbols.length > 0) return symbols;
  // block tier: top-level named blocks of a parseable-but-symbol-less file
  const blocks = tree.rootNode.namedChildren
    .filter((c) => !c.type.includes('comment'))
    .map((c) => toSymbol(c, 'block'));
  return blocks.length > 0 ? blocks : fileTier(source);
}

/** Find one symbol by its FQN in a source file (used to re-anchor after edits). */
export async function findSymbol(
  path: string,
  source: string,
  symbol: string,
): Promise<ExtractedSymbol | undefined> {
  const symbols = await extractSymbols(path, source);
  return symbols.find((s) => s.symbol === symbol);
}

/** Compute the on-disk {@link Anchor} for a symbol in a file, or the file-tier anchor if absent. */
export async function anchorFor(
  path: string,
  source: string,
  symbol?: string,
): Promise<Anchor | undefined> {
  const symbols = await extractSymbols(path, source);
  const chosen = symbol ? symbols.find((s) => s.symbol === symbol) : symbols[0];
  if (!chosen) return undefined;
  return {
    file: path,
    ...(chosen.symbol !== undefined ? { symbol: chosen.symbol } : {}),
    span: chosen.span,
    hash: chosen.hash,
    ...(chosen.dochash !== undefined ? { dochash: chosen.dochash } : {}),
  };
}
