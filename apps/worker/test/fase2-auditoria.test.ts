// Tarea 2.4: GET /api/v1/audit y GET /api/v1/orders/:id/audit (línea de tiempo), con permisos,
// filtros, cursor y descripciones. D1 local real; fixtures con auditoría real (fase2-auditoria-helpers).
import {
  type EventoLineaTiempo,
  type LineaTiempoOrden,
  type ListaAuditoria,
  type OrdenCreada,
  uuidv7,
} from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { sentenciaAuditoria } from '../src/auditoria/auditar';
import { describirEvento, type FilaAuditoriaConActor } from '../src/dominio/auditoria-consulta';
import {
  type Autor,
  decidirConsumo,
  type FilaConsumo,
  materialConNombre,
  registrarConsumo,
  registrarEvidencia,
  registrarNovedad,
  renombrar,
} from './fase2-auditoria-helpers';
import {
  api,
  asignar,
  codigoOrden,
  esperarError,
  nuevaOrden,
  sesion,
  type SesionDeRol,
} from './fase2-helpers';
import { crearAuditoria } from './fixtures-db';

let admin: SesionDeRol;
let jefe: SesionDeRol;
let sup: SesionDeRol;
let sup2: SesionDeRol;
let supAjeno: SesionDeRol;
let supSinAsignacion: SesionDeRol;

let orden: OrdenCreada;
let resina: { id: string };
let arena: { id: string };
let c1: FilaConsumo;
let c2: FilaConsumo;
let c3: FilaConsumo;
let c4: FilaConsumo;
let c5: FilaConsumo;
let c6: FilaConsumo;
/** Orden donde `supSinAsignacion` perdió la asignación pero tiene un consumo propio. */
let ordenPerdida: string;

const autor = (s: SesionDeRol): Autor => ({ id: s.usuario.id, deviceId: s.deviceId });

async function ok<T>(respuesta: Response): Promise<T> {
  expect(respuesta.status, await respuesta.clone().text()).toBe(200);
  return respuesta.json<T>();
}

beforeAll(async () => {
  [admin, jefe, sup, sup2, supAjeno, supSinAsignacion] = await Promise.all([
    sesion('admin'),
    sesion('jefe'),
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('supervisor'),
    sesion('supervisor'),
  ]);
  await renombrar(sup.usuario.id, 'Laura Gómez');
  await renombrar(sup2.usuario.id, 'Pedro Ruiz');
  await renombrar(jefe.usuario.id, 'Carlos Jefe');
  resina = await materialConNombre('Resina furánica', 'kg', 9800);
  arena = await materialConNombre('Arena sílice', 'kg', 350);

  // Orden por la API real: su auditoría (crear, planear, iniciar, asignar) la escribe el dominio.
  const creada = await api('/orders', {
    token: jefe.token,
    body: {
      codigo: codigoOrden(),
      linea: 'Fundición nodular',
      materiales: [
        { material_id: resina.id, cantidad_planeada: 500, unidad: 'kg' },
        { material_id: arena.id, cantidad_planeada: 1000, unidad: 'kg' },
      ],
    },
  });
  expect(creada.status).toBe(201);
  orden = await creada.json<OrdenCreada>();
  expect(
    (await api(`/orders/${orden.id}/start`, { method: 'POST', token: jefe.token })).status,
  ).toBe(200);
  const asignacion = await api(`/orders/${orden.id}/supervisors`, {
    method: 'PUT',
    token: admin.token,
    body: { supervisores: [sup.usuario.id, sup2.usuario.id] },
  });
  expect(asignacion.status).toBe(200);

  c1 = await registrarConsumo({
    orderId: orden.id,
    materialId: resina.id,
    autor: autor(sup),
    cantidad: 125.5,
  });
  const novedad = await registrarNovedad(c1, autor(sup), 'merma', 'Se derramó resina al cargar');
  await registrarEvidencia(novedad, orden.id, autor(sup));
  c2 = await registrarConsumo({
    orderId: orden.id,
    materialId: arena.id,
    autor: autor(sup),
    cantidad: 300,
  });
  await decidirConsumo(c2, autor(jefe), 'aprobado');
  c3 = await registrarConsumo({
    orderId: orden.id,
    materialId: arena.id,
    autor: autor(sup),
    cantidad: 50,
  });
  await decidirConsumo(c3, autor(jefe), 'rechazado', 'Lote equivocado');
  c4 = await registrarConsumo({
    orderId: orden.id,
    materialId: arena.id,
    autor: autor(sup2),
    cantidad: 10,
  });
  await decidirConsumo(c4, autor(jefe), 'aprobado');
  c5 = await registrarConsumo({
    orderId: orden.id,
    materialId: arena.id,
    autor: autor(sup),
    cantidad: 48,
    corrigeA: String(c3.id),
  });
  c6 = await registrarConsumo({
    orderId: orden.id,
    materialId: resina.id,
    autor: autor(sup),
    cantidad: 400,
    requiereNovedad: true,
    registroTardio: true,
    clientAt: new Date(Date.now() - 3_600_000).toISOString(),
  });

  ordenPerdida = await nuevaOrden(jefe.usuario.id);
  await asignar(ordenPerdida, supSinAsignacion.usuario.id, admin.usuario.id, 0);
  await registrarConsumo({
    orderId: ordenPerdida,
    materialId: arena.id,
    autor: autor(supSinAsignacion),
    cantidad: 5,
  });
});

