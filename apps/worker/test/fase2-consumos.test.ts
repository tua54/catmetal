// Registro y listado de consumos: POST /consumptions y GET /orders/:id/consumptions.
// Conversión de unidades (S11), costo congelado (S12), tolerancia (S7) con carrera (H4), registro
// tardío (§6), corrección (S3) y permisos de datos. D1 local real.
import { type Consumo, type ListaConsumos, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ejecutarConReintento, MAX_INTENTOS, registrarConsumo } from '../src/dominio/consumos';
import type { Contexto } from '../src/dominio/contexto';
import { ejecutarPlan, type PlanDeEscritura } from '../src/dominio/plan';
import { ErrorApi } from '../src/errores';
import {
  cuerpoConsumo,
  cuerpoNovedad,
  escenarioOrden,
  novedadOk,
  registrar,
  registrarOk,
} from './fase2-consumos-helpers';
import {
  api,
  asignar,
  auditoriaDesde,
  contextoDe,
  esperarError,
  json,
  nuevaOrden,
  nuevoMaterial,
  planear,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';
import { decidir } from './fixtures-db';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let jefe2: SesionDeRol;
let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;

beforeAll(async () => {
  [admin, jefe, jefe2, supervisor, otroSupervisor] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('jefe'),
    sesion('supervisor'),
    sesion('supervisor'),
  ]);
});

async function filaConsumo(id: string) {
  return env.DB.prepare(
    'SELECT cantidad, cantidad_en_unidad_plan, costo_unitario_cop_snapshot, device_id FROM consumptions WHERE id = ?',
  )
    .bind(id)
    .first<{
      cantidad: number;
      cantidad_en_unidad_plan: number;
      costo_unitario_cop_snapshot: number;
      device_id: string;
    }>();
}

async function contarConsumos(orderId: string): Promise<number> {
  const fila = await env.DB.prepare('SELECT count(*) AS n FROM consumptions WHERE order_id = ?')
    .bind(orderId)
    .first<{ n: number }>();
  return fila?.n ?? -1;
}

describe('permisos', () => {
  it('el supervisor asignado y cualquier jefe registran; el admin recibe 403; sin sesión 401', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
    // P12: el jefe registra en cualquier orden, aunque no la supervise.
    await registrarOk(jefe2.token, cuerpoConsumo(orden, material));
    await esperarError(
      await registrar(admin.token, cuerpoConsumo(orden, material)),
      403,
      'PERMISO_DENEGADO',
    );
    await esperarError(
      await registrar(undefined, cuerpoConsumo(orden, material)),
      401,
      'NO_AUTENTICADO',
    );
    expect(await contarConsumos(orden)).toBe(2);
  });

  it('un supervisor sin asignación activa recibe 404 (no se revela la orden)', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    await esperarError(
      await registrar(otroSupervisor.token, cuerpoConsumo(orden, material)),
      404,
      'NO_ENCONTRADO',
    );
    const quitada = await nuevaOrden(jefe.usuario.id);
    await planear(quitada, material, 10);
    await asignar(quitada, otroSupervisor.usuario.id, admin.usuario.id, 0);
    await esperarError(
      await registrar(otroSupervisor.token, cuerpoConsumo(quitada, material)),
      404,
      'NO_ENCONTRADO',
    );
    await esperarError(
      await registrar(jefe.token, cuerpoConsumo(uuidv7(), material)),
      404,
      'NO_ENCONTRADO',
    );
  });

  it('el comando también rechaza al admin (lo usará /sync/push)', async () => {
    const ctx = await contextoDe('admin');
    await expect(
      registrarConsumo(ctx, {
        id: uuidv7(),
        order_id: uuidv7(),
        material_id: uuidv7(),
        cantidad: 1,
        unidad: 'kg',
        lote: 'L',
        client_created_at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'PERMISO_DENEGADO' });
  });
});

