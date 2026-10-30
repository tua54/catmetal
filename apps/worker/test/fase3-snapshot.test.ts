// Tarea 3.2 — `GET /api/v1/sync/snapshot` (ADR 0005 regla 7; contrato de
// packages/shared/src/snapshot.ts). Worker real, sesiones reales y D1 local real (sin mocks).
import { MAX_ENTIDADES_SNAPSHOT, snapshotResponseSchema, uuidv7 } from '@catmetal/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { aBase64Url } from '../src/auth/codificacion';
import { codificarPagina, decodificarPagina } from '../src/sync/snapshot';
import { escenarioOrden } from './fase2-consumos-helpers';
import {
  api,
  esperarError,
  nuevaOrden,
  nuevoConsumo,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';
import { esperarSinSecretos } from './fase2-transversal-helpers';
import {
  crearConsumo,
  insertar,
  pullTodo,
  pushOk,
  snapshotCompleto,
  snapshotDe,
  snapshotOk,
} from './fase3-helpers';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let supervisor: SesionDeRol;
let otroSupervisor: SesionDeRol;
let jefe: SesionDeRol;
let admin: SesionDeRol;

beforeAll(async () => {
  [supervisor, otroSupervisor, jefe, admin] = await Promise.all([
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('jefe'),
    sesion('admin'),
  ]);
});

async function muchosMateriales(n: number): Promise<string[]> {
  const t = new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = uuidv7();
    ids.push(id);
    await insertar('materials', {
      id,
      codigo: `MP-SNAP-${id}`,
      nombre: `Material snapshot ${String(i)}`,
      unidad: 'kg',
      costo_unitario_cop: 100,
      activo: 1,
      created_at: t,
      updated_at: t,
    });
  }
  return ids;
}

describe('snapshot inicial', () => {
  it('paginado consistente: cursor igual en todas las páginas, sin repetir y una escritura entre páginas llega por el pull', async () => {
    const materiales = await muchosMateriales(MAX_ENTIDADES_SNAPSHOT + 150);
    const maxAntes = await ultimoSeq();

    const primera = await snapshotOk(jefe.token, 'alcance=inicial');
    expect(snapshotResponseSchema.safeParse(primera).success).toBe(true);
    expect(primera.cursor).toBe(maxAntes);
    expect(primera.entidades).toHaveLength(MAX_ENTIDADES_SNAPSHOT);
    expect(primera.siguiente_pagina).not.toBeNull();

    // Escritura entre páginas (con auditoría): un material nuevo por la API.
    const creado = await api('/materials', {
      token: admin.token,
      body: {
        codigo: `MP-${uuidv7().slice(-12)}`,
        nombre: 'Entre páginas',
        unidad: 'kg',
        costo_unitario_cop: 10,
      },
    });
    expect(creado.status).toBe(201);
    const nuevo = (await creado.json<{ id: string }>()).id;

    const resto = await snapshotCompleto(
      jefe.token,
      `alcance=inicial&pagina=${encodeURIComponent(String(primera.siguiente_pagina))}`,
    );
    const paginas = [primera, ...resto.paginas];
    expect(paginas.length).toBeGreaterThanOrEqual(2);
    expect(new Set(paginas.map((p) => p.cursor))).toEqual(new Set([maxAntes]));
    expect(new Set(paginas.map((p) => p.epoca)).size).toBe(1);
    expect(paginas.at(-1)?.siguiente_pagina).toBeNull();

    const todas = paginas.flatMap((p) => p.entidades);
    const claves = todas.map((e) => `${e.entidad}:${e.id}`);
    expect(new Set(claves).size).toBe(claves.length);
    const idsMateriales = new Set(todas.filter((e) => e.entidad === 'materials').map((e) => e.id));
    expect(materiales.every((id) => idsMateriales.has(id))).toBe(true);
    expect(todas.some((e) => e.entidad === 'settings' && e.id === 'tolerancia_pct')).toBe(true);

    // Lo escrito después del cursor del snapshot llega por el pull.
    const { cambios } = await pullTodo(jefe.token, primera.cursor);
    expect(cambios.filter((c) => c.entidad === 'materials' && c.id === nuevo)).toHaveLength(1);
  });

  it('el supervisor solo recibe lo visible: órdenes asignadas, sus consumos y usuarios jefe/admin', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor);
    const ajena = await escenarioOrden(jefe, otroSupervisor);
    const [propio] = await pushOk(supervisor.token, supervisor.usuario.id, [
      crearConsumo(orden, material),
    ]);
    const [deOtro] = await pushOk(otroSupervisor.token, otroSupervisor.usuario.id, [
      crearConsumo(ajena.orden, ajena.material),
    ]);
    // Consumo propio en una orden que ya no tiene asignada: se sigue viendo (ADR 0005 regla 2).
    const sinAsignar = await nuevaOrden(jefe.usuario.id);
    const propioSinOrden = await nuevoConsumo({
      orderId: sinAsignar,
      materialId: material,
      registradoPor: supervisor.usuario.id,
      deviceId: supervisor.deviceId,
      cantidad: 5,
    });

    const { entidades } = await snapshotCompleto(supervisor.token, 'alcance=inicial');
    const ids = (entidad: string) =>
      entidades.filter((e) => e.entidad === entidad).map((e) => e.id);

    expect(ids('production_orders')).toContain(orden);
    expect(ids('production_orders')).not.toContain(ajena.orden);
    expect(ids('production_orders')).not.toContain(sinAsignar);
    expect(ids('consumptions')).toEqual(
      expect.arrayContaining([String(propio?.servidor?.id), propioSinOrden]),
    );
    expect(ids('consumptions')).not.toContain(String(deOtro?.servidor?.id));
    expect(ids('order_supervisors')).not.toContain(`${ajena.orden}:${otroSupervisor.usuario.id}`);
    const usuarios = entidades.filter((e) => e.entidad === 'users');
    expect(usuarios.map((u) => u.id)).toEqual(
      expect.arrayContaining([supervisor.usuario.id, jefe.usuario.id, admin.usuario.id]),
    );
    expect(usuarios.map((u) => u.id)).not.toContain(otroSupervisor.usuario.id);
    expect(
      usuarios.every((u) => Object.keys(u.datos).sort().join() === 'activo,id,nombre,rol'),
    ).toBe(true);
  });

  it('sin correos ni secretos', async () => {
    for (const s of [admin, supervisor]) {
      const respuesta = await snapshotDe(s.token, 'alcance=inicial');
      const texto = await respuesta.text();
      expect(respuesta.status).toBe(200);
      esperarSinSecretos(texto, ['@catmetal.test', 'password_hash', 'storage_key', 'token_hash']);
      expect(texto).not.toMatch(/"email"/);
    }
  });
});

