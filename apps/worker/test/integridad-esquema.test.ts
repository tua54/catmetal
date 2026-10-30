// Integridad del esquema de D1 después de aplicar TODAS las migraciones (ADR 0005, 0006 y 0009):
// tablas, triggers e índices exactos, foreign keys, CHECK, configuración inicial, atomicidad de
// `batch()`, cliente Drizzle y la prueba estática contra el reemplazo implícito de SQLite.
import { TOLERANCIA_PCT_DEFECTO, uuidv7 } from '@catmetal/shared';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { crearDb, MAX_PAYLOAD_JSON_BYTES, schema, settings, users } from '../src/db/schema';
import { CONSULTA_SESION } from '../src/middleware/autenticar';
import { SENTENCIA_PURGA } from '../src/cron/mantenimiento';
import { CONSULTA_CREACION_NO_APLICADA } from '../src/sync/push';
import {
  ahora,
  crearDispositivo,
  crearEscenario,
  crearUsuario,
  insertar,
  sentenciaInsert,
  valoresConsumo,
} from './fixtures-db';

const TABLAS_ESPERADAS = [
  'audit_log',
  'consumptions',
  'devices',
  'evidences',
  'incidents',
  // ADR 0018 (M1): tabla técnica de cupos de login (migración 0007).
  'login_cupos',
  'materials',
  'order_planned_materials',
  'order_supervisors',
  'production_orders',
  'refresh_tokens',
  'settings',
  'sync_mutations',
  'users',
  'validations',
];

// Lista literal de las ADR 0006 y 0010. Si una migración reconstruye una tabla y pierde un trigger,
// falla aquí.
const TRIGGERS_ESPERADOS = [
  'audit_log_no_delete',
  'audit_log_no_update',
  'audit_log_seq_creciente',
  'audit_log_seq_sin_saltos',
  'consumptions_autoria_inmutable',
  'consumptions_corrige_rechazado',
  'consumptions_decidido_inmutable',
  'consumptions_estado_con_validacion',
  'consumptions_insercion_valida',
  'consumptions_no_delete',
  'consumptions_validado_no_se_edita',
  'consumptions_version',
  'devices_no_delete',
  'evidences_inmutable',
  'evidences_insercion_valida',
  'evidences_no_delete',
  'incidents_no_delete',
  'incidents_no_update',
  'materials_no_delete',
  'order_planned_materials_no_delete',
  'order_supervisors_no_delete',
  'production_orders_estado_terminal',
  'production_orders_no_delete',
  'production_orders_transicion',
  'settings_no_delete',
  'settings_valores_validos',
  'sync_mutations_no_delete',
  'sync_mutations_no_update',
  'users_no_delete',
  'validations_aplica_decision',
  'validations_no_delete',
  'validations_no_update',
  'validations_reglas',
  'validations_validador_jefe',
];

// Índices con nombre: los de la §4 de la spec, los adicionales de las ADR 0008/0009 y los de las FK.
// (Las PK y UNIQUE implícitas generan `sqlite_autoindex_*`, que no se listan.)
/** `null` en `columnas`: columna de un índice por expresión (`pragma_index_info` no da nombre). */
const INDICES_ESPERADOS: Record<
  string,
  { tabla: string; columnas: (string | null)[]; unico: boolean }
