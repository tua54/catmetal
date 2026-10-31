// Tarea 2.5 — auditoría en el MISMO batch de cada escritura y atomicidad (docs/spec.md §4;
// docs/plan-fase-2.md "Auditoría"; CLAUDE.md regla 5).
//
// Para cada endpoint de escritura de la Fase 2:
//  1. Éxito: el número de filas nuevas de `audit_log` es exactamente el esperado (entidad y acción),
//     todas con `actor_id`, `device_id` de la sesión, `server_at` de 24 caracteres y `order_id` cuando
//     la entidad pertenece a una orden.
//  2. Fallo a mitad del batch: un trigger temporal sobre `audit_log` (creado y borrado en la prueba)
//     aborta el INSERT de la última fila de auditoría del batch, es decir DESPUÉS de la sentencia
//     principal. La foto completa de la base (todas las tablas) antes y después es idéntica: ni la
//     entidad ni la auditoría quedaron escritas. Sin el trigger, la misma petición se aplica.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ultimoSeq } from './fase2-helpers';
import {
  type ActorConSesion,
  auditoriaCompletaDesde,
  buscarFila,
  comoRegistro,
  conFalloEnAuditoria,
  crearMundo,
  type Esperado,
  enviar,
  type FalloDeAuditoria,
  fotoDeLaBase,
  type Mundo,
  type Peticion,
  revisar,
  sesionDe,
  tablasModificadas,
  usuarioConSesion,
} from './fase2-transversal-helpers';
import { env } from 'cloudflare:workers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let mundo: Mundo;

beforeAll(async () => {
  mundo = await crearMundo();
});

interface FilaEsperada {
  entidad: string;
  accion: string;
  /** La entidad pertenece a una orden: la fila lleva `order_id`. */
  conOrden: boolean;
}

interface Escritura {
  nombre: string;
  actor: Exclude<ActorConSesion, 'supervisor_ajeno'>;
  estadoExito: number;
  auditoria: readonly FilaEsperada[];
  /** Fila de auditoría cuyo INSERT se aborta (la última del batch). */
  falla: FalloDeAuditoria;
  /** Respuesta cuando el batch falla: las rutas con `ejecutarPlan` traducen el trigger a 409. */
  fallo: Esperado;
  preparar: (m: Mundo) => Promise<Peticion>;
}

const CONFLICTO: Esperado = { estado: 409, code: 'CONFLICTO' };
// Las rutas de /users hacen `db.batch` sin traducir el error de restricción: 500 sin filtrar detalles.
const INTERNO: Esperado = { estado: 500, code: 'ERROR_INTERNO' };

function filaBase(metodo: string, ruta: string) {
  return buscarFila(metodo, ruta).preparar;
}

