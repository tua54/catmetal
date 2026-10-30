// Tarea 2.5 — formato único de error de la API (docs/spec.md §7): toda respuesta de error tiene
// exactamente `{ code, message, details? }`, con `code` de CODIGOS_ERROR, `message` en español no
// vacío y el estado HTTP que le corresponde. Se provoca de forma real cada clase de estado
// (400, 401, 403, 404, 409, 413, 415, 422, 429 y 500) contra el Worker real; la matriz y las demás
// pruebas transversales aplican además esta misma revisión a cada error que encuentran.
import { MAX_EVIDENCIA_BYTES, MENSAJES_ERROR, uuidv7 } from '@catmetal/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cuerpoConsumo, jpeg, png } from './fase2-consumos-helpers';
import { peticion as peticionCruda } from './auth-helpers';
import { asignar, nuevaOrden, nuevoMaterial, planear, sesion } from './fase2-helpers';
import {
  type ActorConSesion,
  buscarFila,
  comoRegistro,
  conFalloEnAuditoria,
  consumoConNovedad,
  consumoPendiente,
  crearMundo,
  enviar,
  escena,
  esperarFormatoError,
  FILAS,
  type FilaDeRuta,
  type Mundo,
  normalizar,
  type OpcionesEnvio,
  type Peticion,
  revisar,
  sesionDe,
  fotoDeLaBase,
  tablasModificadas,
} from './fase2-transversal-helpers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let mundo: Mundo;

beforeAll(async () => {
  mundo = await crearMundo();
});

interface Caso {
  nombre: string;
  estado: number;
  code: string;
  /** Hace la petición (y su preparación) y devuelve la respuesta de error. */
  ejecutar: (m: Mundo) => Promise<{ respuesta: Response; peticion: Peticion }>;
  /** Revisión adicional del cuerpo de error. */
  detalle?: (cuerpo: Record<string, unknown>) => void;
}

async function llamar(
  peticion: Peticion,
  opciones: OpcionesEnvio = {},
): Promise<{ respuesta: Response; peticion: Peticion }> {
  return { respuesta: await enviar(peticion, opciones), peticion };
}

/** Evidencia registrada (no subida) por el supervisor del mundo. */
async function evidenciaPendiente(m: Mundo) {
  const e = await escena(m);
  return { e, ...(await consumoConNovedad(m, e, 'supervisor', false)) };
}