describe('registro', () => {
  it('guarda el consumo pendiente con dispositivo de la sesión, horas y su auditoría', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const body = cuerpoConsumo(orden, material, {
      cantidad: 12.5,
      client_created_at: '2026-10-29T15:00:00Z',
      device_id: uuidv7(), // se ignora: el servidor usa el de la sesión
      estado: 'aprobado', // se ignora
    });
    const antes = await ultimoSeq();
    const consumo = await registrarOk(supervisor.token, body);
    expect(consumo).toMatchObject({
      id: body.id,
      order_id: orden,
      material_id: material,
      cantidad: 12.5,
      unidad: 'kg',
      cantidad_en_unidad_plan: 12.5,
      lote: 'L-2026-001',
      costo_unitario_cop_snapshot: 1500,
      registrado_por: supervisor.usuario.id,
      device_id: supervisor.deviceId,
      client_created_at: '2026-10-29T15:00:00.000Z',
      estado: 'pendiente',
      corrige_a: null,
      registro_tardio: false,
      requiere_novedad: false,
      version: 1,
    });
    expect(consumo.server_received_at).toBe(consumo.created_at);
    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      entidad: 'consumptions',
      entidad_id: consumo.id,
      accion: 'consumo.crear',
      order_id: orden,
      actor_id: supervisor.usuario.id,
      device_id: supervisor.deviceId,
    });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({
      cantidad: 12.5,
      registro_tardio: false,
      requiere_novedad: false,
    });
    const auditoria = await env.DB.prepare(
      'SELECT client_at, alerta_reloj FROM audit_log WHERE seq = ?',
    )
      .bind(filas[0]?.seq ?? 0)
      .first<{ client_at: string; alerta_reloj: number }>();
    // La hora de registro del dispositivo queda en la auditoría solo para la trazabilidad. M2
    // (ADR 0019): la alerta de reloj ya no se calcula con ella sino con X-Hora-Dispositivo, que
    // esta petición no envía → 0 (casos con la cabecera en correcciones-m2-alerta-reloj.test.ts).
    expect(auditoria?.client_at).toBe('2026-10-29T15:00:00.000Z');
    expect(auditoria?.alerta_reloj).toBe(0);
  });

  it('convierte a la unidad del plan: g → kg y l → ml', async () => {
    const enKg = await escenarioOrden(jefe, supervisor, { unidadMaterial: 'kg', unidadPlan: 'kg' });
    const a = await registrarOk(
      supervisor.token,
      cuerpoConsumo(enKg.orden, enKg.material, { cantidad: 2500, unidad: 'g' }),
    );
    expect(a).toMatchObject({ cantidad: 2500, unidad: 'g', cantidad_en_unidad_plan: 2.5 });

    const enMl = await escenarioOrden(jefe, supervisor, {
      unidadMaterial: 'l',
      unidadPlan: 'ml',
      cantidad: 5000,
    });
    const b = await registrarOk(
      supervisor.token,
      cuerpoConsumo(enMl.orden, enMl.material, { cantidad: 1.5, unidad: 'l' }),
    );
    expect(b).toMatchObject({ cantidad: 1.5, unidad: 'l', cantidad_en_unidad_plan: 1500 });
    expect((await filaConsumo(b.id))?.cantidad_en_unidad_plan).toBe(1500);
  });

  it('una unidad no convertible responde 422 UNIDAD_INCOMPATIBLE', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    for (const unidad of ['l', 'ml', 'und', 'm']) {
      const cuerpo = await esperarError(
        await registrar(supervisor.token, cuerpoConsumo(orden, material, { unidad })),
        422,
        'UNIDAD_INCOMPATIBLE',
      );
      expect(cuerpo.details).toMatchObject({ unidad, unidad_material: 'kg' });
    }
    expect(await contarConsumos(orden)).toBe(0);
  });

  it('material inexistente → 400; inactivo → 422 MATERIAL_INACTIVO', async () => {
    const { orden } = await escenarioOrden(jefe, supervisor);
    await esperarError(
      await registrar(supervisor.token, cuerpoConsumo(orden, uuidv7())),
      400,
      'VALIDACION',
    );
    const inactivo = await nuevoMaterial({ activo: 0 });
    await esperarError(
      await registrar(supervisor.token, cuerpoConsumo(orden, inactivo)),
      422,
      'MATERIAL_INACTIVO',
    );
  });

  it('valida el cuerpo con Zod', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    for (const extra of [{ cantidad: 0 }, { cantidad: 1.2345 }, { lote: '' }, { id: 'x' }]) {
      await esperarError(
        await registrar(supervisor.token, cuerpoConsumo(orden, material, extra)),
        400,
        'VALIDACION',
      );
    }
  });

  it('congela el costo: cambiar el precio del material después no cambia el snapshot', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { costo: 1000 });
    const primero = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
    const cambio = await api(`/materials/${material}`, {
      method: 'PATCH',
      token: admin.token,
      body: { costo_unitario_cop: 1800 },
    });
    expect(cambio.status).toBe(200);
    const segundo = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
    expect((await filaConsumo(primero.id))?.costo_unitario_cop_snapshot).toBe(1000);
    expect(segundo.costo_unitario_cop_snapshot).toBe(1800);
  });

  it('un id del cliente repetido responde 409 ID_DUPLICADO sin sobrescribir', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const body = cuerpoConsumo(orden, material, { cantidad: 7 });
    await registrarOk(supervisor.token, body);
    const antes = await ultimoSeq();
    const cuerpo = await esperarError(
      await registrar(jefe.token, { ...body, cantidad: 99 }),
      409,
      'ID_DUPLICADO',
    );
    expect(cuerpo.details).toEqual({ entidad: 'consumptions', campos: ['id'] });
    expect((await filaConsumo(String(body.id)))?.cantidad).toBe(7);
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });
});

