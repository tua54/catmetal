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
      // Service Worker propio (src/pwa/sw/sw.ts): precache del shell, navegación offline al
      // shell (excepto /api/*) y reenvío del evento `sync` de Background Sync a las pestañas.
      // generateSW no permite atender `sync` sin inyectar un script aparte con `importScripts`.
      strategies: 'injectManifest',
      srcDir: 'src/pwa/sw',
      filename: 'sw.ts',
      // El registro lo hace la app con `virtual:pwa-register` (src/pwa/registro.ts). Nunca
      // 'inline': un script en línea rompería la CSP `script-src 'self'` (ADR 0004).
      injectRegister: false,
      registerType: 'prompt',
      // Los íconos ya entran al precache por `globPatterns`: no se agregan dos veces.
      includeManifestIcons: false,
      // Los íconos ya están versionados en public/icons (los genera `pnpm generar:iconos` con
      // pwa-assets.config.mjs); el build no los regenera (`pwaAssets` sin configurar).
      manifest: {
        id: '/',
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
        // Íconos PROVISIONALES generados desde public/icons/escudo.svg (pendiente: SVG oficial).
        icons: [
          { src: '/icons/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // Solo el shell estático. Nada de /api/*: el SW no tiene rutas de runtime para la API.
        // (El plugin agrega por su cuenta manifest.webmanifest al precache.)
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico}'],
        // El SVG de origen de los íconos no hace falta offline.
        globIgnores: ['icons/escudo.svg'],
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
    // F4-08: los .map se generan para depurar en local, pero el bundle no los referencia
    // (`hidden`: sin `//# sourceMappingURL`) y `public/.assetsignore` (copiado a la raíz de `dist`)
    // evita que Wrangler los publique como assets (ni en `wrangler deploy` ni en `wrangler dev`).
    sourcemap: 'hidden',
  },
});