const CASOS: readonly Caso[] = [
  // --- 400 --------------------------------------------------------------------------------------
  {
    nombre: 'cuerpo vacío en POST /materials',
    estado: 400,
    code: 'VALIDACION',
    ejecutar: (m) =>
      llamar({ metodo: 'POST', ruta: '/materials', json: {} }, { token: m.admin.token }),
    detalle: (cuerpo) => {
      const detalles = cuerpo.details as { campo: string; mensaje: string }[];
      expect(detalles.map((d) => d.campo)).toEqual(
        expect.arrayContaining(['codigo', 'nombre', 'unidad', 'costo_unitario_cop']),
      );
      for (const d of detalles) {
        expect(Object.keys(d).sort()).toEqual(['campo', 'mensaje']);
        expect(d.mensaje.length).toBeGreaterThan(0);
      }
    },
  },
  {
    nombre: 'id de ruta que no es un UUID v7',
    estado: 400,
    code: 'VALIDACION',
    ejecutar: (m) => llamar({ metodo: 'GET', ruta: '/orders/abc' }, { token: m.jefe.token }),
  },
  {
    nombre: 'query fuera de rango (limite=0)',
    estado: 400,
    code: 'VALIDACION',
    ejecutar: (m) => llamar({ metodo: 'GET', ruta: '/orders?limite=0' }, { token: m.jefe.token }),
  },
  {
    nombre: 'JSON con un valor que no es un objeto (null)',
    estado: 400,
    code: 'VALIDACION',
    ejecutar: (m) =>
      llamar({ metodo: 'POST', ruta: '/materials', jsonCrudo: 'null' }, { token: m.admin.token }),
  },
  {
    nombre: 'JSON con un arreglo en vez de un objeto',
    estado: 400,
    code: 'VALIDACION',
    ejecutar: (m) =>
      llamar({ metodo: 'POST', ruta: '/materials', jsonCrudo: '[]' }, { token: m.admin.token }),
  },
  {
    nombre: 'foto con el sha256 distinto del declarado',
    estado: 400,
    code: 'VALIDACION',
    ejecutar: async (m) => {
      const datos = await evidenciaPendiente(m);
      return llamar(
        {
          metodo: 'PUT',
          ruta: `/evidences/${datos.evidencia}`,
          binario: { bytes: jpeg(), contentType: 'image/jpeg' },
        },
        { token: m.supervisor.token },
      );
    },
  },

  // --- 401 --------------------------------------------------------------------------------------
  {
    nombre: 'sin token',
    estado: 401,
    code: 'NO_AUTENTICADO',
    ejecutar: () => llamar({ metodo: 'GET', ruta: '/orders' }),
  },
  {
    nombre: 'login con credenciales incorrectas',
    estado: 401,
    code: 'CREDENCIALES_INVALIDAS',
    ejecutar: () =>
      llamar({
        metodo: 'POST',
        ruta: '/auth/login',
        json: { email: `nadie-${uuidv7()}@catmetal.test`, password: 'x', device_id: uuidv7() },
        ip: `ip-${uuidv7()}`,
      }),
  },
  {
    nombre: 'refresh sin cookie',
    estado: 401,
    code: 'TOKEN_INVALIDO',
    ejecutar: () => llamar({ metodo: 'POST', ruta: '/auth/refresh' }),
  },
  {
    nombre: 'access token de una sesión ya cerrada',
    estado: 401,
    code: 'SESION_REVOCADA',
    ejecutar: async () => {
      const propia = await sesion('supervisor');
      const cierre = await enviar(
        { metodo: 'POST', ruta: '/auth/logout' },
        { token: propia.token },
      );
      expect(cierre.status).toBe(204);
      return llamar({ metodo: 'GET', ruta: '/auth/me' }, { token: propia.token });
    },
  },

  // --- 403 --------------------------------------------------------------------------------------
  {
    nombre: 'rol sin permiso',
    estado: 403,
    code: 'PERMISO_DENEGADO',
    ejecutar: (m) =>
      llamar(
        { metodo: 'POST', ruta: '/materials', json: { codigo: 'X' } },
        { token: m.supervisor.token },
      ),
  },
  {
    nombre: 'petición que cambia estado sin Origin',
    estado: 403,
    code: 'ORIGEN_INVALIDO',
    ejecutar: (m) =>
      llamar(
        { metodo: 'POST', ruta: '/materials', json: {} },
        { token: m.admin.token, origen: null },
      ),
  },
  {
    nombre: 'jefe que valida su propio consumo',
    estado: 403,
    code: 'AUTOAPROBACION',
    ejecutar: async (m) => {
      const peticion = await buscarFila(
        'POST',
        '/consumptions/:id/approve',
        'consumo propio del jefe',
      ).preparar(m);
      return llamar(peticion, { token: m.jefe.token });
    },
  },

  // --- 404 --------------------------------------------------------------------------------------
  {
    nombre: 'ruta inexistente bajo /api/v1 con token',
    estado: 404,
    code: 'NO_ENCONTRADO',
    ejecutar: (m) => llamar({ metodo: 'GET', ruta: '/no-existe' }, { token: m.admin.token }),
  },
  {
    nombre: 'ruta inexistente bajo /api/v1 sin token',
    estado: 404,
    code: 'NO_ENCONTRADO',
    ejecutar: () => llamar({ metodo: 'GET', ruta: '/no-existe/otra' }),
  },
  {
    nombre: 'orden inexistente',
    estado: 404,
    code: 'NO_ENCONTRADO',
    ejecutar: (m) =>
      llamar({ metodo: 'GET', ruta: `/orders/${uuidv7()}` }, { token: m.jefe.token }),
  },
  {
    nombre: 'evidencia que el servidor no conoce',
    estado: 404,
    code: 'EVIDENCIA_DESCONOCIDA',
    ejecutar: (m) =>
      llamar(
        {
          metodo: 'PUT',
          ruta: `/evidences/${uuidv7()}`,
          binario: { bytes: jpeg(), contentType: 'image/jpeg' },
        },
        { token: m.supervisor.token },
      ),
  },

  // --- 409 --------------------------------------------------------------------------------------
  {
    nombre: 'edición con una versión desactualizada',
    estado: 409,
    code: 'CONFLICTO',
    ejecutar: async (m) => {
      const e = await escena(m);
      const consumo = await consumoPendiente(m, e);
      return llamar(
        {
          metodo: 'PATCH',
          ruta: `/consumptions/${consumo}`,
          json: {
            id: consumo,
            version: 7,
            cantidad: 3,
            client_created_at: new Date().toISOString(),
          },
        },
        { token: m.supervisor.token },
      );
    },
    detalle: (cuerpo) => {
      expect(comoRegistro(cuerpo.details)).toHaveProperty('version_servidor', 1);
    },
  },
  {
    nombre: 'código de material repetido',
    estado: 409,
    code: 'CONFLICTO',
    ejecutar: async (m) => {
      const cuerpo = {
        codigo: `MP-${uuidv7().slice(-16)}`,
        nombre: 'Cal',
        unidad: 'kg',
        costo_unitario_cop: 900,
      };
      const primera = await enviar(
        { metodo: 'POST', ruta: '/materials', json: cuerpo },
        { token: m.admin.token },
      );
      expect(primera.status).toBe(201);
      return llamar({ metodo: 'POST', ruta: '/materials', json: cuerpo }, { token: m.admin.token });
    },
  },
  {
    nombre: 'consumo con un id que ya existe',
    estado: 409,
    code: 'ID_DUPLICADO',
    ejecutar: async (m) => {
      const e = await escena(m);
      const cuerpo = cuerpoConsumo(e.orden, e.material);
      const primera = await enviar(
        { metodo: 'POST', ruta: '/consumptions', json: cuerpo },
        { token: m.supervisor.token },
      );
      expect(primera.status).toBe(201);
      return llamar(
        { metodo: 'POST', ruta: '/consumptions', json: cuerpo },
        { token: m.supervisor.token },
      );
    },
  },
  {
    nombre: 'foto distinta sobre una evidencia ya subida',
    estado: 409,
    code: 'EVIDENCIA_YA_SUBIDA',
    ejecutar: async (m) => {
      const e = await escena(m);
      const datos = await consumoConNovedad(m, e, 'supervisor', true);
      return llamar(
        {
          metodo: 'PUT',
          ruta: `/evidences/${datos.evidencia}`,
          binario: { bytes: jpeg(), contentType: 'image/jpeg' },
        },
        { token: m.supervisor.token },
      );
    },
  },
  {
    nombre: 'finalizar una orden con consumos pendientes',
    estado: 409,
    code: 'ORDEN_CON_PENDIENTES',
    ejecutar: async (m) => {
      const e = await escena(m);
      await consumoPendiente(m, e);
      return llamar(
        { metodo: 'POST', ruta: `/orders/${e.orden}/finish`, json: {} },
        { token: m.jefe.token },
      );
    },
    detalle: (cuerpo) => {
      expect(comoRegistro(cuerpo.details)).toEqual({ pendientes: 1 });
    },
  },
  {
    nombre: 'validar un consumo que ya fue decidido',
    estado: 409,
    code: 'CONSUMO_NO_PENDIENTE',
    ejecutar: async (m) => {
      const peticion = await buscarFila('POST', '/consumptions/:id/approve').preparar(m);
      const primera = await enviar(peticion, { token: m.jefe.token });
      expect(primera.status).toBe(201);
      return llamar(
        { ...peticion, json: { ...(peticion.json as object), id: uuidv7() } },
        { token: m.jefe2.token },
      );
    },
  },

  // --- 413 y 415 --------------------------------------------------------------------------------
  {
    nombre: 'foto de más de 5 MB',
    estado: 413,
    code: 'EVIDENCIA_DEMASIADO_GRANDE',
    ejecutar: async (m) => {
      const datos = await evidenciaPendiente(m);
      return llamar(
        {
          metodo: 'PUT',
          ruta: `/evidences/${datos.evidencia}`,
          binario: { bytes: new Uint8Array(MAX_EVIDENCIA_BYTES + 1), contentType: 'image/jpeg' },
        },
        { token: m.supervisor.token },
      );
    },
  },
  {
    nombre: 'bytes de un PNG declarados como JPEG (magic bytes)',
    estado: 415,
    code: 'EVIDENCIA_TIPO_INVALIDO',
    ejecutar: async (m) => {
      const datos = await evidenciaPendiente(m);
      return llamar(
        {
          metodo: 'PUT',
          ruta: `/evidences/${datos.evidencia}`,
          binario: { bytes: png(), contentType: 'image/jpeg' },
        },
        { token: m.supervisor.token },
      );
    },
  },
  {
    nombre: 'Content-Type que no es una imagen',
    estado: 415,
    code: 'EVIDENCIA_TIPO_INVALIDO',
    ejecutar: async (m) => {
      const datos = await evidenciaPendiente(m);
      return llamar(
        {
          metodo: 'PUT',
          ruta: `/evidences/${datos.evidencia}`,
          binario: { bytes: datos.bytes, contentType: 'text/plain' },
        },
        { token: m.supervisor.token },
      );
    },
  },

  // --- 422 --------------------------------------------------------------------------------------
  {
    nombre: 'consumo en una orden que aún no está en proceso',
    estado: 422,
    code: 'ORDEN_NO_EN_PROCESO',
    ejecutar: async (m) => {
      const e = await escena(m, { estado: 'planeada' });
      return llamar(
        { metodo: 'POST', ruta: '/consumptions', json: cuerpoConsumo(e.orden, e.material) },
        { token: m.supervisor.token },
      );
    },
  },
  {
    nombre: 'consumo en una unidad que no se convierte a la del material',
    estado: 422,
    code: 'UNIDAD_INCOMPATIBLE',
    ejecutar: async (m) => {
      const e = await escena(m);
      return llamar(
        {
          metodo: 'POST',
          ruta: '/consumptions',
          json: cuerpoConsumo(e.orden, e.material, { unidad: 'l' }),
        },
        { token: m.supervisor.token },
      );
    },
  },
  {
    nombre: 'consumo de un material inactivo',
    estado: 422,
    code: 'MATERIAL_INACTIVO',
    ejecutar: async (m) => {
      const orden = await nuevaOrden(m.jefe.usuario.id);
      const material = await nuevoMaterial({ activo: 0 });
      await planear(orden, material, 100);
      await asignar(orden, m.supervisor.usuario.id, m.admin.usuario.id);
      return llamar(
        { metodo: 'POST', ruta: '/consumptions', json: cuerpoConsumo(orden, material) },
        { token: m.supervisor.token },
      );
    },
  },
  {
    nombre: 'aprobar un consumo que excede la tolerancia sin novedad',
    estado: 422,
    code: 'REQUIERE_NOVEDAD',
    ejecutar: async (m) => {
      const e = await escena(m);
      const registrado = await enviar(
        {
          metodo: 'POST',
          ruta: '/consumptions',
          json: cuerpoConsumo(e.orden, e.material, { cantidad: 150 }),
        },
        { token: m.supervisor.token },
      );
      expect(registrado.status).toBe(201);
      const consumo = comoRegistro(await registrado.json());
      expect(consumo.requiere_novedad).toBe(true);
      return llamar(
        {
          metodo: 'POST',
          ruta: `/consumptions/${String(consumo.id)}/approve`,
          json: {
            id: uuidv7(),
            version: consumo.version,
            client_created_at: new Date().toISOString(),
          },
        },
        { token: m.jefe.token },
      );
    },
  },
  {
    nombre: 'iniciar una orden que ya está en proceso',
    estado: 422,
    code: 'ESTADO_ORDEN_INVALIDO',
    ejecutar: async (m) => {
      const e = await escena(m);
      return llamar({ metodo: 'POST', ruta: `/orders/${e.orden}/start` }, { token: m.jefe.token });
    },
  },
  {
    nombre: 'corrección de un consumo que no está rechazado',
    estado: 422,
    code: 'CORRECCION_INVALIDA',
    ejecutar: async (m) => {
      const e = await escena(m);
      const pendiente = await consumoPendiente(m, e);
      return llamar(
        {
          metodo: 'POST',
          ruta: '/consumptions',
          json: cuerpoConsumo(e.orden, e.material, { corrige_a: pendiente }),
        },
        { token: m.supervisor.token },
      );
    },
  },

  // --- 429 --------------------------------------------------------------------------------------
  {
    nombre: 'sexto intento de login con la misma IP y correo',
    estado: 429,
    code: 'DEMASIADOS_INTENTOS',
    ejecutar: async () => {
      const peticion: Peticion = {
        metodo: 'POST',
        ruta: '/auth/login',
        json: { email: `nadie-${uuidv7()}@catmetal.test`, password: 'x', device_id: uuidv7() },
        ip: `ip-${uuidv7()}`,
      };
      for (let i = 0; i < 5; i += 1) {
        expect((await enviar(peticion)).status).toBe(401);
      }
      return llamar(peticion);
    },
  },

  // --- 500 --------------------------------------------------------------------------------------
  {
    nombre: 'error inesperado de la base (trigger que aborta el batch de POST /users)',
    estado: 500,
    code: 'ERROR_INTERNO',
    ejecutar: async (m) => {
      const peticion = await buscarFila('POST', '/users').preparar(m);
      const respuesta = await conFalloEnAuditoria(
        { entidad: 'users', accion: 'usuario.crear' },
        () => enviar(peticion, { token: m.admin.token }),
      );
      return { respuesta, peticion };
    },
    detalle: (cuerpo) => {
      // No filtra información interna: solo el mensaje estándar y sin `details`.
      expect(Object.keys(cuerpo).sort()).toEqual(['code', 'message']);
    },
  },
];

