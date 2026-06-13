import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// In dev the SPA runs on Vite's own port; API + auth endpoints are proxied to
// the Express server (default :3000). GET requests to /invite and
// /reset-password are *page* routes the SPA must render, so we only proxy their
// non-GET (form POST) traffic and let Vite's SPA fallback serve the page on GET.
const SERVER = process.env.AUTH_SERVER_ORIGIN ?? 'http://localhost:3000';

const onlyNonGet = (req: { method?: string; url?: string }) =>
  req.method === 'GET' ? req.url : undefined;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: 'dist',
    // Avoid Vite's inlined module-preload polyfill script, which would need a
    // CSP exception. Entry modules are external files served from our origin.
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/admin/api': SERVER,
      '/admin/github/callback': SERVER,
      '/login': SERVER,
      '/token': SERVER,
      '/refresh': SERVER,
      '/logout': SERVER,
      '/health': SERVER,
      '/.well-known': SERVER,
      '/invite': { target: SERVER, bypass: onlyNonGet },
      '/reset-password': { target: SERVER, bypass: onlyNonGet },
    },
  },
});
