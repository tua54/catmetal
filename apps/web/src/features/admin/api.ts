// Llamadas REST de administración (tarea 5.3). Contrato: apps/worker/src/rutas/{usuarios,
// materiales,settings,ordenes}.ts y los tipos de @catmetal/shared. La administración trabaja SIEMPRE
// contra el servidor (no hay copia local ni outbox): sin conexión, la pantalla lo explica.

import {
  LIMITE_PAGINA_MAXIMO,
  type CrearMaterial,
  type CrearUsuario,
  type Configuracion,
  type DetalleOrden,
  type EditarMaterial,
  type EditarUsuario,
  type EstadoOrden,
  type ListaMateriales,
  type ListaOrdenes,
  type ListaUsuarios,
  type Material,
  type Orden,
  type SupervisoresDeOrden,
  type Usuario,
} from '@catmetal/shared';
import { clienteApi, type ClienteApi } from '../../auth';

/** Tope de páginas al recorrer un listado completo (evita un bucle infinito ante un cursor roto). */
const MAX_PAGINAS = 50;

/** Filtro de la lista de materiales: todos, solo activos o solo inactivos. */
export type FiltroActivo = 'todos' | 'activos' | 'inactivos';

function consulta(parametros: Record<string, string | undefined>): string {
  const busqueda = new URLSearchParams();
  for (const [clave, valor] of Object.entries(parametros)) {
    if (valor !== undefined) {
      busqueda.set(clave, valor);
    }
  }
  const texto = busqueda.toString();
  return texto === '' ? '' : `?${texto}`;
}

/** Recorre todas las páginas de un listado por cursor. */
async function todasLasPaginas<T>(
  pedir: (cursor: string | undefined) => Promise<{ elementos: T[]; siguiente: string | null }>,
): Promise<T[]> {
  const todos: T[] = [];
  let cursor: string | undefined;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const { elementos, siguiente } = await pedir(cursor);
    todos.push(...elementos);
    if (siguiente === null) {
      break;
    }
    cursor = siguiente;
  }
  return todos;
}

/** API de administración sobre un `ClienteApi` (por defecto, el de la sesión de la PWA). */
export function crearApiAdmin(api: ClienteApi = clienteApi) {
  function listarUsuarios(cursor?: string, limite?: number): Promise<ListaUsuarios> {
    return api.peticion<ListaUsuarios>(
      `/users${consulta({ cursor, limite: limite === undefined ? undefined : String(limite) })}`,
    );
  }

  return {
    listarUsuarios,

    crearUsuario(datos: CrearUsuario): Promise<Usuario> {
      return api.peticion<Usuario>('/users', { metodo: 'POST', cuerpo: datos });
    },

    editarUsuario(id: string, datos: EditarUsuario): Promise<Usuario> {
      return api.peticion<Usuario>(`/users/${encodeURIComponent(id)}`, {
        metodo: 'PATCH',
        cuerpo: datos,
      });
    },

    /** Supervisores activos (todas las páginas de `GET /users`, filtradas en el cliente). */
    async supervisoresActivos(): Promise<Usuario[]> {
      const usuarios = await todasLasPaginas(async (cursor) => {
        const pagina = await listarUsuarios(cursor, LIMITE_PAGINA_MAXIMO);
        return { elementos: pagina.usuarios, siguiente: pagina.siguiente_cursor };
      });
      return usuarios
        .filter((u) => u.rol === 'supervisor' && u.activo)
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es-CO'));
    },

    listarMateriales(filtro: FiltroActivo, cursor?: string): Promise<ListaMateriales> {
      const activo = filtro === 'todos' ? undefined : filtro === 'activos' ? 'true' : 'false';
      return api.peticion<ListaMateriales>(`/materials${consulta({ activo, cursor })}`);
    },

    crearMaterial(datos: CrearMaterial): Promise<Material> {
      return api.peticion<Material>('/materials', { metodo: 'POST', cuerpo: datos });
    },

    editarMaterial(id: string, datos: EditarMaterial): Promise<Material> {
      return api.peticion<Material>(`/materials/${encodeURIComponent(id)}`, {
        metodo: 'PATCH',
        cuerpo: datos,
      });
    },

    leerConfiguracion(): Promise<Configuracion> {
      return api.peticion<Configuracion>('/settings');
    },

    cambiarTolerancia(toleranciaPct: number): Promise<Configuracion> {
      return api.peticion<Configuracion>('/settings/tolerancia', {
        metodo: 'PATCH',
        cuerpo: { tolerancia_pct: toleranciaPct },
      });
    },

    /** Órdenes en los estados pedidos (todas las páginas de `GET /orders?estado=`). */
    async ordenesEn(estados: readonly EstadoOrden[]): Promise<Orden[]> {
      const listas = await Promise.all(
        estados.map((estado) =>
          todasLasPaginas(async (cursor) => {
            const pagina = await api.peticion<ListaOrdenes>(
              `/orders${consulta({ estado, cursor, limite: String(LIMITE_PAGINA_MAXIMO) })}`,
            );
            return { elementos: pagina.ordenes, siguiente: pagina.siguiente_cursor };
          }),
        ),
      );
      return listas.flat().sort((a, b) => a.codigo.localeCompare(b.codigo, 'es-CO'));
    },

    detalleOrden(id: string): Promise<DetalleOrden> {
      return api.peticion<DetalleOrden>(`/orders/${encodeURIComponent(id)}`);
    },

    reemplazarSupervisores(id: string, supervisores: string[]): Promise<SupervisoresDeOrden> {
      return api.peticion<SupervisoresDeOrden>(`/orders/${encodeURIComponent(id)}/supervisors`, {
        metodo: 'PUT',
        cuerpo: { supervisores },
      });
    },
  };
}

export type ApiAdmin = ReturnType<typeof crearApiAdmin>;

/** Instancia de la app (usa `clienteApi`, con el token de la sesión y el refresh automático). */
export const apiAdmin: ApiAdmin = crearApiAdmin();

/** Claves de TanStack Query de la administración. */
export const CLAVES_ADMIN = {
  todo: ['admin'] as const,
  usuarios: ['admin', 'usuarios'] as const,
  supervisores: ['admin', 'supervisores'] as const,
  materiales: (filtro: FiltroActivo) => ['admin', 'materiales', filtro] as const,
  materialesTodos: ['admin', 'materiales'] as const,
  configuracion: ['admin', 'configuracion'] as const,
  ordenes: ['admin', 'ordenes'] as const,
  orden: (id: string) => ['admin', 'orden', id] as const,
};
