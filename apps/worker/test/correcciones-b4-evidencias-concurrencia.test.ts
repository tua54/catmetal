// B4 (docs/correcciones-v1.1.md): una subida concurrente de la misma foto nunca borra de R2 un
// objeto que otra subida ya confirmó en D1. La clave de R2 es fija por evidencia
// (`evidencias/<order_id>/<evidence_id>`, spec §6) e inmutable en D1 (trigger `evidences_inmutable`),
// y el contenido aceptado es siempre el mismo (sha256 y tamaño declarados): la subida que falla al
// confirmar NO borra el objeto. D1 y R2 locales reales; solo se inyecta la confirmación para forzar
// el entrelazado de forma determinista.
import type { Evidencia } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/dominio/evidencias';
import { ejecutarPlan, type PlanDeEscritura } from '../src/dominio/plan';
import { manejarError, manejarNoEncontrado } from '../src/errores';
import { crearRutasEvidencias, type OpcionesRutasEvidencias } from '../src/rutas/evidencias';
import type { AppEnv } from '../src/tipos';
import {
  type Archivo,
  archivo,
  cuerpoConsumo,
  cuerpoNovedad,
  descargar,
  escenarioOrden,
  jpeg,
  novedadOk,
  registrarOk,
  subir,
} from './fase2-consumos-helpers';
import { auditoriaDesde, sesion, type SesionDeRol, ultimoSeq } from './fase2-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let jefe: SesionDeRol;
let supervisor: SesionDeRol;

beforeAll(async () => {
  [jefe, supervisor] = await Promise.all([sesion('jefe'), sesion('supervisor')]);
});

/** Novedad del supervisor con la foto declarada (todavía sin subir). */
async function declarar(foto: Archivo): Promise<void> {
  const esc = await escenarioOrden(jefe, supervisor);
  const consumo = await registrarOk(supervisor.token, cuerpoConsumo(esc.orden, esc.material));
  await novedadOk(supervisor.token, consumo.id, cuerpoNovedad(consumo.id, [foto]));
}

/** Promesa que se resuelve desde fuera (para pausar una petición en un punto exacto). */
function compuerta(): { abrir: () => void; abierta: Promise<void> } {
  let abrir: () => void = () => undefined;
  const abierta = new Promise<void>((resolver) => {
    abrir = resolver;
  });
  return { abrir, abierta };
}

/** Sub-app de evidencias con los middlewares reales y la confirmación en D1 inyectada. */
function appCon(
  confirmarSubida: OpcionesRutasEvidencias['confirmarSubida'],
  reloj?: OpcionesRutasEvidencias['reloj'],
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(manejarError);
  app.notFound(manejarNoEncontrado);
  app.route('/api/v1', crearRutasEvidencias({ confirmarSubida, reloj }));
  return app;
}

