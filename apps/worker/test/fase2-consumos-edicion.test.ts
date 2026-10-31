// Edición de consumos: PATCH /consumptions/:id (S4, P3; §6 conflicto de versión). D1 local real.
import { type Consumo, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { editarConsumo, ejecutarConReintento } from '../src/dominio/consumos';
import type { Contexto } from '../src/dominio/contexto';
import { cuerpoConsumo, editar, escenarioOrden, registrarOk } from './fase2-consumos-helpers';
import {
  asignar,
  auditoriaDesde,
  esperarError,
  json,
  nuevoMaterial,
  planear,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';
import { decidir } from './fixtures-db';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;

beforeAll(async () => {
  [admin, jefe, supervisor, otroSupervisor] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('supervisor'),
    sesion('supervisor'),
  ]);
});

const ahora = () => new Date().toISOString();

async function consumoPendiente(extra: Record<string, unknown> = {}, plan = 100) {
  const esc = await escenarioOrden(jefe, supervisor, { cantidad: plan });
  const consumo = await registrarOk(
    supervisor.token,
    cuerpoConsumo(esc.orden, esc.material, extra),
  );
  return { ...esc, consumo };
}

function cambios(consumo: Consumo, extra: Record<string, unknown>) {
  return { id: consumo.id, version: consumo.version, client_created_at: ahora(), ...extra };
}

describe('permisos', () => {
  it('jefe y admin reciben 403; sin sesión 401', async () => {
    const { consumo } = await consumoPendiente();
    for (const token of [jefe.token, admin.token]) {
      await esperarError(
        await editar(token, consumo.id, cambios(consumo, { lote: 'X' })),
        403,
        'PERMISO_DENEGADO',
      );
    }
    await esperarError(
      await editar(undefined, consumo.id, cambios(consumo, { lote: 'X' })),
      401,
      'NO_AUTENTICADO',
    );
  });

  it('otro supervisor: 403 si ve la orden, 404 si no; inexistente 404', async () => {
    const { orden, consumo } = await consumoPendiente();
    await esperarError(
      await editar(otroSupervisor.token, consumo.id, cambios(consumo, { lote: 'X' })),
      404,
      'NO_ENCONTRADO',
    );
    await asignar(orden, otroSupervisor.usuario.id, admin.usuario.id);
    await esperarError(
      await editar(otroSupervisor.token, consumo.id, cambios(consumo, { lote: 'X' })),
      403,
      'PERMISO_DENEGADO',
    );
    const id = uuidv7();
    await esperarError(
      await editar(supervisor.token, id, { id, version: 1, client_created_at: ahora(), lote: 'X' }),
      404,
      'NO_ENCONTRADO',
    );
  });
});

