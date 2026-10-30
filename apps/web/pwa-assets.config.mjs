// Generación de los íconos de la PWA a partir del escudo SVG provisional (tarea 4.2).
//
//   pnpm --filter @catmetal/web generar:iconos
//
// Usa @vite-pwa/assets-generator (sharp). Los PNG resultantes se versionan en public/icons/ y el
// build NO los regenera: así el build no depende de sharp y los íconos no cambian sin querer.
// Genera: pwa-192x192.png, pwa-512x512.png, maskable-icon-512x512.png y
// apple-touch-icon-180x180.png. El fondo de los rellenos es ink-950 (#111111), igual al del SVG.
import { defineConfig } from '@vite-pwa/assets-generator/config';

const FONDO = '#111111';

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    // "any": el SVG ya trae su fondo y su margen.
    transparent: { sizes: [192, 512], padding: 0 },
    // Maskable: el contenido debe caber en el círculo central (80 %): se reduce con relleno.
    maskable: { sizes: [512], padding: 0.3, resizeOptions: { background: FONDO } },
    apple: { sizes: [180], padding: 0.15, resizeOptions: { background: FONDO } },
  },
  images: ['public/icons/escudo.svg'],
});
