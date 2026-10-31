// Tarea 3.2 — `GET /api/v1/sync/pull` (docs/spec.md §6; ADR 0005 reglas 1–6 y 9; ADR 0010).
// Worker real, sesiones reales y D1 local real (sin mocks). Las pruebas de un archivo comparten
// base y corren en serie: cada prueba parte de `ultimoSeq()`.
import {
  type CambioSync,
  MAX_CAMBIOS_PULL,
  MAX_FILAS_REVISADAS_PULL,
  uuidv7,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { iniciarSesion } from './auth-helpers';
import { escenarioOrden } from './fase2-consumos-helpers';
import {
  api,
  esperarError,
  nuevaOrden,
  nuevoMaterial,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';
import { esperarSinSecretos } from './fase2-transversal-helpers';
import {
  crearConsumo,
  crearNovedadMut,
  decidirMut,
  filaAuditoria,
  insertar,
  pullOk,
  pullTodo,
  pushOk,
  rellenarAuditoria,
  snapshotCompleto,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;
let ajeno: SesionDeRol;
let jefe: SesionDeRol;
let admin: SesionDeRol;

beforeAll(async () => {
  [supervisor, otroSupervisor, ajeno, jefe, admin] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
    sesion('admin'),
  ]);
});

const de = (cambios: readonly CambioSync[], entidad: string, id: string) =>
  cambios.filter((c) => c.entidad === entidad && c.id === id);

function asignarPorApi(orderId: string, supervisores: string[]) {
  return api(`/orders/${orderId}/supervisors`, {
    method: 'PUT',
    token: admin.token,
    body: { supervisores },
  });
}

async function asignarOk(orderId: string, supervisores: string[]) {
  const r = await asignarPorApi(orderId, supervisores);
  expect(r.status, await r.clone().text()).toBe(200);
}

async function seqsDesde(cursor: number, limite: number): Promise<number[]> {
  const { results } = await env.DB.prepare(
    'SELECT seq FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?',
  )
    .bind(cursor, limite)
    .all<{ seq: number }>();
  return results.map((f) => f.seq);
}

describe('cursor y ventana', () => {
  it('el pull avanza el cursor aunque no haya cambios visibles', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const cursor = await ultimoSeq();
    await rellenarAuditoria(
      Array.from({ length: 300 }, () => filaAuditoria('production_orders', orden, orden)),
    );

    const r = await pullOk(ajeno.token, cursor);

    expect(r.cambios).toEqual([]);
    expect(r.cursor).toBe(await ultimoSeq());
    expect(r.cursor).toBeGreaterThanOrEqual(cursor + 300);
    expect(r.hay_mas).toBe(false);
  });

  it('revisa como máximo 1000 filas por pull y avisa con hay_mas', async () => {
    const orden = await nuevaOrden(jefe.usuario.id);
    const cursor = await ultimoSeq();
    await rellenarAuditoria(
      Array.from({ length: MAX_FILAS_REVISADAS_PULL + 100 }, () =>
        filaAuditoria('production_orders', orden, orden),
      ),
    );
    const ventana = await seqsDesde(cursor, MAX_FILAS_REVISADAS_PULL);

    const primero = await pullOk(ajeno.token, cursor);
    expect(primero).toMatchObject({ cambios: [], hay_mas: true, cursor: ventana.at(-1) });

    const segundo = await pullOk(ajeno.token, primero.cursor);
    expect(segundo).toMatchObject({ cambios: [], hay_mas: false, cursor: await ultimoSeq() });
  });

  it('un cursor más allá del final devuelve el mismo cursor y nada más', async () => {
    const final = (await ultimoSeq()) + 1000;
    expect(await pullOk(jefe.token, final)).toMatchObject({
      cursor: final,
      hay_mas: false,
      cambios: [],
    });
  });

  it('cupo de 200 entidades: se detiene, el cursor es el seq de la fila 200 y hay_mas = true', async () => {
    const cursor = await ultimoSeq();
    const t = new Date().toISOString();
    const materiales: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const id = uuidv7();
      materiales.push(id);
      await insertar('materials', {
        id,
        codigo: `MP-CUPO-${id}`,
        nombre: `Material ${String(i)}`,
        unidad: 'kg',
        costo_unitario_cop: 100,
        activo: 1,
        created_at: t,
        updated_at: t,
      });
    }
    await rellenarAuditoria(materiales.map((id) => filaAuditoria('materials', id)));
    const seqs = await seqsDesde(cursor, 250);

    const primero = await pullOk(jefe.token, cursor);
    expect(primero.cambios).toHaveLength(MAX_CAMBIOS_PULL);
    expect(primero.hay_mas).toBe(true);
    expect(primero.cursor).toBe(seqs[MAX_CAMBIOS_PULL - 1]);
    expect(primero.cambios.map((c) => c.id)).toEqual(materiales.slice(0, 200));
    expect(primero.cambios[0]).toMatchObject({
      tipo: 'upsert',
      entidad: 'materials',
      datos: { activo: true, unidad: 'kg', costo_unitario_cop: 100 },
    });

    const segundo = await pullOk(jefe.token, primero.cursor);
    expect(segundo.cambios.map((c) => c.id)).toEqual(materiales.slice(200));
    expect(segundo.hay_mas).toBe(false);
  });

  it('deduplica por (entidad, id) con el estado actual y el seq de la última fila', async () => {
    const material = await nuevoMaterial();
    const cursor = await ultimoSeq();
    for (const costo of [1600, 1700, 1800]) {
      const r = await api(`/materials/${material}`, {
        method: 'PATCH',
        token: admin.token,
        body: { costo_unitario_cop: costo },
      });
      expect(r.status).toBe(200);
    }
    const r = await pullOk(jefe.token, cursor);
    const cambios = de(r.cambios, 'materials', material);
    expect(cambios).toHaveLength(1);
    expect(cambios[0]).toMatchObject({
      tipo: 'upsert',
      seq: await ultimoSeq(),
      datos: { id: material, costo_unitario_cop: 1800 },
    });
  });

  it('la época viene en cada respuesta, es la de settings y es estable', async () => {
    const fila = await env.DB.prepare(
      "SELECT valor FROM settings WHERE clave = 'sync_epoca'",
    ).first<{
      valor: string;
    }>();
    const epoca = JSON.parse(fila?.valor ?? '""') as string;
    const a = await pullOk(supervisor.token, 0);
    const b = await pullOk(jefe.token, await ultimoSeq());
    expect(epoca).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.epoca).toBe(epoca);
    expect(b.epoca).toBe(epoca);
  });

  it('permisos y validación: sin token 401; cursor inválido 400', async () => {
    await esperarError(await api('/sync/pull?cursor=0'), 401, 'NO_AUTENTICADO');
    for (const cursor of ['-1', 'abc', '1e3', '01']) {
      await esperarError(
        await api(`/sync/pull?cursor=${cursor}`, { token: jefe.token }),
        400,
        'VALIDACION',
      );
    }
    const sinCursor = await api('/sync/pull', { token: ajeno.token });
    expect(sinCursor.status).toBe(200);
  });
});

