import { NavLink, Outlet } from 'react-router';
import { Aviso } from '../../components/ui';
import { cx } from '../../components/ui/clases';
import { useEnLinea } from '../../features/admin/formularios';

const SECCIONES = [
  { ruta: '/admin', texto: 'Usuarios', exacta: true },
  { ruta: '/admin/materiales', texto: 'Materiales', exacta: false },
  { ruta: '/admin/asignaciones', texto: 'Asignaciones', exacta: false },
  { ruta: '/admin/tolerancia', texto: 'Tolerancia', exacta: false },
] as const;

/**
 * Estructura de `/admin`: encabezado "Administración" y navegación entre secciones (enlaces con
 * `aria-current="page"` en la sección abierta; ≥ 44 px). Las pantallas trabajan contra el servidor.
 */
export function AdminLayout() {
  const enLinea = useEnLinea();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-ink-950">Administración</h1>
      <nav aria-label="Secciones de administración">
        <ul className="flex flex-wrap gap-2 border-b border-line-200">
          {SECCIONES.map((seccion) => (
            <li key={seccion.ruta}>
              <NavLink
                to={seccion.ruta}
                end={seccion.exacta}
                className={({ isActive }) =>
                  cx(
                    '-mb-px inline-flex min-h-12 items-center border-b-[3px] px-4 text-base font-semibold',
                    isActive
                      ? 'border-brand-600 text-brand-600'
                      : 'border-transparent text-ink-700 active:bg-surface-200',
                  )
                }
              >
                {seccion.texto}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      {!enLinea && (
        <Aviso tono="advertencia" anunciar titulo="Sin conexión con el servidor">
          Puede revisar lo que ya se cargó, pero los cambios no se pueden guardar hasta que vuelva
          la conexión.
        </Aviso>
      )}
      <Outlet />
    </div>
  );
}