const ESCRITURAS: readonly Escritura[] = [
  {
    nombre: 'POST /materials',
    actor: 'admin',
    estadoExito: 201,
    auditoria: [{ entidad: 'materials', accion: 'material.crear', conOrden: false }],
    falla: { entidad: 'materials', accion: 'material.crear' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/materials'),
  },
  {
    nombre: 'PATCH /materials/:id',
    actor: 'admin',
    estadoExito: 200,
    auditoria: [{ entidad: 'materials', accion: 'material.editar', conOrden: false }],
    falla: { entidad: 'materials', accion: 'material.editar' },
    fallo: CONFLICTO,
    preparar: filaBase('PATCH', '/materials/:id'),
  },
  {
    nombre: 'PATCH /settings/tolerancia',
    actor: 'admin',
    estadoExito: 200,
    auditoria: [{ entidad: 'settings', accion: 'settings.tolerancia', conOrden: false }],
    falla: { entidad: 'settings', accion: 'settings.tolerancia' },
    fallo: CONFLICTO,
    preparar: filaBase('PATCH', '/settings/tolerancia'),
  },
  {
    nombre: 'POST /orders (con dos materiales planeados)',
    actor: 'jefe',
    estadoExito: 201,
    auditoria: [
      { entidad: 'production_orders', accion: 'orden.crear', conOrden: true },
      { entidad: 'order_planned_materials', accion: 'orden.planear_material', conOrden: true },
      { entidad: 'order_planned_materials', accion: 'orden.planear_material', conOrden: true },
    ],
    falla: { entidad: 'order_planned_materials', accion: 'orden.planear_material' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/orders'),
  },
  {
    nombre: 'POST /orders/:id/start',
    actor: 'jefe',
    estadoExito: 200,
    auditoria: [{ entidad: 'production_orders', accion: 'orden.iniciar', conOrden: true }],
    falla: { entidad: 'production_orders', accion: 'orden.iniciar' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/orders/:id/start'),
  },
  {
    nombre: 'POST /orders/:id/finish',
    actor: 'jefe',
    estadoExito: 200,
    auditoria: [{ entidad: 'production_orders', accion: 'orden.finalizar', conOrden: true }],
    falla: { entidad: 'production_orders', accion: 'orden.finalizar' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/orders/:id/finish'),
  },
  {
    nombre: 'PUT /orders/:id/supervisors (quita uno y asigna otro)',
    actor: 'admin',
    estadoExito: 200,
    auditoria: [
      { entidad: 'order_supervisors', accion: 'asignacion.desactivar', conOrden: true },
      { entidad: 'order_supervisors', accion: 'asignacion.crear', conOrden: true },
    ],
    falla: { entidad: 'order_supervisors', accion: 'asignacion.crear' },
    fallo: CONFLICTO,
    preparar: filaBase('PUT', '/orders/:id/supervisors'),
  },
  {
    nombre: 'POST /consumptions',
    actor: 'supervisor',
    estadoExito: 201,
    auditoria: [{ entidad: 'consumptions', accion: 'consumo.crear', conOrden: true }],
    falla: { entidad: 'consumptions', accion: 'consumo.crear' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/consumptions'),
  },
  {
    nombre: 'PATCH /consumptions/:id',
    actor: 'supervisor',
    estadoExito: 200,
    auditoria: [{ entidad: 'consumptions', accion: 'consumo.editar', conOrden: true }],
    falla: { entidad: 'consumptions', accion: 'consumo.editar' },
    fallo: CONFLICTO,
    preparar: filaBase('PATCH', '/consumptions/:id'),
  },
  {
    nombre: 'POST /consumptions/:id/incident (con una foto)',
    actor: 'supervisor',
    estadoExito: 201,
    auditoria: [
      { entidad: 'incidents', accion: 'novedad.crear', conOrden: true },
      { entidad: 'evidences', accion: 'evidencia.crear', conOrden: true },
    ],
    falla: { entidad: 'evidences', accion: 'evidencia.crear' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/consumptions/:id/incident'),
  },
  {
    nombre: 'PUT /evidences/:id',
    actor: 'supervisor',
    estadoExito: 200,
    auditoria: [{ entidad: 'evidences', accion: 'evidencia.subida', conOrden: true }],
    falla: { entidad: 'evidences', accion: 'evidencia.subida' },
    fallo: CONFLICTO,
    preparar: filaBase('PUT', '/evidences/:id'),
  },
  {
    nombre: 'POST /consumptions/:id/approve',
    actor: 'jefe',
    estadoExito: 201,
    auditoria: [
      { entidad: 'validations', accion: 'validacion.crear', conOrden: true },
      { entidad: 'consumptions', accion: 'consumo.aprobar', conOrden: true },
    ],
    falla: { entidad: 'consumptions', accion: 'consumo.aprobar' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/consumptions/:id/approve'),
  },
  {
    nombre: 'POST /consumptions/:id/reject',
    actor: 'jefe',
    estadoExito: 201,
    auditoria: [
      { entidad: 'validations', accion: 'validacion.crear', conOrden: true },
      { entidad: 'consumptions', accion: 'consumo.rechazar', conOrden: true },
    ],
    falla: { entidad: 'consumptions', accion: 'consumo.rechazar' },
    fallo: CONFLICTO,
    preparar: filaBase('POST', '/consumptions/:id/reject'),
  },
  {
    nombre: 'POST /users',
    actor: 'admin',
    estadoExito: 201,
    auditoria: [{ entidad: 'users', accion: 'usuario.crear', conOrden: false }],
    falla: { entidad: 'users', accion: 'usuario.crear' },
    fallo: INTERNO,
    preparar: filaBase('POST', '/users'),
  },
  {
    nombre: 'PATCH /users/:id (cambio de nombre)',
    actor: 'admin',
    estadoExito: 200,
    auditoria: [{ entidad: 'users', accion: 'usuario.editar', conOrden: false }],
    falla: { entidad: 'users', accion: 'usuario.editar' },
    fallo: INTERNO,
    preparar: filaBase('PATCH', '/users/:id'),
  },
  {
    nombre: 'PATCH /users/:id (cambio de rol con sesión activa: revoca los refresh tokens)',
    actor: 'admin',
    estadoExito: 200,
    auditoria: [{ entidad: 'users', accion: 'usuario.editar', conOrden: false }],
    falla: { entidad: 'users', accion: 'usuario.editar' },
    fallo: INTERNO,
    preparar: async () => {
      const { usuario } = await usuarioConSesion('supervisor');
      return { metodo: 'PATCH', ruta: `/users/${usuario.id}`, json: { rol: 'jefe' } };
    },
  },
];

function ordenDe(peticion: Peticion, respuesta: unknown): string | null {
  if (peticion.orderId !== undefined) {
    return peticion.orderId;
  }
  // POST /orders: la orden se crea en la petición y su id viene en la respuesta.
  const id =
    typeof respuesta === 'object' && respuesta !== null ? comoRegistro(respuesta).id : null;
  return peticion.ruta === '/orders' && typeof id === 'string' ? id : null;
}

const FORMATO_SERVER_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('cobertura de la tabla de escrituras', () => {
  it('cubre cada endpoint de escritura de negocio de la Fase 2 (los de /auth escriben sesiones)', () => {
    const cubiertas = new Set(ESCRITURAS.map((e) => e.nombre.split(' (')[0]));
    expect([...cubiertas].sort()).toEqual(
      [
        'PATCH /materials/:id',
        'PATCH /settings/tolerancia',
        'PATCH /users/:id',
        'POST /consumptions',
        'POST /consumptions/:id/approve',
        'POST /consumptions/:id/incident',
        'POST /consumptions/:id/reject',
        'POST /materials',
        'POST /orders',
        'POST /orders/:id/finish',
        'POST /orders/:id/start',
        'POST /users',
        'PATCH /consumptions/:id',
        'PUT /evidences/:id',
        'PUT /orders/:id/supervisors',
      ].sort(),
    );
  });
});

describe('éxito: la auditoría se escribe en el mismo batch, completa y sin filas de más', () => {
  it.each(ESCRITURAS.map((e) => [e.nombre, e] as const))('%s', async (_nombre, escritura) => {
    const sesion = sesionDe(mundo, escritura.actor);
    const peticion = await escritura.preparar(mundo);
    const antes = await ultimoSeq();

    const respuesta = await enviar(peticion, { token: sesion.token });
    const revisada = await revisar(respuesta, peticion);
    expect(revisada.estado, revisada.texto).toBe(escritura.estadoExito);

    const filas = await auditoriaCompletaDesde(antes);
    const ordenEsperada = ordenDe(peticion, revisada.cuerpo);
    // Exactamente las filas esperadas (entidad y acción), ni más ni menos.
    expect(
      filas.map((f) => `${f.entidad}/${f.accion}`).sort(),
      'filas nuevas de audit_log',
    ).toEqual(escritura.auditoria.map((f) => `${f.entidad}/${f.accion}`).sort());

    for (const fila of filas) {
      const esperada = escritura.auditoria.find(
        (f) => f.entidad === fila.entidad && f.accion === fila.accion,
      );
      expect(fila.actor_id, `actor_id de ${fila.accion}`).toBe(sesion.usuario.id);
      expect(fila.device_id, `device_id de ${fila.accion}`).toBe(sesion.deviceId);
      expect(fila.server_at.length, `server_at de ${fila.accion}`).toBe(24);
      expect(fila.server_at).toMatch(FORMATO_SERVER_AT);
      expect(fila.entidad_id.length).toBeGreaterThan(0);
      if (esperada?.conOrden === true) {
        expect(ordenEsperada, 'la prueba conoce la orden').not.toBeNull();
        expect(fila.order_id, `order_id de ${fila.accion}`).toBe(ordenEsperada);
      } else {
        expect(fila.order_id, `order_id de ${fila.accion}`).toBeNull();
      }
    }
    // Las seq son consecutivas y crecientes: ningún otro proceso escribió en medio.
    expect(filas.map((f) => f.seq)).toEqual(filas.map((_, i) => (filas[0]?.seq ?? 0) + i));
  });
});

describe('fallo a mitad del batch: no queda nada escrito', () => {
  it.each(ESCRITURAS.map((e) => [e.nombre, e] as const))('%s', async (_nombre, escritura) => {
    const sesion = sesionDe(mundo, escritura.actor);
    const peticion = await escritura.preparar(mundo);
    const antes = await fotoDeLaBase();

    // El trigger existe solo mientras dura la petición y se borra siempre.
    const respuesta = await conFalloEnAuditoria(escritura.falla, () =>
      enviar(peticion, { token: sesion.token }),
    );
    const revisada = await revisar(respuesta, peticion);
    expect({ estado: revisada.estado, code: revisada.code }).toEqual(escritura.fallo);
    // El cliente no recibe el mensaje interno del trigger.
    expect(revisada.texto).not.toContain('fallo simulado');

    // Ni la entidad (INSERT/UPDATE de la sentencia principal) ni la auditoría quedaron escritas.
    expect(tablasModificadas(antes, await fotoDeLaBase()), 'tablas con cambios').toEqual([]);

    // El trigger ya no existe y el mismo pedido se aplica completo (no quedó un id a medias).
    const { results: triggers } = await env.DB.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'tmp_fallo_transversal_%'`,
    ).all();
    expect(triggers).toEqual([]);
    const seq = await ultimoSeq();
    const reintento = await revisar(await enviar(peticion, { token: sesion.token }), peticion);
    expect(reintento.estado, reintento.texto).toBe(escritura.estadoExito);
    const filas = await auditoriaCompletaDesde(seq);
    expect(filas.length).toBe(escritura.auditoria.length);
  });

  it('una subida cuyo batch falla no deja la foto servible; el reintento la publica con los mismos bytes', async () => {
    const subida = await buscarFila('PUT', '/evidences/:id').preparar(mundo);
    const evidencia = subida.ruta.split('/').at(-1) ?? '';
    const autor = mundo.supervisor.token;

    const fallida = await conFalloEnAuditoria(
      { entidad: 'evidences', accion: 'evidencia.subida' },
      () => enviar(subida, { token: autor }),
    );
    expect(fallida.status).toBe(409);
    // Aunque el archivo ya hubiera llegado a R2, la evidencia sigue sin subir en D1: no se sirve.
    const sinSubir = await env.DB.prepare('SELECT subido, subido_at FROM evidences WHERE id = ?')
      .bind(evidencia)
      .first<{ subido: number; subido_at: string | null }>();
    expect(sinSubir).toEqual({ subido: 0, subido_at: null });
    const oculta = await enviar(
      { metodo: 'GET', ruta: `/evidences/${evidencia}` },
      { token: autor },
    );
    expect(oculta.status).toBe(404);
    await oculta.arrayBuffer();

    expect((await enviar(subida, { token: autor })).status).toBe(200);
    const publicada = await enviar(
      { metodo: 'GET', ruta: `/evidences/${evidencia}` },
      { token: autor },
    );
    expect(publicada.status).toBe(200);
    expect(new Uint8Array(await publicada.arrayBuffer())).toEqual(subida.binario?.bytes);
  });

  it('el cambio de rol con sesión activa no deja sus refresh tokens revocados si el batch falla', async () => {
    const { usuario } = await usuarioConSesion('supervisor');
    const peticion: Peticion = {
      metodo: 'PATCH',
      ruta: `/users/${usuario.id}`,
      json: { rol: 'jefe' },
    };
    const vigentes = (): Promise<number> =>
      env.DB.prepare(
        'SELECT count(*) AS n FROM refresh_tokens WHERE user_id = ? AND revocado_at IS NULL',
      )
        .bind(usuario.id)
        .first<{ n: number }>()
        .then((fila) => fila?.n ?? -1);
    expect(await vigentes()).toBe(1);

    const respuesta = await conFalloEnAuditoria(
      { entidad: 'users', accion: 'usuario.editar' },
      () => enviar(peticion, { token: mundo.admin.token }),
    );
    expect(respuesta.status).toBe(500);
    expect(await vigentes(), 'el batch revertido no revoca la sesión').toBe(1);
    const rol = await env.DB.prepare('SELECT rol FROM users WHERE id = ?')
      .bind(usuario.id)
      .first<{ rol: string }>();
    expect(rol?.rol).toBe('supervisor');

    const exito = await enviar(peticion, { token: mundo.admin.token });
    expect(exito.status).toBe(200);
    expect(await vigentes(), 'aplicado completo: sí revoca').toBe(0);
  });
});