describe('edición', () => {
  it('el autor edita su pendiente: versión + 1, autoría intacta y auditoría con antes/después', async () => {
    const { consumo } = await consumoPendiente({ cantidad: 10 });
    const antes = await ultimoSeq();
    const respuesta = await editar(
      supervisor.token,
      consumo.id,
      cambios(consumo, {
        cantidad: 12,
        lote: 'L-NUEVO',
        client_created_at: '2026-10-29T16:00:00Z',
      }),
    );
    expect(respuesta.status).toBe(200);
    const editado = await respuesta.json<Consumo>();
    expect(editado).toMatchObject({
      cantidad: 12,
      cantidad_en_unidad_plan: 12,
      lote: 'L-NUEVO',
      version: 2,
      estado: 'pendiente',
      registrado_por: consumo.registrado_por,
      device_id: consumo.device_id,
      client_created_at: consumo.client_created_at,
      server_received_at: consumo.server_received_at,
      created_at: consumo.created_at,
    });
    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      entidad: 'consumptions',
      entidad_id: consumo.id,
      accion: 'consumo.editar',
      order_id: consumo.order_id,
      actor_id: supervisor.usuario.id,
    });
    expect(json(filas[0]?.datos_antes ?? null)).toMatchObject({ cantidad: 10, version: 1 });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({ cantidad: 12, version: 2 });
  });

  it('recalcula conversión y requiere_novedad (sube y baja)', async () => {
    const { consumo } = await consumoPendiente({ cantidad: 50 }, 100);
    let actual = consumo;
    const paso = async (extra: Record<string, unknown>) => {
      const respuesta = await editar(supervisor.token, actual.id, cambios(actual, extra));
      expect(respuesta.status).toBe(200);
      actual = await respuesta.json<Consumo>();
      return actual;
    };
    expect(await paso({ cantidad: 106 })).toMatchObject({ requiere_novedad: true, version: 2 });
    expect(await paso({ cantidad: 105 })).toMatchObject({ requiere_novedad: false, version: 3 });
    expect(await paso({ cantidad: 2000, unidad: 'g' })).toMatchObject({
      cantidad_en_unidad_plan: 2,
      requiere_novedad: false,
    });
  });

  it('cambiar el material toma su costo y su plan; fuera del plan marca la novedad', async () => {
    const { orden, consumo } = await consumoPendiente({ cantidad: 5 });
    const otro = await nuevoMaterial({ unidad: 'g', costo: 7 });
    await planear(orden, otro, 10_000, 'g');
    let respuesta = await editar(
      supervisor.token,
      consumo.id,
      cambios(consumo, { material_id: otro, cantidad: 2, unidad: 'kg' }),
    );
    let editado = await respuesta.json<Consumo>();
    expect(editado).toMatchObject({
      material_id: otro,
      cantidad_en_unidad_plan: 2000,
      costo_unitario_cop_snapshot: 7,
      requiere_novedad: false,
    });
    const sinPlan = await nuevoMaterial({ unidad: 'kg', costo: 9 });
    respuesta = await editar(
      supervisor.token,
      consumo.id,
      cambios(editado, { material_id: sinPlan }),
    );
    editado = await respuesta.json<Consumo>();
    expect(editado).toMatchObject({
      material_id: sinPlan,
      requiere_novedad: true,
      costo_unitario_cop_snapshot: 9,
    });
  });

  it('material nuevo inexistente 400, inactivo 422; unidad no convertible 422', async () => {
    const { consumo } = await consumoPendiente();
    await esperarError(
      await editar(supervisor.token, consumo.id, cambios(consumo, { material_id: uuidv7() })),
      400,
      'VALIDACION',
    );
    const inactivo = await nuevoMaterial({ activo: 0 });
    await esperarError(
      await editar(supervisor.token, consumo.id, cambios(consumo, { material_id: inactivo })),
      422,
      'MATERIAL_INACTIVO',
    );
    await esperarError(
      await editar(supervisor.token, consumo.id, cambios(consumo, { unidad: 'l' })),
      422,
      'UNIDAD_INCOMPATIBLE',
    );
  });

  it('si el material se desactivó después, se puede seguir editando conservando el snapshot', async () => {
    const { material, consumo } = await consumoPendiente();
    await env.DB.prepare('UPDATE materials SET activo = 0, costo_unitario_cop = 1 WHERE id = ?')
      .bind(material)
      .run();
    const respuesta = await editar(supervisor.token, consumo.id, cambios(consumo, { lote: 'L-9' }));
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json<Consumo>()).toMatchObject({
      lote: 'L-9',
      costo_unitario_cop_snapshot: consumo.costo_unitario_cop_snapshot,
    });
  });

  it('versión distinta → 409 CONFLICTO con la versión y el consumo del servidor', async () => {
    const { consumo } = await consumoPendiente();
    expect(
      (await editar(supervisor.token, consumo.id, cambios(consumo, { lote: 'A' }))).status,
    ).toBe(200);
    const antes = await ultimoSeq();
    const cuerpo = await esperarError(
      await editar(supervisor.token, consumo.id, cambios(consumo, { lote: 'B' })),
      409,
      'CONFLICTO',
    );
    expect(cuerpo.details).toMatchObject({
      version_servidor: 2,
      consumo: { id: consumo.id, lote: 'A', version: 2 },
    });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it.each(['aprobado', 'rechazado'] as const)(
    'un consumo %s no se edita: 409 CONSUMO_NO_PENDIENTE',
    async (decision) => {
      const { consumo } = await consumoPendiente();
      await decidir(consumo.id, jefe.usuario.id, decision);
      const cuerpo = await esperarError(
        await editar(supervisor.token, consumo.id, cambios(consumo, { lote: 'X' })),
        409,
        'CONSUMO_NO_PENDIENTE',
      );
      expect(cuerpo.details).toEqual({ estado: decision });
    },
  );

  it('si el jefe lo valida mientras se edita: al reintentar responde CONSUMO_NO_PENDIENTE', async () => {
    const { consumo } = await consumoPendiente();
    const ctx: Contexto = {
      db: env.DB,
      actor: { id: supervisor.usuario.id, rol: 'supervisor' },
      deviceId: supervisor.deviceId,
      ahora: ahora(),
      alertaReloj: false,
    };
    const entrada = { id: consumo.id, version: 1, client_created_at: ahora(), lote: 'TARDE' };
    const viejo = await editarConsumo(ctx, entrada);
    await decidir(consumo.id, jefe.usuario.id, 'aprobado');
    let llamadas = 0;
    await expect(
      ejecutarConReintento(env.DB, async () => {
        llamadas += 1;
        return llamadas === 1 ? viejo : editarConsumo(ctx, entrada);
      }),
    ).rejects.toMatchObject({ code: 'CONSUMO_NO_PENDIENTE' });
    expect(llamadas).toBe(2);
  });

  it('el id del cuerpo debe coincidir con el de la ruta y hay que cambiar algo', async () => {
    const { consumo } = await consumoPendiente();
    await esperarError(
      await editar(supervisor.token, consumo.id, cambios(consumo, { id: uuidv7(), lote: 'X' })),
      400,
      'VALIDACION',
    );
    await esperarError(
      await editar(supervisor.token, consumo.id, cambios(consumo, {})),
      400,
      'VALIDACION',
    );
  });
});
