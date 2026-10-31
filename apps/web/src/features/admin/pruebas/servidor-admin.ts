// Servidor simulado de las rutas de administración para las pruebas de la PWA (solo la red se
// simula). Reproduce el contrato de apps/worker/src/rutas/{usuarios,materiales,settings,ordenes}.ts:
// validación con los mismos esquemas de @catmetal/shared (400 `VALIDACION` con `[{ campo, mensaje }]`),
// paginación por cursor sobre el id, 409 `CONFLICTO` por correo o código repetido, 422
// `ULTIMO_ADMIN` y la lista resultante de `PUT /orders/:id/supervisors`. La autenticación la
// atiende el servidor falso de auth (`crearServidorFalso`).

import {
  asignarSupervisoresSchema,
  crearError,
  crearMaterialSchema,
  crearUsuarioSchema,
  detallesValidacion,
  editarMaterialSchema,
  editarUsuarioSchema,
  ESTADO_HTTP_POR_CODIGO,
  toleranciaSchema,
  uuidv7,
  type CodigoError,
  type DetalleOrden,
  type ListaMateriales,
  type ListaOrdenes,
  type ListaUsuarios,
  type Material,
  type Orden,
  type Rol,
  type SupervisorAsignado,
  type Unidad,
  type Usuario,
} from '@catmetal/shared';
import type { ZodError } from 'zod';
import type { ServidorFalso } from '../../../auth/pruebas/servidor-falso';

export interface PeticionAdmin {
  metodo: string;
  ruta: string;
  query: URLSearchParams;
  cuerpo: unknown;
}

const AHORA = '2026-10-29T15:00:00.000Z';

