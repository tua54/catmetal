// Utilidades de las pruebas transversales de la Fase 2 (tarea 2.5 de docs/plan-fase-2.md).
//
// Contiene: sesiones por rol, el catálogo literal de rutas con la regla de la spec que fija el
// estado esperado de cada rol, el envío de peticiones al Worker real, las revisiones comunes a toda
// respuesta (formato único de error, cabeceras de seguridad, sin secretos), la foto de la base para
// comprobar que un fallo a mitad del batch no deja datos parciales y el trigger temporal que lo
// provoca. D1 y R2 son los locales reales del pool de Workers (sin mocks).
import {
  type CodigoError,
  CODIGOS_ERROR_LISTA,
  ESTADO_HTTP_POR_CODIGO,
  MENSAJES_ERROR,
  uuidv7,
} from '@catmetal/shared';
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { app } from '../src/app';
import { BASE, crearUsuarioConClave, iniciarSesion, ORIGEN } from './auth-helpers';
import {
  archivo,
  cuerpoConsumo,
  cuerpoNovedad,
  jpeg,
  novedadOk,
  subir,
} from './fase2-consumos-helpers';
import {
  asignar,
  codigoOrden,
  nuevaOrden,
  nuevoConsumo,
  nuevoMaterial,
  planear,
  sesion,
  type SesionDeRol,
} from './fase2-helpers';
import { crearUsuario } from './fixtures-db';

// ---------------------------------------------------------------------------------------------
// Actores y sesiones
// ---------------------------------------------------------------------------------------------

/**
 * `supervisor` es el supervisor ASIGNADO a la orden del escenario; `supervisor_ajeno` es otro
 * supervisor sin asignación en esa orden.
 */
export type Actor = 'sin_token' | 'supervisor' | 'supervisor_ajeno' | 'jefe' | 'admin';
export type ActorConSesion = Exclude<Actor, 'sin_token'>;

export const ACTORES: readonly Actor[] = [
  'sin_token',
  'supervisor',
  'supervisor_ajeno',
  'jefe',
  'admin',
];

export interface Mundo {
  supervisor: SesionDeRol;
  supervisorAjeno: SesionDeRol;
  jefe: SesionDeRol;
  jefe2: SesionDeRol;
  admin: SesionDeRol;
}

/** Una sesión real (login por la API) por cada actor. */
export async function crearMundo(): Promise<Mundo> {
  const [supervisor, supervisorAjeno, jefe, jefe2, admin] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
    sesion('jefe'),
    sesion('admin'),
  ]);
  return { supervisor, supervisorAjeno, jefe, jefe2, admin };
}

export function sesionDe(m: Mundo, actor: ActorConSesion): SesionDeRol {
  switch (actor) {
    case 'supervisor':
      return m.supervisor;
    case 'supervisor_ajeno':
      return m.supervisorAjeno;
    case 'jefe':
      return m.jefe;
    case 'admin':
      return m.admin;
  }
}

/** Token del actor, o `undefined` si no manda token. */
export function tokenDe(m: Mundo, actor: Actor): string | undefined {
  return actor === 'sin_token' ? undefined : sesionDe(m, actor).token;
}

/** Sesión nueva (propia) con el rol del actor, para los endpoints que cierran o rotan la sesión. */
export async function sesionPropia(actor: ActorConSesion): Promise<SesionDeRol> {
  return sesion(actor === 'jefe' ? 'jefe' : actor === 'admin' ? 'admin' : 'supervisor');
}

// ---------------------------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------------------------

export interface Peticion {
  metodo: string;
  /** Ruta bajo `/api/v1` (con query si aplica). */
  ruta: string;
  json?: unknown;
  /** Cuerpo JSON literal (para JSON mal formado). */
  jsonCrudo?: string;
  binario?: { bytes: Uint8Array; contentType: string };
  ip?: string;
  /** Orden a la que pertenecen las filas de auditoría que deja la petición. */
  orderId?: string;
}

export interface OpcionesEnvio {
  token?: string;
  /** `null` = sin cabecera Origin. Por defecto, el propio origen. */
  origen?: string | null;
}

export async function enviar(p: Peticion, o: OpcionesEnvio = {}): Promise<Response> {
  const headers = new Headers();
  const origen = o.origen === undefined ? ORIGEN : o.origen;
  if (origen !== null) {
    headers.set('Origin', origen);
  }
  if (o.token !== undefined) {
    headers.set('Authorization', `Bearer ${o.token}`);
  }
  if (p.ip !== undefined) {
    headers.set('cf-connecting-ip', p.ip);
  }
  let cuerpo: BodyInit | undefined;
  if (p.binario !== undefined) {
    headers.set('Content-Type', p.binario.contentType);
    cuerpo = p.binario.bytes as BodyInit;
  } else if (p.jsonCrudo !== undefined) {
    headers.set('Content-Type', 'application/json');
    cuerpo = p.jsonCrudo;
  } else if (p.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    cuerpo = JSON.stringify(p.json);
  }
  return exports.default.fetch(
    new Request(`${BASE}/api/v1${p.ruta}`, { method: p.metodo, headers, body: cuerpo }),
  );
}

// ---------------------------------------------------------------------------------------------
// Revisiones comunes a toda respuesta
// ---------------------------------------------------------------------------------------------

export function comoRegistro(valor: unknown): Record<string, unknown> {
  expect(valor).toBeTypeOf('object');
  expect(valor).not.toBeNull();
  expect(Array.isArray(valor)).toBe(false);
  return valor as Record<string, unknown>;
}

