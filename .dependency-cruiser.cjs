// Guards the one axis of cleanliness (implementation-plan §8, rules 1–5):
//   renderer → packages/ipc (types) only
//   main services → packages/*
//   packages/* → nothing of ours above them, nothing Electron
// A violation fails `pnpm dep:check` and, in CI, the build.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular dependencies are forbidden — they defeat the layering.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-no-electron',
      comment: 'packages/* is the core: buildable as a plain CLI, never coupled to Electron.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '(^|/)electron($|/)' },
    },
    {
      name: 'packages-no-apps',
      comment: 'packages/* must not depend on apps/* — imports only ever point downward.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'renderer-only-ipc',
      comment:
        'The renderer knows only the typed IPC vocabulary at runtime. It may import @alethic/ipc; from other packages (e.g. @alethic/format) only type-only imports are allowed (erased at build), so FSD entities can re-export format types without pulling in schema/runtime code.',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer/' },
      to: { path: '^packages/(?!ipc/)', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'renderer-no-main',
      comment: 'The renderer must not reach into main-process code; IPC is the only boundary.',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer/' },
      to: { path: '^apps/desktop/src/main/' },
    },
    {
      name: 'main-no-renderer',
      comment: 'Main-process code must not import renderer code.',
      severity: 'error',
      from: { path: '^apps/desktop/src/main/' },
      to: { path: '^apps/desktop/src/renderer/' },
    },
  ],
  options: {
    // Keep dist as a leaf node (so a renderer→@alethic/format edge that resolves to packages/
    // format/dist is still evaluated against the rules) but don't traverse its internals.
    doNotFollow: { path: '(^|/)(node_modules|dist)/' },
    // Tests are not part of the shipped graph; they may import runtime helpers freely.
    exclude: { path: '\\.test\\.tsx?$' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
  },
};