> = {
  // §4
  consumptions_order_id_estado: {
    tabla: 'consumptions',
    columnas: ['order_id', 'estado'],
    unico: false,
  },
  consumptions_registrado_por_created_at: {
    tabla: 'consumptions',
    columnas: ['registrado_por', 'created_at'],
    unico: false,
  },
  consumptions_corrige_a_unico: { tabla: 'consumptions', columnas: ['corrige_a'], unico: true },
  validations_consumption_id_unico: {
    tabla: 'validations',
    columnas: ['consumption_id'],
    unico: true,
  },
  audit_log_entidad_entidad_id: {
    tabla: 'audit_log',
    columnas: ['entidad', 'entidad_id'],
    unico: false,
  },
  audit_log_actor_id_seq: { tabla: 'audit_log', columnas: ['actor_id', 'seq'], unico: false },
  order_supervisors_user_id: { tabla: 'order_supervisors', columnas: ['user_id'], unico: false },
  refresh_tokens_user_id: { tabla: 'refresh_tokens', columnas: ['user_id'], unico: false },
  refresh_tokens_token_hash: { tabla: 'refresh_tokens', columnas: ['token_hash'], unico: true },
  incidents_consumption_id: { tabla: 'incidents', columnas: ['consumption_id'], unico: false },
  evidences_incident_id: { tabla: 'evidences', columnas: ['incident_id'], unico: false },
  // Unicidad de negocio
  users_email_unico: { tabla: 'users', columnas: ['email'], unico: true },
  materials_codigo_unico: { tabla: 'materials', columnas: ['codigo'], unico: true },
  production_orders_codigo_unico: {
    tabla: 'production_orders',
    columnas: ['codigo'],
    unico: true,
  },
  audit_log_id_unico: { tabla: 'audit_log', columnas: ['id'], unico: true },
  evidences_storage_key_unico: { tabla: 'evidences', columnas: ['storage_key'], unico: true },
  // ADR 0008
  refresh_tokens_familia_id: { tabla: 'refresh_tokens', columnas: ['familia_id'], unico: false },
  devices_user_id: { tabla: 'devices', columnas: ['user_id'], unico: false },
  // FK y consultas frecuentes
  consumptions_material_id: { tabla: 'consumptions', columnas: ['material_id'], unico: false },
  order_planned_materials_material_id: {
    tabla: 'order_planned_materials',
    columnas: ['material_id'],
    unico: false,
  },
  production_orders_estado: { tabla: 'production_orders', columnas: ['estado'], unico: false },
  sync_mutations_user_id_procesada_at: {
    tabla: 'sync_mutations',
    columnas: ['user_id', 'procesada_at'],
    unico: false,
  },
  // ADR 0010 (revisión del esquema H6, H7, H8 y H10)
  consumptions_pendientes_id: { tabla: 'consumptions', columnas: ['id'], unico: false },
  consumptions_order_id_id: { tabla: 'consumptions', columnas: ['order_id', 'id'], unico: false },
  refresh_tokens_vigentes_usuario: {
    tabla: 'refresh_tokens',
    columnas: ['user_id', 'device_id'],
    unico: false,
  },
  audit_log_order_id_seq: { tabla: 'audit_log', columnas: ['order_id', 'seq'], unico: false },
  // Revisión de la Fase 3: B5 (purga del cron) y B1 (por expresión, solo en migrations/0006)
  refresh_tokens_expira_at: { tabla: 'refresh_tokens', columnas: ['expira_at'], unico: false },
  // ADR 0018 (M1): purga de login_cupos en el cron de mantenimiento.
  login_cupos_updated_at: { tabla: 'login_cupos', columnas: ['updated_at'], unico: false },
  sync_mutations_no_aplicadas_consumo: {
    tabla: 'sync_mutations',
    columnas: ['user_id', null],
    unico: false,
  },
};

interface FilaMaestra {
  name: string;
  tbl_name: string;
  sql: string | null;
}