/** Cuerpo de error con el formato único: exactamente `{ code, message, details? }`. */
export function esperarFormatoError(estado: number, cuerpo: unknown): CodigoError {
  const registro = comoRegistro(cuerpo);
  const claves = Object.keys(registro).sort().join(',');
  expect(['code,message', 'code,details,message'], `claves del error: ${claves}`).toContain(claves);
  const code = registro.code as CodigoError;
  expect(CODIGOS_ERROR_LISTA, `código desconocido: ${String(code)}`).toContain(code);
  expect(registro.message).toBeTypeOf('string');
  expect((registro.message as string).length).toBeGreaterThan(0);
  // El mensaje es el estándar del código, escrito en español (docs/spec.md §7).
  expect(registro.message).toBe(MENSAJES_ERROR[code]);
  expect(estado, `estado HTTP de ${code}`).toBe(ESTADO_HTTP_POR_CODIGO[code]);
  return code;
}

const PROHIBIDOS_EN_RESPUESTAS = ['password_hash', 'token_hash', 'storage_key', 'evidencias/'];

/** Valores secretos que nunca deben aparecer en una respuesta. */
export function valoresProhibidos(): string[] {
  return [...PROHIBIDOS_EN_RESPUESTAS, env.JWT_SECRET, env.REFRESH_SECRET];
}

export function esperarSinSecretos(texto: string, adicionales: readonly string[] = []): void {
  for (const prohibido of [...valoresProhibidos(), ...adicionales]) {
    expect(texto.includes(prohibido), `la respuesta contiene «${prohibido.slice(0, 12)}…»`).toBe(
      false,
    );
  }
}