async function lineaCompleta(
  token: string,
  orderId: string,
  limite = 3,
): Promise<EventoLineaTiempo[]> {
  const eventos: EventoLineaTiempo[] = [];
  let cursor: number | null = null;
  do {
    const query: string = `?limite=${String(limite)}${cursor === null ? '' : `&cursor=${String(cursor)}`}`;
    const pagina: LineaTiempoOrden = await ok(
      await api(`/orders/${orderId}/audit${query}`, { token }),
    );
    expect(pagina.order_id).toBe(orderId);
    eventos.push(...pagina.eventos);
    cursor = pagina.siguiente_cursor;
  } while (cursor !== null);
  return eventos;
}

// ---------------------------------------------------------------------------------------------
// GET /audit
// ---------------------------------------------------------------------------------------------

describe('GET /audit: permisos y contenido', () => {
  it('sin token → 401', async () => {
    await esperarError(await api('/audit'), 401, 'NO_AUTENTICADO');
  });

  it.each(['jefe', 'admin'] as const)(
    '%s ve cualquier fila con actor, order_id y datos parseados',
    async (rol) => {
      const token = rol === 'jefe' ? jefe.token : admin.token;
      const lista: ListaAuditoria = await ok(
        await api(`/audit?entidad=consumptions&entidad_id=${String(c1.id)}`, { token }),
      );
      expect(lista.siguiente_cursor).toBeNull();
      expect(lista.entradas).toHaveLength(1);
      const [entrada] = lista.entradas;
      expect(entrada).toMatchObject({
        entidad: 'consumptions',
        entidad_id: c1.id,
        order_id: orden.id,
        accion: 'consumo.crear',
        actor: { id: sup.usuario.id, nombre: 'Laura Gómez', rol: 'supervisor' },
        device_id: sup.deviceId,
        datos_antes: null,
        alerta_reloj: false,
      });
      expect(entrada?.datos_despues).toMatchObject({
        cantidad: 125.5,
        estado: 'pendiente',
        registro_tardio: false,
        requiere_novedad: false,
      });
      expect(typeof entrada?.seq).toBe('number');
      expect(Object.keys(entrada ?? {}).sort()).toEqual(
        [
          'accion',
          'actor',
          'alerta_reloj',
          'client_at',
          'datos_antes',
          'datos_despues',
          'device_id',
          'entidad',
          'entidad_id',
          'id',
          'order_id',
          'seq',
          'server_at',
        ].sort(),
      );
    },
  );

  it('marca alerta_reloj cuando la hora del dispositivo difiere más de 10 min', async () => {
    const lista: ListaAuditoria = await ok(
      await api(`/audit?entidad=consumptions&entidad_id=${String(c6.id)}`, { token: jefe.token }),
    );
    expect(lista.entradas[0]?.alerta_reloj).toBe(true);
  });

  it('una acción del sistema (sin actor) tiene actor null', async () => {
    const entidadId = uuidv7();
    await crearAuditoria({ entidad: 'materials', entidad_id: entidadId, accion: 'seed' });
    const lista: ListaAuditoria = await ok(
      await api(`/audit?entidad_id=${entidadId}`, { token: admin.token }),
    );
    expect(lista.entradas).toHaveLength(1);
    expect(lista.entradas[0]?.actor).toBeNull();
  });

  it('nunca expone secretos ni storage_key', async () => {
    for (const entidad of ['users', 'refresh_tokens', 'evidences', 'devices']) {
      const respuesta = await api(`/audit?entidad=${entidad}&limite=200`, { token: admin.token });
      const textoRespuesta = await respuesta.text();
      expect(respuesta.status).toBe(200);
      for (const prohibido of ['password_hash', 'token_hash', 'storage_key', 'pbkdf2-sha256$']) {
        expect(textoRespuesta.includes(prohibido), `${entidad}: ${prohibido}`).toBe(false);
      }
    }
  });
});

