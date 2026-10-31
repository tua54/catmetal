import { Outlet } from 'react-router';
import { ProveedorAvisos } from '../components/ui';

/**
 * Raíz de todas las rutas: el proveedor de avisos vive aquí (y no en `AppLayout`) para que un toast
 * sobreviva al paso entre el login y las pantallas con sesión (p. ej. "Sesión cerrada").
 */
export function RaizApp() {
  return (
    <ProveedorAvisos>
      <Outlet />
    </ProveedorAvisos>
  );
}
