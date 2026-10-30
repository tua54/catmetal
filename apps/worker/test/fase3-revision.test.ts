// Tarea 3.8 — correcciones del servidor de la revisión de la Fase 3
// (docs/auditoria/revision-esquema-fase-3.md; ADR 0016): A1 (época en el push), M2 (idempotencia
// por clave natural), B2 (fila `aplicada` registrada), B3 (clasificador sin el sufijo de D1) y B7
// (contención agotada y cupo del pull). Worker real, sesiones reales y D1 local real (sin mocks).
import { type Consumo, type ResultadoMutacion, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { esErrorDeRestriccion, traducirErrorD1 } from '../src/dominio/errores-d1';
import { escenarioOrden, novedadOk, registrarOk } from './fase2-consumos-helpers';
import {
  api,
  asignar,
  esperarError,
  nuevoConsumo,
  sesion,
  type SesionDeRol,
  supervisorConDispositivo,
  ultimoSeq,
} from './fase2-helpers';
import { fotoDeLaBase, tablasModificadas } from './fase2-transversal-helpers';
import {
  contar,
  crearConsumo,
  crearNovedadMut,
  dbConInterferencia,
  decidirMut,
  editarConsumoMut,
  filaAuditoria,
  filaSync,
  insertar,
  llamarConDb,
  type MutacionPrueba,
  pullOk,
  pushOk,
  rellenarAuditoria,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;
let jefe: SesionDeRol;

beforeAll(async () => {
  [supervisor, otroSupervisor, jefe] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function epocaActual(): Promise<string> {
  const fila = await env.DB.prepare("SELECT valor FROM settings WHERE clave = 'sync_epoca'").first<{
    valor: string;
  }>();
  return JSON.parse(fila?.valor ?? '""') as string;
}

function pushConEpoca(s: SesionDeRol, mutaciones: unknown[], epoca?: string, userId?: string) {
  return api('/sync/push', {
    token: s.token,
    body: {
      user_id: userId ?? s.usuario.id,
      ...(epoca === undefined ? {} : { epoca }),
      mutaciones,
    },
  });
}

describe('A1: época en el sobre del push', () => {
  it('una época vieja → 409 EPOCA_CAMBIADA sin escribir nada (ni sync_mutations, ni auditoría, ni el dispositivo)', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const antes = await fotoDeLaBase();
    const respuesta = await pushConEpoca(
      supervisor,
      [crearConsumo(orden, material)],
      'epoca-de-antes-de-restaurar',
    );
    await esperarError(respuesta, 409, 'EPOCA_CAMBIADA');
    expect(tablasModificadas(antes, await fotoDeLaBase())).toEqual([]);
  });

  it('con la época correcta o sin época, procesa', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    for (const epoca of [await epocaActual(), undefined]) {
      const respuesta = await pushConEpoca(supervisor, [crearConsumo(orden, material)], epoca);
      expect(respuesta.status, await respuesta.clone().text()).toBe(200);
      const { resultados } = await respuesta.json<{ resultados: ResultadoMutacion[] }>();
      expect(resultados[0]?.resultado).toBe('aplicada');
    }
  });

  it('AUTOR_NO_COINCIDE se comprueba antes que la época', async () => {
    const respuesta = await pushConEpoca(supervisor, [{}], 'vieja', otroSupervisor.usuario.id);
    await esperarError(respuesta, 403, 'AUTOR_NO_COINCIDE');
  });
});

describe('M2: idempotencia por clave natural (entidad sin su fila de sync_mutations)', () => {
  /** Payload de `consumo.crear` y la misma creación hecha por REST (no escribe sync_mutations). */
  async function consumoPorRest(): Promise<{ m: MutacionPrueba; consumo: Consumo }> {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material);
    const consumo = await registrarOk(supervisor.token, m.payload);
    expect(await contar('sync_mutations', 'mutation_id = ?', m.mutation_id)).toBe(0);
    return { m, consumo };
  }

  it('consumo.crear de un consumo que ya existe con la misma clave natural → aplicada y guardada como aplicada', async () => {
    const { m, consumo } = await consumoPorRest();
    const seq = await ultimoSeq();
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);

    expect(r).toMatchObject({ resultado: 'aplicada', servidor: { id: consumo.id, version: 1 } });
    expect(r?.servidor).toEqual(JSON.parse(JSON.stringify(consumo)));
    const fila = await filaSync(m.mutation_id);
    expect(fila).toMatchObject({ resultado: 'aplicada', payload_json: null });
    expect(await contar('consumptions', 'id = ?', consumo.id)).toBe(1);
    expect(await ultimoSeq(), 'no se reaplica: ninguna auditoría nueva').toBe(seq);
    // Reenvío: la respuesta guardada.
    expect(await pushOk(supervisor.token, supervisor.usuario.id, [m])).toEqual([r]);
  });

  it('si la clave natural no coincide sigue siendo rechazada ID_DUPLICADO', async () => {
    const { m } = await consumoPorRest();
    const otraHora = {
      ...m,
      mutation_id: uuidv7(),
      payload: { ...m.payload, client_created_at: new Date(Date.now() - 60_000).toISOString() },
    };
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [otraHora]);
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'ID_DUPLICADO' });
    expect(r?.servidor).toBeUndefined();

    // Otro autor con los mismos datos tampoco (no se reconoce lo de otro como propio).
    const { orden } = await escenarioOrden(jefe, otroSupervisor);
    await asignar(String(m.payload.order_id), otroSupervisor.usuario.id, jefe.usuario.id);
    void orden;
    const ajena = { ...m, mutation_id: uuidv7() };
    const [r2] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [ajena]);
    expect(r2).toMatchObject({ resultado: 'rechazada', code: 'ID_DUPLICADO' });
  });

  it('novedad.crear ya registrada por REST → aplicada con sus evidencias', async () => {
    const { consumo } = await consumoPorRest();
    const n = crearNovedadMut(consumo.id);
    const creada = await novedadOk(supervisor.token, consumo.id, n.payload);
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [n]);
    expect(r).toMatchObject({ resultado: 'aplicada' });
    expect(r?.servidor).toEqual(JSON.parse(JSON.stringify(creada)));
    expect((await filaSync(n.mutation_id))?.resultado).toBe('aplicada');
  });

  it('consumo.aprobar ya aplicado por REST con la misma decisión → aplicada; con otra decisión → ID_DUPLICADO', async () => {
    const { consumo } = await consumoPorRest();
    const m = decidirMut('aprobar', consumo.id, 1);
    const rest = await api(`/consumptions/${consumo.id}/approve`, {
      token: jefe.token,
      body: { id: m.payload.id, version: 1, client_created_at: m.payload.client_created_at },
    });
    expect(rest.status).toBe(201);
    const [r] = await pushOk(jefe.token, jefe.usuario.id, [m]);
    expect(r).toMatchObject({
      resultado: 'aplicada',
      servidor: {
        consumo: { id: consumo.id, estado: 'aprobado', version: 2 },
        validacion: { id: m.payload.id, decision: 'aprobado', validado_por: jefe.usuario.id },
      },
    });

    const rechazo = { ...decidirMut('rechazar', consumo.id, 1), mutation_id: uuidv7() };
    rechazo.payload.id = m.payload.id;
    const [r2] = await pushOk(jefe.token, jefe.usuario.id, [rechazo]);
    expect(r2).toMatchObject({ resultado: 'rechazada', code: 'ID_DUPLICADO' });
  });
});

