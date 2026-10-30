// Tarea 2.5 — CSRF por Origin en TODAS las rutas que cambian estado (docs/spec.md §5; ADR 0008
// punto 5). Los casos salen de la misma tabla que la matriz (`FILAS`): cada ruta POST/PUT/PATCH
// registrada responde 403 ORIGEN_INVALIDO sin `Origin` o con uno ajeno, aunque la petición sea
// válida en todo lo demás (token del rol permitido y cuerpo correcto), y no escribe nada.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Actor,
  type ActorConSesion,
  crearMundo,
  enviar,
  FILAS,
  type FilaDeRuta,
  fotoDeLaBase,
  type Mundo,
  nombreDeFila,
  normalizar,
  revisar,
  rutasRegistradas,
  sesionDe,
  sesionPropia,
  tablasModificadas,
} from './fase2-transversal-helpers';
import { api } from './fase2-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let mundo: Mundo;

beforeAll(async () => {
  mundo = await crearMundo();
});

const ORIGENES_AJENOS: readonly (string | null)[] = [
  null,
  'https://evil.example',
  'null',
  // Casi iguales al propio origen (https://catmetal.test): otro esquema, otro puerto, un sufijo.
  'http://catmetal.test',
  'https://catmetal.test:8443',
  'https://catmetal.test.evil.example',
  'https://CATMETAL.test.',
];

/** Filas base que cambian estado (todo salvo GET), una por ruta. */
const ESCRITURAS = FILAS.filter((f) => f.variante === undefined && f.metodo !== 'GET');

/** Actor con el que la petición es válida: el primero con un 2xx esperado, o el primero con token. */
function actorValido(fila: FilaDeRuta): ActorConSesion {
  const candidatos = (['jefe', 'admin', 'supervisor'] as const).filter(
    (a) => fila.esperado[a] !== undefined,
  );
  const exitoso = candidatos.find((a) => {
    const celda = fila.esperado[a];
    return celda !== undefined && normalizar(celda).estado < 300;
  });
  return exitoso ?? candidatos[0] ?? 'admin';
}

async function tokenValido(fila: FilaDeRuta, actor: ActorConSesion): Promise<string> {
  return fila.sesionPropia === true
    ? (await sesionPropia(actor)).token
    : sesionDe(mundo, actor).token;
}

describe('la lista de rutas que cambian estado', () => {
  it('coincide con las rutas no-GET que Hono tiene registradas bajo /api/v1', () => {
    const registradas = rutasRegistradas().filter((r) => !r.startsWith('GET '));
    expect(ESCRITURAS.map((f) => `${f.metodo} ${f.ruta}`).sort()).toEqual(registradas);
    expect(ESCRITURAS.length).toBe(18);
  });
});

describe('CSRF: toda ruta que cambia estado exige un Origin propio', () => {
  it.each(ESCRITURAS.map((f) => [nombreDeFila(f), f] as const))(
    '%s responde 403 ORIGEN_INVALIDO sin Origin o con uno ajeno, sin escribir nada',
    async (_nombre, fila) => {
      const actor = actorValido(fila);
      const token = await tokenValido(fila, actor);
      const peticion = await fila.preparar(mundo);
      const antes = await fotoDeLaBase();

      for (const origen of ORIGENES_AJENOS) {
        for (const conToken of [true, false]) {
          const respuesta = await enviar(peticion, {
            token: conToken ? token : undefined,
            origen,
          });
          const revisada = await revisar(respuesta, peticion);
          expect(
            { estado: revisada.estado, code: revisada.code },
            `origen ${String(origen)} con token ${String(conToken)}`,
          ).toEqual({ estado: 403, code: 'ORIGEN_INVALIDO' });
        }
      }

      expect(tablasModificadas(antes, await fotoDeLaBase())).toEqual([]);
    },
  );

  it.each(ESCRITURAS.map((f) => [nombreDeFila(f), f] as const))(
    '%s con el Origin correcto sí llega a la ruta (control: el 403 era solo por el origen)',
    async (_nombre, fila) => {
      const actor = actorValido(fila);
      const peticion = await fila.preparar(mundo);
      const esperado = normalizar(fila.esperado[actor] ?? 0);
      const respuesta = await enviar(peticion, { token: await tokenValido(fila, actor) });
      const revisada = await revisar(respuesta, peticion);
      expect({ estado: revisada.estado, code: revisada.code }).toEqual({
        estado: esperado.estado,
        code: esperado.code,
      });
    },
  );
});

describe('CSRF: casos adicionales', () => {
  it('un origen de desarrollo configurado en ORIGENES_DEV se acepta (solo local)', async () => {
    const peticion = { metodo: 'POST', ruta: '/auth/refresh' };
    const respuesta = await enviar(peticion, { origen: 'http://localhost:5173' });
    const revisada = await revisar(respuesta, peticion);
    // Pasa el filtro de origen y llega al refresh, que sin cookie responde TOKEN_INVALIDO.
    expect({ estado: revisada.estado, code: revisada.code }).toEqual({
      estado: 401,
      code: 'TOKEN_INVALIDO',
    });
  });

  it('los métodos seguros (GET) no exigen Origin ni se rechazan por uno ajeno', async () => {
    for (const origen of [null, 'https://evil.example']) {
      const respuesta = await api('/health', { token: mundo.jefe.token });
      expect(respuesta.status).toBe(200);
      const conOrigen = await enviar({ metodo: 'GET', ruta: '/health' }, { origen });
      expect(conOrigen.status).toBe(200);
    }
  });

  it('el rechazo por origen ocurre antes de autenticar: sin token tampoco responde 401', async () => {
    const peticion = { metodo: 'POST', ruta: '/materials', json: {} };
    const respuesta = await enviar(peticion, { origen: 'https://evil.example' });
    const revisada = await revisar(respuesta, peticion);
    expect(revisada.code).toBe('ORIGEN_INVALIDO');
  });

  it('los casos cubren los tres métodos que escriben y a los tres roles', () => {
    const metodos = new Set(ESCRITURAS.map((f) => f.metodo));
    expect([...metodos].sort()).toEqual(['PATCH', 'POST', 'PUT']);
    const actores = new Set<Actor>(ESCRITURAS.map(actorValido));
    expect([...actores].sort()).toEqual(['admin', 'jefe', 'supervisor']);
  });
});