describe('estado de la orden (registro tardío)', () => {
  it('una orden planeada responde 422 ORDEN_NO_EN_PROCESO', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, {}, 'planeada');
    await esperarError(
      await registrar(supervisor.token, cuerpoConsumo(orden, material)),
      422,
      'ORDEN_NO_EN_PROCESO',
    );
    expect(await contarConsumos(orden)).toBe(0);
  });

  it.each(['finalizada', 'cancelada'] as const)(
    'en una orden %s se acepta con registro_tardio y queda pendiente',
    async (estado) => {
      const { orden, material } = await escenarioOrden(jefe, supervisor, {}, estado);
      const consumo = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
      expect(consumo).toMatchObject({ registro_tardio: true, estado: 'pendiente' });
    },
  );
});

describe('tolerancia (S7)', () => {
  it('justo en el límite no marca; por encima marca requiere_novedad y se acepta igual', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    const a = await registrarOk(supervisor.token, cuerpoConsumo(orden, material, { cantidad: 60 }));
    const b = await registrarOk(jefe.token, cuerpoConsumo(orden, material, { cantidad: 45 }));
    expect([a.requiere_novedad, b.requiere_novedad]).toEqual([false, false]); // 105 = 100 + 5 %
    const c = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 0.001 }),
    );
    expect(c.requiere_novedad).toBe(true);
    expect(c.estado).toBe('pendiente');
  });

  it('los consumos rechazados no cuentan en el acumulado', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    const grande = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 90 }),
    );
    await decidir(grande.id, jefe.usuario.id, 'rechazado');
    const nuevo = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 90 }),
    );
    expect(nuevo.requiere_novedad).toBe(false);
  });

  it('usa la tolerancia vigente', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
    const cambio = await api('/settings/tolerancia', {
      method: 'PATCH',
      token: admin.token,
      body: { tolerancia_pct: 0 },
    });
    expect(cambio.status).toBe(200);
    try {
      const justo = await registrarOk(
        supervisor.token,
        cuerpoConsumo(orden, material, { cantidad: 100 }),
      );
      expect(justo.requiere_novedad).toBe(false);
      const encima = await registrarOk(
        supervisor.token,
        cuerpoConsumo(orden, material, { cantidad: 0.5 }),
      );
      expect(encima.requiere_novedad).toBe(true);
    } finally {
      await api('/settings/tolerancia', {
        method: 'PATCH',
        token: admin.token,
        body: { tolerancia_pct: 5 },
      });
    }
  });

  it('un material fuera del plan se acepta en la unidad del material con requiere_novedad', async () => {
    const { orden } = await escenarioOrden(jefe, supervisor);
    const fuera = await nuevoMaterial({ unidad: 'kg' });
    const consumo = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, fuera, { cantidad: 750, unidad: 'g' }),
    );
    expect(consumo).toMatchObject({ cantidad_en_unidad_plan: 0.75, requiere_novedad: true });
  });

  describe('carrera entre dos registros que leen el mismo acumulado (H4)', () => {
    async function preparar() {
      const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
      const ctx: Contexto = await contextoDe('supervisor');
      await asignar(orden, ctx.actor.id, admin.usuario.id);
      const entrada = (cantidad: number) => ({
        id: uuidv7(),
        order_id: orden,
        material_id: material,
        cantidad,
        unidad: 'kg' as const,
        lote: 'L-1',
        client_created_at: new Date().toISOString(),
      });
      return { ctx, orden, entrada };
    }

    it('el segundo no aplica con el acumulado viejo: relee, reintenta y marca la novedad', async () => {
      const { ctx, orden, entrada } = await preparar();
      const primero = entrada(60);
      const segundo = entrada(60);
      // Ambos leen acumulado 0: ninguno cree que excede.
      const planA = await registrarConsumo(ctx, primero);
      const planB = await registrarConsumo(ctx, segundo);
      expect([planA.respuesta.requiere_novedad, planB.respuesta.requiere_novedad]).toEqual([
        false,
        false,
      ]);
      await ejecutarPlan(env.DB, planA);

      // Con el plan viejo, la principal no aplica y no se escribe nada (ni la auditoría).
      const antes = await ultimoSeq();
      await expect(ejecutarPlan(env.DB, planB)).rejects.toBe(planB.siNoAplica);
      expect(await auditoriaDesde(antes)).toHaveLength(0);
      expect(await contarConsumos(orden)).toBe(1);

      // Con reintento: el primer intento usa el plan viejo, el segundo relee (60 + 60 > 105).
      let llamadas = 0;
      const consumo = await ejecutarConReintento(env.DB, async () => {
        llamadas += 1;
        return llamadas === 1 ? planB : registrarConsumo(ctx, segundo);
      });
      expect(llamadas).toBe(2);
      expect(consumo.requiere_novedad).toBe(true);
      expect(await contarConsumos(orden)).toBe(2);
      expect((await auditoriaDesde(antes)).map((f) => f.accion)).toEqual(['consumo.crear']);
    });

    it('tras MAX_INTENTOS sin aplicar responde 409 CONFLICTO; otros errores no se reintentan', async () => {
      const { ctx, entrada } = await preparar();
      const viejo = await registrarConsumo(ctx, entrada(10));
      await ejecutarPlan(env.DB, await registrarConsumo(ctx, entrada(10)));
      let llamadas = 0;
      await expect(
        ejecutarConReintento(env.DB, () => {
          llamadas += 1;
          return Promise.resolve(viejo);
        }),
      ).rejects.toMatchObject({ code: 'CONFLICTO' });
      expect(llamadas).toBe(MAX_INTENTOS);

      llamadas = 0;
      await expect(
        ejecutarConReintento(env.DB, (): Promise<PlanDeEscritura<Consumo>> => {
          llamadas += 1;
          return Promise.reject(new ErrorApi('MATERIAL_INACTIVO'));
        }),
      ).rejects.toMatchObject({ code: 'MATERIAL_INACTIVO' });
      expect(llamadas).toBe(1);
    });

    it('si el material se desactiva o cambia de costo entretanto, no aplica', async () => {
      const { ctx, orden, entrada } = await preparar();
      const plan = await registrarConsumo(ctx, entrada(1));
      await env.DB.prepare('UPDATE materials SET costo_unitario_cop = 1 WHERE id = ?')
        .bind(plan.respuesta.material_id)
        .run();
      await expect(ejecutarPlan(env.DB, plan)).rejects.toBe(plan.siNoAplica);
      expect(await contarConsumos(orden)).toBe(0);
    });

    it('si la asignación se quita entretanto, no aplica', async () => {
      const { ctx, orden, entrada } = await preparar();
      const plan = await registrarConsumo(ctx, entrada(1));
      await env.DB.prepare(
        'UPDATE order_supervisors SET activo = 0 WHERE order_id = ? AND user_id = ?',
      )
        .bind(orden, ctx.actor.id)
        .run();
      await expect(ejecutarPlan(env.DB, plan)).rejects.toBe(plan.siNoAplica);
      expect(await contarConsumos(orden)).toBe(0);
    });

    it('un fallo forzado a mitad del batch no deja el consumo ni su auditoría', async () => {
      const { ctx, orden, entrada } = await preparar();
      const plan = await registrarConsumo(ctx, entrada(1));
      const saboteado = {
        ...plan,
        sentencias: [
          plan.sentencias[0] as D1PreparedStatement,
          env.DB.prepare(`UPDATE audit_log SET accion = 'x' WHERE seq = 1`),
          ...plan.sentencias.slice(1),
        ],
      };
      const antes = await ultimoSeq();
      await expect(ejecutarPlan(env.DB, saboteado)).rejects.toMatchObject({ code: 'CONFLICTO' });
      expect(await contarConsumos(orden)).toBe(0);
      expect(await auditoriaDesde(antes)).toHaveLength(0);
    });
  });
});