describe('visibilidad', () => {
  it('el supervisor recibe lo de su orden asignada y sus consumos; nunca lo de órdenes ajenas', async () => {
    const cursor = await ultimoSeq();
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const ajena = await escenarioOrden(jefe, otroSupervisor);
    const [propio] = await pushOk(supervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const [deOtro] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crearConsumo(ajena.orden, ajena.material),
    ]);

    const { cambios } = await pullTodo(supervisor.token, cursor);

    expect(de(cambios, 'consumptions', String(propio?.servidor?.id))).toMatchObject([
      { tipo: 'upsert', datos: { id: propio?.servidor?.id, registro_tardio: false } },
    ]);
    expect(de(cambios, 'consumptions', String(deOtro?.servidor?.id))).toEqual([]);
    expect(cambios.some((c) => c.id.includes(ajena.orden))).toBe(false);
    expect(
      cambios.every((c) => !['devices', 'refresh_tokens', 'sync_mutations'].includes(c.entidad)),
    ).toBe(true);
  });

  it('jefe y admin reciben todo lo de negocio', async () => {
    const cursor = await ultimoSeq();
    const { orden, material } = await escenarioOrden(jefe, otroSupervisor);
    const [c] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    for (const s of [jefe, admin]) {
      const { cambios } = await pullTodo(s.token, cursor);
      expect(de(cambios, 'consumptions', String(c?.servidor?.id))).toHaveLength(1);
    }
  });

  it('users: solo id, nombre, rol y activo; el supervisor no ve a los demás supervisores', async () => {
    const cursor = await ultimoSeq();
    const crear = async (rol: string) => {
      const r = await api('/users', {
        token: admin.token,
        body: {
          nombre: `Usuaria ${rol}`,
          email: `${uuidv7()}@catmetal.test`,
          password: 'Clave-Segura-2026!',
          rol,
        },
      });
      expect(r.status, await r.clone().text()).toBe(201);
      return (await r.json<{ id: string }>()).id;
    };
    const nuevoJefe = await crear('jefe');
    const nuevoSupervisor = await crear('supervisor');

    const paraSupervisor = await pullTodo(supervisor.token, cursor);
    expect(de(paraSupervisor.cambios, 'users', nuevoJefe)).toEqual([
      expect.objectContaining({
        tipo: 'upsert',
        datos: { id: nuevoJefe, nombre: 'Usuaria jefe', rol: 'jefe', activo: true },
      }),
    ]);
    expect(de(paraSupervisor.cambios, 'users', nuevoSupervisor)).toEqual([]);
    const paraJefe = await pullTodo(jefe.token, cursor);
    expect(de(paraJefe.cambios, 'users', nuevoSupervisor)).toHaveLength(1);

    // Un jefe que pasa a supervisor deja de estar en la lista del supervisor: revocar.
    const despues = paraSupervisor.cursor;
    const r = await api(`/users/${nuevoJefe}`, {
      method: 'PATCH',
      token: admin.token,
      body: { rol: 'supervisor' },
    });
    expect(r.status).toBe(200);
    const revocado = await pullOk(supervisor.token, despues);
    expect(de(revocado.cambios, 'users', nuevoJefe)).toMatchObject([
      { tipo: 'revocar', datos: null },
    ]);
  });

  it('sin correos ni secretos en el pull', async () => {
    const respuesta = await api('/sync/pull?cursor=0', { token: admin.token });
    const texto = await respuesta.text();
    expect(respuesta.status).toBe(200);
    esperarSinSecretos(texto, ['@catmetal.test', 'password_hash', 'storage_key', 'token_hash']);
    expect(texto).not.toMatch(/"email"/);
  });
});

