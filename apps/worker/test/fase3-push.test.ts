// Tarea 3.1 — `POST /api/v1/sync/push` (docs/spec.md §6; ADR 0009; ADR 0010; revisión H2).
// Worker real, sesiones reales y D1 local real (sin mocks).
import { type Consumo, MAX_PAYLOAD_MUTACION_BYTES, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { escenarioOrden } from './fase2-consumos-helpers';
import {
  esperarError,
  nuevaOrden,
  nuevoMaterial,
  planear,
  asignar,
  sesion,
  type SesionDeRol,
} from './fase2-helpers';
import { conFalloEnAuditoria, fotoDeLaBase, tablasModificadas } from './fase2-transversal-helpers';
import {
  contar,
  crearConsumo,
  crearNovedadMut,
  decidirMut,
  editarConsumoMut,
  filaSync,
  push,
  pushOk,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;
let jefe: SesionDeRol;
let jefe2: SesionDeRol;
let admin: SesionDeRol;

beforeAll(async () => {
  [supervisor, otroSupervisor, jefe, jefe2, admin] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
    sesion('jefe'),
    sesion('admin'),
  ]);
});

async function consumoAplicado(
  s: SesionDeRol,
  orden: string,
  material: string,
  extra: Record<string, unknown> = {},
): Promise<Consumo> {
  const [r] = await pushOk(s.token, s.usuario.id, [crearConsumo(orden, material, extra)]);
  expect(r?.resultado, JSON.stringify(r)).toBe('aplicada');
  return r?.servidor as unknown as Consumo;
}

describe('idempotencia por mutation_id', () => {
  it('una mutación repetida no duplica y devuelve la misma respuesta', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material);
    const primera = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    const segunda = await pushOk(supervisor.token, supervisor.usuario.id, [m]);

    expect(primera).toEqual(segunda);
    expect(primera[0]).toMatchObject({
      indice: 0,
      mutation_id: m.mutation_id,
      resultado: 'aplicada',
    });
    expect(primera[0]?.servidor).toMatchObject({
      id: m.payload.id,
      registrado_por: supervisor.usuario.id,
      device_id: supervisor.deviceId,
      estado: 'pendiente',
      version: 1,
    });
    expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(1);
    expect(await contar('sync_mutations', 'mutation_id = ?', m.mutation_id)).toBe(1);
    expect(
      await contar('audit_log', "entidad = 'consumptions' AND entidad_id = ?", m.payload.id),
    ).toBe(1);
    const fila = await filaSync(m.mutation_id);
    expect(fila).toMatchObject({
      user_id: supervisor.usuario.id,
      device_id: supervisor.deviceId,
      tipo: 'consumo.crear',
      resultado: 'aplicada',
      payload_json: null,
    });
  });

  it('en concurrencia (dos pushes del mismo lote a la vez) tampoco duplica', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const crear = crearConsumo(orden, material);
    const lote = [crear, crearNovedadMut(String(crear.payload.id))];

    const [a, b] = await Promise.all([
      pushOk(supervisor.token, supervisor.usuario.id, lote),
      pushOk(supervisor.token, supervisor.usuario.id, lote),
    ]);

    expect(a.map((r) => r.resultado)).toEqual(['aplicada', 'aplicada']);
    expect(b).toEqual(a);
    expect(await contar('consumptions', 'id = ?', crear.payload.id)).toBe(1);
    expect(await contar('incidents', 'consumption_id = ?', crear.payload.id)).toBe(1);
    for (const m of lote) {
      expect(await contar('sync_mutations', 'mutation_id = ?', m.mutation_id)).toBe(1);
    }
    expect(
      await contar('audit_log', "entidad = 'consumptions' AND entidad_id = ?", crear.payload.id),
    ).toBe(1);
  });

  it('un mutation_id de otro usuario responde ID_DUPLICADO sin revelar la respuesta guardada', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    await asignar(orden, otroSupervisor.usuario.id, admin.usuario.id);
    const m = crearConsumo(orden, material);
    await pushOk(supervisor.token, supervisor.usuario.id, [m]);

    const ajena = { ...crearConsumo(orden, material), mutation_id: m.mutation_id };
    const [r] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [ajena]);

    expect(r).toEqual({
      indice: 0,
      mutation_id: m.mutation_id,
      resultado: 'rechazada',
      code: 'ID_DUPLICADO',
      message: expect.any(String) as string,
    });
    expect(await contar('consumptions', 'id = ?', ajena.payload.id)).toBe(0);
    expect((await filaSync(m.mutation_id))?.user_id).toBe(supervisor.usuario.id);
  });
});