describe('B2: la fila aplicada de sync_mutations', () => {
  it('cada tipo de mutación aplicada deja su fila aplicada con la respuesta devuelta', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const crear = crearConsumo(orden, material);
    const crear2 = crearConsumo(orden, material);
    const crear3 = crearConsumo(orden, material);
    const [rc, ,] = await pushOk(supervisor.token, supervisor.usuario.id, [crear, crear2, crear3]);
    expect(rc?.resultado).toBe('aplicada');
    const deSupervisor = [
      editarConsumoMut(String(crear.payload.id), 1),
      crearNovedadMut(String(crear.payload.id)),
    ];
    const deJefe = [
      decidirMut('aprobar', String(crear2.payload.id), 1),
      decidirMut('rechazar', String(crear3.payload.id), 1),
    ];
    const resultados = [
      rc,
      ...(await pushOk(supervisor.token, supervisor.usuario.id, deSupervisor)),
      ...(await pushOk(jefe.token, jefe.usuario.id, deJefe)),
    ];
    const mutaciones = [crear, ...deSupervisor, ...deJefe];
    expect(mutaciones.map((m) => m.tipo)).toEqual([
      'consumo.crear',
      'consumo.editar',
      'novedad.crear',
      'consumo.aprobar',
      'consumo.rechazar',
    ]);
    for (const [i, m] of mutaciones.entries()) {
      const fila = await filaSync(m.mutation_id);
      const r = resultados[i];
      expect(fila, m.tipo).toMatchObject({
        resultado: 'aplicada',
        tipo: m.tipo,
        payload_json: null,
      });
      expect(JSON.parse(fila?.respuesta_json ?? 'null'), m.tipo).toEqual({
        resultado: r?.resultado,
        servidor: r?.servidor,
      });
    }
  });

  it('si la fila aplicada no se inserta, responde aplicada igual, registra el error y el reenvío la reconoce', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material);
    const trigger = `tmp_sin_fila_sync_${uuidv7().replaceAll('-', '')}`;
    // RAISE(IGNORE): SQLite omite el INSERT sin error, así que `meta.changes` de esa sentencia es 0.
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON sync_mutations
       WHEN NEW.mutation_id = '${m.mutation_id}' BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let r: ResultadoMutacion | undefined;
    try {
      [r] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
    }
    const eventos = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    log.mockRestore();

    expect(r).toMatchObject({ resultado: 'aplicada', servidor: { id: m.payload.id } });
    expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(1);
    expect(await filaSync(m.mutation_id)).toBeNull();
    const evento = eventos.find((e) => e.evento === 'sync_mutation_no_registrada');
    expect(evento).toEqual({
      nivel: 'error',
      evento: 'sync_mutation_no_registrada',
      hora: expect.any(String) as string,
      mutation_id: m.mutation_id,
      tipo: 'consumo.crear',
    });

    // El reenvío (respuesta perdida) se reconoce por clave natural y ahora sí queda guardado.
    const [reenvio] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    expect(reenvio).toMatchObject({ resultado: 'aplicada', servidor: { id: m.payload.id } });
    expect((await filaSync(m.mutation_id))?.resultado).toBe('aplicada');
    expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(1);
  });
});