describe('corrección (S3)', () => {
  async function rechazadoDe(autor: SesionDeRol) {
    const esc = await escenarioOrden(jefe, autor);
    const original = await registrarOk(autor.token, cuerpoConsumo(esc.orden, esc.material));
    await decidir(original.id, jefe.usuario.id, 'rechazado');
    return { ...esc, original };
  }

  it('el autor corrige su consumo rechazado una sola vez', async () => {
    const { orden, material, original } = await rechazadoDe(supervisor);
    const correccion = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { corrige_a: original.id, cantidad: 8 }),
    );
    expect(correccion.corrige_a).toBe(original.id);
    await esperarError(
      await registrar(supervisor.token, cuerpoConsumo(orden, material, { corrige_a: original.id })),
      422,
      'CORRECCION_INVALIDA',
    );
  });

  it('no corrige un consumo pendiente, inexistente, de otra orden ni de otro supervisor', async () => {
    const { orden, material, original } = await rechazadoDe(supervisor);
    const pendiente = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
    const otra = await escenarioOrden(jefe, supervisor);
    const casos = [
      cuerpoConsumo(orden, material, { corrige_a: pendiente.id }),
      cuerpoConsumo(orden, material, { corrige_a: uuidv7() }),
      cuerpoConsumo(otra.orden, otra.material, { corrige_a: original.id }),
    ];
    for (const body of casos) {
      await esperarError(await registrar(supervisor.token, body), 422, 'CORRECCION_INVALIDA');
    }
    await asignar(orden, otroSupervisor.usuario.id, admin.usuario.id);
    await esperarError(
      await registrar(
        otroSupervisor.token,
        cuerpoConsumo(orden, material, { corrige_a: original.id }),
      ),
      422,
      'CORRECCION_INVALIDA',
    );
  });

  it('un jefe puede corregir el rechazado de un supervisor', async () => {
    const { orden, material, original } = await rechazadoDe(supervisor);
    const correccion = await registrarOk(
      jefe2.token,
      cuerpoConsumo(orden, material, { corrige_a: original.id }),
    );
    expect(correccion).toMatchObject({ corrige_a: original.id, registrado_por: jefe2.usuario.id });
  });
});

