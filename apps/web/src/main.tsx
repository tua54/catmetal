import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-700.css';
import './styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { arrancar, obtenerSincronizacion } from './app/arranque';
import { createQueryClient } from './lib/query-client';
import { registrarServiceWorker } from './pwa/registro';
import { routes } from './routes';

const contenedor = document.getElementById('root');
if (!contenedor) {
  throw new Error('No se encontró el elemento #root en index.html');
}

const queryClient = createQueryClient();

// Una sola vez por pestaña, fuera de React (StrictMode monta dos veces los efectos en desarrollo).
const sincronizacion = obtenerSincronizacion();
void arrancar({
  // F6-04: la caché de consultas se vacía cada vez que cambia el usuario de la sesión.
  cacheConsultas: queryClient,
  // En desarrollo no se registra el SW: no debe cachear builds intermedios.
  registrarServiceWorker: import.meta.env.PROD
    ? () => registrarServiceWorker(registerSW)
    : undefined,
});

const router = createBrowserRouter(routes);

createRoot(contenedor).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} sincronizacion={sincronizacion} />
  </StrictMode>,
);
