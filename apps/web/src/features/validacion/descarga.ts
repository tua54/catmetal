// Descarga autenticada de binarios de la API (evidencias y CSV). `clienteApi.peticion` interpreta
// siempre el cuerpo como JSON; aquí se necesita el `Blob` tal cual, con el mismo Bearer de la
// sesión (que vive solo en memoria) y el mismo formato de error `{ code, message, details }`.
//
// Nunca se usa `<img src="/api/...">` ni un enlace directo: el navegador no enviaría el token y el
// bucket de evidencias es privado (docs/spec.md §7 y §9).

import { esCodigoError, type CodigoError } from '@catmetal/shared';
import { BASE_API, ErrorApi, ErrorRed, sesion } from '../../auth';

/** Lo que necesita la descarga de la sesión (la real en la app; reemplazable en pruebas). */
export interface ProveedorToken {
  obtenerAccessToken(): Promise<string | null>;
  refrescar(): Promise<string | null>;
}

export interface ArchivoDescargado {
  blob: Blob;
  /** Nombre sugerido por `Content-Disposition: attachment; filename="…"`, si viene. */
  nombre: string | null;
}

async function errorDe(respuesta: Response): Promise<ErrorApi> {
  try {
    const cuerpo = (await respuesta.json()) as unknown;
    if (typeof cuerpo === 'object' && cuerpo !== null && 'code' in cuerpo) {
      const { code, message, details } = cuerpo as Record<string, unknown>;
      if (esCodigoError(code)) {
        return new ErrorApi(
          code,
          respuesta.status,
          typeof message === 'string' ? message : undefined,
          details,
        );
      }
    }
  } catch {
    // Cuerpo vacío o no JSON.
  }
  const code: CodigoError =
    respuesta.status === 401
      ? 'NO_AUTENTICADO'
      : respuesta.status === 403
        ? 'PERMISO_DENEGADO'
        : respuesta.status === 404
          ? 'NO_ENCONTRADO'
          : 'ERROR_INTERNO';
  return new ErrorApi(code, respuesta.status);
}

/** `attachment; filename="OP-2026-0587-consumos.csv"` → `OP-2026-0587-consumos.csv`. */
export function nombreDeDisposicion(cabecera: string | null): string | null {
  const coincidencia = /filename="([^"]+)"/i.exec(cabecera ?? '');
  return coincidencia?.[1] ?? null;
}

async function pedir(ruta: string, token: string): Promise<Response> {
  try {
    return await globalThis.fetch(`${BASE_API}${ruta}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    throw new ErrorRed(undefined, { cause: error });
  }
}

/**
 * `GET` autenticado que devuelve el cuerpo como `Blob`. Ante un 401 refresca el token UNA vez y
 * reintenta, igual que el cliente JSON. Sin red lanza `ErrorRed`; con error HTTP, `ErrorApi`.
 */
export async function descargarAutenticado(
  ruta: string,
  proveedor: ProveedorToken = sesion,
): Promise<ArchivoDescargado> {
  const token = await proveedor.obtenerAccessToken();
  if (token === null) {
    throw new ErrorApi('NO_AUTENTICADO', 401);
  }
  let respuesta = await pedir(ruta, token);
  if (respuesta.status === 401) {
    const nuevo = await proveedor.refrescar();
    if (nuevo === null) {
      throw await errorDe(respuesta);
    }
    respuesta = await pedir(ruta, nuevo);
  }
  if (!respuesta.ok) {
    throw await errorDe(respuesta);
  }
  return {
    blob: await respuesta.blob(),
    nombre: nombreDeDisposicion(respuesta.headers.get('Content-Disposition')),
  };
}

/**
 * Entrega un `Blob` como archivo descargado con `<a download>`. La URL `blob:` se libera después
 * (con un margen: algunos navegadores leen el blob de forma asíncrona tras el clic).
 */
export function guardarArchivo(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombre;
  enlace.rel = 'noopener';
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