/** Cabeceras de seguridad de toda respuesta (docs/spec.md §9) y `Cache-Control` de la API. */
export function esperarCabecerasDeSeguridad(
  respuesta: Response,
  opciones: { cacheControl?: string } = {},
): void {
  const h = respuesta.headers;
  const csp = h.get('Content-Security-Policy') ?? '';
  for (const directiva of [
    "default-src 'self'",
    "script-src 'self'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ]) {
    expect(csp, `CSP sin ${directiva}`).toContain(directiva);
  }
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(h.get('X-Content-Type-Options')).toBe('nosniff');
  expect(h.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(h.get('Permissions-Policy')).toContain('camera=(self)');
  const hsts = h.get('Strict-Transport-Security') ?? '';
  expect(Number(/^max-age=(\d+)/.exec(hsts)?.[1] ?? '0')).toBeGreaterThanOrEqual(31_536_000);
  expect(hsts).toContain('includeSubDomains');
  expect(h.get('X-Frame-Options')).toBe('DENY');
  expect(h.get('Cache-Control')).toBe(opciones.cacheControl ?? 'no-store');
}

export interface Revisada {
  estado: number;
  /** Código de error (solo si el estado es >= 400). */
  code?: CodigoError;
  cuerpo: unknown;
  texto: string;
}

function esEvidenciaDescargada(p: Peticion, estado: number): boolean {
  return p.metodo === 'GET' && p.ruta.startsWith('/evidences/') && estado === 200;
}

/**
 * Lee la respuesta y aplica las revisiones comunes: formato único de error (con JSON), cabeceras de
 * seguridad, `Cache-Control` y ausencia de secretos. Devuelve lo leído para que la prueba compare.
 */
export async function revisar(respuesta: Response, p: Peticion): Promise<Revisada> {
  const tipo = respuesta.headers.get('Content-Type') ?? '';
  const esBinario = tipo.startsWith('image/');
  const texto = esBinario ? '' : await respuesta.text();
  if (esBinario) {
    await respuesta.arrayBuffer();
  }
  const cuerpo: unknown =
    texto !== '' && tipo.includes('application/json') ? JSON.parse(texto) : undefined;

  esperarCabecerasDeSeguridad(respuesta, {
    cacheControl: esEvidenciaDescargada(p, respuesta.status) ? 'private, no-store' : 'no-store',
  });
  esperarSinSecretos(texto);

  if (respuesta.status >= 400) {
    expect(tipo, 'Content-Type de un error').toContain('application/json');
    return {
      estado: respuesta.status,
      code: esperarFormatoError(respuesta.status, cuerpo),
      cuerpo,
      texto,
    };
  }
  return { estado: respuesta.status, cuerpo, texto };
}

// ---------------------------------------------------------------------------------------------
// Auditoría y foto de la base
// ---------------------------------------------------------------------------------------------

export interface FilaAuditoriaCompleta {
  seq: number;
  entidad: string;
  entidad_id: string;
  accion: string;
  order_id: string | null;
  actor_id: string | null;
  device_id: string | null;
  server_at: string;
}

export async function auditoriaCompletaDesde(seq: number): Promise<FilaAuditoriaCompleta[]> {
  const { results } = await env.DB.prepare(
    `SELECT seq, entidad, entidad_id, accion, order_id, actor_id, device_id, server_at
     FROM audit_log WHERE seq > ? ORDER BY seq`,
  )
    .bind(seq)
    .all<FilaAuditoriaCompleta>();
  return results;
}

/** Todas las tablas de la base: la foto detecta cualquier escritura parcial, también los UPDATE. */
const TABLAS = [
  'users',
  'devices',
  'refresh_tokens',
  'settings',
  'materials',
  'production_orders',
  'order_planned_materials',
  'order_supervisors',
  'consumptions',
  'incidents',
  'evidences',
  'validations',
  'sync_mutations',
  'audit_log',
] as const;

export type FotoDeLaBase = Record<(typeof TABLAS)[number], string>;

export async function fotoDeLaBase(): Promise<FotoDeLaBase> {
  const resultados = await env.DB.batch(
    TABLAS.map((tabla) => env.DB.prepare(`SELECT * FROM ${tabla} ORDER BY rowid`)),
  );
  return Object.fromEntries(
    TABLAS.map((tabla, i) => [tabla, JSON.stringify(resultados[i]?.results ?? [])]),
  ) as FotoDeLaBase;
}

/** Tablas cuyo contenido cambió entre dos fotos (lista vacía = base idéntica). */
export function tablasModificadas(antes: FotoDeLaBase, despues: FotoDeLaBase): string[] {
  return TABLAS.filter((tabla) => antes[tabla] !== despues[tabla]);
}

export interface FalloDeAuditoria {
  entidad: string;
  accion: string;
}

/**
 * Crea un trigger temporal que aborta el INSERT en `audit_log` de la entidad y acción indicadas,
 * ejecuta `fn` y lo borra siempre. `audit_log` no admite DELETE, pero sí `DROP TRIGGER` del
 * trigger temporal. El aborto ocurre a mitad del batch (después de la sentencia principal).
 */
export async function conFalloEnAuditoria<T>(
  fallo: FalloDeAuditoria,
  fn: () => Promise<T>,
): Promise<T> {
  // Los valores salen de las tablas de las pruebas, nunca de una entrada externa.
  expect(`${fallo.entidad} ${fallo.accion}`).toMatch(/^[a-z_]+ [a-z_.]+$/);
  const nombre = `tmp_fallo_transversal_${uuidv7().replaceAll('-', '')}`;
  await env.DB.prepare(
    `CREATE TRIGGER ${nombre} BEFORE INSERT ON audit_log
     WHEN NEW.entidad = '${fallo.entidad}' AND NEW.accion = '${fallo.accion}'
     BEGIN SELECT RAISE(ABORT, 'fallo simulado por la prueba transversal'); END`,
  ).run();
  try {
    return await fn();
  } finally {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${nombre}`).run();
  }
}

// ---------------------------------------------------------------------------------------------
// Escenarios de negocio (SQL directo para el estado de partida)
// ---------------------------------------------------------------------------------------------

export interface Escena {
  orden: string;
  material: string;
}

/**
 * Orden con un material planeado (100 kg). El supervisor del mundo queda asignado, salvo que
 * `asignado: false` (asignación inactiva, como un supervisor desasignado).
 */
export async function escena(
  m: Mundo,
  opciones: { estado?: 'planeada' | 'en_proceso' | 'finalizada'; asignado?: boolean } = {},
): Promise<Escena> {
  const orden = await nuevaOrden(m.jefe.usuario.id, opciones.estado ?? 'en_proceso');
  const material = await nuevoMaterial({ unidad: 'kg', costo: 1500 });
  await planear(orden, material, 100, 'kg');
  await asignar(
    orden,
    m.supervisor.usuario.id,
    m.admin.usuario.id,
    opciones.asignado === false ? 0 : 1,
  );
  return { orden, material };
}

/** Consumo pendiente (SQL directo) registrado por el supervisor o por el jefe del mundo. */
export async function consumoPendiente(
  m: Mundo,
  e: Escena,
  autor: 'supervisor' | 'jefe' = 'supervisor',
  extra: { cantidad?: number } = {},
): Promise<string> {
  const s = autor === 'jefe' ? m.jefe : m.supervisor;
  return nuevoConsumo({
    orderId: e.orden,
    materialId: e.material,
    registradoPor: s.usuario.id,
    deviceId: s.deviceId,
    cantidad: extra.cantidad ?? 10,
  });
}

export interface ConNovedad {
  consumo: string;
  novedad: string;
  evidencia: string;
  bytes: Uint8Array;
}

/** Consumo con una novedad (por la API) y una foto registrada, subida o no. */
export async function consumoConNovedad(
  m: Mundo,
  e: Escena,
  autor: 'supervisor' | 'jefe',
  subida: boolean,
): Promise<ConNovedad> {
  const s = autor === 'jefe' ? m.jefe : m.supervisor;
  const consumo = await consumoPendiente(m, e, autor);
  const foto = await archivo('image/jpeg', jpeg());
  const novedad = await novedadOk(s.token, consumo, cuerpoNovedad(consumo, [foto]));
  if (subida) {
    const respuesta = await subir(s.token, foto.id, foto.bytes, 'image/jpeg');
    expect(respuesta.status).toBe(200);
  }
  return { consumo, novedad: novedad.id, evidencia: foto.id, bytes: foto.bytes };
}

const ahoraIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// Catálogo literal de rutas
// ---------------------------------------------------------------------------------------------

export interface Esperado {
  estado: number;
  code?: CodigoError;
}

export type Celda = number | Esperado;

export interface FilaDeRuta {
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Ruta tal como la registra Hono, sin el prefijo `/api/v1` (p. ej. `/orders/:id/start`). */
  ruta: string;
  /** Distingue filas de la misma ruta que prueban otra regla de datos. */
  variante?: string;
  /** Regla de docs/spec.md o del plan que fija los estados esperados. */
  regla: string;
  /** Estado esperado por actor. Las filas base definen los cinco; las variantes, solo los que cambian. */
  esperado: Partial<Record<Actor, Celda>>;
  /** Los actores con token usan una sesión propia (el endpoint cierra o rota la sesión). */
  sesionPropia?: boolean;
  preparar: (m: Mundo) => Promise<Peticion>;
}

export function normalizar(celda: Celda): Esperado {
  if (typeof celda !== 'number') {
    return celda;
  }
  const porDefecto: Record<number, CodigoError> = {
    401: 'NO_AUTENTICADO',
    403: 'PERMISO_DENEGADO',
    404: 'NO_ENCONTRADO',
  };
  const code = porDefecto[celda];
  return code === undefined ? { estado: celda } : { estado: celda, code };
}

const SIN_TOKEN = 401;
const DENEGADO = 403;
const OCULTO = 404;

/** Mismo resultado para los cuatro actores con token. */
function conTokenTodos(celda: Celda): Record<ActorConSesion, Celda> {
  return { supervisor: celda, supervisor_ajeno: celda, jefe: celda, admin: celda };
}

const bodyFechado = (extra: Record<string, unknown>): Record<string, unknown> => ({
  client_created_at: ahoraIso(),
  ...extra,
});

/** Consumo pendiente del supervisor con cuerpo de edición. */
async function peticionEditar(
  m: Mundo,
  autor: 'supervisor' | 'jefe',
  e?: Escena,
): Promise<Peticion> {
  const escenaUsada = e ?? (await escena(m));
  const consumo = await consumoPendiente(m, escenaUsada, autor);
  return {
    metodo: 'PATCH',
    ruta: `/consumptions/${consumo}`,
    json: bodyFechado({ id: consumo, version: 1, cantidad: 12 }),
    orderId: escenaUsada.orden,
  };
}

async function peticionDecidir(
  m: Mundo,
  decision: 'approve' | 'reject',
  autor: 'supervisor' | 'jefe',
): Promise<Peticion> {
  const e = await escena(m);
  const consumo = await consumoPendiente(m, e, autor);
  return {
    metodo: 'POST',
    ruta: `/consumptions/${consumo}/${decision}`,
    json: bodyFechado({
      id: uuidv7(),
      version: 1,
      ...(decision === 'reject' ? { motivo: 'Cantidad mal digitada' } : {}),
    }),
    orderId: e.orden,
  };
}

async function peticionSubirEvidencia(m: Mundo, autor: 'supervisor' | 'jefe'): Promise<Peticion> {
  const e = await escena(m);
  const datos = await consumoConNovedad(m, e, autor, false);
  return {
    metodo: 'PUT',
    ruta: `/evidences/${datos.evidencia}`,
    binario: { bytes: datos.bytes, contentType: 'image/jpeg' },
    orderId: e.orden,
  };
}

async function peticionNovedad(
  m: Mundo,
  e?: Escena,
  autor: 'supervisor' | 'jefe' = 'supervisor',
): Promise<Peticion> {
  const escenaUsada = e ?? (await escena(m));
  const consumo = await consumoPendiente(m, escenaUsada, autor);
  const foto = await archivo('image/jpeg', jpeg());
  return {
    metodo: 'POST',
    ruta: `/consumptions/${consumo}/incident`,
    json: cuerpoNovedad(consumo, [foto]),
    orderId: escenaUsada.orden,
  };
}

async function peticionDescargar(m: Mundo, e?: Escena): Promise<Peticion> {
  const escenaUsada = e ?? (await escena(m));
  const datos = await consumoConNovedad(m, escenaUsada, 'supervisor', true);
  return { metodo: 'GET', ruta: `/evidences/${datos.evidencia}`, orderId: escenaUsada.orden };
}

/** Escenario con un consumo del supervisor y la asignación del supervisor desactivada. */
async function escenaDesasignada(m: Mundo): Promise<Escena> {
  const e = await escena(m, { asignado: false });
  return e;
}

async function peticionDeOrden(m: Mundo, metodo: 'GET', sufijo: string): Promise<Peticion> {
  const e = await escena(m);
  await consumoPendiente(m, e, 'supervisor');
  return { metodo, ruta: `/orders/${e.orden}${sufijo}`, orderId: e.orden };
}

async function peticionDeReporte(m: Mundo, sufijo: string): Promise<Peticion> {
  const e = await escena(m);
  await consumoPendiente(m, e, 'supervisor');
  return { metodo: 'GET', ruta: `/reports/orders/${e.orden}${sufijo}`, orderId: e.orden };
}

async function peticionIniciar(m: Mundo): Promise<Peticion> {
  const e = await escena(m, { estado: 'planeada' });
  return { metodo: 'POST', ruta: `/orders/${e.orden}/start`, orderId: e.orden };
}

async function peticionFinalizar(m: Mundo): Promise<Peticion> {
  const e = await escena(m);
  return { metodo: 'POST', ruta: `/orders/${e.orden}/finish`, json: {}, orderId: e.orden };
}

async function peticionAsignar(m: Mundo): Promise<Peticion> {
  const e = await escena(m);
  return {
    metodo: 'PUT',
    ruta: `/orders/${e.orden}/supervisors`,
    json: { supervisores: [m.supervisorAjeno.usuario.id] },
    orderId: e.orden,
  };
}

async function peticionCrearOrden(): Promise<Peticion> {
  const a = await nuevoMaterial({ unidad: 'kg' });
  const b = await nuevoMaterial({ unidad: 'l' });
  return {
    metodo: 'POST',
    ruta: '/orders',
    json: {
      codigo: codigoOrden(),
      linea: 'Moldeo',
      materiales: [
        { material_id: a, cantidad_planeada: 50, unidad: 'kg' },
        { material_id: b, cantidad_planeada: 20, unidad: 'l' },
      ],
    },
  };
}

function codigoMaterial(): string {
  return `MP-${uuidv7().slice(-16)}`;
}

export const FILAS: readonly FilaDeRuta[] = [
  // --- Públicas ---------------------------------------------------------------------------------
  {
    metodo: 'GET',
    ruta: '/health',
    regla: '§7: /health es público (sin token responde 200 para el monitoreo)',
    esperado: { sin_token: 200, ...conTokenTodos(200) },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/health' }),
  },
  {
    metodo: 'POST',
    ruta: '/auth/login',
    regla:
      '§5/§7: el login no exige token; con credenciales ajenas responde CREDENCIALES_INVALIDAS',
    esperado: {
      sin_token: { estado: 401, code: 'CREDENCIALES_INVALIDAS' },
      ...conTokenTodos({ estado: 401, code: 'CREDENCIALES_INVALIDAS' }),
    },
    preparar: () =>
      Promise.resolve({
        metodo: 'POST',
        ruta: '/auth/login',
        json: {
          email: `nadie-${uuidv7()}@catmetal.test`,
          password: 'clave-incorrecta',
          device_id: uuidv7(),
        },
        ip: `ip-${uuidv7()}`,
      }),
  },
  {
    metodo: 'POST',
    ruta: '/auth/refresh',
    regla:
      '§5: el refresh se autentica con la cookie, no con Bearer; sin cookie responde TOKEN_INVALIDO',
    esperado: {
      sin_token: { estado: 401, code: 'TOKEN_INVALIDO' },
      ...conTokenTodos({ estado: 401, code: 'TOKEN_INVALIDO' }),
    },
    preparar: () => Promise.resolve({ metodo: 'POST', ruta: '/auth/refresh' }),
  },
  {
    metodo: 'POST',
    ruta: '/auth/logout',
    regla: '§5: el logout es idempotente y no exige token (204); con token cierra esa sesión',
    esperado: { sin_token: 204, ...conTokenTodos(204) },
    sesionPropia: true,
    preparar: () => Promise.resolve({ metodo: 'POST', ruta: '/auth/logout' }),
  },
  {
    metodo: 'GET',
    ruta: '/auth/me',
    regla: '§7: /auth/me exige sesión y sirve a cualquier rol',
    esperado: { sin_token: SIN_TOKEN, ...conTokenTodos(200) },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/auth/me' }),
  },

  // --- Usuarios (§3: "Gestionar usuarios": solo admin) -----------------------------------------
  {
    metodo: 'GET',
    ruta: '/users',
    regla: '§3 fila "Gestionar usuarios…": solo admin',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: 200,
    },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/users' }),
  },
  {
    metodo: 'POST',
    ruta: '/users',
    regla: '§3 fila "Gestionar usuarios…": solo admin',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: 201,
    },
    preparar: () =>
      Promise.resolve({
        metodo: 'POST',
        ruta: '/users',
        json: {
          nombre: 'Operaria nueva',
          email: `nueva-${uuidv7()}@catmetal.test`,
          rol: 'supervisor',
          password: 'Clave-Segura-2026',
        },
      }),
  },
  {
    metodo: 'PATCH',
    ruta: '/users/:id',
    regla: '§3 fila "Gestionar usuarios…": solo admin (el permiso se evalúa antes que el dato)',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: 200,
    },
    preparar: async () => {
      const id = await crearUsuario('supervisor');
      return { metodo: 'PATCH', ruta: `/users/${id}`, json: { nombre: 'Nombre corregido' } };
    },
  },

  // --- Materiales y configuración ---------------------------------------------------------------
  {
    metodo: 'GET',
    ruta: '/materials',
    regla: '§7: cualquier usuario autenticado lee el catálogo (lo necesitan los formularios)',
    esperado: { sin_token: SIN_TOKEN, ...conTokenTodos(200) },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/materials' }),
  },
  {
    metodo: 'POST',
    ruta: '/materials',
    regla: '§3 fila "Gestionar … materiales": solo admin',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: 201,
    },
    preparar: () =>
      Promise.resolve({
        metodo: 'POST',
        ruta: '/materials',
        json: {
          codigo: codigoMaterial(),
          nombre: 'Bentonita sódica',
          unidad: 'kg',
          costo_unitario_cop: 2300,
        },
      }),
  },
  {
    metodo: 'PATCH',
    ruta: '/materials/:id',
    regla: '§3 fila "Gestionar … materiales": solo admin',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: 200,
    },
    preparar: async () => {
      const id = await nuevoMaterial();
      return { metodo: 'PATCH', ruta: `/materials/${id}`, json: { costo_unitario_cop: 1800 } };
    },
  },
  {
    metodo: 'GET',
    ruta: '/settings',
    regla: '§7: cualquier usuario autenticado lee la tolerancia vigente',
    esperado: { sin_token: SIN_TOKEN, ...conTokenTodos(200) },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/settings' }),
  },
  {
    metodo: 'PATCH',
    ruta: '/settings/tolerancia',
    regla: '§3 fila "Gestionar … tolerancia": solo admin',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: 200,
    },
    preparar: () =>
      Promise.resolve({
        metodo: 'PATCH',
        ruta: '/settings/tolerancia',
        json: { tolerancia_pct: 5 },
      }),
  },

  // --- Órdenes ----------------------------------------------------------------------------------
  {
    metodo: 'GET',
    ruta: '/orders',
    regla:
      '§3 fila "Ver órdenes": supervisor solo asignadas (filtra, no deniega); jefe y admin todas',
    esperado: { sin_token: SIN_TOKEN, ...conTokenTodos(200) },
    preparar: async (m) => {
      await escena(m);
      return { metodo: 'GET', ruta: '/orders' };
    },
  },
  {
    metodo: 'GET',
    ruta: '/orders/:id',
    regla: '§3 "Ver órdenes": supervisor solo asignada (no asignada = 404, no revela existencia)',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: OCULTO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionDeOrden(m, 'GET', ''),
  },
  {
    metodo: 'POST',
    ruta: '/orders',
    regla: '§3 fila "Crear / iniciar / finalizar orden": jefe y admin',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: 201,
      admin: 201,
    },
    preparar: () => peticionCrearOrden(),
  },
  {
    metodo: 'POST',
    ruta: '/orders/:id/start',
    regla:
      '§3 fila "Crear / iniciar / finalizar orden": jefe y admin (el supervisor, aun asignado, no)',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionIniciar(m),
  },
  {
    metodo: 'POST',
    ruta: '/orders/:id/finish',
    regla: '§3 fila "Crear / iniciar / finalizar orden": jefe y admin (sin pendientes, sin force)',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionFinalizar(m),
  },
  {
    metodo: 'PUT',
    ruta: '/orders/:id/supervisors',
    regla: '§3 fila "Gestionar … asignaciones": solo admin (el jefe no asigna)',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: 200,
    },
    preparar: (m) => peticionAsignar(m),
  },

  // --- Consumos, novedades y evidencias ---------------------------------------------------------
  {
    metodo: 'GET',
    ruta: '/orders/:id/consumptions',
    regla:
      '§3 "Ver órdenes" + ADR 0005 regla 2: el supervisor ajeno sin consumos propios recibe 404; jefe y admin ven todo',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: OCULTO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionDeOrden(m, 'GET', '/consumptions'),
  },
  {
    metodo: 'POST',
    ruta: '/consumptions',
    regla:
      '§3 fila "Registrar consumo": supervisor en órdenes asignadas en proceso, jefe en cualquiera, admin nunca',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 201,
      supervisor_ajeno: OCULTO,
      jefe: 201,
      admin: DENEGADO,
    },
    preparar: async (m) => {
      const e = await escena(m);
      return {
        metodo: 'POST',
        ruta: '/consumptions',
        json: cuerpoConsumo(e.orden, e.material),
        orderId: e.orden,
      };
    },
  },
  {
    metodo: 'PATCH',
    ruta: '/consumptions/:id',
    regla:
      '§3 fila "Editar consumo propio pendiente": solo el supervisor autor; otro supervisor no ve el consumo (404); jefe y admin no editan',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: OCULTO,
      jefe: DENEGADO,
      admin: DENEGADO,
    },
    preparar: (m) => peticionEditar(m, 'supervisor'),
  },
  {
    metodo: 'POST',
    ruta: '/consumptions/:id/incident',
    regla:
      '§3 fila "Registrar novedad + evidencia": el autor del consumo o un jefe; admin nunca; supervisor ajeno 404',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 201,
      supervisor_ajeno: OCULTO,
      jefe: 201,
      admin: DENEGADO,
    },
    preparar: (m) => peticionNovedad(m),
  },
  {
    metodo: 'PUT',
    ruta: '/evidences/:id',
    regla:
      'plan "Evidencia": solo quien registró la novedad sube la foto (otro supervisor o el jefe → 403); admin sin permiso',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: DENEGADO,
      jefe: DENEGADO,
      admin: DENEGADO,
    },
    preparar: (m) => peticionSubirEvidencia(m, 'supervisor'),
  },
  {
    metodo: 'GET',
    ruta: '/evidences/:id',
    regla:
      'plan "Evidencia": permiso de lectura del consumo; supervisor ajeno 404; jefe y admin ven todo',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: OCULTO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionDescargar(m),
  },

  // --- Validación -------------------------------------------------------------------------------
  {
    metodo: 'GET',
    ruta: '/validations/queue',
    regla: '§3 fila "Aprobar / rechazar consumo": la cola es solo del jefe',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: 200,
      admin: DENEGADO,
    },
    preparar: async (m) => {
      const e = await escena(m);
      await consumoPendiente(m, e);
      return { metodo: 'GET', ruta: '/validations/queue' };
    },
  },
  {
    metodo: 'POST',
    ruta: '/consumptions/:id/approve',
    regla: '§3 fila "Aprobar / rechazar consumo": solo el jefe (sobre consumos ajenos)',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: 201,
      admin: DENEGADO,
    },
    preparar: (m) => peticionDecidir(m, 'approve', 'supervisor'),
  },
  {
    metodo: 'POST',
    ruta: '/consumptions/:id/reject',
    regla: '§3 fila "Aprobar / rechazar consumo": solo el jefe (sobre consumos ajenos)',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: DENEGADO,
      supervisor_ajeno: DENEGADO,
      jefe: 201,
      admin: DENEGADO,
    },
    preparar: (m) => peticionDecidir(m, 'reject', 'supervisor'),
  },

  // --- Sincronización offline (Fase 3) ----------------------------------------------------------
  {
    metodo: 'POST',
    ruta: '/sync/push',
    regla:
      '§6 + ADR 0008 punto 8: cualquier rol con sesión; el sobre es del supervisor del escenario, así que otro usuario recibe 403 AUTOR_NO_COINCIDE',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: { estado: 403, code: 'AUTOR_NO_COINCIDE' },
      jefe: { estado: 403, code: 'AUTOR_NO_COINCIDE' },
      admin: { estado: 403, code: 'AUTOR_NO_COINCIDE' },
    },
    preparar: async (m) => {
      const e = await escena(m);
      return {
        metodo: 'POST',
        ruta: '/sync/push',
        json: {
          user_id: m.supervisor.usuario.id,
          mutaciones: [
            {
              mutation_id: uuidv7(),
              tipo: 'consumo.crear',
              client_created_at: ahoraIso(),
              payload: cuerpoConsumo(e.orden, e.material),
            },
          ],
        },
        orderId: e.orden,
      };
    },
  },
  {
    metodo: 'GET',
    ruta: '/sync/pull',
    regla: '§6: cualquier rol con sesión; la visibilidad filtra los cambios, no deniega',
    esperado: { sin_token: SIN_TOKEN, ...conTokenTodos(200) },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/sync/pull?cursor=0' }),
  },
  {
    metodo: 'GET',
    ruta: '/sync/snapshot',
    regla: 'ADR 0005 regla 7: cualquier rol con sesión; el alcance inicial filtra por visibilidad',
    esperado: { sin_token: SIN_TOKEN, ...conTokenTodos(200) },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/sync/snapshot?alcance=inicial' }),
  },

  // --- Auditoría y reportes ---------------------------------------------------------------------
  {
    metodo: 'GET',
    ruta: '/audit',
    regla:
      '§3 fila "Ver auditoría": jefe y admin todo; supervisor solo lo propio (filtra, no deniega)',
    esperado: { sin_token: SIN_TOKEN, ...conTokenTodos(200) },
    preparar: () => Promise.resolve({ metodo: 'GET', ruta: '/audit' }),
  },
  {
    metodo: 'GET',
    ruta: '/orders/:id/audit',
    regla:
      '§3 "Ver auditoría" + ADR 0005 regla 2: el supervisor ajeno sin consumos propios en la orden recibe 404',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: OCULTO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionDeOrden(m, 'GET', '/audit'),
  },
  {
    metodo: 'GET',
    ruta: '/reports/orders/:id/summary',
    regla:
      'plan "Reportes": jefe y admin cualquier orden; supervisor solo asignada activa; lo demás 404',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: OCULTO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionDeReporte(m, '/summary'),
  },
  {
    metodo: 'GET',
    ruta: '/reports/orders/:id/export.csv',
    regla: 'plan "Reportes": mismos permisos que el resumen',
    esperado: {
      sin_token: SIN_TOKEN,
      supervisor: 200,
      supervisor_ajeno: OCULTO,
      jefe: 200,
      admin: 200,
    },
    preparar: (m) => peticionDeReporte(m, '/export.csv'),
  },

  // --- Variantes: reglas de datos que cambian el resultado de un actor --------------------------
  {
    metodo: 'POST',
    ruta: '/consumptions/:id/approve',
    variante: 'consumo propio del jefe',
    regla: '§3 "Aprobar / rechazar consumo": nunca uno propio (P1: aunque sea el único jefe)',
    esperado: { jefe: { estado: 403, code: 'AUTOAPROBACION' } },
    preparar: (m) => peticionDecidir(m, 'approve', 'jefe'),
  },
  {
    metodo: 'POST',
    ruta: '/consumptions/:id/reject',
    variante: 'consumo propio del jefe',
    regla: '§3 "Aprobar / rechazar consumo": nunca uno propio (P1)',
    esperado: { jefe: { estado: 403, code: 'AUTOAPROBACION' } },
    preparar: (m) => peticionDecidir(m, 'reject', 'jefe'),
  },
  {
    metodo: 'PATCH',
    ruta: '/consumptions/:id',
    variante: 'consumo propio del jefe',
    regla:
      '§3 "Editar consumo propio pendiente": solo supervisor (P3); el jefe no edita ni el suyo',
    esperado: { jefe: DENEGADO },
    preparar: (m) => peticionEditar(m, 'jefe'),
  },
  {
    metodo: 'PUT',
    ruta: '/evidences/:id',
    variante: 'novedad registrada por el jefe',
    regla:
      'plan "Evidencia": sube la foto quien registró la novedad (aquí el jefe); el supervisor no',
    esperado: { jefe: 200, supervisor: DENEGADO },
    preparar: (m) => peticionSubirEvidencia(m, 'jefe'),
  },
  {
    metodo: 'GET',
    ruta: '/orders/:id',
    variante: 'supervisor desasignado',
    regla: 'plan "Lectura": solo órdenes con asignación ACTIVA; la desasignación oculta la orden',
    esperado: { supervisor: OCULTO },
    preparar: async (m) => {
      const e = await escenaDesasignada(m);
      await consumoPendiente(m, e);
      return { metodo: 'GET', ruta: `/orders/${e.orden}`, orderId: e.orden };
    },
  },
  {
    metodo: 'GET',
    ruta: '/orders/:id/consumptions',
    variante: 'supervisor desasignado con consumo propio',
    regla:
      'ADR 0005 regla 2: el supervisor sigue viendo sus propios consumos aunque pierda la asignación',
    esperado: { supervisor: 200 },
    preparar: async (m) => {
      const e = await escenaDesasignada(m);
      await consumoPendiente(m, e);
      return { metodo: 'GET', ruta: `/orders/${e.orden}/consumptions`, orderId: e.orden };
    },
  },
  {
    metodo: 'GET',
    ruta: '/orders/:id/audit',
    variante: 'supervisor desasignado con consumo propio',
    regla:
      'ADR 0005 regla 2: la línea de tiempo sigue visible si tiene algún consumo propio en la orden',
    esperado: { supervisor: 200 },
    preparar: async (m) => {
      const e = await escenaDesasignada(m);
      await consumoPendiente(m, e);
      return { metodo: 'GET', ruta: `/orders/${e.orden}/audit`, orderId: e.orden };
    },
  },
  {
    metodo: 'POST',
    ruta: '/consumptions',
    variante: 'supervisor desasignado',
    regla:
      '§3 "Registrar consumo": solo órdenes asignadas; sin asignación activa es como si no existiera',
    esperado: { supervisor: OCULTO },
    preparar: async (m) => {
      const e = await escenaDesasignada(m);
      return {
        metodo: 'POST',
        ruta: '/consumptions',
        json: cuerpoConsumo(e.orden, e.material),
        orderId: e.orden,
      };
    },
  },
  {
    metodo: 'GET',
    ruta: '/reports/orders/:id/summary',
    variante: 'supervisor desasignado',
    regla: 'plan "Reportes": el supervisor solo ve el reporte de órdenes asignadas activas',
    esperado: { supervisor: OCULTO },
    preparar: async (m) => {
      const e = await escenaDesasignada(m);
      await consumoPendiente(m, e);
      return { metodo: 'GET', ruta: `/reports/orders/${e.orden}/summary`, orderId: e.orden };
    },
  },
  {
    metodo: 'GET',
    ruta: '/reports/orders/:id/export.csv',
    variante: 'supervisor desasignado',
    regla: 'plan "Reportes": el CSV sigue la misma regla que el resumen',
    esperado: { supervisor: OCULTO },
    preparar: async (m) => {
      const e = await escenaDesasignada(m);
      await consumoPendiente(m, e);
      return { metodo: 'GET', ruta: `/reports/orders/${e.orden}/export.csv`, orderId: e.orden };
    },
  },
  {
    metodo: 'GET',
    ruta: '/evidences/:id',
    variante: 'supervisor desasignado, evidencia de su consumo',
    regla: 'ADR 0005 regla 2: el autor del consumo sigue viendo su novedad y evidencias',
    esperado: { supervisor: 200 },
    preparar: async (m) => {
      const e = await escena(m);
      const datos = await consumoConNovedad(m, e, 'supervisor', true);
      await env.DB.prepare(
        'UPDATE order_supervisors SET activo = 0, updated_at = ? WHERE order_id = ? AND user_id = ?',
      )
        .bind(ahoraIso(), e.orden, m.supervisor.usuario.id)
        .run();
      return { metodo: 'GET', ruta: `/evidences/${datos.evidencia}`, orderId: e.orden };
    },
  },
  {
    metodo: 'GET',
    ruta: '/sync/snapshot',
    variante: 'alcance orden',
    regla:
      'plan de la Fase 3: el snapshot de una orden exige verla; supervisor no asignado → 404 (no se revela)',
    esperado: { supervisor: 200, supervisor_ajeno: OCULTO, jefe: 200, admin: 200 },
    preparar: async (m) => {
      const e = await escena(m);
      return {
        metodo: 'GET',
        ruta: `/sync/snapshot?alcance=orden&order_id=${e.orden}`,
        orderId: e.orden,
      };
    },
  },
];

/** Clave `METODO /ruta` de una fila (sin la variante). */
export function claveDeRuta(fila: Pick<FilaDeRuta, 'metodo' | 'ruta'>): string {
  return `${fila.metodo} ${fila.ruta}`;
}

export function nombreDeFila(fila: FilaDeRuta): string {
  return fila.variante === undefined
    ? claveDeRuta(fila)
    : `${claveDeRuta(fila)} (${fila.variante})`;
}

/** Rutas de la tabla (sin repetir, ordenadas). */
export function rutasDeLaTabla(): string[] {
  return [...new Set(FILAS.map(claveDeRuta))].sort();
}

/**
 * Rutas que Hono tiene registradas bajo `/api/v1` (`app.routes`), sin repetir y ordenadas. Se
 * ignoran los middlewares (método `ALL`): cada ruta aparece una vez por handler.
 */
export function rutasRegistradas(): string[] {
  const prefijo = '/api/v1';
  const claves = app.routes
    .filter((ruta) => ruta.method !== 'ALL' && ruta.path.startsWith(prefijo))
    .map((ruta) => `${ruta.method} ${ruta.path.slice(prefijo.length)}`);
  return [...new Set(claves)].sort();
}

export function buscarFila(metodo: string, ruta: string, variante?: string): FilaDeRuta {
  const fila = FILAS.find((f) => f.metodo === metodo && f.ruta === ruta && f.variante === variante);
  if (fila === undefined) {
    throw new Error(`Fila no definida: ${metodo} ${ruta} ${variante ?? ''}`);
  }
  return fila;
}

/** Usuario con sesión real y un refresh token vigente (para probar la revocación). */
export async function usuarioConSesion(rol: 'supervisor' | 'jefe' | 'admin') {
  const usuario = await crearUsuarioConClave(rol);
  const sesionIniciada = await iniciarSesion(usuario);
  return { usuario, sesion: sesionIniciada };
}
