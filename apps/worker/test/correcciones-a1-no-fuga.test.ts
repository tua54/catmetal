// A1 (ADR 0028, punto 8): la marca de escritura `escritura_id` es INTERNA. Después de escribir por
// todas las vías (REST, /sync/push) en todas las tablas que la tienen, no aparece en ninguna
// respuesta REST, de /sync/push, de /sync/pull ni del snapshot, ni en `datos_antes`/`datos_despues`
// de la auditoría. Sin fuga no hay cambio de contrato (clientes v1.0 y v1.1). Worker y D1 reales.
import { uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { archivo, cuerpoConsumo, cuerpoNovedad, jpeg, subir } from './fase2-consumos-helpers';
import { api, codigoOrden, sesion, type SesionDeRol } from './fase2-helpers';
import { crearConsumo, editarConsumoMut, pullTodo, push, snapshotCompleto } from './fase3-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

const textos: { donde: string; texto: string }[] = [];

/** Guarda el cuerpo de la respuesta (para buscar la marca) y exige el estado esperado. */
async function guardar(donde: string, respuesta: Response, estado: number): Promise<unknown> {
  const texto = await respuesta.text();
  expect(respuesta.status, `${donde}: ${texto}`).toBe(estado);
  textos.push({ donde, texto });
  return texto === '' ? null : (JSON.parse(texto) as unknown);
}

describe('A1: escritura_id nunca sale del Worker', () => {
  it('escribe por todas las vías y ninguna respuesta ni auditoría trae la marca', async () => {
    // Catálogo y configuración (admin).
    const material = (await guardar(
      'POST /materials',
      await api('/materials', {
        token: admin.token,
        body: {
          codigo: `M-${uuidv7().slice(-8)}`,
          nombre: 'Arena',
          unidad: 'kg',
          costo_unitario_cop: 900,
        },
      }),
      201,
    )) as { id: string };
    await guardar(
      'PATCH /materials/:id',
      await api(`/materials/${material.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { nombre: 'Arena fina' },
      }),
      200,
    );
    await guardar(
      'PATCH /settings/tolerancia',
      await api('/settings/tolerancia', {
        method: 'PATCH',
        token: admin.token,
        body: { tolerancia_pct: 6 },
      }),
      200,
    );

    // Orden (jefe), asignación (admin) e inicio.
    const orden = (await guardar(
      'POST /orders',
      await api('/orders', {
        token: jefe.token,
        body: {
          codigo: codigoOrden(),
          linea: 'Moldeo',
          materiales: [{ material_id: material.id, cantidad_planeada: 100, unidad: 'kg' }],
        },
      }),
      201,
    )) as { id: string };
    await guardar(
      'PUT /orders/:id/supervisors',
      await api(`/orders/${orden.id}/supervisors`, {
        method: 'PUT',
        token: admin.token,
        body: { supervisores: [supervisor.usuario.id] },
      }),
      200,
    );
    await guardar(
      'POST /orders/:id/start',
      await api(`/orders/${orden.id}/start`, { token: jefe.token, body: {} }),
      200,
    );

    // Consumo, edición, novedad con foto y subida (supervisor); aprobación (jefe).
    const consumo = (await guardar(
      'POST /consumptions',
      await api('/consumptions', {
        token: supervisor.token,
        body: cuerpoConsumo(orden.id, material.id),
      }),
      201,
    )) as { id: string; version: number };
    const editado = (await guardar(
      'PATCH /consumptions/:id',
      await api(`/consumptions/${consumo.id}`, {
        method: 'PATCH',
        token: supervisor.token,
        body: {
          id: consumo.id,
          version: 1,
          client_created_at: new Date().toISOString(),
          lote: 'L-2',
        },
      }),
      200,
    )) as { version: number };
    const foto = await archivo('image/jpeg', jpeg(1024));
    await guardar(
      'POST /consumptions/:id/incident',
      await api(`/consumptions/${consumo.id}/incident`, {
        token: supervisor.token,
        body: cuerpoNovedad(consumo.id, [foto]),
      }),
      201,
    );
    await guardar(
      'PUT /evidences/:id',
      await subir(supervisor.token, foto.id, foto.bytes, 'image/jpeg'),
      200,
    );
    await guardar(
      'POST /consumptions/:id/approve',
      await api(`/consumptions/${consumo.id}/approve`, {
        token: jefe.token,
        body: {
          id: uuidv7(),
          version: editado.version,
          client_created_at: new Date().toISOString(),
        },
      }),
      201,
    );

    // Por /sync/push: crear y editar.
    const crear = crearConsumo(orden.id, material.id);
    await guardar(
      'POST /sync/push',
      await push(supervisor.token, supervisor.usuario.id, [
        crear,
        editarConsumoMut(String(crear.payload.id), 1, { lote: 'L-3' }),
      ]),
      200,
    );

    // Usuario (admin).
    await guardar(
      'PATCH /users/:id',
      await api(`/users/${supervisor.usuario.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { nombre: 'Supervisor renombrado' },
      }),
      200,
    );

    // Las filas escritas SÍ tienen la marca (si no, la prueba no probaría nada).
    for (const [tabla, id] of [
      ['materials', material.id],
      ['production_orders', orden.id],
      ['consumptions', consumo.id],
      ['evidences', foto.id],
      ['users', supervisor.usuario.id],
    ] as const) {
      const fila = await env.DB.prepare(`SELECT escritura_id FROM ${tabla} WHERE id = ?`)
        .bind(id)
        .first<{ escritura_id: string | null }>();
      expect(fila?.escritura_id, tabla).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Lecturas REST de todo lo escrito.
    const lecturas: [string, SesionDeRol][] = [
      ['/materials', admin],
      [`/orders`, jefe],
      [`/orders/${orden.id}`, jefe],
      [`/orders/${orden.id}/consumptions`, jefe],
      [`/orders/${orden.id}/audit`, jefe],
      ['/audit', admin],
      ['/validations/queue', jefe],
      ['/settings', admin],
      ['/users', admin],
      ['/auth/me', supervisor],
      [`/reports/orders/${orden.id}/summary`, jefe],
    ];
    for (const [ruta, quien] of lecturas) {
      await guardar(`GET ${ruta}`, await api(ruta, { token: quien.token }), 200);
    }

    // /sync/pull y snapshot (supervisor y jefe).
    for (const quien of [supervisor, jefe]) {
      const { cambios } = await pullTodo(quien.token, 0);
      textos.push({ donde: 'GET /sync/pull', texto: JSON.stringify(cambios) });
      const { entidades } = await snapshotCompleto(quien.token, 'alcance=inicial');
      expect(entidades.length).toBeGreaterThan(0);
      textos.push({ donde: 'GET /sync/snapshot', texto: JSON.stringify(entidades) });
    }

    expect(textos.filter((t) => t.texto.includes('escritura_id')).map((t) => t.donde)).toEqual([]);
    const auditoria = await env.DB.prepare(
      `SELECT count(*) AS n FROM audit_log
       WHERE datos_antes LIKE '%escritura_id%' OR datos_despues LIKE '%escritura_id%'`,
    ).first<{ n: number }>();
    expect(auditoria?.n).toBe(0);
  });
});
