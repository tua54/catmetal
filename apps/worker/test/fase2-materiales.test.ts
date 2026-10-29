// Catálogo de materiales: /api/v1/materials (leer: autenticado; crear/editar: admin.gestionar).
import { type ListaMateriales, type Material, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { editarMaterial } from '../src/dominio/materiales';
import { ejecutarPlan } from '../src/dominio/plan';
import {
  api,
  auditoriaDesde,
  contextoDe,
  esperarError,
  json,
  nuevoMaterial,
  sesion,
  type SesionDeRol,
  ultimoSeq,
} from './fase2-helpers';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let supervisor: SesionDeRol;

beforeAll(async () => {
  [admin, jefe, supervisor] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('supervisor'),
  ]);
});

function nuevo(extra: Record<string, unknown> = {}) {
  return {
    codigo: `AR-${uuidv7().slice(-12)}`,
    nombre: 'Arena sílice',
    unidad: 'kg',
    costo_unitario_cop: 850,
    ...extra,
  };
}

async function crearPorApi(datos = nuevo()): Promise<Material> {
  const respuesta = await api('/materials', { token: admin.token, body: datos });
  expect(respuesta.status).toBe(201);
  return respuesta.json<Material>();
}

function editar(token: string, id: string, body: unknown) {
  return api(`/materials/${id}`, { method: 'PATCH', token, body });
}

describe('permisos', () => {
  it.each(['supervisor', 'jefe', 'admin'] as const)(
    'un %s puede listar materiales',
    async (rol) => {
      const token = { supervisor, jefe, admin }[rol].token;
      expect((await api('/materials', { token })).status).toBe(200);
    },
  );

  it.each(['supervisor', 'jefe'] as const)('un %s recibe 403 al crear y editar', async (rol) => {
    const token = { supervisor, jefe }[rol].token;
    const id = await nuevoMaterial();
    const antes = await ultimoSeq();
    await esperarError(await api('/materials', { token, body: nuevo() }), 403, 'PERMISO_DENEGADO');
    await esperarError(await editar(token, id, { nombre: 'X' }), 403, 'PERMISO_DENEGADO');
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('sin sesión responde 401 en GET, POST y PATCH', async () => {
    await esperarError(await api('/materials'), 401, 'NO_AUTENTICADO');
    await esperarError(await api('/materials', { body: nuevo() }), 401, 'NO_AUTENTICADO');
    await esperarError(await editar('', uuidv7(), { nombre: 'X' }), 401, 'NO_AUTENTICADO');
  });
});

describe('crear', () => {
  it('crea el material activo y escribe exactamente una fila de auditoría', async () => {
    const antes = await ultimoSeq();
    const datos = nuevo({ codigo: '  RF-001-X  ', nombre: 'Resina furánica', unidad: 'l' });
    const material = await crearPorApi(datos);
    expect(material).toMatchObject({
      codigo: 'RF-001-X',
      nombre: 'Resina furánica',
      unidad: 'l',
      costo_unitario_cop: 850,
      activo: true,
    });
    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      entidad: 'materials',
      entidad_id: material.id,
      accion: 'material.crear',
      actor_id: admin.usuario.id,
      device_id: admin.deviceId,
      order_id: null,
      datos_antes: null,
    });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({
      codigo: 'RF-001-X',
      activo: true,
    });
  });

  it('un código repetido responde 409 CONFLICTO sin escribir nada', async () => {
    const datos = nuevo();
    await crearPorApi(datos);
    const antes = await ultimoSeq();
    const cuerpo = await esperarError(
      await api('/materials', { token: admin.token, body: { ...datos, nombre: 'Otro' } }),
      409,
      'CONFLICTO',
    );
    expect(cuerpo.details).toEqual({ entidad: 'materials', campos: ['codigo'] });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    const { n } = (await env.DB.prepare('SELECT count(*) AS n FROM materials WHERE codigo = ?')
      .bind(datos.codigo)
      .first<{ n: number }>()) ?? { n: -1 };
    expect(n).toBe(1);
  });

  it('valida el cuerpo con Zod (400 VALIDACION con detalles)', async () => {
    const cuerpo = await esperarError(
      await api('/materials', {
        token: admin.token,
        body: nuevo({ unidad: 'ton', costo_unitario_cop: -1 }),
      }),
      400,
      'VALIDACION',
    );
    const campos = (cuerpo.details as { campo: string }[]).map((d) => d.campo).sort();
    expect(campos).toEqual(['costo_unitario_cop', 'unidad']);
  });
});

