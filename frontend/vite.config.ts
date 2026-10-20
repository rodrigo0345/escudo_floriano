import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vite';

// Dev-only proxy target for the FireTrace Coordination API. `backend/` is served behind this same
// path in production (see docker/nginx.conf); in dev we point at wherever the API actually runs.
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080';

// dev only: serves the 3D city tiles that tools/fetch_tiles3d.py saved (nginx does the same in Docker). No folder = 404 = no 3D city.
const tilesRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), 'data', 'tiles3d');
const localTiles = (): Plugin => ({
  name: 'local-tiles3d',
  configureServer(server) {
    server.middlewares.use('/tiles3d', (req, res, next) => {
      const file = resolve(tilesRoot, `.${decodeURIComponent((req.url ?? '/').split('?')[0])}`);
      if (!file.startsWith(tilesRoot) || !existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      createReadStream(file).pipe(res);
    });
  },
});

export default defineConfig({
  plugins: [react(), localTiles()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/v1': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // three.js is the bulk of the bundle and changes far less often than app code: its own chunk caches across deploys
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