describe('B3: clasificador de errores de D1 sin el sufijo SQLITE_CONSTRAINT', () => {
  const error = (mensaje: string) => new Error(mensaje);

  it.each([
    ['UNIQUE constraint failed: consumptions.id', 'ID_DUPLICADO'],
    ['D1_ERROR: unique constraint failed: sync_mutations.mutation_id', 'ID_DUPLICADO'],
    ['D1_ERROR: UNIQUE constraint failed: production_orders.codigo', 'CONFLICTO'],
    [
      'UNIQUE constraint failed: order_supervisors.order_id, order_supervisors.user_id',
      'CONFLICTO',
    ],
    ['CHECK constraint failed: consumptions_cantidad_positiva', 'VALIDACION'],
    ['NOT NULL constraint failed: consumptions.lote', 'VALIDACION'],
    ['FOREIGN KEY constraint failed', 'CONFLICTO'],
    ['D1_ERROR: un consumo aprobado o rechazado es inmutable', 'CONSUMO_NO_PENDIENTE'],
    ['Error: nadie valida un consumo que registró', 'AUTOAPROBACION'],
    ['transición de estado de orden no permitida', 'ESTADO_ORDEN_INVALIDO'],
    ['D1_ERROR: alguna restricción desconocida: SQLITE_CONSTRAINT', 'CONFLICTO'],
  ])('«%s» → %s (nunca transitorio)', (mensaje, codigo) => {
    expect(esErrorDeRestriccion(error(mensaje))).toBe(true);
    expect(traducirErrorD1(error(mensaje))?.code).toBe(codigo);
  });

  it('con el código extendido se respeta la distinción PK/UNIQUE', () => {
    const unicoEnId =
      'D1_ERROR: UNIQUE constraint failed: audit_log.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)';
    expect(traducirErrorD1(error(unicoEnId))?.code).toBe('CONFLICTO');
    expect(traducirErrorD1(error('UNIQUE constraint failed: consumptions.id'))?.details).toEqual({
      entidad: 'consumptions',
      campos: ['id'],
    });
  });

  it('los errores que no son de restricción siguen siendo transitorios (null)', () => {
    for (const mensaje of [
      'D1_ERROR: Network connection lost.',
      'D1_ERROR: D1 DB is overloaded. Too many requests queued.',
      'D1_ERROR: malformed JSON: SQLITE_ERROR',
    ]) {
      expect(esErrorDeRestriccion(error(mensaje)), mensaje).toBe(false);
      expect(traducirErrorD1(error(mensaje)), mensaje).toBeNull();
    }
    expect(traducirErrorD1('no es un Error')).toBeNull();
  });
});