describe('GET /orders/:id/consumptions', () => {
  async function listar(token: string | undefined, orden: string, query = '') {
    return api(`/orders/${orden}/consumptions${query}`, { token });
  }

  it('supervisor asignado y jefe ven todos, con novedades, validación y falta_novedad', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 10 });
    const propio = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 5 }),
    );
    const delJefe = await registrarOk(jefe.token, cuerpoConsumo(orden, material, { cantidad: 20 }));
    const conNovedad = await registrarOk(
      supervisor.token,
      cuerpoConsumo(orden, material, { cantidad: 1 }),
    );
    await novedadOk(supervisor.token, conNovedad.id, cuerpoNovedad(conNovedad.id));
    await decidir(propio.id, jefe2.usuario.id, 'rechazado');

    for (const token of [supervisor.token, jefe.token, admin.token]) {
      const respuesta = await listar(token, orden);
      expect(respuesta.status).toBe(200);
      const { consumos, siguiente_cursor } = await respuesta.json<ListaConsumos>();
      expect(siguiente_cursor).toBeNull();
      expect(consumos.map((c) => c.id)).toEqual([propio.id, delJefe.id, conNovedad.id]);
      const [a, b, c] = consumos;
      expect(a).toMatchObject({ estado: 'rechazado', falta_novedad: false, novedades: [] });
      expect(a?.validacion).toMatchObject({
        decision: 'rechazado',
        motivo: 'Cantidad mal digitada',
      });
      expect(b).toMatchObject({ requiere_novedad: true, falta_novedad: true, validacion: null });
      expect(c?.novedades).toHaveLength(1);
      expect(c?.novedades[0]).toMatchObject({ tipo: 'merma', evidencias: [] });
      expect(c).toMatchObject({ requiere_novedad: true, falta_novedad: false });
    }
  });

  it('pagina por cursor', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 1000 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await registrarOk(supervisor.token, cuerpoConsumo(orden, material))).id);
    }
    const p1 = await (await listar(jefe.token, orden, '?limite=2')).json<ListaConsumos>();
    expect(p1.consumos.map((c) => c.id)).toEqual(ids.slice(0, 2));
    const p2 = await (
      await listar(jefe.token, orden, `?limite=2&cursor=${p1.siguiente_cursor ?? ''}`)
    ).json<ListaConsumos>();
    expect(p2.consumos.map((c) => c.id)).toEqual(ids.slice(2));
    expect(p2.siguiente_cursor).toBeNull();
    await esperarError(await listar(jefe.token, orden, '?limite=0'), 400, 'VALIDACION');
  });

  it('sin asignación el supervisor ve solo los suyos; sin ninguno, 404', async () => {
    const { orden, material } = await escenarioOrden(jefe, otroSupervisor);
    await registrarOk(jefe.token, cuerpoConsumo(orden, material));
    const suyo = await registrarOk(otroSupervisor.token, cuerpoConsumo(orden, material));
    // Pierde la asignación: sigue viendo lo que registró (ADR 0005 regla 2).
    await env.DB.prepare(
      'UPDATE order_supervisors SET activo = 0 WHERE order_id = ? AND user_id = ?',
    )
      .bind(orden, otroSupervisor.usuario.id)
      .run();
    const lista = await (await listar(otroSupervisor.token, orden)).json<ListaConsumos>();
    expect(lista.consumos.map((c) => c.id)).toEqual([suyo.id]);
    await esperarError(await listar(supervisor.token, orden), 404, 'NO_ENCONTRADO');
    await esperarError(await listar(jefe.token, uuidv7()), 404, 'NO_ENCONTRADO');
  });

  it('sin sesión 401; id inválido 400', async () => {
    await esperarError(await listar(undefined, uuidv7()), 401, 'NO_AUTENTICADO');
    await esperarError(await listar(jefe.token, 'x'), 400, 'VALIDACION');
  });
});
