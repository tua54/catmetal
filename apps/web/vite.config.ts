// Configuración de Vite para la PWA de Control de Materia Prima.
// En desarrollo, Vite (5173) sirve el frontend y reenvía /api al Worker local de `wrangler dev` (8787).
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Worker local (`wrangler dev`). Nunca apunta a un entorno remoto. */
const WORKER_LOCAL = 'http://127.0.0.1:8787';

/**
 * Proxy de /api hacia el Worker local.
 * `changeOrigin: false` conserva el Host/Origin del navegador: el Worker verifica el header Origin
 * y debe ver el origen real de la página (http://localhost:5173), no el del destino.
 */
const proxyApi = {
  '/api': {
    target: WORKER_LOCAL,
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'generateSW',
      // TODO(Fase 4): registrar el Service Worker desde la app con `virtual:pwa-register`
      // (workbox-window) y definir la estrategia de actualización. En la Fase 0 el SW se genera
      // en el build pero NO se registra, para que no cachee builds intermedios durante el desarrollo.
      injectRegister: false,
      registerType: 'prompt',
      manifest: {
        name: 'Control de Materia Prima · Catmetal',
        short_name: 'Catmetal MP',
        description: 'Registro y validación de consumos de materia prima en planta.',
        lang: 'es-CO',
        dir: 'ltr',
        theme_color: '#111111',
        background_color: '#F5F7F9',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        // TODO(Fase 4): íconos 192, 512 y maskable a partir del SVG oficial de Catmetal
        // (pendiente de que el cliente lo entregue).
        icons: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico}'],
        navigateFallback: 'index.html',
        // La API nunca se resuelve con el shell de la SPA.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // Sin runtimeCaching a propósito: el Service Worker nunca cachea respuestas de /api/*.
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: proxyApi,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: proxyApi,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
