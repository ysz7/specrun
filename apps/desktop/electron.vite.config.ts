import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// main externalizes node deps (they touch fs / load wasm and must not be bundled).
// preload is bundled self-contained so it needs no runtime require under contextIsolation.
// renderer is a React (Vite) build.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
