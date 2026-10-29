import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-700.css';
import './styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App } from './App';
import { createQueryClient } from './lib/query-client';
import { routes } from './routes';

const contenedor = document.getElementById('root');
if (!contenedor) {
  throw new Error('No se encontró el elemento #root en index.html');
}

const router = createBrowserRouter(routes);
const queryClient = createQueryClient();

createRoot(contenedor).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
