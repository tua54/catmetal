// Tarea 2.5 — matriz endpoint × rol de TODA la API bajo /api/v1 (docs/spec.md §3 y §7).
//
// La tabla literal vive en `fase2-transversal-helpers.ts` (`FILAS`): una fila por ruta registrada,
// con la regla de la spec que fija el estado esperado de cada actor (supervisor asignado,
// supervisor no asignado, jefe, admin y sin token). La primera prueba compara la tabla contra
// `app.routes` de Hono: si aparece una ruta nueva sin cubrir, falla. Cada celda prepara un
// escenario propio (SQL directo sobre la D1 local real) y llama al Worker real con sesiones reales.
//
// Invariantes que se revisan en CADA respuesta de la matriz: formato único de error, cabeceras de
// seguridad, `Cache-Control` y ausencia de secretos. Además, una respuesta de error o un GET nunca
// escriben en `audit_log`.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACTORES,
  type Actor,
  crearMundo,
  enviar,
  FILAS,
  type FilaDeRuta,
  type Mundo,
  nombreDeFila,
  normalizar,
  revisar,
  rutasDeLaTabla,
  rutasRegistradas,
  sesionPropia,
  sesionDe,
} from './fase2-transversal-helpers';
import { ultimoSeq } from './fase2-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let mundo: Mundo;

beforeAll(async () => {
  mundo = await crearMundo();
});

describe('cobertura: la tabla incluye todas las rutas registradas', () => {
  it('las rutas de la tabla son exactamente las de app.routes bajo /api/v1', () => {
    const registradas = rutasRegistradas();
    const enTabla = rutasDeLaTabla();
    expect(
      registradas.filter((r) => !enTabla.includes(r)),
      'rutas registradas sin fila en la matriz',
    ).toEqual([]);
    expect(
      enTabla.filter((r) => !registradas.includes(r)),
      'filas de la matriz sin ruta registrada',
    ).toEqual([]);
    expect(registradas.length).toBeGreaterThanOrEqual(32);
  });

  it('cada fila base define los cinco actores y cada variante solo cambia actores concretos', () => {
    for (const fila of FILAS) {
      const definidos = Object.keys(fila.esperado);
      if (fila.variante === undefined) {
        expect(definidos.sort(), nombreDeFila(fila)).toEqual([...ACTORES].sort());
      } else {
        expect(definidos.length, nombreDeFila(fila)).toBeGreaterThan(0);
        expect(definidos, nombreDeFila(fila)).not.toContain('sin_token');
      }
    }
  });

  it('toda ruta autenticada responde 401 sin token en la tabla (salvo login, refresh, logout y health)', () => {
    const publicas = new Set([
      'GET /health',
      'POST /auth/login',
      'POST /auth/refresh',
      'POST /auth/logout',
    ]);
    for (const fila of FILAS.filter((f) => f.variante === undefined)) {
      const esperado = normalizar(fila.esperado.sin_token ?? 0);
      if (publicas.has(`${fila.metodo} ${fila.ruta}`)) {
        expect(esperado.code, nombreDeFila(fila)).not.toBe('NO_AUTENTICADO');
      } else {
        expect(esperado, nombreDeFila(fila)).toEqual({ estado: 401, code: 'NO_AUTENTICADO' });
      }
    }
  });
});

async function ejecutarCelda(fila: FilaDeRuta, actor: Actor): Promise<void> {
  const celda = fila.esperado[actor];
  if (celda === undefined) {
    throw new Error('celda sin definir');
  }
  const esperado = normalizar(celda);
  const peticion = await fila.preparar(mundo);
  let token: string | undefined;
  if (actor !== 'sin_token') {
    token =
      fila.sesionPropia === true ? (await sesionPropia(actor)).token : sesionDe(mundo, actor).token;
  }
  const seqAntes = await ultimoSeq();

  const respuesta = await enviar(peticion, { token });
  const revisada = await revisar(respuesta, peticion);

  expect({ estado: revisada.estado, code: revisada.code }, fila.regla).toEqual({
    estado: esperado.estado,
    code: esperado.code,
  });
  if (esperado.estado >= 400 || peticion.metodo === 'GET') {
    expect(await ultimoSeq(), 'un error o un GET no deja filas de auditoría').toBe(seqAntes);
  }
}

describe('matriz endpoint × rol', () => {
  for (const fila of FILAS) {
    describe(nombreDeFila(fila), () => {
      for (const actor of ACTORES) {
        const celda = fila.esperado[actor];
        if (celda === undefined) {
          continue;
        }
        const esperado = normalizar(celda);
        const resultado =
          esperado.code === undefined
            ? String(esperado.estado)
            : `${esperado.estado} ${esperado.code}`;
        it(`${actor} → ${resultado}`, async () => {
          await ejecutarCelda(fila, actor);
        });
      }
    });
  }
});

describe('token inválido en rutas autenticadas', () => {
  const protegidas = FILAS.filter(
    (f) =>
      f.variante === undefined && normalizar(f.esperado.sin_token ?? 0).code === 'NO_AUTENTICADO',
  );

  it.each(protegidas.map((f) => [nombreDeFila(f), f] as const))(
    '%s con un Bearer que no es un JWT responde 401 NO_AUTENTICADO',
    async (_nombre, fila) => {
      const peticion = await fila.preparar(mundo);
      const respuesta = await enviar(peticion, { token: 'esto-no-es-un-jwt' });
      const revisada = await revisar(respuesta, peticion);
      expect({ estado: revisada.estado, code: revisada.code }).toEqual({
        estado: 401,
        code: 'NO_AUTENTICADO',
      });
    },
  );
});

describe('métodos no registrados', () => {
  // No existe ningún DELETE en la API (nada de negocio se borra; docs/spec.md §7).
  const rutas = rutasDeLaTabla().map((clave) => clave.split(' ')[1] ?? '');

  it.each([...new Set(rutas)])('DELETE %s responde 404 con el formato único', async (plantilla) => {
    const ruta = plantilla.replace(/:id/g, '018f0000-0000-7000-8000-000000000000');
    const peticion = { metodo: 'DELETE', ruta };
    const respuesta = await enviar(peticion, { token: mundo.admin.token });
    const revisada = await revisar(respuesta, peticion);
    expect({ estado: revisada.estado, code: revisada.code }).toEqual({
      estado: 404,
      code: 'NO_ENCONTRADO',
    });
  });
});