async function objetos(tipo: 'table' | 'trigger' | 'index'): Promise<FilaMaestra[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, tbl_name, sql FROM sqlite_master
     WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       AND name <> 'd1_migrations'
     ORDER BY name`,
  )
    .bind(tipo)
    .all<FilaMaestra>();
  return results;
}

describe('sqlite_master después de todas las migraciones', () => {
  it('tiene exactamente las tablas del esquema', async () => {
    const tablas = (await objetos('table')).map((t) => t.name);
    expect(tablas).toEqual(TABLAS_ESPERADAS);
    expect(Object.keys(schema).sort()).toEqual(TABLAS_ESPERADAS);
  });

  it('tiene exactamente la lista de triggers de la ADR 0006', async () => {
    const triggers = (await objetos('trigger')).map((t) => t.name);
    expect(triggers).toEqual(TRIGGERS_ESPERADOS);
  });

  it('tiene exactamente los índices esperados, con sus columnas y unicidad', async () => {
    const indices = await objetos('index');
    expect(indices.map((i) => i.name)).toEqual(Object.keys(INDICES_ESPERADOS).sort());

    for (const [nombre, esperado] of Object.entries(INDICES_ESPERADOS)) {
      const indice = indices.find((i) => i.name === nombre);
      expect(indice?.tbl_name, nombre).toBe(esperado.tabla);
      const { results: columnas } = await env.DB.prepare(
        `SELECT name FROM pragma_index_info(?) ORDER BY seqno`,
      )
        .bind(nombre)
        .all<{ name: string | null }>();
      expect(
        columnas.map((c) => c.name),
        nombre,
      ).toEqual(esperado.columnas);
      const lista = await env.DB.prepare(
        `SELECT "unique" AS unico, partial FROM pragma_index_list(?) WHERE name = ?`,
      )
        .bind(esperado.tabla, nombre)
        .first<{ unico: number; partial: number }>();
      expect(lista?.unico, nombre).toBe(esperado.unico ? 1 : 0);
    }
  });

  it('el índice de corrige_a es único y parcial (solo filas con corrige_a)', async () => {
    const lista = await env.DB.prepare(
      `SELECT partial FROM pragma_index_list('consumptions') WHERE name = 'consumptions_corrige_a_unico'`,
    ).first<{ partial: number }>();
    expect(lista?.partial).toBe(1);
  });

  it('todas las tablas tienen created_at y updated_at NOT NULL', async () => {
    for (const tabla of TABLAS_ESPERADAS) {
      const { results } = await env.DB.prepare(
        `SELECT name, "notnull" AS obligatorio FROM pragma_table_info(?)
         WHERE name IN ('created_at', 'updated_at') ORDER BY name`,
      )
        .bind(tabla)
        .all<{ name: string; obligatorio: number }>();
      expect(results, tabla).toEqual([
        { name: 'created_at', obligatorio: 1 },
        { name: 'updated_at', obligatorio: 1 },
      ]);
    }
  });

  it('audit_log.seq es INTEGER PRIMARY KEY AUTOINCREMENT', async () => {
    const tabla = (await objetos('table')).find((t) => t.name === 'audit_log');
    expect(tabla?.sql).toMatch(/`seq` integer PRIMARY KEY AUTOINCREMENT/i);
  });

  it('ninguna FK usa ON DELETE CASCADE ni SET NULL', async () => {
    for (const tabla of TABLAS_ESPERADAS) {
      const { results } = await env.DB.prepare(
        `SELECT "table" AS destino, on_delete FROM pragma_foreign_key_list(?)`,
      )
        .bind(tabla)
        .all<{ destino: string; on_delete: string }>();
      for (const fk of results) {
        expect(fk.on_delete, `${tabla} → ${fk.destino}`).toBe('NO ACTION');
      }
    }
  });

  it('refresh_tokens.reemplazado_por no tiene FK (ADR 0008)', async () => {
    const { results } = await env.DB.prepare(
      `SELECT "from" AS columna FROM pragma_foreign_key_list('refresh_tokens')`,
    ).all<{ columna: string }>();
    expect(results.map((r) => r.columna).sort()).toEqual(['device_id', 'user_id']);
  });
});

describe('foreign keys', () => {
  it('están activas', async () => {
    const pragma = await env.DB.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>();
    expect(pragma?.foreign_keys).toBe(1);
  });

  it('rechazan un consumo con una orden inexistente', async () => {
    const e = await crearEscenario();
    await expect(
      insertar('consumptions', valoresConsumo(e, { order_id: uuidv7() })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rechazan un dispositivo de un usuario inexistente', async () => {
    await expect(crearDispositivo(uuidv7())).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('CHECK', () => {
  it('users: email en minúsculas, rol válido, booleano y contador no negativo', async () => {
    const base = () => {
      const t = ahora();
      return {
        id: uuidv7(),
        nombre: 'Prueba',
        email: `${uuidv7()}@catmetal.test`,
        password_hash: 'x',
        rol: 'jefe',
        created_at: t,
        updated_at: t,
      };
    };
    await expect(insertar('users', { ...base(), email: 'Jefe@Catmetal.test' })).rejects.toThrow(
      /users_email_minusculas/,
    );
    await expect(insertar('users', { ...base(), rol: 'gerente' })).rejects.toThrow(
      /users_rol_valido/,
    );
    await expect(insertar('users', { ...base(), activo: 2 })).rejects.toThrow(
      /users_activo_booleano/,
    );
    await expect(insertar('users', { ...base(), intentos_fallidos: -1 })).rejects.toThrow(
      /users_intentos_no_negativos/,
    );
    const correo = `${uuidv7()}@catmetal.test`;
    await insertar('users', { ...base(), email: correo });
    await expect(insertar('users', { ...base(), email: correo })).rejects.toThrow(
      /UNIQUE constraint failed: users\.email/,
    );
  });

  it('fechas: solo el formato de toISOString()', async () => {
    const e = await crearEscenario();
    for (const malo of [
      '2026-10-29T20:55:00Z',
      '2026-10-29 20:55:00.000',
      '29/10/2026 20:55:00.0',
    ]) {
      await expect(
        insertar('consumptions', valoresConsumo(e, { client_created_at: malo })),
      ).rejects.toThrow(/consumptions_fechas_iso/);
    }
    await expect(
      insertar('users', {
        id: uuidv7(),
        nombre: 'Prueba',
        email: `${uuidv7()}@catmetal.test`,
        password_hash: 'x',
        rol: 'jefe',
        bloqueado_hasta: 'mañana',
        created_at: ahora(),
        updated_at: ahora(),
      }),
    ).rejects.toThrow(/users_fechas_iso/);
  });

  it('consumptions: cantidad, unidad, estado, costo, booleanos y versión', async () => {
    const e = await crearEscenario();
    const casos: [Record<string, string | number>, RegExp][] = [
      [{ cantidad: 0 }, /consumptions_cantidad_positiva/],
      [{ cantidad: -3 }, /consumptions_cantidad_positiva/],
      [{ cantidad_en_unidad_plan: 0 }, /consumptions_cantidad_plan_positiva/],
      [{ unidad: 'ton' }, /consumptions_unidad_valida/],
      // El BEFORE INSERT consumptions_insercion_valida se dispara antes que los CHECK: un estado
      // distinto de 'pendiente' o una versión distinta de 1 los frena el trigger (ADR 0010).
      [{ estado: 'borrado' }, /un consumo nuevo nace pendiente y con version 1/],
      [{ estado: 'aprobado' }, /un consumo nuevo nace pendiente y con version 1/],
      [{ costo_unitario_cop_snapshot: -1 }, /consumptions_costo_no_negativo/],
      [{ registro_tardio: 2 }, /consumptions_registro_tardio_booleano/],
      [{ requiere_novedad: -1 }, /consumptions_requiere_novedad_booleano/],
      [{ version: 0 }, /un consumo nuevo nace pendiente y con version 1/],
      [{ version: 2 }, /un consumo nuevo nace pendiente y con version 1/],
    ];
    for (const [extra, error] of casos) {
      await expect(insertar('consumptions', valoresConsumo(e, extra))).rejects.toThrow(error);
    }
  });

  it('validations: rechazo sin motivo o con motivo de menos de 3 caracteres falla', async () => {
    const e = await crearEscenario();
    const consumo = String(valoresConsumo(e).id);
    await insertar('consumptions', { ...valoresConsumo(e), id: consumo });
    const validacion = (motivo: string | null) => ({
      id: uuidv7(),
      consumption_id: consumo,
      decision: 'rechazado',
      motivo,
      validado_por: e.jefe,
      client_created_at: ahora(),
      server_received_at: ahora(),
      created_at: ahora(),
      updated_at: ahora(),
    });
    await expect(insertar('validations', validacion(null))).rejects.toThrow(
      /validations_motivo_si_rechaza/,
    );
    await expect(insertar('validations', validacion('no'))).rejects.toThrow(
      /validations_motivo_si_rechaza/,
    );
    await expect(insertar('validations', validacion('   ab   '))).rejects.toThrow(
      /validations_motivo_si_rechaza/,
    );
    await expect(
      insertar('validations', { ...validacion(null), decision: 'quizas' }),
    ).rejects.toThrow(/validations_decision_valida/);
  });

  it('sync_mutations: payload_json válido y de máximo 64 KiB; respuesta JSON válida', async () => {
    const usuario = await crearUsuario();
    const dispositivo = await crearDispositivo(usuario);
    const mutacion = (extra: Record<string, string>) => ({
      mutation_id: uuidv7(),
      user_id: usuario,
      device_id: dispositivo,
      tipo: 'consumo.crear',
      resultado: 'rechazada',
      respuesta_json: '{"codigo":"VALIDACION"}',
      procesada_at: ahora(),
      created_at: ahora(),
      updated_at: ahora(),
      ...extra,
    });
    const relleno = (n: number) => JSON.stringify({ x: 'a'.repeat(n - 8) });
    expect(relleno(MAX_PAYLOAD_JSON_BYTES)).toHaveLength(MAX_PAYLOAD_JSON_BYTES);

    await insertar('sync_mutations', mutacion({ payload_json: relleno(MAX_PAYLOAD_JSON_BYTES) }));
    await expect(
      insertar('sync_mutations', mutacion({ payload_json: relleno(MAX_PAYLOAD_JSON_BYTES + 1) })),
    ).rejects.toThrow(/sync_mutations_payload_json/);
    await expect(
      insertar('sync_mutations', mutacion({ payload_json: '{no es json' })),
    ).rejects.toThrow(/sync_mutations_payload_json/);
    await expect(insertar('sync_mutations', mutacion({ respuesta_json: 'texto' }))).rejects.toThrow(
      /sync_mutations_respuesta_json/,
    );
    await expect(insertar('sync_mutations', mutacion({ resultado: 'perdida' }))).rejects.toThrow(
      /sync_mutations_resultado_valido/,
    );
  });

  it('settings y audit_log: JSON válido', async () => {
    await expect(
      insertar('settings', {
        clave: `prueba_${uuidv7()}`,
        valor: 'no json',
        created_at: ahora(),
        updated_at: ahora(),
      }),
    ).rejects.toThrow(/settings_valor_json/);
    await expect(
      insertar('audit_log', {
        id: uuidv7(),
        entidad: 'x',
        entidad_id: 'y',
        accion: 'z',
        datos_despues: '{',
        server_at: ahora(),
        created_at: ahora(),
        updated_at: ahora(),
      }),
    ).rejects.toThrow(/audit_log_datos_despues_json/);
  });

  it('refresh_tokens: token_hash de 64 caracteres y único', async () => {
    const usuario = await crearUsuario();
    const dispositivo = await crearDispositivo(usuario);
    const token = (hash: string) => ({
      id: uuidv7(),
      user_id: usuario,
      device_id: dispositivo,
      token_hash: hash,
      familia_id: uuidv7(),
      expira_at: ahora(),
      created_at: ahora(),
      updated_at: ahora(),
    });
    await expect(insertar('refresh_tokens', token('abc'))).rejects.toThrow(
      /refresh_tokens_token_hash_hex/,
    );
    const hash = 'b'.repeat(64);
    await insertar('refresh_tokens', token(hash));
    await expect(insertar('refresh_tokens', token(hash))).rejects.toThrow(
      /UNIQUE constraint failed: refresh_tokens\.token_hash/,
    );
  });
});

describe('atomicidad de batch()', () => {
  it('un batch cuya última sentencia viola un CHECK no deja datos parciales', async () => {
    const e = await crearEscenario();
    const bueno = valoresConsumo(e);
    const auditoria = {
      id: uuidv7(),
      entidad: 'consumptions',
      entidad_id: String(bueno.id),
      accion: 'crear',
      server_at: ahora(),
      created_at: ahora(),
      updated_at: ahora(),
    };
    await expect(
      env.DB.batch([
        sentenciaInsert('consumptions', bueno),
        sentenciaInsert('audit_log', auditoria),
        sentenciaInsert('consumptions', valoresConsumo(e, { cantidad: 0 })),
      ]),
    ).rejects.toThrow(/consumptions_cantidad_positiva/);

    const consumo = await env.DB.prepare('SELECT id FROM consumptions WHERE id = ?')
      .bind(bueno.id)
      .first();
    const fila = await env.DB.prepare('SELECT id FROM audit_log WHERE id = ?')
      .bind(auditoria.id)
      .first();
    expect(consumo).toBeNull();
    expect(fila).toBeNull();
  });
});

describe('configuración inicial (migración settings_iniciales)', () => {
  it('trae tolerancia_pct = TOLERANCIA_PCT_DEFECTO y una época de sync', async () => {
    const { results } = await env.DB.prepare(
      'SELECT clave, valor, actualizado_por FROM settings ORDER BY clave',
    ).all<{ clave: string; valor: string; actualizado_por: string | null }>();
    expect(results.map((r) => r.clave)).toEqual(['sync_epoca', 'tolerancia_pct']);
    const tolerancia = results.find((r) => r.clave === 'tolerancia_pct');
    const epoca = results.find((r) => r.clave === 'sync_epoca');
    expect(JSON.parse(tolerancia?.valor ?? 'null')).toBe(TOLERANCIA_PCT_DEFECTO);
    expect(JSON.parse(epoca?.valor ?? 'null')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(results.every((r) => r.actualizado_por === null)).toBe(true);
  });

  it('cada fila de configuración tiene su auditoría de seed (actor NULL)', async () => {
    const { results } = await env.DB.prepare(
      `SELECT entidad, entidad_id, accion, actor_id, datos_despues FROM audit_log
       WHERE accion = 'seed' AND entidad = 'settings' ORDER BY seq`,
    ).all<{
      entidad: string;
      entidad_id: string;
      accion: string;
      actor_id: string | null;
      datos_despues: string;
    }>();
    expect(results.map((r) => r.entidad_id)).toEqual(['tolerancia_pct', 'sync_epoca']);
    expect(results.every((r) => r.actor_id === null)).toBe(true);
    expect(JSON.parse(results[0]?.datos_despues ?? '{}')).toEqual({
      clave: 'tolerancia_pct',
      valor: TOLERANCIA_PCT_DEFECTO,
    });
  });
});

describe('cliente Drizzle (crearDb)', () => {
  it('lee la configuración y mapea booleanos', async () => {
    const db = crearDb(env.DB);
    const [tolerancia] = await db
      .select()
      .from(settings)
      .where(eq(settings.clave, 'tolerancia_pct'));
    expect(tolerancia?.valor).toBe('5');

    const id = await crearUsuario('admin');
    const usuario = await db.query.users.findFirst({ where: eq(users.id, id) });
    expect(usuario?.activo).toBe(true);
    expect(usuario?.rol).toBe('admin');
    expect(usuario?.intentos_fallidos).toBe(0);
  });

  it('inserta con los valores por defecto del esquema', async () => {
    const db = crearDb(env.DB);
    const t = ahora();
    const id = uuidv7();
    await db.insert(users).values({
      id,
      nombre: 'Desde Drizzle',
      email: `${id}@catmetal.test`,
      password_hash: 'x',
      rol: 'supervisor',
      created_at: t,
      updated_at: t,
    });
    const fila = await env.DB.prepare(
      'SELECT activo, intentos_fallidos, bloqueado_hasta FROM users WHERE id = ?',
    )
      .bind(id)
      .first();
    expect(fila).toEqual({ activo: 1, intentos_fallidos: 0, bloqueado_hasta: null });
  });
});

describe('prueba estática: sin reemplazo implícito de SQLite (ADR 0006)', () => {
  /** Quita comentarios para no marcar la documentación que explica la prohibición. */
  function sinComentarios(ruta: string, contenido: string): string {
    if (ruta.endsWith('.sql')) {
      return contenido.replace(/--.*$/gm, '');
    }
    return contenido.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  // Palabra clave SQL, en cualquier mayúscula/minúscula. Se excluye la llamada a métodos de JS
  // (`texto.replace(...)`), que no es SQL.
  const PALABRA_PROHIBIDA = new RegExp(String.raw`(?<!\.)\b${'REP' + 'LACE'}\b`, 'i');

  it('revisa src/, migrations/ y scripts/', () => {
    const rutas = env.TEST_ARCHIVOS_FUENTE.map((a) => a.ruta);
    expect(rutas).toContain('apps/worker/src/db/schema.ts');
    expect(rutas).toContain('migrations/0001_triggers.sql');
    expect(rutas.some((r) => r.startsWith('scripts/'))).toBe(true);
  });

  it('ningún archivo usa la palabra clave', () => {
    const infractores = env.TEST_ARCHIVOS_FUENTE.filter((archivo) =>
      PALABRA_PROHIBIDA.test(sinComentarios(archivo.ruta, archivo.contenido)),
    ).map((archivo) => archivo.ruta);
    expect(infractores).toEqual([]);
  });

  it('la expresión detecta las formas peligrosas', () => {
    const muestras = [
      'INSERT OR ' + 'REPLACE INTO users VALUES (1)',
      'rep' + 'lace into users values (1)',
      'UNIQUE ON CONFLICT ' + 'Replace',
    ];
    for (const muestra of muestras) {
      expect(PALABRA_PROHIBIDA.test(sinComentarios('x.sql', muestra)), muestra).toBe(true);
    }
    expect(PALABRA_PROHIBIDA.test(sinComentarios('x.ts', "texto.replace('a', 'b')"))).toBe(false);
    expect(PALABRA_PROHIBIDA.test(sinComentarios('x.sql', '-- INSERT OR ' + 'REPLACE'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// ADR 0010: columna audit_log.order_id, índices parciales, planes de consulta y reconstrucciones
// ---------------------------------------------------------------------------------------------

describe('ADR 0010: esquema', () => {
  it('audit_log.order_id es TEXT nullable y sin FK', async () => {
    const columna = await env.DB.prepare(
      `SELECT type AS tipo, "notnull" AS obligatorio FROM pragma_table_info('audit_log') WHERE name = 'order_id'`,
    ).first();
    expect(columna).toEqual({ tipo: 'TEXT', obligatorio: 0 });
    const { results } = await env.DB.prepare(
      `SELECT "from" AS columna FROM pragma_foreign_key_list('audit_log')`,
    ).all<{ columna: string }>();
    expect(results.map((r) => r.columna)).not.toContain('order_id');
  });

  it.each([
    ['consumptions', 'consumptions_pendientes_id', "WHERE estado = 'pendiente'"],
    ['refresh_tokens', 'refresh_tokens_vigentes_usuario', 'WHERE revocado_at IS NULL'],
    ['audit_log', 'audit_log_order_id_seq', 'WHERE order_id IS NOT NULL'],
  ])('%s: el índice %s es parcial (%s)', async (tabla, nombre, condicion) => {
    const lista = await env.DB.prepare(`SELECT partial FROM pragma_index_list(?) WHERE name = ?`)
      .bind(tabla, nombre)
      .first<{ partial: number }>();
    expect(lista?.partial).toBe(1);
    const definicion = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
    )
      .bind(nombre)
      .first<{ sql: string }>();
    expect(definicion?.sql).toContain(condicion);
  });
});

describe('ADR 0010: planes de consulta (EXPLAIN QUERY PLAN en la D1 local)', () => {
  async function plan(sql: string, ...parametros: string[]): Promise<string> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...parametros)
      .all<{ detail: string }>();
    return results.map((r) => r.detail).join(' | ');
  }

  it('la cola de validación (pendientes por id) usa consumptions_pendientes_id', async () => {
    const detalle = await plan(
      `SELECT id FROM consumptions WHERE estado = 'pendiente' AND id > ? ORDER BY id LIMIT 50`,
      '',
    );
    expect(detalle).toContain('consumptions_pendientes_id');
  });

  it('los consumos de una orden paginados por id usan consumptions_order_id_id', async () => {
    const detalle = await plan(
      `SELECT id FROM consumptions WHERE order_id = ? AND id > ? ORDER BY id LIMIT 50`,
      uuidv7(),
      '',
    );
    expect(detalle).toContain('consumptions_order_id_id');
  });

  it('la consulta de sesión del middleware usa refresh_tokens_vigentes_usuario', async () => {
    const detalle = await plan(CONSULTA_SESION, uuidv7(), uuidv7(), ahora(), uuidv7());
    expect(detalle).toContain('refresh_tokens_vigentes_usuario');
  });

  it('la revocación por usuario y dispositivo del login usa refresh_tokens_vigentes_usuario', async () => {
    const detalle = await plan(
      `UPDATE refresh_tokens SET revocado_at = ? WHERE user_id = ? AND device_id = ? AND revocado_at IS NULL`,
      ahora(),
      uuidv7(),
      uuidv7(),
    );
    expect(detalle).toContain('refresh_tokens_vigentes_usuario');
  });

  it('la búsqueda de una creación de consumo no aplicada (/sync/push) usa el índice por expresión', async () => {
    const detalle = await plan(CONSULTA_CREACION_NO_APLICADA, uuidv7(), uuidv7(), uuidv7());
    expect(detalle).toContain('sync_mutations_no_aplicadas_consumo');
    const definicion = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'sync_mutations_no_aplicadas_consumo'",
    ).first<{ sql: string }>();
    expect(definicion?.sql).toContain("json_extract(payload_json, '$.payload.id')");
    expect(definicion?.sql).toContain("WHERE tipo = 'consumo.crear' AND resultado <> 'aplicada'");
    const parcial = await env.DB.prepare(
      "SELECT partial FROM pragma_index_list('sync_mutations') WHERE name = 'sync_mutations_no_aplicadas_consumo'",
    ).first<{ partial: number }>();
    expect(parcial?.partial).toBe(1);
  });

  it('la purga de refresh tokens del cron usa refresh_tokens_expira_at', async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${SENTENCIA_PURGA}`)
      .bind(ahora(), 500)
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join(' | ')).toContain('refresh_tokens_expira_at');
  });

  it('la línea de tiempo de una orden usa audit_log_order_id_seq', async () => {
    const detalle = await plan(
      `SELECT seq FROM audit_log WHERE order_id = ? AND seq > 0 ORDER BY seq LIMIT 100`,
      uuidv7(),
    );
    expect(detalle).toContain('audit_log_order_id_seq');
  });
});

