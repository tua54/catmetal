// API simulada para las pruebas del panel del jefe (solo la red se simula; la sesión, Dexie y el
// cliente HTTP son los reales). Responde `/auth/refresh` para dar a la sesión un access token y
// atiende las rutas que cada prueba registre, con el formato de error del contrato.

import {
  crearError,
  ESTADO_HTTP_POR_CODIGO,
  uuidv7,
  type CodigoError,
  type ElementoCola,
  type EventoLineaTiempo,
  type Perfil,
  type ResumenOrden,
  type RespuestaSesion,
} from '@catmetal/shared';
import { expect, vi } from 'vitest';
import { sesion } from '../../../auth';
import { urlDe } from '../../../auth/pruebas/servidor-falso';
import { consumoServidor } from '../../../datos/pruebas/fabricas';
import { entrarSinConexion, fijarConexion } from '../../../test/app';

export interface PeticionJefe {
  metodo: string;
  ruta: string;
  query: URLSearchParams;
  autorizacion: string | null;
  cuerpo: unknown;
}

export type Manejador = (peticion: PeticionJefe) => Response | Promise<Response>;

export function json(cuerpo: unknown, status = 200, cabeceras: HeadersInit = {}): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json', ...cabeceras },
  });
}

export function errorApi(code: CodigoError, details?: unknown): Response {
  return json(crearError(code, details), ESTADO_HTTP_POR_CODIGO[code]);
}

export interface ServidorJefe {
  fetch: typeof fetch;
  peticiones: PeticionJefe[];
  /** Registra el manejador de `METODO /ruta` (ruta sin `/api/v1`, con `:id` literal). */
  en(metodo: string, ruta: string, manejador: Manejador): void;
  peticionesA(metodo: string, ruta: string): PeticionJefe[];
  /** Simula un corte de red (fetch lanza `TypeError`). */
  caido: boolean;
  /** Usuario al que `/auth/refresh` le entrega la sesión. */
  perfil: Perfil | null;
}

export const TOKEN = 'jwt.jefe-de-prueba';

export function crearServidorJefe(): ServidorJefe {
  const rutas = new Map<string, Manejador>();
  const peticiones: PeticionJefe[] = [];
  const servidor: ServidorJefe = {
    peticiones,
    caido: false,
    perfil: null,
    en: (metodo, ruta, manejador) => rutas.set(`${metodo} ${ruta}`, manejador),
    peticionesA: (metodo, ruta) => peticiones.filter((p) => p.metodo === metodo && p.ruta === ruta),
    fetch: (entrada, init) => {
      const url = new URL(urlDe(entrada), 'http://localhost');
      const ruta = url.pathname.replace(/^\/api\/v1/, '');
      const texto = typeof init?.body === 'string' ? init.body : null;
      const peticion: PeticionJefe = {
        metodo: init?.method ?? 'GET',
        ruta,
        query: url.searchParams,
        autorizacion: new Headers(init?.headers).get('Authorization'),
        cuerpo: texto === null ? null : (JSON.parse(texto) as unknown),
      };
      peticiones.push(peticion);
      if (servidor.caido) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (peticion.metodo === 'POST' && ruta === '/auth/refresh') {
        const usuario = servidor.perfil;
        if (usuario === null) {
          return Promise.resolve(errorApi('TOKEN_INVALIDO'));
        }
        const cuerpo: RespuestaSesion = {
          access_token: TOKEN,
          expira_en: 900,
          device_id: uuidv7(),
          usuario,
        };
        return Promise.resolve(json(cuerpo));
      }
      if (peticion.autorizacion !== `Bearer ${TOKEN}`) {
        return Promise.resolve(errorApi('NO_AUTENTICADO'));
      }
      const manejador = rutas.get(`${peticion.metodo} ${ruta}`);
      return Promise.resolve(manejador ? manejador(peticion) : errorApi('NO_ENCONTRADO'));
    },
  };
  return servidor;
}

/** Jefe con sesión del servidor: entra sin conexión (rápido) y luego recupera la sesión online. */
export async function entrarComoJefeEnLinea(
  servidor: ServidorJefe,
  nombre = 'Roberto Méndez',
): Promise<Perfil> {
  const perfil = await entrarSinConexion('jefe', nombre);
  servidor.perfil = perfil;
  vi.stubGlobal('fetch', servidor.fetch);
  fijarConexion(true);
  await sesion.refrescar();
  expect(sesion.estado().modo).toBe('online');
  return perfil;
}

export const ORDEN_A = uuidv7();
export const ORDEN_B = uuidv7();
export const SUPERVISOR_JUAN = uuidv7();
export const SUPERVISOR_ANA = uuidv7();

/** Elemento de la cola con valores del Figma (Resina PET, 125,5 kg, Juan S., 10:24 a. m.). */
export function elementoCola(base: Partial<ElementoCola> = {}): ElementoCola {
  const consumo = consumoServidor({
    order_id: ORDEN_A,
    cantidad: 125.5,
    cantidad_en_unidad_plan: 125.5,
    lote: '4471',
    registrado_por: SUPERVISOR_JUAN,
    client_created_at: '2026-10-29T15:24:00.000Z',
    version: 3,
  });
  return {
    ...consumo,
    material: { id: consumo.material_id, codigo: 'MP-010', nombre: 'Resina PET Grado A' },
    supervisor: { id: SUPERVISOR_JUAN, nombre: 'Juan Suárez' },
    orden: { id: ORDEN_A, codigo: 'OP-2026-0587' },
    falta_novedad: false,
    propio: false,
    novedades: [],
    ...base,
  };
}

export function resumenOrden(base: Partial<ResumenOrden> = {}): ResumenOrden {
  return {
    order_id: ORDEN_A,
    codigo: 'OP-2026-0587',
    linea: 'Moldeo 1',
    estado: 'en_proceso',
    fecha_inicio: '2026-10-29T13:20:00.000Z',
    fecha_fin: null,
    tolerancia_pct: 5,
    materiales: [
      {
        material_id: uuidv7(),
        codigo: 'MP-010',
        nombre: 'Resina PET Grado A',
        unidad: 'kg',
        cantidad_planeada: 100,
        consumido: 125.5,
        porcentaje: 125.5,
        costo_cop: 4_000_000,
        registros: 2,
        excede_tolerancia: true,
      },
    ],
    materiales_fuera_de_plan: [],
    totales: {
      materiales_consumidos: 3,
      costo_total_cop: 4_182_300,
      novedades_abiertas: 1,
      novedades_faltantes: 1,
      pendientes: 3,
      aprobados: 0,
      rechazados: 0,
    },
    ...base,
  };
}

export function eventoLinea(base: Partial<EventoLineaTiempo> = {}): EventoLineaTiempo {
  return {
    seq: 1,
    id: uuidv7(),
    entidad: 'production_orders',
    entidad_id: ORDEN_A,
    accion: 'iniciar',
    tipo: 'sistema',
    descripcion: 'Orden OP-2026-0587 iniciada',
    consumption_id: null,
    actor: null,
    device_id: null,
    client_at: null,
    server_at: '2026-10-29T13:20:00.000Z',
    alerta_reloj: false,
    ...base,
  };
}
