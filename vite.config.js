import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works from a bucket root, a subpath, or a
  // file:// WebView inside an APK without rebuilding.
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // MapLibre is the bulk of the bundle and changes far less often than the
        // app, so it gets its own long-lived chunk.
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          if (id.includes('node_modules/pmtiles')) return 'pmtiles';
        },
      },
    },
  },
  worker: {
    // The maplibre worker entry is an ES module (it imports its shared chunk).
    format: 'es',
  },
  optimizeDeps: {
    // Keep the dep optimizer away from maplibre so the worker's relative
    // imports resolve against the real package files in dev.
    exclude: ['maplibre-gl'],
  },
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
});
