// tree-sitter runtime: one WASM core, grammars loaded on demand by language id and cached.
// WASM (not native bindings) so packages/format builds and runs on any OS with no node-gyp step
// (M5 is Windows-first). Grammars ship prebuilt in tree-sitter-wasms; web-tree-sitter is pinned
// to the matching grammar ABI (0.24.x).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);

/** A tree-sitter syntax node (aliased so the rest of the package doesn't couple to the ws typings). */
export type TsNode = Parser.SyntaxNode;
export type TsTree = Parser.Tree;
type TsLanguage = Parser.Language;

/** Grammar id → prebuilt wasm module specifier. */
const WASM_BY_LANG: Record<string, string> = {
  typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
  python: 'tree-sitter-wasms/out/tree-sitter-python.wasm',
  // NB: YAML anchoring goes through the `yaml` package (see extract-yaml.ts), not tree-sitter —
  // the prebuilt yaml grammar's external scanner is incompatible with the pinned runtime.
};

/** File extension → grammar id. */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

/** The grammar id for a file path, or null when no grammar is available (→ file-tier anchor). */
export function languageForFile(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  return LANG_BY_EXT[ext] ?? null;
}

let initPromise: Promise<void> | null = null;
const langCache = new Map<string, TsLanguage>();
const parserCache = new Map<string, Parser>();

function ensureInit(): Promise<void> {
  if (!initPromise) {
    const coreWasm = require.resolve('web-tree-sitter/tree-sitter.wasm');
    initPromise = Parser.init({ locateFile: () => coreWasm });
  }
  return initPromise;
}

/** Load (and cache) a grammar by id. */
export async function loadLanguage(lang: string): Promise<TsLanguage> {
  await ensureInit();
  const cached = langCache.get(lang);
  if (cached) return cached;
  const wasmSpecifier = WASM_BY_LANG[lang];
  if (!wasmSpecifier) throw new Error(`No tree-sitter grammar registered for "${lang}"`);
  const bytes = readFileSync(require.resolve(wasmSpecifier));
  const language = await Parser.Language.load(new Uint8Array(bytes));
  langCache.set(lang, language);
  return language;
}

/** Parse source with the given grammar into a syntax tree. */
export async function parseTree(lang: string, source: string): Promise<TsTree> {
  const language = await loadLanguage(lang);
  let parser = parserCache.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserCache.set(lang, parser);
  }
  return parser.parse(source);
}