describe('formato único de error: cada estado de la spec se provoca de verdad', () => {
  it('los casos cubren 400, 401, 403, 404, 409, 413, 415, 422, 429 y 500', () => {
    expect([...new Set(CASOS.map((c) => c.estado))].sort()).toEqual([
      400, 401, 403, 404, 409, 413, 415, 422, 429, 500,
    ]);
  });

  it.each(CASOS.map((c) => [`${c.estado} ${c.code}: ${c.nombre}`, c] as const))(
    '%s',
    async (_nombre, caso) => {
      const { respuesta, peticion } = await caso.ejecutar(mundo);
      const revisada = await revisar(respuesta, peticion);
      expect({ estado: revisada.estado, code: revisada.code }).toEqual({
        estado: caso.estado,
        code: caso.code,
      });
      expect(revisada.texto).not.toMatch(/SQLITE|D1_ERROR|stack|trigger/i);
      caso.detalle?.(comoRegistro(revisada.cuerpo));
    },
  );
});

describe('rutas inexistentes fuera de /api/v1', () => {
  it.each(['/api', '/api/', '/api/v2/orders', '/api/otra-cosa'])(
    'GET %s responde 404 JSON con el formato único (nunca el shell de la PWA)',
    async (ruta) => {
      const respuesta = await peticionCruda(ruta, { token: mundo.admin.token });
      expect(respuesta.status).toBe(404);
      expect(respuesta.headers.get('Content-Type')).toContain('application/json');
      esperarFormatoError(404, await respuesta.json());
    },
  );
});

