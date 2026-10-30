// Configuración común de las pruebas del frontend (jsdom).
import '@testing-library/jest-dom/vitest';
// IndexedDB en memoria para la capa de datos local (Dexie): jsdom no implementa IndexedDB.
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Sin `globals: true`, Testing Library no limpia el DOM automáticamente entre pruebas.
afterEach(() => {
  cleanup();
});
