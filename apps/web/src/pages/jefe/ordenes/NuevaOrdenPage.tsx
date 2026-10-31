import { Link, useNavigate } from 'react-router';
import { useSesion } from '../../../auth';
import { Aviso, useAvisos } from '../../../components/ui';
import { FormularioOrden } from '../../../features/ordenes/FormularioOrden';

/** `/jefe/ordenes/nueva`: crear una orden con sus materiales planeados (`POST /orders`). */
export function NuevaOrdenPage() {
  const navegar = useNavigate();
  const avisos = useAvisos();
  const enLinea = useSesion((s) => s.modo === 'online');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/jefe/ordenes"
          className="inline-flex min-h-11 items-center font-semibold text-brand-600 underline underline-offset-4"
        >
          ← Órdenes de producción
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-ink-950">Nueva orden de producción</h1>
      </div>
      {!enLinea && (
        <Aviso tono="advertencia" titulo="Sin conexión">
          Crear una orden requiere conexión con el servidor.
        </Aviso>
      )}
      <FormularioOrden
        alCrear={(id) => {
          avisos.mostrar({ tono: 'exito', titulo: 'Orden creada', mensaje: 'Quedó planeada.' });
          void navegar(`/jefe/ordenes/${id}`, { replace: true });
        }}
        alCancelar={() => void navegar('/jefe/ordenes')}
      />
    </div>
  );
}