describe('reglas de conflicto (§6)', () => {
  it('conflicto de versión: responde conflicto con la versión del servidor y lo guarda con el payload', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const consumo = await consumoAplicado(supervisor, orden, material);
    const [editada] = await pushOk(supervisor.token, supervisor.usuario.id, [
      editarConsumoMut(consumo.id, 1, { cantidad: 11 }),
    ]);
    expect(editada).toMatchObject({
      resultado: 'aplicada',
      servidor: { version: 2, cantidad: 11 },
    });

    const vieja = editarConsumoMut(consumo.id, 1, { cantidad: 99 });
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [vieja]);

    expect(r).toMatchObject({
      resultado: 'conflicto',
      code: 'CONFLICTO',
      servidor: { id: consumo.id, version: 2, cantidad: 11 },
    });
    const fila = await filaSync(vieja.mutation_id);
    expect(fila?.resultado).toBe('conflicto');
    expect(JSON.parse(fila?.payload_json ?? 'null')).toEqual(vieja);
  });

  it('la edición de un consumo ya validado se rechaza con CONSUMO_NO_PENDIENTE y el consumo queda intacto', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const consumo = await consumoAplicado(supervisor, orden, material);
    const [aprobada] = await pushOk(jefe.token, jefe.usuario.id, [
      decidirMut('aprobar', consumo.id, 1),
    ]);
    expect(aprobada?.resultado).toBe('aplicada');
    const antes = await env.DB.prepare('SELECT * FROM consumptions WHERE id = ?')
      .bind(consumo.id)
      .first();

    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [
      editarConsumoMut(consumo.id, 1, { cantidad: 50 }),
    ]);

    expect(r).toMatchObject({
      resultado: 'rechazada',
      code: 'CONSUMO_NO_PENDIENTE',
      servidor: { id: consumo.id, estado: 'aprobado', version: 2, cantidad: 10 },
    });
    expect(
      await env.DB.prepare('SELECT * FROM consumptions WHERE id = ?').bind(consumo.id).first(),
    ).toEqual(antes);
  });

  it('registro tardío en una orden finalizada: aplicada con registro_tardio = 1', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, {}, 'finalizada');
    const consumo = await consumoAplicado(supervisor, orden, material);
    expect(consumo).toMatchObject({ registro_tardio: true, estado: 'pendiente' });
    const fila = await env.DB.prepare('SELECT registro_tardio FROM consumptions WHERE id = ?')
      .bind(consumo.id)
      .first<{ registro_tardio: number }>();
    expect(fila?.registro_tardio).toBe(1);
  });

  it('tolerancia superada sin novedad: aplicada con requiere_novedad = 1', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    const consumo = await consumoAplicado(supervisor, orden, material, { cantidad: 150 });
    expect(consumo.requiere_novedad).toBe(true);
    const fila = await env.DB.prepare('SELECT requiere_novedad FROM consumptions WHERE id = ?')
      .bind(consumo.id)
      .first<{ requiere_novedad: number }>();
    expect(fila?.requiere_novedad).toBe(1);
  });

  it('marca alerta_reloj en la auditoría si el reloj del dispositivo difiere más de 10 min', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const hace1h = new Date(Date.now() - 3_600_000).toISOString();
    const m = crearConsumo(orden, material, { client_created_at: hace1h });
    await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    const auditoria = await env.DB.prepare(
      "SELECT alerta_reloj, client_at FROM audit_log WHERE entidad = 'consumptions' AND entidad_id = ?",
    )
      .bind(m.payload.id)
      .first<{ alerta_reloj: number; client_at: string }>();
    expect(auditoria).toEqual({ alerta_reloj: 1, client_at: hace1h });
  });
});

