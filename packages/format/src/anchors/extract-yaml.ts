// YAML key-path anchors (format-spec §5.1: "for config formats the symbol is the key path").
// Uses the `yaml` CST rather than tree-sitter: the prebuilt yaml grammar's external scanner is
// incompatible with the pinned web-tree-sitter runtime, and key-path extraction is exactly what
// this format needs anyway (services.api.image). The hash is over the value node's source text.
import { isMap, isSeq, parseDocument, type Node as YamlNode, type Pair } from 'yaml';
import { blake3Hash } from './hash.js';
import type { ExtractedSymbol } from './types.js';

/** Precompute line-start offsets so a character range maps to a 1-based inclusive line span. */
function lineSpanner(source: string): (start: number, end: number) => [number, number] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return (start, end) => [lineAt(start), lineAt(Math.max(start, end - 1))];
}

function collectComment(pair: Pair, value: YamlNode | null): string | undefined {
  const parts = [pair.key, value]
    .flatMap((n) =>
      n && typeof n === 'object'
        ? [(n as { commentBefore?: string }).commentBefore, (n as { comment?: string }).comment]
        : [],
    )
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  return parts.length > 0 ? blake3Hash(parts.join('\n')) : undefined;
}

/** Extract dotted key-path symbols from a YAML document, hashing each value's source text. */
export function extractYamlSymbols(source: string): ExtractedSymbol[] {
  const norm = source.replace(/\r\n/g, '\n');
  const doc = parseDocument(norm, { keepSourceTokens: true });
  const spanOf = lineSpanner(norm);
  const out: ExtractedSymbol[] = [];

  const walk = (node: unknown, prefix: string): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const keyText = String((pair.key as { value?: unknown })?.value ?? pair.key ?? '').trim();
        if (!keyText) continue;
        const path = prefix ? `${prefix}.${keyText}` : keyText;
        const value = (pair.value as YamlNode | null) ?? null;
        const range = value?.range;
        const text = range ? norm.slice(range[0], range[1]) : '';
        const span = range ? spanOf(range[0], range[1]) : ([1, 1] as [number, number]);
        const dochash = collectComment(pair, value);
        out.push({
          symbol: path,
          tier: 'symbol',
          span,
          hash: blake3Hash(text),
          ...(dochash !== undefined ? { dochash } : {}),
        });
        walk(value, path);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item) => walk(item, prefix));
    }
  };

  walk(doc.contents, '');
  return out;
}
