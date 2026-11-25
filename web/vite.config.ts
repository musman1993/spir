import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/spir/"). Locally it is "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    port: 5173,
    // In Codespaces/local dev, /api is proxied to the local API so no CORS setup is needed.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
});
