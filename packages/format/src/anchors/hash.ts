// Structural and doc hashes (format-spec §5.2, §5.4). The structural hash is the cheap, LLM-free
// drift signal: formatting and comments don't change it, logic does. Comments feed `dochash`
// separately, so they inform understanding without ever costing a sync call.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { TsNode } from './engine.js';

const encoder = new TextEncoder();

/** `blake3(input)[:16]` as `blake3:<16 hex>` — the on-disk hash form. */
export function blake3Hash(input: string): string {
  return `blake3:${bytesToHex(blake3(encoder.encode(input))).slice(0, 16)}`;
}

/** Comment nodes exist in every tree-sitter grammar; we detect them structurally by type name. */
function isComment(type: string): boolean {
  return type.includes('comment');
}

/**
 * A deterministic, whitespace-free serialization of a subtree, skipping comment nodes. Leaf
 * tokens contribute their literal text (identifiers are NOT normalized — a rename is a real
 * change). Reformatting the code leaves this string untouched; changing logic does not.
 */
export function structuralString(node: TsNode): string {
  const parts: string[] = [];
  const walk = (n: TsNode): void => {
    if (isComment(n.type)) return;
    if (n.childCount === 0) {
      parts.push(`${n.type}:${n.text}`);
      return;
    }
    parts.push(`(${n.type}`);
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
    parts.push(')');
  };
  walk(node);
  return parts.join(' ');
}

/** Structural hash of an AST node (format-spec §5.2). */
export function structuralHash(node: TsNode): string {
  return blake3Hash(structuralString(node));
}

/** File-anchor hash: whole file, normalizing only line endings (format-spec §5.2 tier 3). */
export function fileHash(source: string): string {
  return blake3Hash(source.replace(/\r\n/g, '\n'));
}

/** All comment texts inside a subtree, in document order. */
export function collectComments(node: TsNode): string[] {
  const out: string[] = [];
  const walk = (n: TsNode): void => {
    if (isComment(n.type)) {
      out.push(n.text);
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  };
  walk(node);
  return out;
}

/** Doc hash of the comments inside a symbol (format-spec §5.4); undefined when there are none. */
export function docHash(node: TsNode): string | undefined {
  const comments = collectComments(node);
  if (comments.length === 0) return undefined;
  return blake3Hash(comments.join('\n'));
}