describe('JSON mal formado: 400 VALIDACION en cada ruta que recibe un cuerpo JSON', () => {
  const CON_JSON = [
    'POST /auth/login',
    'POST /users',
    'PATCH /users/:id',
    'POST /materials',
    'PATCH /materials/:id',
    'PATCH /settings/tolerancia',
    'POST /orders',
    'POST /orders/:id/finish',
    'PUT /orders/:id/supervisors',
    'POST /consumptions',
    'PATCH /consumptions/:id',
    'POST /consumptions/:id/incident',
    'POST /consumptions/:id/approve',
    'POST /consumptions/:id/reject',
    'POST /sync/push',
  ];
  const SIN_JSON = [
    'POST /auth/refresh',
    'POST /auth/logout',
    'POST /orders/:id/start',
    'PUT /evidences/:id',
  ];

  const filas = FILAS.filter((f) => f.variante === undefined && f.metodo !== 'GET');

  it('la lista cubre todas las escrituras', () => {
    expect(filas.map((f) => `${f.metodo} ${f.ruta}`).sort()).toEqual(
      [...CON_JSON, ...SIN_JSON].sort(),
    );
  });

  /** Primer actor con token para el que la petición es válida. */
  function actorDe(fila: FilaDeRuta): ActorConSesion {
    const candidatos = (['jefe', 'admin', 'supervisor'] as const).filter((a) => {
      const celda = fila.esperado[a];
      return celda !== undefined && normalizar(celda).estado < 300;
    });
    return candidatos[0] ?? 'admin';
  }

  it.each(CON_JSON)('%s con "{\\"a\\":" responde 400 VALIDACION y no escribe', async (clave) => {
    const fila = filas.find((f) => `${f.metodo} ${f.ruta}` === clave);
    if (fila === undefined) {
      throw new Error(`Fila no definida: ${clave}`);
    }
    const base = await fila.preparar(mundo);
    expect(base.json, 'la ruta recibe un cuerpo JSON').toBeDefined();
    const peticion: Peticion = { ...base, json: undefined, jsonCrudo: '{"a":' };
    const antes = await fotoDeLaBase();

    const token = clave === 'POST /auth/login' ? undefined : sesionDe(mundo, actorDe(fila)).token;
    const respuesta = await enviar(peticion, { token });
    const revisada = await revisar(respuesta, peticion);

    expect({ estado: revisada.estado, code: revisada.code }).toEqual({
      estado: 400,
      code: 'VALIDACION',
    });
    expect(tablasModificadas(antes, await fotoDeLaBase())).toEqual([]);
  });

  it.each(SIN_JSON)('%s no recibe un cuerpo JSON', async (clave) => {
    const fila = filas.find((f) => `${f.metodo} ${f.ruta}` === clave);
    const base = await fila?.preparar(mundo);
    expect(base?.json).toBeUndefined();
  });
});