describe('dependencias y lotes con errores', () => {
  it('lo que depende de un consumo rechazado en el lote se rechaza con DEPENDENCIA_RECHAZADA', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const ajena = await nuevaOrden(jefe.usuario.id); // no asignada: el consumo se rechaza
    const crear = crearConsumo(ajena, material);
    const id = String(crear.payload.id);
    const lote = [
      crear,
      crearNovedadMut(id),
      editarConsumoMut(id, 1),
      crearConsumo(orden, material), // no depende: se aplica
    ];
    const resultados = await pushOk(supervisor.token, supervisor.usuario.id, lote);

    expect(resultados.map((r) => [r.resultado, r.code])).toEqual([
      ['rechazada', 'NO_ENCONTRADO'],
      ['rechazada', 'DEPENDENCIA_RECHAZADA'],
      ['rechazada', 'DEPENDENCIA_RECHAZADA'],
      ['aplicada', undefined],
    ]);
    for (const m of lote.slice(0, 3)) {
      expect(JSON.parse((await filaSync(m.mutation_id))?.payload_json ?? 'null')).toEqual(m);
    }

    // En otro lote, la dependencia se reconoce por la creación rechazada guardada.
    const tarde = await pushOk(supervisor.token, supervisor.usuario.id, [crearNovedadMut(id)]);
    expect(tarde[0]).toMatchObject({ resultado: 'rechazada', code: 'DEPENDENCIA_RECHAZADA' });
  });

  it('una creación inválida (con id legible) también arrastra a sus dependientes', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const crear = crearConsumo(orden, material, { cantidad: -1 });
    const resultados = await pushOk(supervisor.token, supervisor.usuario.id, [
      crear,
      crearNovedadMut(String(crear.payload.id)),
    ]);
    expect(resultados.map((r) => r.code)).toEqual(['VALIDACION', 'DEPENDENCIA_RECHAZADA']);
    expect(resultados[0]?.message).toContain('mayor que cero');
  });

  it('una mutación inválida en medio del lote no bloquea las siguientes', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const basura = { mutation_id: uuidv7(), tipo: 'consumo.borrar', payload: { id: 'x' } };
    const lote = [
      crearConsumo(orden, material),
      basura,
      { tipo: 'consumo.crear', payload: {} }, // sin mutation_id
      'no soy un objeto',
      crearConsumo(orden, material),
    ];
    const resultados = await pushOk(supervisor.token, supervisor.usuario.id, lote);

    expect(resultados.map((r) => [r.indice, r.resultado, r.code])).toEqual([
      [0, 'aplicada', undefined],
      [1, 'rechazada', 'VALIDACION'],
      [2, 'rechazada', 'VALIDACION'],
      [3, 'rechazada', 'VALIDACION'],
      [4, 'aplicada', undefined],
    ]);
    expect(resultados[2]?.mutation_id).toBeUndefined();
    const guardada = await filaSync(basura.mutation_id);
    expect(guardada).toMatchObject({ resultado: 'rechazada', tipo: 'consumo.borrar' });
    expect(JSON.parse(guardada?.payload_json ?? 'null')).toEqual(basura);
  });

  it('una mutación de más de 64 KiB se rechaza y se guarda un marcador en lugar del payload', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const enorme = crearConsumo(orden, material, { lote: 'x'.repeat(MAX_PAYLOAD_MUTACION_BYTES) });
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [enorme]);
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'VALIDACION' });
    expect(r?.message).toContain('64 KiB');
    const fila = await filaSync(enorme.mutation_id);
    expect(fila?.tipo).toBe('consumo.crear');
    expect(JSON.parse(fila?.payload_json ?? 'null')).toMatchObject({
      omitido: true,
      tamano_bytes: expect.any(Number) as number,
    });
    expect(await contar('consumptions', 'id = ?', enorme.payload.id)).toBe(0);
  });

  it('un tipo ilegible se guarda como "desconocido"', async () => {
    const m = { mutation_id: uuidv7(), tipo: 42, payload: null };
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    expect(r?.code).toBe('VALIDACION');
    expect((await filaSync(m.mutation_id))?.tipo).toBe('desconocido');
  });

  it('un error transitorio de D1 detiene el lote: esa y las siguientes quedan sin resultado y luego se aplican', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const lote = [
      crearConsumo(orden, material),
      crearConsumo(orden, material, { lote: 'FALLO-TRANSITORIO' }),
      crearConsumo(orden, material),
    ];
    // Error real de SQLite que no es de restricción (JSON mal formado), como una falla de D1.
    const trigger = `tmp_fallo_transitorio_${uuidv7().replaceAll('-', '')}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON consumptions WHEN NEW.lote = 'FALLO-TRANSITORIO'
       BEGIN SELECT json_extract('esto no es json', '$'); END`,
    ).run();
    let resultados;
    try {
      resultados = await pushOk(supervisor.token, supervisor.usuario.id, lote);
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
    }
    expect(resultados.map((r) => r.resultado)).toEqual(['aplicada']);
    expect(await filaSync(String(lote[1]?.mutation_id))).toBeNull();
    expect(await filaSync(String(lote[2]?.mutation_id))).toBeNull();

    const reenvio = await pushOk(supervisor.token, supervisor.usuario.id, lote);
    expect(reenvio.map((r) => r.resultado)).toEqual(['aplicada', 'aplicada', 'aplicada']);
    expect(reenvio[0]).toEqual(resultados[0]);
  });
});