describe('B7: ramas críticas', () => {
  it('contención agotada: la principal no aplica en los 3 intentos → la mutación queda sin resultado y sin fila', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    const otro = await supervisorConDispositivo();
    let interferencias = 0;
    // Antes de cada batch de escritura, otra "petición" registra de verdad un consumo del mismo
    // material: el acumulado leído deja de valer y la sentencia principal no aplica.
    const db = dbConInterferencia('INSERT INTO sync_mutations', async () => {
      interferencias += 1;
      await nuevoConsumo({
        orderId: orden,
        materialId: material,
        registradoPor: otro.id,
        deviceId: otro.deviceId,
        cantidad: 1,
      });
    });
    const m = crearConsumo(orden, material);
    const siguiente = crearConsumo(orden, material);

    const respuesta = await llamarConDb(db, '/sync/push', {
      token: supervisor.token,
      body: { user_id: supervisor.usuario.id, mutaciones: [m, siguiente] },
    });
    expect(respuesta.status).toBe(200);
    const { resultados } = await respuesta.json<{ resultados: ResultadoMutacion[] }>();

    expect(interferencias).toBe(3);
    expect(resultados).toEqual([]); // se detuvo el lote: ambas siguen pendientes en el cliente
    expect(await filaSync(m.mutation_id)).toBeNull();
    expect(await filaSync(siguiente.mutation_id)).toBeNull();
    expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(0);

    // Sin contención, el reenvío se aplica.
    const reenvio = await pushOk(supervisor.token, supervisor.usuario.id, [m, siguiente]);
    expect(reenvio.map((r) => r.resultado)).toEqual(['aplicada', 'aplicada']);
  });

  it('cupo del pull: 199 cambios + una asignación que produce 2 → se entregan los 199 y el cursor no pasa de lo entregado', async () => {
    const yo = await sesion('supervisor');
    const orden = (await escenarioOrden(jefe, otroSupervisor)).orden;
    const cursor = await ultimoSeq();
    const t = new Date().toISOString();
    const materiales: string[] = [];
    for (let i = 0; i < 199; i += 1) {
      const id = uuidv7();
      materiales.push(id);
      await insertar('materials', {
        id,
        codigo: `MP-B7-${id}`,
        nombre: `Material ${String(i)}`,
        unidad: 'kg',
        costo_unitario_cop: 100,
        activo: 1,
        created_at: t,
        updated_at: t,
      });
    }
    await rellenarAuditoria(materiales.map((id) => filaAuditoria('materials', id)));
    // La asignación del propio supervisor: una fila de auditoría que produce `hidratar` + `upsert`.
    await asignar(orden, yo.usuario.id, jefe.usuario.id);
    await rellenarAuditoria([
      filaAuditoria('order_supervisors', `${orden}:${yo.usuario.id}`, orden),
    ]);
    const seqMaterial199 = (await ultimoSeq()) - 1;

    const primero = await pullOk(yo.token, cursor);
    expect(primero.cambios).toHaveLength(199);
    expect(primero.cambios.every((c) => c.entidad === 'materials')).toBe(true);
    expect(primero.hay_mas).toBe(true);
    expect(primero.cursor).toBe(seqMaterial199);

    const segundo = await pullOk(yo.token, primero.cursor);
    expect(segundo.cambios.map((c) => [c.tipo, c.entidad])).toEqual([
      ['hidratar', 'production_orders'],
      ['upsert', 'order_supervisors'],
    ]);
    expect(segundo.cursor).toBe(await ultimoSeq());
    expect(segundo.hay_mas).toBe(false);
  });
});
