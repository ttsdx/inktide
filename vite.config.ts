import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.INKTIDE_PORT) || 43117,
    strictPort: false,
    // The screenshot harness drives a paused page and steps it frame by frame.
    // A hot-update in the middle of that reloads the module graph and destroys
    // the execution context, so a capture run started while anyone is editing
    // fails from the second shot onwards. Capture servers set this.
    hmr: process.env.INKTIDE_NO_HMR ? false : undefined,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  // GLSL lives in .ts files as tagged template strings, so no plugin is needed.
});
