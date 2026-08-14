// packages/format — the .alethic/ format as code. One definition of the format, shared by the
// renderer (reads), the agent (writes via MCP tools), git (diffs) and humans (edit).
export const FORMAT_VERSION = 1 as const;

export * from './schema.js';
export * from './statuses.js';
export * from './ids.js';
export * from './titles.js';
export * from './sections.js';
export * from './form.js';
export * from './parse.js';
export * from './serialize.js';
export * from './anchors/index.js';
export * from './index-builder.js';
export * from './load.js';
export * from './drift.js';
export * from './validate.js';
export * from './plan-phases.js';
