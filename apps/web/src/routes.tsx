import { crearRutas } from './rutas/rutas';

/**
 * Rutas de la app. `/diseno` (muestra del sistema visual) solo existe en desarrollo: en el build de
 * producción `import.meta.env.DEV` es `false`, la ruta no se registra y el `import()` se elimina.
 */
export const routes = crearRutas({
  diseno: import.meta.env.DEV ? () => import('./pages/DisenoPage') : null,
});
