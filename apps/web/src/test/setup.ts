// Configuración común de las pruebas del frontend (jsdom).
import '@testing-library/jest-dom/vitest';
// IndexedDB en memoria para la capa de datos local (Dexie): jsdom no implementa IndexedDB.
import 'fake-indexeddb/auto';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Las rutas por rol se cargan con `lazy` y la suite completa corre ~40 archivos en paralelo con
// jsdom e IndexedDB en memoria: con el tiempo de espera por defecto de `findBy*`/`waitFor` (1 s),
// algunas pruebas fallaban de forma intermitente solo bajo carga. Se amplía a 5 s; las aserciones
// no cambian (una espera que nunca se cumple sigue fallando).
configure({ asyncUtilTimeout: 5000 });

// Sin `globals: true`, Testing Library no limpia el DOM automáticamente entre pruebas.
afterEach(() => {
  cleanup();
});