describe('GET /audit: supervisor solo lo propio', () => {
  it('todas las filas que recibe tienen al supervisor como actor', async () => {
    let cursor: number | null = null;
    const entidades = new Set<string>();
    let total = 0;
    do {
      const query: string = `?limite=2${cursor === null ? '' : `&cursor=${String(cursor)}`}`;
      const pagina: ListaAuditoria = await ok(await api(`/audit${query}`, { token: sup.token }));
      for (const entrada of pagina.entradas) {
        expect(entrada.actor?.id).toBe(sup.usuario.id);
        entidades.add(`${entrada.entidad}:${entrada.entidad_id}`);
      }
      total += pagina.entradas.length;
      cursor = pagina.siguiente_cursor;
    } while (cursor !== null);
    // Sus consumos sí; las validaciones del jefe y los consumos de otro supervisor no.
    for (const consumo of [c1, c2, c3, c5, c6]) {
      expect(entidades.has(`consumptions:${String(consumo.id)}`)).toBe(true);
    }
    expect(entidades.has(`consumptions:${String(c4.id)}`)).toBe(false);
    expect([...entidades].some((e) => e.startsWith('validations:'))).toBe(false);
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it('filtrar por una entidad ajena devuelve vacío (no un error)', async () => {
    const lista: ListaAuditoria = await ok(
      await api(`/audit?entidad=consumptions&entidad_id=${String(c4.id)}`, { token: sup.token }),
    );
    expect(lista).toEqual({ entradas: [], siguiente_cursor: null });
    const ajeno: ListaAuditoria = await ok(await api('/audit', { token: supAjeno.token }));
    for (const entrada of ajeno.entradas) {
      expect(entrada.actor?.id).toBe(supAjeno.usuario.id);
    }
  });
});

describe('GET /audit: orden, cursor y filtros', () => {
  it('orden descendente por seq y cursor por seq', async () => {
    const todas: ListaAuditoria = await ok(
      await api(`/audit?entidad=production_orders&entidad_id=${orden.id}`, { token: jefe.token }),
    );
    expect(todas.entradas.map((e) => e.accion)).toEqual(['orden.iniciar', 'orden.crear']);
    const [primera, segunda] = todas.entradas;
    expect((primera?.seq ?? 0) > (segunda?.seq ?? 0)).toBe(true);

    const p1: ListaAuditoria = await ok(
      await api(`/audit?entidad=production_orders&entidad_id=${orden.id}&limite=1`, {
        token: jefe.token,
      }),
    );
    expect(p1.entradas.map((e) => e.seq)).toEqual([primera?.seq]);
    expect(p1.siguiente_cursor).toBe(primera?.seq);
    const p2: ListaAuditoria = await ok(
      await api(
        `/audit?entidad=production_orders&entidad_id=${orden.id}&limite=1&cursor=${String(p1.siguiente_cursor)}`,
        { token: jefe.token },
      ),
    );
    expect(p2.entradas.map((e) => e.seq)).toEqual([segunda?.seq]);
    expect(p2.siguiente_cursor).toBeNull();
  });

  it('sin filtros pagina por toda la tabla con límite por defecto 50', async () => {
    // Completa al menos 51 filas para que la primera página quede llena.
    const fila = await env.DB.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>();
    for (let i = fila?.n ?? 0; i <= 50; i += 1) {
      await crearAuditoria({ entidad: 'materials', accion: 'relleno' });
    }
    const pagina: ListaAuditoria = await ok(await api('/audit', { token: admin.token }));
    expect(pagina.entradas.length).toBe(50);
    expect(pagina.siguiente_cursor).toBe(pagina.entradas.at(-1)?.seq);
    const seqs = pagina.entradas.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it('desde y hasta filtran por server_at (inclusivos)', async () => {
    const entidadId = uuidv7();
    for (const dia of ['01', '02', '03']) {
      await crearAuditoria({
        entidad: 'materials',
        entidad_id: entidadId,
        accion: `prueba.${dia}`,
        server_at: `2001-01-${dia}T12:00:00.000Z`,
      });
    }
    const consultar = async (filtro: string): Promise<string[]> => {
      const lista: ListaAuditoria = await ok(
        await api(`/audit?entidad_id=${entidadId}${filtro}`, { token: jefe.token }),
      );
      return lista.entradas.map((e) => e.accion);
    };
    expect(await consultar('')).toEqual(['prueba.03', 'prueba.02', 'prueba.01']);
    expect(await consultar('&desde=2001-01-02T12:00:00Z')).toEqual(['prueba.03', 'prueba.02']);
    expect(await consultar('&hasta=2001-01-02T12:00:00.000Z')).toEqual(['prueba.02', 'prueba.01']);
    expect(
      await consultar('&desde=2001-01-02T00:00:00.000Z&hasta=2001-01-02T23:59:59.999Z'),
    ).toEqual(['prueba.02']);
    expect(await consultar('&entidad=consumptions')).toEqual([]);
  });

  it.each([
    'cursor=abc',
    'cursor=-1',
    'cursor=0',
    'cursor=1.5',
    'cursor=1e3',
    'limite=0',
    'limite=201',
    'entidad=audit_log',
    'entidad_id=x%27%20OR%201%3D1',
    'desde=ayer',
    'desde=2026-10-30T00:00:00Z&hasta=2026-10-29T00:00:00Z',
  ])('query inválida (%s) → 400 VALIDACION', async (query) => {
    await esperarError(await api(`/audit?${query}`, { token: jefe.token }), 400, 'VALIDACION');
  });
});

// ---------------------------------------------------------------------------------------------
// GET /orders/:id/audit
// ---------------------------------------------------------------------------------------------

describe('GET /orders/:id/audit: línea de tiempo del jefe y del admin', () => {
  it('es cronológica, con descripciones en español, tipos y actor', async () => {
    const eventos = await lineaCompleta(jefe.token, orden.id);
    const seqs = eventos.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const resumen = eventos.map((e) => [e.tipo, e.descripcion]);
    expect(resumen.slice(0, 4)).toEqual([
      ['sistema', `Orden ${orden.codigo} creada`],
      ['sistema', 'Planeó 500 kg de Resina furánica'],
      ['sistema', 'Planeó 1.000 kg de Arena sílice'],
      ['sistema', `Orden ${orden.codigo} iniciada`],
    ]);
    expect(resumen.slice(4, 6)).toEqual(
      expect.arrayContaining([
        ['sistema', 'Asignó a Laura Gómez'],
        ['sistema', 'Asignó a Pedro Ruiz'],
      ]),
    );
    expect(resumen.slice(6)).toEqual([
      ['novedad', 'Registró 125,5 kg de Resina furánica + novedad'],
      [
        'novedad',
        'Registró novedad (Merma) en el consumo de Resina furánica: Se derramó resina al cargar',
      ],
      [
        'novedad',
        'Adjuntó una foto de evidencia a la novedad de Resina furánica (pendiente de subir)',
      ],
      ['novedad', 'Subió la foto de evidencia de la novedad de Resina furánica'],
      ['registro', 'Registró 300 kg de Arena sílice'],
      ['validacion', 'Validó consumo de Arena sílice'],
      ['registro', 'Registró 50 kg de Arena sílice'],
      ['rechazo', 'Rechazó consumo de Arena sílice: Lote equivocado'],
      ['registro', 'Registró 10 kg de Arena sílice'],
      ['validacion', 'Validó consumo de Arena sílice'],
      ['registro', 'Registró corrección: 48 kg de Arena sílice'],
      [
        'novedad',
        'Registró 400 kg de Resina furánica (supera la tolerancia: falta novedad) (registro tardío)',
      ],
    ]);

    const creacion = eventos[0];
    expect(creacion?.actor).toEqual({ id: jefe.usuario.id, nombre: 'Carlos Jefe', rol: 'jefe' });
    const asignaciones = eventos.filter((e) => e.entidad === 'order_supervisors');
    expect(asignaciones.every((e) => e.actor?.rol === 'admin')).toBe(true);
    const rechazo = eventos.find((e) => e.tipo === 'rechazo');
    expect(rechazo?.consumption_id).toBe(c3.id);
    expect(rechazo?.actor?.nombre).toBe('Carlos Jefe');
    const tardio = eventos.at(-1);
    expect(tardio?.alerta_reloj).toBe(true);
    // La fila del consumo que escribe la validación no se repite en la línea de tiempo.
    expect(eventos.filter((e) => e.entidad === 'consumptions').map((e) => e.accion)).toEqual(
      Array.from({ length: 6 }, () => 'consumo.crear'),
    );
  });

  it('el admin ve la misma línea de tiempo y la paginación no pierde ni repite eventos', async () => {
    const delJefe = await lineaCompleta(jefe.token, orden.id, 200);
    const delAdmin = await lineaCompleta(admin.token, orden.id, 1);
    expect(delAdmin).toEqual(delJefe);
    const pagina: LineaTiempoOrden = await ok(
      await api(`/orders/${orden.id}/audit?limite=5`, { token: jefe.token }),
    );
    expect(pagina.codigo).toBe(orden.codigo);
    expect(pagina.eventos).toHaveLength(5);
    expect(pagina.siguiente_cursor).toBe(pagina.eventos[4]?.seq);
  });

  it('describe la edición de un consumo pendiente', async () => {
    const consumo = await registrarConsumo({
      orderId: orden.id,
      materialId: arena.id,
      autor: autor(sup),
      cantidad: 20,
    });
    const ahora = new Date().toISOString();
    const despues = {
      ...consumo,
      cantidad: 22,
      cantidad_en_unidad_plan: 22,
      version: 2,
      updated_at: ahora,
    };
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE consumptions SET cantidad = 22, cantidad_en_unidad_plan = 22, version = 2,
         updated_at = ? WHERE id = ?`,
      ).bind(ahora, String(consumo.id)),
      sentenciaAuditoria(env.DB, {
        entidad: 'consumptions',
        entidad_id: String(consumo.id),
        accion: 'consumo.editar',
        order_id: orden.id,
        actor_id: sup.usuario.id,
        device_id: sup.deviceId,
        antes: consumo,
        despues,
        server_at: ahora,
      }),
    ]);
    const eventos = await lineaCompleta(jefe.token, orden.id, 200);
    expect(eventos.at(-1)).toMatchObject({
      tipo: 'registro',
      descripcion: 'Editó el consumo de Arena sílice: 20 kg → 22 kg',
      consumption_id: consumo.id,
      actor: { id: sup.usuario.id },
    });
  });

  it('orden inexistente → 404; id inválido o cursor inválido → 400; sin token → 401', async () => {
    await esperarError(
      await api(`/orders/${uuidv7()}/audit`, { token: jefe.token }),
      404,
      'NO_ENCONTRADO',
    );
    await esperarError(
      await api('/orders/no-es-uuid/audit', { token: jefe.token }),
      400,
      'VALIDACION',
    );
    await esperarError(
      await api(`/orders/${orden.id}/audit?cursor=abc`, { token: jefe.token }),
      400,
      'VALIDACION',
    );
    await esperarError(
      await api(`/orders/${orden.id}/audit?limite=201`, { token: jefe.token }),
      400,
      'VALIDACION',
    );
    await esperarError(await api(`/orders/${orden.id}/audit`), 401, 'NO_AUTENTICADO');
  });
});

describe('GET /orders/:id/audit: supervisor', () => {
  it('ve solo sus eventos y las validaciones de sus propios consumos', async () => {
    const eventos = await lineaCompleta(sup.token, orden.id);
    const ajenos = eventos.filter((e) => e.actor?.id !== sup.usuario.id);
    // Lo ajeno que ve son solo las decisiones del jefe sobre sus consumos (c2 aprobado, c3 rechazado).
    expect(ajenos.map((e) => [e.entidad, e.consumption_id, e.tipo])).toEqual([
      ['validations', c2.id, 'validacion'],
      ['validations', c3.id, 'rechazo'],
    ]);
    expect(ajenos[1]?.descripcion).toBe('Rechazó consumo de Arena sílice: Lote equivocado');
    const descripciones = eventos.map((e) => e.descripcion);
    expect(descripciones).not.toContain(`Orden ${orden.codigo} creada`);
    expect(descripciones.some((d) => d.startsWith('Asignó a'))).toBe(false);
    expect(eventos.some((e) => e.consumption_id === c4.id)).toBe(false);
    expect(eventos.some((e) => e.consumption_id === c1.id)).toBe(true);
  });

  it('el otro supervisor asignado no ve las validaciones de los consumos de Laura', async () => {
    const eventos = await lineaCompleta(sup2.token, orden.id);
    expect(eventos.map((e) => [e.entidad, e.consumption_id])).toEqual([
      ['consumptions', c4.id],
      ['validations', c4.id],
    ]);
  });

  it('sin asignación ni consumos propios → 404; con un consumo propio en la orden → 200', async () => {
    await esperarError(
      await api(`/orders/${orden.id}/audit`, { token: supAjeno.token }),
      404,
      'NO_ENCONTRADO',
    );
    await esperarError(
      await api(`/orders/${ordenPerdida}/audit`, { token: sup.token }),
      404,
      'NO_ENCONTRADO',
    );
    const eventos = await lineaCompleta(supSinAsignacion.token, ordenPerdida);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      tipo: 'registro',
      descripcion: 'Registró 5 kg de Arena sílice',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// describirEvento: ramas que no producen los fixtures
// ---------------------------------------------------------------------------------------------

function fila(
  entidad: string,
  antes: Record<string, unknown> | null,
  despues: Record<string, unknown> | null,
  accion = 'x.y',
): FilaAuditoriaConActor {
  return {
    seq: 1,
    id: uuidv7(),
    entidad,
    entidad_id: 'e1',
    order_id: 'o1',
    accion,
    actor_id: null,
    actor_nombre: null,
    actor_rol: null,
    device_id: null,
    datos_antes: antes === null ? null : JSON.stringify(antes),
    datos_despues: despues === null ? null : JSON.stringify(despues),
    client_at: null,
    server_at: new Date().toISOString(),
    alerta_reloj: 0,
  };
}

const vacias = {
  consumos: new Map(),
  novedades: new Map(),
  materiales: new Map(),
  usuarios: new Map(),
};

describe('describirEvento', () => {
  it.each([
    [
      { estado: 'en_proceso' },
      { estado: 'finalizada', force: true, pendientes: 2 },
      'Orden OP-1 finalizada con 2 consumo(s) pendiente(s) (forzada)',
    ],
    [
      { estado: 'en_proceso' },
      { estado: 'finalizada', force: false, pendientes: 0 },
      'Orden OP-1 finalizada',
    ],
    [{ estado: 'planeada' }, { estado: 'cancelada' }, 'Orden OP-1 cancelada'],
    [{ estado: 'planeada' }, { estado: 'planeada' }, 'Orden OP-1 actualizada'],
    [{ estado: 'planeada' }, { estado: 'otro' }, 'Orden OP-1 actualizada'],
  ])('orden %j → %j', (antes, despues, esperado) => {
    expect(describirEvento(fila('production_orders', antes, despues), vacias, 'OP-1')).toEqual({
      tipo: 'sistema',
      descripcion: esperado,
      consumption_id: null,
    });
  });

  it('asignaciones, planes y entidades desconocidas sin referencias', () => {
    expect(
      describirEvento(
        fila('order_supervisors', null, { user_id: 'u', activo: false }),
        vacias,
        'OP',
      ).descripcion,
    ).toBe('Quitó la asignación de un supervisor');
    expect(
      describirEvento(fila('order_planned_materials', null, {}), vacias, 'OP').descripcion,
    ).toBe('Planeó consumo de material');
    expect(
      describirEvento(fila('settings', null, {}, 'settings.tolerancia'), vacias, 'OP'),
    ).toEqual({
      tipo: 'sistema',
      descripcion: 'settings.tolerancia (settings)',
      consumption_id: null,
    });
  });

  it('consumos, novedades, evidencias y validaciones con datos incompletos', () => {
    expect(describirEvento(fila('consumptions', null, {}), vacias, 'OP').descripcion).toBe(
      'Registró consumo de material',
    );
    expect(
      describirEvento(
        fila(
          'consumptions',
          { estado: 'pendiente', cantidad: 1, unidad: 'kg' },
          { estado: 'aprobado', cantidad: 1, unidad: 'kg' },
        ),
        vacias,
        'OP',
      ),
    ).toEqual({
      tipo: 'validacion',
      descripcion: 'Consumo de material aprobado',
      consumption_id: 'e1',
    });
    expect(
      describirEvento(
        fila('consumptions', { estado: 'pendiente' }, { estado: 'rechazado' }),
        vacias,
        'OP',
      ).tipo,
    ).toBe('rechazo');
    expect(
      describirEvento(
        fila(
          'consumptions',
          { estado: 'pendiente', lote: 'A' },
          { estado: 'pendiente', lote: 'B' },
        ),
        vacias,
        'OP',
      ).descripcion,
    ).toBe('Editó el consumo de material');
    expect(
      describirEvento(fila('incidents', null, { consumption_id: 'c', tipo: 'raro' }), vacias, 'OP')
        .descripcion,
    ).toBe('Registró novedad (Novedad) en el consumo de material');
    expect(
      describirEvento(
        fila('incidents', null, { tipo: 'dano', descripcion: 'x'.repeat(300) }),
        vacias,
        'OP',
      ).descripcion,
    ).toMatch(/^Registró novedad \(Daño\) en el consumo de material: x{159}…$/);
    expect(describirEvento(fila('evidences', null, {}), vacias, 'OP')).toMatchObject({
      tipo: 'novedad',
      consumption_id: null,
    });
    expect(
      describirEvento(fila('validations', null, { decision: 'rechazado' }), vacias, 'OP'),
    ).toEqual({
      tipo: 'rechazo',
      descripcion: 'Rechazó consumo de material',
      consumption_id: null,
    });
  });
});