describe('atomicidad: una mutación, un batch', () => {
  it('si falla la auditoría a mitad del batch no queda nada parcial: ni consumo, ni auditoría, ni fila aplicada', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const m = crearConsumo(orden, material);
    const [r] = await conFalloEnAuditoria(
      { entidad: 'consumptions', accion: 'consumo.crear' },
      () => pushOk(supervisor.token, supervisor.usuario.id, [m]),
    );
    // Un RAISE desconocido es una restricción (nunca transitorio): rechazada y guardada.
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'CONFLICTO' });
    expect(await contar('consumptions', 'id = ?', m.payload.id)).toBe(0);
    expect(await contar('audit_log', 'entidad_id = ?', m.payload.id)).toBe(0);
    expect((await filaSync(m.mutation_id))?.resultado).toBe('rechazada');
  });
});

describe('autoría y permisos revalidados', () => {
  it('user_id distinto del sub de la sesión → 403 AUTOR_NO_COINCIDE y no se escribe nada', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const antes = await fotoDeLaBase();
    const respuesta = await push(otroSupervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    await esperarError(respuesta, 403, 'AUTOR_NO_COINCIDE');
    expect(tablasModificadas(antes, await fotoDeLaBase())).toEqual([]);
  });

  it('sin token responde 401 y un sobre inválido 400 VALIDACION', async () => {
    await esperarError(await push(undefined, supervisor.usuario.id, [{}]), 401, 'NO_AUTENTICADO');
    await esperarError(await push(supervisor.token, supervisor.usuario.id, []), 400, 'VALIDACION');
    const muchas = Array.from({ length: 26 }, () => ({}));
    await esperarError(
      await push(supervisor.token, supervisor.usuario.id, muchas),
      400,
      'VALIDACION',
    );
  });

  it('la mutación usa el did de la sesión y actualiza devices.ultimo_sync_at', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const antes = new Date().toISOString();
    const m = crearConsumo(orden, material, { device_id: uuidv7() });
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [m]);
    expect(r?.servidor?.device_id).toBe(supervisor.deviceId);
    const dispositivo = await env.DB.prepare('SELECT ultimo_sync_at FROM devices WHERE id = ?')
      .bind(supervisor.deviceId)
      .first<{ ultimo_sync_at: string }>();
    expect((dispositivo?.ultimo_sync_at ?? '') >= antes).toBe(true);
  });

  it('supervisor no asignado → rechazada NO_ENCONTRADO (no se revela la orden)', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const [r] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'NO_ENCONTRADO' });
  });

  it('admin no registra consumos → rechazada PERMISO_DENEGADO', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const [r] = await pushOk(admin.token, admin.usuario.id, [crearConsumo(orden, material)]);
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'PERMISO_DENEGADO' });
  });

  it('el jefe aprueba y rechaza por sync', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const a = await consumoAplicado(supervisor, orden, material);
    const b = await consumoAplicado(supervisor, orden, material);
    const resultados = await pushOk(jefe.token, jefe.usuario.id, [
      decidirMut('aprobar', a.id, 1),
      decidirMut('rechazar', b.id, 1),
    ]);
    expect(resultados).toMatchObject([
      {
        resultado: 'aplicada',
        servidor: {
          consumo: { id: a.id, estado: 'aprobado', version: 2 },
          validacion: { decision: 'aprobado', validado_por: jefe.usuario.id },
        },
      },
      {
        resultado: 'aplicada',
        servidor: {
          consumo: { id: b.id, estado: 'rechazado' },
          validacion: { decision: 'rechazado', motivo: 'Cantidad no coincide con el lote' },
        },
      },
    ]);
    const estados = await env.DB.prepare(
      'SELECT id, estado FROM consumptions WHERE id IN (?, ?) ORDER BY id',
    )
      .bind(a.id, b.id)
      .all<{ id: string; estado: string }>();
    expect(estados.results.map((f) => f.estado)).toEqual(['aprobado', 'rechazado']);

    // Aprobar otra vez con la versión vieja: el consumo ya no está pendiente.
    const [otraVez] = await pushOk(jefe2.token, jefe2.usuario.id, [decidirMut('aprobar', a.id, 1)]);
    expect(otraVez).toMatchObject({ resultado: 'rechazada', code: 'CONSUMO_NO_PENDIENTE' });
  });

  it('aprobar con una versión vieja de un consumo pendiente → conflicto con la versión del servidor', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const c = await consumoAplicado(supervisor, orden, material);
    await pushOk(supervisor.token, supervisor.usuario.id, [editarConsumoMut(c.id, 1)]);
    const [r] = await pushOk(jefe.token, jefe.usuario.id, [decidirMut('aprobar', c.id, 1)]);
    expect(r).toMatchObject({
      resultado: 'conflicto',
      code: 'CONFLICTO',
      servidor: { version: 2 },
    });
  });

  it('autoaprobación por sync → rechazada AUTOAPROBACION', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const propio = await consumoAplicado(jefe, orden, material);
    const [r] = await pushOk(jefe.token, jefe.usuario.id, [decidirMut('aprobar', propio.id, 1)]);
    expect(r).toMatchObject({ resultado: 'rechazada', code: 'AUTOAPROBACION' });
    expect(await contar('validations', 'consumption_id = ?', propio.id)).toBe(0);
  });

  it('novedad por sync con evidencias declaradas', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const material = await nuevoMaterial();
    await planear(orden, material, 100);
    await asignar(orden, supervisor.usuario.id, admin.usuario.id);
    const c = await consumoAplicado(supervisor, orden, material);
    const n = crearNovedadMut(c.id);
    const [r] = await pushOk(supervisor.token, supervisor.usuario.id, [n]);
    expect(r).toMatchObject({
      resultado: 'aplicada',
      servidor: { id: n.payload.id, consumption_id: c.id, evidencias: [{ subido: false }] },
    });
    expect(JSON.stringify(r)).not.toContain('storage_key');
  });
});