describe('listar', () => {
  it('pagina por cursor y filtra por activo', async () => {
    const activos = [await crearPorApi(), await crearPorApi()];
    const inactivo = await crearPorApi();
    expect((await editar(admin.token, inactivo.id, { activo: false })).status).toBe(200);

    const vistos: Material[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limite=2' : `?limite=2&cursor=${cursor}`;
      const respuesta = await api(`/materials${query}`, { token: supervisor.token });
      expect(respuesta.status).toBe(200);
      const pagina = await respuesta.json<ListaMateriales>();
      expect(pagina.materiales.length).toBeLessThanOrEqual(2);
      vistos.push(...pagina.materiales);
      cursor = pagina.siguiente_cursor;
    } while (cursor !== null);
    const ids = vistos.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of [...activos, inactivo]) {
      expect(ids).toContain(m.id);
    }

    const soloActivos = await (
      await api('/materials?activo=true&limite=100', { token: jefe.token })
    ).json<ListaMateriales>();
    expect(soloActivos.materiales.every((m) => m.activo)).toBe(true);
    expect(soloActivos.materiales.map((m) => m.id)).not.toContain(inactivo.id);
    const soloInactivos = await (
      await api('/materials?activo=false', { token: jefe.token })
    ).json<ListaMateriales>();
    expect(soloInactivos.materiales.map((m) => m.id)).toContain(inactivo.id);
    expect(soloInactivos.materiales.every((m) => !m.activo)).toBe(true);
  });

  it.each(['limite=0', 'limite=101', 'activo=1', 'cursor=abc'])(
    'rechaza la query %s con 400',
    async (query) => {
      await esperarError(
        await api(`/materials?${query}`, { token: admin.token }),
        400,
        'VALIDACION',
      );
    },
  );
});

describe('editar', () => {
  it('edita nombre y costo, desactiva y audita antes/después', async () => {
    const material = await crearPorApi();
    const antes = await ultimoSeq();
    const respuesta = await editar(admin.token, material.id, {
      nombre: 'Arena sílice malla 50',
      costo_unitario_cop: 900,
      activo: false,
    });
    expect(respuesta.status).toBe(200);
    expect(await respuesta.json<Material>()).toMatchObject({
      id: material.id,
      codigo: material.codigo,
      unidad: material.unidad,
      nombre: 'Arena sílice malla 50',
      costo_unitario_cop: 900,
      activo: false,
    });
    const filas = await auditoriaDesde(antes);
    expect(filas).toHaveLength(1);
    expect(filas[0]?.accion).toBe('material.editar');
    expect(json(filas[0]?.datos_antes ?? null)).toMatchObject({
      activo: true,
      costo_unitario_cop: 850,
    });
    expect(json(filas[0]?.datos_despues ?? null)).toMatchObject({
      activo: false,
      costo_unitario_cop: 900,
    });
    // Nunca se borra: sigue en la base.
    const fila = await env.DB.prepare('SELECT activo FROM materials WHERE id = ?')
      .bind(material.id)
      .first<{ activo: number }>();
    expect(fila?.activo).toBe(0);
  });

  it('no permite cambiar el código ni la unidad (se ignoran) y exige algún campo', async () => {
    const material = await crearPorApi();
    await esperarError(
      await editar(admin.token, material.id, { codigo: 'NUEVO', unidad: 'g' }),
      400,
      'VALIDACION',
    );
  });

  it('responde 404 si no existe y 400 si el id no es UUID v7', async () => {
    await esperarError(await editar(admin.token, uuidv7(), { nombre: 'X' }), 404, 'NO_ENCONTRADO');
    await esperarError(await editar(admin.token, 'abc', { nombre: 'X' }), 400, 'VALIDACION');
  });

  it('si otro admin lo editó entre la lectura y la escritura: 409 y sin auditoría', async () => {
    const id = await nuevoMaterial();
    const ctx = await contextoDe('admin');
    const plan = await editarMaterial(ctx, id, { costo_unitario_cop: 2000 });
    await env.DB.prepare(`UPDATE materials SET costo_unitario_cop = 1, updated_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() + 1000).toISOString(), id)
      .run();
    const antes = await ultimoSeq();
    await expect(ejecutarPlan(env.DB, plan)).rejects.toMatchObject({ code: 'CONFLICTO' });
    expect(await auditoriaDesde(antes)).toHaveLength(0);
    const fila = await env.DB.prepare('SELECT costo_unitario_cop FROM materials WHERE id = ?')
      .bind(id)
      .first<{ costo_unitario_cop: number }>();
    expect(fila?.costo_unitario_cop).toBe(1);
  });
});