function subirCon(app: Hono<AppEnv>, foto: Archivo): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/v1/evidences/${foto.id}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${supervisor.token}`, 'Content-Type': foto.mime },
        body: foto.bytes,
      },
      env,
    ),
  );
}

/** Pausa la confirmación (ya escrito el objeto en R2) hasta que la prueba la suelte. */
function confirmacionPausada() {
  const llego = compuerta();
  const soltar = compuerta();
  const confirmar = async (db: D1Database, plan: PlanDeEscritura<Evidencia>) => {
    llego.abrir();
    await soltar.abierta;
    return ejecutarPlan(db, plan);
  };
  return { llego, soltar, confirmar };
}

/** Confirmación que falla antes de llegar a D1 (fallo transitorio simulado: nada se escribe). */
async function confirmacionFallida(): Promise<Evidencia> {
  await Promise.resolve();
  throw new Error('fallo transitorio de D1 (simulado)');
}

interface EstadoFinal {
  subido: number;
  sha256: string;
  /** sha256 del objeto de R2 en la `storage_key` de D1, o `null` si no existe. */
  sha256EnR2: string | null;
}

async function estadoFinal(id: string): Promise<EstadoFinal> {
  const fila = await env.DB.prepare(
    'SELECT storage_key, sha256, subido FROM evidences WHERE id = ?',
  )
    .bind(id)
    .first<{ storage_key: string; sha256: string; subido: number }>();
  if (fila === null) {
    throw new Error(`evidencia ${id} inexistente`);
  }
  const objeto = await env.EVIDENCE.get(fila.storage_key);
  const sha256EnR2 =
    objeto === null ? null : await sha256Hex(new Uint8Array(await objeto.arrayBuffer()));
  return { subido: fila.subido, sha256: fila.sha256, sha256EnR2 };
}

async function accionesSubida(desde: number, id: string): Promise<number> {
  return (await auditoriaDesde(desde)).filter(
    (f) => f.accion === 'evidencia.subida' && f.entidad_id === id,
  ).length;
}

describe('B4: subidas concurrentes de la misma evidencia', () => {
  it('la que falla al confirmar no borra el objeto que otra confirma después', async () => {
    const foto = await archivo('image/jpeg', jpeg(4096));
    await declarar(foto);
    const antes = await ultimoSeq();

    // A escribe en R2 y se detiene antes de confirmar en D1.
    const pausa = confirmacionPausada();
    const respuestaA = subirCon(appCon(pausa.confirmar), foto);
    await pausa.llego.abierta;

    // B escribe en R2 (misma clave, mismo contenido) y su confirmación falla: D1 sigue en 0.
    const respuestaB = await subirCon(appCon(confirmacionFallida), foto);
    expect(respuestaB.status).toBe(500);

    // A confirma: D1 la da por subida, así que el objeto TIENE que estar en R2.
    pausa.soltar.abrir();
    const a = await respuestaA;
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ id: foto.id, subido: true, sha256: foto.sha256 });

    expect(await estadoFinal(foto.id)).toEqual({
      subido: 1,
      sha256: foto.sha256,
      sha256EnR2: foto.sha256,
    });
    expect(await accionesSubida(antes, foto.id)).toBe(1);
    const descarga = await descargar(supervisor.token, foto.id);
    expect(descarga.status).toBe(200);
    expect(new Uint8Array(await descarga.arrayBuffer())).toEqual(foto.bytes);
  });

  it('la que pierde la confirmación (otra ya confirmó) responde 200 y conserva el objeto', async () => {
    const foto = await archivo('image/jpeg', jpeg(4096));
    await declarar(foto);
    const antes = await ultimoSeq();

    const pausa = confirmacionPausada();
    const respuestaA = subirCon(appCon(pausa.confirmar), foto);
    await pausa.llego.abierta;

    // B completa la subida entera mientras A está detenida entre R2 y D1.
    const b = await subirCon(appCon(undefined), foto);
    expect(b.status).toBe(200);

    // A ya no aplica en D1 (subido = 1): idempotente, sin auditoría extra y sin tocar R2.
    pausa.soltar.abrir();
    const a = await respuestaA;
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ id: foto.id, subido: true, sha256: foto.sha256 });

    expect(await estadoFinal(foto.id)).toEqual({
      subido: 1,
      sha256: foto.sha256,
      sha256EnR2: foto.sha256,
    });
    expect(await accionesSubida(antes, foto.id)).toBe(1);
  });

  it('si la confirmación falla, el objeto queda en R2 y el reintento lo confirma', async () => {
    const foto = await archivo('image/jpeg', jpeg(4096));
    await declarar(foto);

    const fallida = await subirCon(appCon(confirmacionFallida), foto);
    expect(fallida.status).toBe(500);
    // Sin confirmar en D1, pero el objeto (contenido verificado) se conserva en su clave fija.
    expect(await estadoFinal(foto.id)).toEqual({
      subido: 0,
      sha256: foto.sha256,
      sha256EnR2: foto.sha256,
    });
    expect((await descargar(supervisor.token, foto.id)).status).toBe(404);

    // El cliente reintenta: sobrescribe el mismo objeto y confirma.
    const reintento = await subir(supervisor.token, foto.id, foto.bytes, 'image/jpeg');
    expect(reintento.status).toBe(200);
    expect(await estadoFinal(foto.id)).toEqual({
      subido: 1,
      sha256: foto.sha256,
      sha256EnR2: foto.sha256,
    });
  });

  it('varias subidas simultáneas por el Worker real: una confirma, todas 200, objeto íntegro', async () => {
    const foto = await archivo('image/jpeg', jpeg(64 * 1024));
    await declarar(foto);
    const otra = await archivo('image/jpeg', jpeg(64 * 1024));
    const antes = await ultimoSeq();

    const [iguales, distinta] = await Promise.all([
      Promise.all(
        Array.from({ length: 5 }, () => subir(supervisor.token, foto.id, foto.bytes, 'image/jpeg')),
      ),
      // Otros bytes para la misma evidencia: nunca llegan a R2 (sha256 distinto del declarado) o,
      // si la evidencia ya figura subida, 409.
      subir(supervisor.token, foto.id, otra.bytes, 'image/jpeg'),
    ]);

    expect(iguales.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const r of iguales) {
      expect(await r.json()).toMatchObject({ id: foto.id, subido: true, sha256: foto.sha256 });
    }
    expect([400, 409]).toContain(distinta.status);
    const { code } = await distinta.json<{ code: string }>();
    expect(['VALIDACION', 'EVIDENCIA_YA_SUBIDA']).toContain(code);

    expect(await estadoFinal(foto.id)).toEqual({
      subido: 1,
      sha256: foto.sha256,
      sha256EnR2: foto.sha256,
    });
    expect(await accionesSubida(antes, foto.id)).toBe(1);
  });
  // A1 (docs/correcciones-v1.2.md): la prueba anterior depende del azar (que dos subidas calculen
  // el mismo milisegundo). Esta lo fuerza: dos subidas por la ruta real, con el MISMO `ahora`,
  // ambas detenidas después de escribir en R2 y antes de confirmar (las dos leyeron `subido = 0`).
  // Se sueltan juntas y D1 las serializa: una confirma y la otra no aplica.
  it('dos confirmaciones con el mismo ahora (determinista): una sola evidencia.subida', async () => {
    const foto = await archivo('image/jpeg', jpeg(4096));
    await declarar(foto);
    const antes = await ultimoSeq();
    const ahora = new Date(Date.now() + 120_000).toISOString();

    const todas = compuerta();
    let llegadas = 0;
    const confirmar = async (db: D1Database, plan: PlanDeEscritura<Evidencia>) => {
      llegadas += 1;
      if (llegadas === 2) {
        todas.abrir();
      }
      await todas.abierta;
      return ejecutarPlan(db, plan);
    };
    const app = appCon(confirmar, () => ahora);
    const respuestas = await Promise.all([subirCon(app, foto), subirCon(app, foto)]);

    expect(llegadas).toBe(2);
    expect(respuestas.map((r) => r.status)).toEqual([200, 200]);
    for (const r of respuestas) {
      expect(await r.json()).toMatchObject({ id: foto.id, subido: true, subido_at: ahora });
    }
    expect(await estadoFinal(foto.id)).toEqual({
      subido: 1,
      sha256: foto.sha256,
      sha256EnR2: foto.sha256,
    });
    expect(await accionesSubida(antes, foto.id)).toBe(1);
  });
});