/**
 * Regla de reconstrucción (ADR 0010): todo `DROP TABLE T` va seguido de
 * `ALTER TABLE __new_T RENAME TO T` en la misma migración, y la migración usa
 * `PRAGMA defer_foreign_keys = on` (el `PRAGMA foreign_keys=OFF` de drizzle-kit no sirve en D1).
 * Devuelve los problemas encontrados.
 */
function problemasDeReconstruccion(contenido: string): string[] {
  const sql = contenido.replace(/--.*$/gm, '');
  const problemas: string[] = [];
  const identificador = '[`"\\[]?([A-Za-z_][A-Za-z0-9_]*)[`"\\]]?';
  const drops = [
    ...sql.matchAll(new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${identificador}`, 'gi')),
  ];
  for (const drop of drops) {
    const tabla = drop[1] ?? '';
    const resto = sql.slice((drop.index ?? 0) + drop[0].length);
    const rename = new RegExp(
      `\\bALTER\\s+TABLE\\s+[\`"\\[]?__new_${tabla}[\`"\\]]?\\s+RENAME\\s+TO\\s+[\`"\\[]?${tabla}[\`"\\]]?`,
      'i',
    );
    if (!rename.test(resto)) {
      problemas.push(`DROP TABLE ${tabla} sin RENAME de __new_${tabla}`);
    }
  }
  if (drops.length > 0) {
    if (!/\bPRAGMA\s+defer_foreign_keys\s*=\s*on\b/i.test(sql)) {
      problemas.push('falta PRAGMA defer_foreign_keys = on');
    }
    if (/\bPRAGMA\s+foreign_keys\s*=\s*off\b/i.test(sql)) {
      problemas.push('PRAGMA foreign_keys = OFF no sirve en D1');
    }
  }
  return problemas;
}

describe('prueba estática: reconstrucción de tablas (ADR 0010)', () => {
  it('ninguna migración tiene un DROP TABLE sin su RENAME', () => {
    const migraciones = env.TEST_ARCHIVOS_FUENTE.filter(
      (a) => a.ruta.startsWith('migrations/') && a.ruta.endsWith('.sql'),
    );
    expect(migraciones.length).toBeGreaterThanOrEqual(5);
    const problemas = migraciones.flatMap((a) =>
      problemasDeReconstruccion(a.contenido).map((p) => `${a.ruta}: ${p}`),
    );
    expect(problemas).toEqual([]);
  });

  it('detecta casos sintéticos', () => {
    const correcta = [
      'PRAGMA defer_foreign_keys = on;',
      'CREATE TABLE `__new_users` (id text);',
      'INSERT INTO `__new_users` SELECT id FROM `users`;',
      'DROP TABLE `users`;',
      'ALTER TABLE `__new_users` RENAME TO `users`;',
    ].join('\n');
    expect(problemasDeReconstruccion(correcta)).toEqual([]);
    expect(problemasDeReconstruccion('DROP TABLE users;')).toEqual([
      'DROP TABLE users sin RENAME de __new_users',
      'falta PRAGMA defer_foreign_keys = on',
    ]);
    expect(
      problemasDeReconstruccion(
        'PRAGMA foreign_keys=OFF;\nPRAGMA defer_foreign_keys = on;\nDROP TABLE IF EXISTS "materials";\nALTER TABLE __new_otra RENAME TO materials;',
      ),
    ).toEqual([
      'DROP TABLE materials sin RENAME de __new_materials',
      'PRAGMA foreign_keys = OFF no sirve en D1',
    ]);
    // Un RENAME antes del DROP no cuenta, y un comentario no es una sentencia.
    expect(
      problemasDeReconstruccion(
        'PRAGMA defer_foreign_keys = on;\nALTER TABLE __new_users RENAME TO users;\nDROP TABLE users;',
      ),
    ).toEqual(['DROP TABLE users sin RENAME de __new_users']);
    expect(problemasDeReconstruccion('-- DROP TABLE users;')).toEqual([]);
  });
});
