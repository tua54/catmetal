// Novedades: POST /consumptions/:id/incident con los metadatos de sus evidencias. D1 local real.
import { type ListaConsumos, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  archivo,
  cuerpoConsumo,
  cuerpoNovedad,
  escenarioOrden,
  jpeg,
  novedad,
  novedadOk,
  png,
  registrarOk,
} from './fase2-consumos-helpers';
import {
  api,
  asignar,
  auditoriaDesde,
  esperarError,
  json,
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

async function consumoDelSupervisor(cantidad = 150) {
  const esc = await escenarioOrden(jefe, supervisor, { cantidad: 100 });
  const consumo = await registrarOk(
    supervisor.token,
    cuerpoConsumo(esc.orden, esc.material, { cantidad }),
  );
  return { ...esc, consumo };
}

async function contar(tabla: 'incidents' | 'evidences', columna: string, valor: string) {
  const fila = await env.DB.prepare(`SELECT count(*) AS n FROM ${tabla} WHERE ${columna} = ?`)
    .bind(valor)
    .first<{ n: number }>();
  return fila?.n ?? -1;
}

describe('registrar novedad', () => {
  it('el autor la registra con evidencias en el mismo batch y una auditoría por entidad', async () => {
    const { orden, consumo } = await consumoDelSupervisor();
    expect(consumo.requiere_novedad).toBe(true);
    const fotos = [await archivo('image/jpeg', jpeg()), await archivo('image/png', png())];
    const body = cuerpoNovedad(consumo.id, fotos);
    const antes = await ultimoSeq();
    const creada = await novedadOk(supervisor.token, consumo.id, body);
    expect(creada).toMatchObject({
      id: body.id,
      consumption_id: consumo.id,
      tipo: 'merma',
      registrado_por: supervisor.usuario.id,
    });
    expect(creada.evidencias).toEqual(
      fotos.map(
        (f) =>
          expect.objectContaining({
            id: f.id,
            incident_id: body.id,
            mime: f.mime,
            sha256: f.sha256,
            tamano_bytes: f.bytes.byteLength,
            subido: false,
            subido_at: null,
          }) as unknown,
      ),
    );
    expect(creada.evidencias[0]).not.toHaveProperty('storage_key');

    const { results } = await env.DB.prepare(
      'SELECT id, storage_key, subido FROM evidences WHERE incident_id = ? ORDER BY id',
    )
      .bind(body.id)
      .all<{ id: string; storage_key: string; subido: number }>();
    expect(results).toEqual(
      fotos.map((f) => ({ id: f.id, storage_key: `evidencias/${orden}/${f.id}`, subido: 0 })),
    );

    const filas = await auditoriaDesde(antes);
    expect(filas.map((f) => [f.entidad, f.entidad_id, f.accion, f.order_id])).toEqual([
      ['incidents', body.id, 'novedad.crear', orden],
      ['evidences', fotos[0]?.id, 'evidencia.crear', orden],
      ['evidences', fotos[1]?.id, 'evidencia.crear', orden],
    ]);
    expect(JSON.stringify(filas)).not.toContain('storage_key');
    expect(json(filas[1]?.datos_despues ?? null)).toMatchObject({ subido: false });

    // Ya no "falta novedad".
    const lista = await (
      await api(`/orders/${orden}/consumptions`, { token: jefe.token })
    ).json<ListaConsumos>();
    const visto = lista.consumos.find((c) => c.id === consumo.id);
    expect(visto).toMatchObject({ requiere_novedad: true, falta_novedad: false });
    expect(visto?.novedades[0]?.evidencias.map((e) => e.id)).toEqual(fotos.map((f) => f.id));
  });

  it('un jefe la registra sobre el consumo de otro; se admiten varias y en cualquier estado', async () => {
    const { consumo } = await consumoDelSupervisor(10);
    await decidir(consumo.id, jefe.usuario.id, 'aprobado');
    await novedadOk(jefe.token, consumo.id, cuerpoNovedad(consumo.id));
    await novedadOk(supervisor.token, consumo.id, cuerpoNovedad(consumo.id));
    expect(await contar('incidents', 'consumption_id', consumo.id)).toBe(2);
  });

  it('permisos: otro supervisor 403 (si ve la orden) o 404; admin 403; sin sesión 401', async () => {
    const { orden, consumo } = await consumoDelSupervisor();
    await esperarError(
      await novedad(otroSupervisor.token, consumo.id, cuerpoNovedad(consumo.id)),
      404,
      'NO_ENCONTRADO',
    );
    await asignar(orden, otroSupervisor.usuario.id, admin.usuario.id);
    await esperarError(
      await novedad(otroSupervisor.token, consumo.id, cuerpoNovedad(consumo.id)),
      403,
      'PERMISO_DENEGADO',
    );
    await esperarError(
      await novedad(admin.token, consumo.id, cuerpoNovedad(consumo.id)),
      403,
      'PERMISO_DENEGADO',
    );
    await esperarError(
      await novedad(undefined, consumo.id, cuerpoNovedad(consumo.id)),
      401,
      'NO_AUTENTICADO',
    );
    expect(await contar('incidents', 'consumption_id', consumo.id)).toBe(0);
  });

  it('ids repetidos (novedad o evidencia) → 409 ID_DUPLICADO sin escribir nada', async () => {
    const { consumo } = await consumoDelSupervisor();
    const foto = await archivo('image/jpeg', jpeg());
    const primera = cuerpoNovedad(consumo.id, [foto]);
    await novedadOk(supervisor.token, consumo.id, primera);
    const antes = await ultimoSeq();
    await esperarError(
      await novedad(supervisor.token, consumo.id, { ...primera, evidencias: [] }),
      409,
      'ID_DUPLICADO',
    );
    const segunda = cuerpoNovedad(consumo.id, [foto]);
    const cuerpo = await esperarError(
      await novedad(supervisor.token, consumo.id, segunda),
      409,
      'ID_DUPLICADO',
    );
    expect(cuerpo.details).toEqual({ entidad: 'evidences', campos: ['id'] });
    expect(await contar('incidents', 'id', String(segunda.id))).toBe(0);
    expect(await auditoriaDesde(antes)).toHaveLength(0);
  });

  it('valida el cuerpo: máximo 5 fotos, mime permitido, ids de ruta y cuerpo iguales', async () => {
    const { consumo } = await consumoDelSupervisor();
    const foto = await archivo('image/jpeg', jpeg());
    const seis = Array.from({ length: 6 }, () => ({ ...foto, id: uuidv7() }));
    for (const body of [
      cuerpoNovedad(consumo.id, seis),
      cuerpoNovedad(consumo.id, [{ ...foto, mime: 'image/gif' }]),
      { ...cuerpoNovedad(consumo.id), tipo: 'robo' },
      cuerpoNovedad(uuidv7()),
    ]) {
      await esperarError(await novedad(supervisor.token, consumo.id, body), 400, 'VALIDACION');
    }
    const otro = uuidv7();
    await esperarError(
      await novedad(supervisor.token, otro, cuerpoNovedad(otro)),
      404,
      'NO_ENCONTRADO',
    );
  });
});