export interface ServidorAdmin {
  fetch: typeof fetch;
  peticiones: PeticionAdmin[];
  usuarios: Map<string, Usuario>;
  materiales: Map<string, Material>;
  ordenes: Map<string, Orden>;
  /** Asignaciones activas por orden. */
  asignaciones: Map<string, SupervisorAsignado[]>;
  tolerancia: number;
  /** `caido`: las rutas de admin lanzan TypeError (sin conexión). */
  modo: 'normal' | 'caido';
  /** El próximo PATCH/PUT de admin responde este error (una vez). */
  forzarError: CodigoError | null;
  agregarUsuario(datos: Partial<Usuario> & { nombre: string; rol: Rol }): Usuario;
  agregarMaterial(
    datos: Partial<Material> & { codigo: string; nombre: string; unidad: Unidad },
  ): Material;
  agregarOrden(datos: Partial<Orden> & { codigo: string }): Orden;
  asignar(orderId: string, userId: string): void;
  peticionesA(metodo: string, ruta: string): PeticionAdmin[];
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(code: CodigoError, details?: unknown): Response {
  return json(crearError(code, details), ESTADO_HTTP_POR_CODIGO[code]);
}

function validacion(errorZod: ZodError): Response {
  return error('VALIDACION', detallesValidacion(errorZod));
}

function urlDe(entrada: RequestInfo | URL): string {
  return typeof entrada === 'string'
    ? entrada
    : entrada instanceof URL
      ? entrada.href
      : entrada.url;
}

/** Página por cursor sobre el id (como el Worker: `id > cursor ORDER BY id LIMIT n`). */
function paginar<T extends { id: string }>(
  filas: T[],
  query: URLSearchParams,
): { pagina: T[]; siguiente_cursor: string | null } {
  const limite = Number(query.get('limite') ?? '50');
  const cursor = query.get('cursor') ?? '';
  const ordenadas = filas.filter((f) => f.id > cursor).sort((a, b) => a.id.localeCompare(b.id));
  const pagina = ordenadas.slice(0, limite);
  return {
    pagina,
    siguiente_cursor: ordenadas.length > limite ? (pagina.at(-1)?.id ?? null) : null,
  };
}

export function crearServidorAdmin(auth: ServidorFalso): ServidorAdmin {
  const servidor: ServidorAdmin = {
    peticiones: [],
    usuarios: new Map(),
    materiales: new Map(),
    ordenes: new Map(),
    asignaciones: new Map(),
    tolerancia: 5,
    modo: 'normal',
    forzarError: null,

    agregarUsuario(datos) {
      const usuario: Usuario = {
        id: uuidv7(),
        email: `${datos.nombre.toLowerCase().replace(/\s+/g, '.')}@catmetal.test`,
        activo: true,
        intentos_fallidos: 0,
        bloqueado_hasta: null,
        created_at: AHORA,
        updated_at: AHORA,
        ...datos,
      };
      servidor.usuarios.set(usuario.id, usuario);
      return usuario;
    },

    agregarMaterial(datos) {
      const material: Material = {
        id: uuidv7(),
        costo_unitario_cop: 1000,
        activo: true,
        created_at: AHORA,
        updated_at: AHORA,
        ...datos,
      };
      servidor.materiales.set(material.id, material);
      return material;
    },

    agregarOrden(datos) {
      const orden: Orden = {
        id: uuidv7(),
        linea: 'Moldeo 1',
        estado: 'en_proceso',
        fecha_inicio: AHORA,
        fecha_fin: null,
        creada_por: uuidv7(),
        created_at: AHORA,
        updated_at: AHORA,
        ...datos,
      };
      servidor.ordenes.set(orden.id, orden);
      return orden;
    },

    asignar(orderId, userId) {
      const usuario = servidor.usuarios.get(userId);
      const lista = servidor.asignaciones.get(orderId) ?? [];
      lista.push({
        user_id: userId,
        nombre: usuario?.nombre ?? '',
        asignado_por: uuidv7(),
        created_at: AHORA,
        updated_at: AHORA,
      });
      servidor.asignaciones.set(orderId, lista);
    },

    peticionesA: (metodo, ruta) =>
      servidor.peticiones.filter((p) => p.metodo === metodo && p.ruta === ruta),

    fetch: async (entrada, init) => {
      const url = new URL(urlDe(entrada), 'http://localhost');
      if (url.pathname.startsWith('/api/v1/auth/')) {
        return auth.fetch(entrada, init);
      }
      const metodo = init?.method ?? 'GET';
      const cuerpo: unknown =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const ruta = url.pathname.replace(/^\/api\/v1/, '');
      servidor.peticiones.push({ metodo, ruta, query: url.searchParams, cuerpo });
      if (servidor.modo === 'caido') {
        throw new TypeError('Failed to fetch');
      }
      if (!new Headers(init?.headers).get('Authorization')?.startsWith('Bearer ')) {
        return error('NO_AUTENTICADO');
      }
      if (metodo !== 'GET' && servidor.forzarError !== null) {
        const code = servidor.forzarError;
        servidor.forzarError = null;
        return error(code);
      }
      return atender(servidor, metodo, ruta, url.searchParams, cuerpo);
    },
  };
  return servidor;
}

function atender(
  s: ServidorAdmin,
  metodo: string,
  ruta: string,
  query: URLSearchParams,
  cuerpo: unknown,
): Response {
  const partes = ruta.split('/').filter(Boolean);
  const [recurso, id, sub] = partes;

  if (recurso === 'users') {
    if (metodo === 'GET' && id === undefined) {
      const { pagina, siguiente_cursor } = paginar([...s.usuarios.values()], query);
      return json({ usuarios: pagina, siguiente_cursor } satisfies ListaUsuarios);
    }
    if (metodo === 'POST' && id === undefined) {
      const datos = crearUsuarioSchema.safeParse(cuerpo);
      if (!datos.success) {
        return validacion(datos.error);
      }
      if ([...s.usuarios.values()].some((u) => u.email === datos.data.email)) {
        return error('CONFLICTO', { campo: 'email' });
      }
      const { nombre, email, rol } = datos.data;
      return json(s.agregarUsuario({ nombre, email, rol }), 201);
    }
    if (metodo === 'PATCH' && id !== undefined) {
      const actual = s.usuarios.get(id);
      if (actual === undefined) {
        return error('NO_ENCONTRADO');
      }
      const datos = editarUsuarioSchema.safeParse(cuerpo);
      if (!datos.success) {
        return validacion(datos.error);
      }
      const nuevo: Usuario = {
        ...actual,
        nombre: datos.data.nombre ?? actual.nombre,
        rol: datos.data.rol ?? actual.rol,
        activo: datos.data.activo ?? actual.activo,
        intentos_fallidos: datos.data.desbloquear ? 0 : actual.intentos_fallidos,
        bloqueado_hasta: datos.data.desbloquear ? null : actual.bloqueado_hasta,
        updated_at: new Date().toISOString(),
      };
      const quitaAdmin =
        actual.rol === 'admin' && actual.activo && (nuevo.rol !== 'admin' || !nuevo.activo);
      const otrosAdmins = [...s.usuarios.values()].filter(
        (u) => u.id !== id && u.rol === 'admin' && u.activo,
      );
      if (quitaAdmin && otrosAdmins.length === 0) {
        return error('ULTIMO_ADMIN');
      }
      s.usuarios.set(id, nuevo);
      return json(nuevo);
    }
  }

  if (recurso === 'materials') {
    if (metodo === 'GET' && id === undefined) {
      const activo = query.get('activo');
      const filas = [...s.materiales.values()].filter(
        (m) => activo === null || m.activo === (activo === 'true'),
      );
      const { pagina, siguiente_cursor } = paginar(filas, query);
      return json({ materiales: pagina, siguiente_cursor } satisfies ListaMateriales);
    }
    if (metodo === 'POST' && id === undefined) {
      const datos = crearMaterialSchema.safeParse(cuerpo);
      if (!datos.success) {
        return validacion(datos.error);
      }
      if ([...s.materiales.values()].some((m) => m.codigo === datos.data.codigo)) {
        return error('CONFLICTO', { entidad: 'materials', campos: ['codigo'] });
      }
      return json(s.agregarMaterial(datos.data), 201);
    }
    if (metodo === 'PATCH' && id !== undefined) {
      const actual = s.materiales.get(id);
      if (actual === undefined) {
        return error('NO_ENCONTRADO');
      }
      const datos = editarMaterialSchema.safeParse(cuerpo);
      if (!datos.success) {
        return validacion(datos.error);
      }
      const nuevo: Material = { ...actual, ...datos.data, updated_at: new Date().toISOString() };
      s.materiales.set(id, nuevo);
      return json(nuevo);
    }
  }

  if (recurso === 'settings') {
    if (metodo === 'GET' && id === undefined) {
      return json({ tolerancia_pct: s.tolerancia });
    }
    if (metodo === 'PATCH' && id === 'tolerancia') {
      const datos = toleranciaSchema.safeParse(cuerpo);
      if (!datos.success) {
        return validacion(datos.error);
      }
      s.tolerancia = datos.data.tolerancia_pct;
      return json({ tolerancia_pct: s.tolerancia });
    }
  }

  if (recurso === 'orders') {
    if (metodo === 'GET' && id === undefined) {
      const estado = query.get('estado');
      const filas = [...s.ordenes.values()].filter((o) => estado === null || o.estado === estado);
      const { pagina, siguiente_cursor } = paginar(filas, query);
      return json({ ordenes: pagina, siguiente_cursor } satisfies ListaOrdenes);
    }
    const orden = id === undefined ? undefined : s.ordenes.get(id);
    if (id !== undefined && orden === undefined) {
      return error('NO_ENCONTRADO');
    }
    if (metodo === 'GET' && orden !== undefined && sub === undefined) {
      const detalle: DetalleOrden = {
        ...orden,
        tolerancia_pct: s.tolerancia,
        materiales: [],
        materiales_fuera_de_plan: [],
        supervisores: s.asignaciones.get(orden.id) ?? [],
      };
      return json(detalle);
    }
    if (metodo === 'PUT' && orden !== undefined && sub === 'supervisors') {
      const datos = asignarSupervisoresSchema.safeParse(cuerpo);
      if (!datos.success) {
        return validacion(datos.error);
      }
      const invalidos = datos.data.supervisores.flatMap((userId, i) => {
        const u = s.usuarios.get(userId);
        return u === undefined || u.rol !== 'supervisor' || !u.activo
          ? [{ campo: `supervisores.${i}`, mensaje: 'El usuario no es un supervisor activo.' }]
          : [];
      });
      if (invalidos.length > 0) {
        return error('VALIDACION', invalidos);
      }
      const previas = new Map((s.asignaciones.get(orden.id) ?? []).map((a) => [a.user_id, a]));
      const lista = datos.data.supervisores.map(
        (userId) =>
          previas.get(userId) ?? {
            user_id: userId,
            nombre: s.usuarios.get(userId)?.nombre ?? '',
            asignado_por: uuidv7(),
            created_at: AHORA,
            updated_at: AHORA,
          },
      );
      s.asignaciones.set(orden.id, lista);
      return json({ order_id: orden.id, supervisores: lista });
    }
  }

  return error('NO_ENCONTRADO');
}