describe('snapshot de una orden', () => {
  it('jefe ve cualquier orden; el supervisor solo las asignadas (si no, 404)', async () => {
    const { orden } = await escenarioOrden(jefe, supervisor);
    const r = await snapshotOk(jefe.token, `alcance=orden&order_id=${orden}`);
    expect(r.entidades.filter((e) => e.entidad === 'production_orders').map((e) => e.id)).toEqual([
      orden,
    ]);
    expect(r.entidades.some((e) => ['materials', 'users', 'settings'].includes(e.entidad))).toBe(
      false,
    );
    expect(r.siguiente_pagina).toBeNull();

    await esperarError(
      await snapshotDe(otroSupervisor.token, `alcance=orden&order_id=${orden}`),
      404,
      'NO_ENCONTRADO',
    );
    await esperarError(
      await snapshotDe(jefe.token, `alcance=orden&order_id=${uuidv7()}`),
      404,
      'NO_ENCONTRADO',
    );
  });

  it('pagina las entidades de la orden con el mismo cursor', async () => {
    const { orden, material } = await escenarioOrden(jefe, supervisor, { cantidad: 1_000_000 });
    for (let i = 0; i < 6; i += 1) {
      await pushOk(
        supervisor.token,
        supervisor.usuario.id,
        Array.from({ length: 25 }, () => crearConsumo(orden, material)),
      );
    }
    // 150 consumos + orden + plan + asignación: una página. Con 600 consumos, dos páginas.
    for (let i = 0; i < 18; i += 1) {
      await pushOk(
        supervisor.token,
        supervisor.usuario.id,
        Array.from({ length: 25 }, () => crearConsumo(orden, material)),
      );
    }
    const { paginas, entidades } = await snapshotCompleto(
      supervisor.token,
      `alcance=orden&order_id=${orden}`,
    );
    expect(paginas.length).toBe(2);
    expect(new Set(paginas.map((p) => p.cursor)).size).toBe(1);
    expect(entidades.filter((e) => e.entidad === 'consumptions')).toHaveLength(600);
    const claves = entidades.map((e) => `${e.entidad}:${e.id}`);
    expect(new Set(claves).size).toBe(claves.length);
  });
});

describe('validación del snapshot', () => {
  it('sin token 401; alcance u order_id inválidos 400; página manipulada 400', async () => {
    await esperarError(await snapshotDe(undefined, 'alcance=inicial'), 401, 'NO_AUTENTICADO');
    await esperarError(await snapshotDe(jefe.token, 'alcance=todo'), 400, 'VALIDACION');
    await esperarError(await snapshotDe(jefe.token, 'alcance=orden'), 400, 'VALIDACION');
    const malas = [
      'xyz',
      aBase64Url(new TextEncoder().encode('no es json')),
      aBase64Url(new TextEncoder().encode('[1,2]')),
      codificarPagina({ cursor: -1, entidad: 'materials', ultimo_id: 'a' }),
      codificarPagina({ cursor: 1, entidad: 'audit_log', ultimo_id: 'a' }),
      codificarPagina({ cursor: 1, entidad: 'materials', ultimo_id: "' OR 1=1 --" }),
    ];
    for (const pagina of malas) {
      await esperarError(
        await snapshotDe(jefe.token, `alcance=inicial&pagina=${pagina}`),
        400,
        'VALIDACION',
      );
    }
    // Un token de una entidad que no existe en el alcance de orden.
    const { orden } = await escenarioOrden(jefe, supervisor);
    await esperarError(
      await snapshotDe(
        jefe.token,
        `alcance=orden&order_id=${orden}&pagina=${codificarPagina({ cursor: 1, entidad: 'materials', ultimo_id: 'a' })}`,
      ),
      400,
      'VALIDACION',
    );
  });

  it('el token de página es base64url de { cursor, entidad, ultimo_id }', () => {
    const token = codificarPagina({
      cursor: 42,
      entidad: 'order_supervisors',
      ultimo_id: `${uuidv7()}:${uuidv7()}`,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodificarPagina(token)).toMatchObject({ cursor: 42, entidad: 'order_supervisors' });
  });
});