describe('entradas hostiles: nunca un 500 ni una escritura', () => {
  const grande = 'x'.repeat(10_000);
  const IDLARGO = '018f0000-0000-7000-8000-000000000000';
  const CASOS_HOSTILES: readonly [string, Peticion][] = [
    ['limite no numérico', { metodo: 'GET', ruta: '/orders?limite=abc' }],
    ['cursor con byte nulo', { metodo: 'GET', ruta: '/orders?cursor=%00' }],
    ['fecha de auditoría inválida', { metodo: 'GET', ruta: '/audit?desde=ayer' }],
    ['límite negativo', { metodo: 'GET', ruta: '/audit?limite=-1' }],
    ['cursor en notación científica', { metodo: 'GET', ruta: '/audit?cursor=1e3' }],
    ['SQL en entidad_id', { metodo: 'GET', ruta: "/audit?entidad_id=' OR 1=1--" }],
    ['comodín LIKE en entidad_id', { metodo: 'GET', ruta: '/audit?entidad=users&entidad_id=%25' }],
    ['id de orden con SQL', { metodo: 'GET', ruta: "/orders/'%20OR%201=1--" }],
    ['id de orden con byte nulo', { metodo: 'GET', ruta: '/orders/%00' }],
    [
      'id de usuario con SQL',
      { metodo: 'PATCH', ruta: "/users/' OR 1=1--", json: { nombre: 'x' } },
    ],
    [
      'id de usuario de 500 caracteres',
      { metodo: 'PATCH', ruta: `/users/${'a'.repeat(500)}`, json: { nombre: 'x' } },
    ],
    [
      'código de material de 10 000 caracteres',
      {
        metodo: 'POST',
        ruta: '/materials',
        json: { codigo: grande, nombre: 'n', unidad: 'kg', costo_unitario_cop: 1 },
      },
    ],
    [
      'costo de material absurdo',
      {
        metodo: 'POST',
        ruta: '/materials',
        json: { codigo: 'X-1', nombre: 'n', unidad: 'kg', costo_unitario_cop: 1e300 },
      },
    ],
    [
      '10 000 materiales en una orden',
      {
        metodo: 'POST',
        ruta: '/orders',
        json: {
          codigo: 'OP-2026-0001',
          linea: 'x',
          materiales: Array.from({ length: 10_000 }, () => ({})),
        },
      },
    ],
    [
      'tolerancia que no es número',
      { metodo: 'PATCH', ruta: '/settings/tolerancia', json: { tolerancia_pct: 'NaN' } },
    ],
    [
      'tolerancia desmedida',
      { metodo: 'PATCH', ruta: '/settings/tolerancia', json: { tolerancia_pct: 1e308 } },
    ],
    [
      'supervisor que no es UUID',
      { metodo: 'PUT', ruta: `/orders/${IDLARGO}/supervisors`, json: { supervisores: ['x'] } },
    ],
    ['cuerpo JSON de 2 MB', { metodo: 'POST', ruta: '/materials', jsonCrudo: grande.repeat(200) }],
    ['JSON vacío', { metodo: 'POST', ruta: '/materials', jsonCrudo: '' }],
    [
      'foto vacía',
      {
        metodo: 'PUT',
        ruta: `/evidences/${IDLARGO}`,
        binario: { bytes: new Uint8Array(0), contentType: 'image/jpeg' },
      },
    ],
    [
      'foto sin Content-Type de imagen',
      {
        metodo: 'PUT',
        ruta: `/evidences/${IDLARGO}`,
        binario: { bytes: jpeg(), contentType: 'application/octet-stream' },
      },
    ],
  ];

  it.each(CASOS_HOSTILES)('%s', async (_nombre, peticion) => {
    const antes = await fotoDeLaBase();
    const respuesta = await enviar(peticion, { token: mundo.admin.token });
    const revisada = await revisar(respuesta, peticion);
    expect(revisada.estado).toBeLessThan(500);
    if (peticion.metodo !== 'GET') {
      expect(revisada.estado).toBeGreaterThanOrEqual(400);
    }
    expect(tablasModificadas(antes, await fotoDeLaBase())).toEqual([]);
  });
});