describe('eventos de visibilidad', () => {
  it('revocación: al desasignar, revocar de la orden y de lo ajeno; lo propio sigue llegando', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    await asignarOk(orden, [supervisor.usuario.id, otroSupervisor.usuario.id]);
    const [propio] = await pushOk(supervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const [ajenoC] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const idPropio = String(propio?.servidor?.id);
    const idAjeno = String(ajenoC?.servidor?.id);
    const cursor = await ultimoSeq();

    await asignarOk(orden, [otroSupervisor.usuario.id]); // quita al supervisor
    const decisiones = await pushOk(jefe.token, jefe.usuario.id, [
      decidirMut('aprobar', idPropio, 1),
      decidirMut('aprobar', idAjeno, 1),
    ]);
    expect(decisiones.map((d) => d.resultado)).toEqual(['aplicada', 'aplicada']);

    const { cambios } = await pullTodo(supervisor.token, cursor);

    expect(de(cambios, 'production_orders', orden)).toMatchObject([
      { tipo: 'revocar', datos: null },
    ]);
    expect(de(cambios, 'order_supervisors', `${orden}:${supervisor.usuario.id}`)).toMatchObject([
      { tipo: 'revocar' },
    ]);
    expect(de(cambios, 'consumptions', idAjeno)).toMatchObject([{ tipo: 'revocar' }]);
    expect(de(cambios, 'consumptions', idPropio)).toMatchObject([
      { tipo: 'upsert', datos: { estado: 'aprobado' } },
    ]);
    const validaciones = cambios.filter((c) => c.entidad === 'validations');
    expect(validaciones.map((v) => v.tipo).sort()).toEqual(['revocar', 'upsert']);
    expect(validaciones.find((v) => v.tipo === 'upsert')?.datos).toMatchObject({
      consumption_id: idPropio,
    });

    // El supervisor ajeno (nunca asignado) no recibe revocaciones de lo que nunca vio.
    const paraAjeno = await pullTodo(ajeno.token, cursor);
    expect(paraAjeno.cambios.filter((c) => c.tipo === 'revocar')).toEqual([]);
  });

  it('hidratación: al asignar, hidratar; el snapshot de la orden trae el histórico que el cursor ya pasó', async () => {
    const { orden, material } = await escenarioOrden(jefe, otroSupervisor);
    const [historico] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const idHistorico = String(historico?.servidor?.id);
    await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [crearNovedadMut(idHistorico)]);
    const { cursor } = await pullTodo(supervisor.token, 0);
    expect(cursor).toBe(await ultimoSeq());

    await asignarOk(orden, [otroSupervisor.usuario.id, supervisor.usuario.id]);
    const r = await pullOk(supervisor.token, cursor);

    expect(de(r.cambios, 'production_orders', orden)).toMatchObject([
      { tipo: 'hidratar', datos: null },
    ]);
    expect(de(r.cambios, 'order_supervisors', `${orden}:${supervisor.usuario.id}`)).toMatchObject([
      { tipo: 'upsert', datos: { activo: true, user_id: supervisor.usuario.id } },
    ]);
    // El cursor ya pasó el consumo histórico: no viene en el pull…
    expect(de(r.cambios, 'consumptions', idHistorico)).toEqual([]);
    // …pero sí en el snapshot de la orden.
    const { entidades } = await snapshotCompleto(
      supervisor.token,
      `alcance=orden&order_id=${orden}`,
    );
    const entidadesDe = (e: string) => entidades.filter((x) => x.entidad === e);
    expect(entidadesDe('consumptions').map((c) => c.id)).toContain(idHistorico);
    expect(entidadesDe('incidents')).toHaveLength(1);
    expect(entidadesDe('evidences')).toHaveLength(1);
    expect(entidadesDe('production_orders').map((o) => o.id)).toEqual([orden]);
    expect(entidadesDe('order_planned_materials').map((p) => p.id)).toEqual([
      `${orden}:${material}`,
    ]);
    expect(
      entidadesDe('order_supervisors')
        .map((s) => s.id)
        .sort(),
    ).toEqual(
      [`${orden}:${otroSupervisor.usuario.id}`, `${orden}:${supervisor.usuario.id}`].sort(),
    );
  });

  it('reiniciar al cambiar el rol del propio usuario y al reactivarlo', async () => {
    const yo = await sesion('supervisor');
    const cursor = await ultimoSeq();
    const cambiar = async (cuerpo: Record<string, unknown>) => {
      const r = await api(`/users/${yo.usuario.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: cuerpo,
      });
      expect(r.status, await r.clone().text()).toBe(200);
    };
    await cambiar({ rol: 'jefe' }); // revoca sus sesiones
    const token = (await iniciarSesion(yo.usuario)).cuerpo.access_token;
    const r = await pullOk(token, cursor);
    expect(de(r.cambios, 'users', yo.usuario.id)).toMatchObject([
      { tipo: 'reiniciar', datos: null },
    ]);

    const antes = await ultimoSeq();
    await cambiar({ activo: false });
    await cambiar({ activo: true });
    const token2 = (await iniciarSesion(yo.usuario)).cuerpo.access_token;
    const r2 = await pullOk(token2, antes);
    expect(de(r2.cambios, 'users', yo.usuario.id)).toMatchObject([{ tipo: 'reiniciar' }]);

    // Un cambio que no altera el alcance (el nombre) es un upsert normal.
    const antes3 = await ultimoSeq();
    await cambiar({ nombre: 'Nombre nuevo' });
    const r3 = await pullOk(token2, antes3);
    expect(de(r3.cambios, 'users', yo.usuario.id)).toMatchObject([
      { tipo: 'upsert', datos: { nombre: 'Nombre nuevo', rol: 'jefe' } },
    ]);
  });
});
