// Servidor de autenticación simulado para las pruebas del cliente (solo la red se simula; IndexedDB
// es la real de fake-indexeddb). Reproduce el contrato de `apps/worker/src/rutas/auth.ts`:
// respuestas `RespuestaSesion`, errores `{ code, message }` con su estado HTTP, una sola cookie
// `mp_refresh` por origen (la del último login) y logout por cookie o, sin cookie, por Bearer.

import {
  crearError,
  ESTADO_HTTP_POR_CODIGO,
  permisosDeRol,
  uuidv7,
  type CodigoError,
  type Perfil,
  type RespuestaSesion,
  type Rol,
} from '@catmetal/shared';

export interface PeticionRegistrada {
  ruta: string;
  metodo: string;
  autorizacion: string | null;
  credenciales: RequestCredentials | undefined;
  cuerpo: string | null;
}

interface UsuarioFalso {
  perfil: Perfil;
  password: string;
}

export interface ServidorFalso {
  fetch: typeof fetch;
  peticiones: PeticionRegistrada[];
  agregarUsuario(nombre: string, email: string, password: string, rol?: Rol): Perfil;
  /** Dueño de la cookie `mp_refresh` del navegador, o `null`. */
  duenoCookie(): string | null;
  /** Simula la red: `caido` lanza TypeError (sin conexión); `error500` responde 500. */
  modo: 'normal' | 'caido' | 'error500';
  latenciaMs: number;
  /** Fuerza que el próximo login responda este error. */
  forzarErrorLogin: CodigoError | null;
  /** Invalida un access token (el middleware responderá NO_AUTENTICADO). */
  invalidarToken(token: string): void;
  /** Revoca la familia del usuario (el middleware responderá SESION_REVOCADA). */
  revocarUsuario(userId: string): void;
  maxRefrescosSimultaneos: number;
  peticionesA(ruta: string): PeticionRegistrada[];
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(code: CodigoError): Response {
  return json(crearError(code), ESTADO_HTTP_POR_CODIGO[code]);
}

export function crearServidorFalso(): ServidorFalso {
  const usuarios = new Map<string, UsuarioFalso>();
  const tokens = new Map<string, string>();
  const revocados = new Set<string>();
  const peticiones: PeticionRegistrada[] = [];
  let cookie: string | null = null;
  let dispositivoCookie = '';
  let refrescosEnCurso = 0;

  function emitir(userId: string, deviceId: string): Response {
    const usuario = [...usuarios.values()].find((u) => u.perfil.id === userId);
    if (usuario === undefined) {
      return error('SESION_REVOCADA');
    }
    const token = `jwt.${uuidv7()}`;
    tokens.set(token, userId);
    cookie = userId;
    dispositivoCookie = deviceId;
    const cuerpo: RespuestaSesion = {
      access_token: token,
      expira_en: 900,
      device_id: deviceId,
      usuario: usuario.perfil,
    };
    return json(cuerpo);
  }

  const servidor: ServidorFalso = {
    peticiones,
    modo: 'normal',
    latenciaMs: 0,
    forzarErrorLogin: null,
    maxRefrescosSimultaneos: 0,
    agregarUsuario(nombre, email, password, rol = 'supervisor') {
      const perfil: Perfil = { id: uuidv7(), nombre, email, rol, permisos: permisosDeRol(rol) };
      usuarios.set(email, { perfil, password });
      return perfil;
    },
    duenoCookie: () => cookie,
    invalidarToken: (token) => tokens.delete(token),
    revocarUsuario: (userId) => revocados.add(userId),
    peticionesA: (ruta) => peticiones.filter((p) => p.ruta === ruta),
    fetch: async (entrada, init) => {
      const url = new URL(urlDe(entrada), 'http://localhost');
      const cabeceras = new Headers(init?.headers);
      const registrada: PeticionRegistrada = {
        ruta: url.pathname,
        metodo: init?.method ?? 'GET',
        autorizacion: cabeceras.get('Authorization'),
        credenciales: init?.credentials,
        cuerpo: typeof init?.body === 'string' ? init.body : null,
      };
      peticiones.push(registrada);
      if (servidor.modo === 'caido') {
        throw new TypeError('Failed to fetch');
      }
      const esRefresh = registrada.ruta === '/api/v1/auth/refresh';
      if (esRefresh) {
        refrescosEnCurso += 1;
        servidor.maxRefrescosSimultaneos = Math.max(
          servidor.maxRefrescosSimultaneos,
          refrescosEnCurso,
        );
      }
      try {
        if (servidor.latenciaMs > 0) {
          await new Promise((r) => setTimeout(r, servidor.latenciaMs));
        }
        if (servidor.modo === 'error500') {
          return error('ERROR_INTERNO');
        }
        const conCookie = init?.credentials !== 'omit' && cookie !== null;
        const bearer = registrada.autorizacion?.replace(/^Bearer /, '') ?? null;
        const userIdBearer = bearer === null ? undefined : tokens.get(bearer);

        switch (`${registrada.metodo} ${registrada.ruta}`) {
          case 'POST /api/v1/auth/login': {
            const datos = JSON.parse(registrada.cuerpo ?? '{}') as Record<string, string>;
            if (servidor.forzarErrorLogin !== null) {
              const code = servidor.forzarErrorLogin;
              servidor.forzarErrorLogin = null;
              return error(code);
            }
            const usuario = usuarios.get(datos.email ?? '');
            if (usuario === undefined || usuario.password !== datos.password) {
              return error('CREDENCIALES_INVALIDAS');
            }
            revocados.delete(usuario.perfil.id);
            return emitir(usuario.perfil.id, datos.device_id ?? uuidv7());
          }
          case 'POST /api/v1/auth/refresh': {
            if (!conCookie || cookie === null) {
              return error('TOKEN_INVALIDO');
            }
            if (revocados.has(cookie)) {
              cookie = null;
              return error('SESION_REVOCADA');
            }
            return emitir(cookie, dispositivoCookie);
          }
          case 'POST /api/v1/auth/logout': {
            if (conCookie && cookie !== null) {
              revocados.add(cookie);
              cookie = null;
            } else if (userIdBearer !== undefined) {
              revocados.add(userIdBearer);
            }
            return new Response(null, { status: 204 });
          }
          case 'GET /api/v1/prueba': {
            if (userIdBearer === undefined) {
              return error('NO_AUTENTICADO');
            }
            if (revocados.has(userIdBearer)) {
              return error('SESION_REVOCADA');
            }
            return json({ ok: true, user_id: userIdBearer });
          }
          default:
            return error('NO_ENCONTRADO');
        }
      } finally {
        if (esRefresh) {
          refrescosEnCurso -= 1;
        }
      }
    },
  };
  return servidor;
}

/** `LockManager` falso que serializa por nombre (simula Web Locks). */
export function locksFalsos(): {
  request<T>(nombre: string, callback: () => Promise<T>): Promise<T>;
  solicitudes: string[];
} {
  const colas = new Map<string, Promise<unknown>>();
  const solicitudes: string[] = [];
  return {
    solicitudes,
    request<T>(nombre: string, callback: () => Promise<T>): Promise<T> {
      solicitudes.push(nombre);
      const resultado = (colas.get(nombre) ?? Promise.resolve()).then(callback);
      colas.set(
        nombre,
        resultado.catch(() => undefined),
      );
      return resultado;
    },
  };
}

/** URL de la entrada de `fetch` como texto. */
export function urlDe(entrada: RequestInfo | URL): string {
  if (typeof entrada === 'string') {
    return entrada;
  }
  return entrada instanceof URL ? entrada.href : entrada.url;
}