describe('las revisiones del formato de error detectan un error mal formado', () => {
  const codigo = 'NO_ENCONTRADO';
  const mensaje = MENSAJES_ERROR.NO_ENCONTRADO;

  it('acepta el formato único, con y sin details', () => {
    expect(esperarFormatoError(404, { code: codigo, message: mensaje })).toBe(codigo);
    expect(esperarFormatoError(404, { code: codigo, message: mensaje, details: [] })).toBe(codigo);
  });

  it.each([
    ['una clave de más', 404, { code: codigo, message: mensaje, error: 'x' }],
    ['sin message', 404, { code: codigo }],
    ['message vacío', 404, { code: codigo, message: '' }],
    ['message en otro idioma', 404, { code: codigo, message: 'Not found' }],
    ['code desconocido', 404, { code: 'NO_EXISTE', message: mensaje }],
    ['estado HTTP que no corresponde al code', 500, { code: codigo, message: mensaje }],
    ['un texto en vez de un objeto', 404, 'Not Found'],
    ['un arreglo', 404, []],
  ])('rechaza %s', (_motivo, estado, cuerpo) => {
    expect(() => esperarFormatoError(estado, cuerpo)).toThrow();
  });

  it('la foto de la base detecta una escritura parcial', async () => {
    const antes = await fotoDeLaBase();
    await nuevoMaterial();
    expect(tablasModificadas(antes, await fotoDeLaBase())).toEqual(['materials']);
  });
});
