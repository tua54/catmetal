// M4 (ADR 0021): restaurar el backup de R2 deja la base CONSISTENTE entre tablas.
//
// Escenario de la auditoría: el jefe aprueba un consumo después de que el backup exportó
// `validations` y antes de que exporte `consumptions`. Restaurado tal cual, el consumo queda
// `aprobado` sin su validación, y lo escrito durante la ventana del backup queda sin su auditoría.
//
// Todo contra la D1 y el R2 locales reales: `env.DB` es la base de origen (escrituras por la API
// real) y `env.DB_RESTAURADA` una D1 limpia, solo de pruebas, donde se importa el NDJSON.
import { uuidv7 } from '@catmetal/shared';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COLUMNAS_AUDITABLES,
  COLUMNAS_BOOLEANAS,
  sentenciaAuditoria,
  type EntidadAuditada,
} from '../src/auditoria/auditar';
import { ejecutarBackup, type ManifestBackup } from '../src/cron/backup';
import { Presupuesto } from '../src/cron/presupuesto';
import { TABLAS_BACKUP } from '../src/cron/tablas';
import { api, sesion, type SesionDeRol } from './fase2-helpers';
import { cuerpoConsumo, editar, escenarioOrden, registrarOk } from './fase2-consumos-helpers';
import { completas, leerManifest, leerProgreso, leerTabla, type Fila } from './fase6-cron-helpers';
import { crearConsumo, editarConsumoMut, pushOk } from './fase3-helpers';
import {
  ErrorRestauracion,
  literal,
  MAX_BYTES_SENTENCIA,
  ORDEN_IMPORTACION,
  planificarRestauracion,
  TABLAS,
  TABLAS_AUDITADAS,
  triggersDeMigraciones,
  type PlanRestauracion,
} from '../../../scripts/restauracion-nucleo.mjs';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const FECHA = '2027-05-03';
const a = (hora: number) => new Date(`${FECHA}T${String(hora).padStart(2, '0')}:00:00.000Z`);

/** Tablas con auditoría por fila (las demás son operativas o no se restauran; ADR 0021, 4). */
const AUDITADAS: Record<string, (fila: Fila) => string> = {
  users: (f) => String(f.id),
  devices: (f) => String(f.id),
  materials: (f) => String(f.id),
  production_orders: (f) => String(f.id),
  settings: (f) => String(f.clave),
  order_supervisors: (f) => `${String(f.order_id)}:${String(f.user_id)}`,
  order_planned_materials: (f) => `${String(f.order_id)}:${String(f.material_id)}`,
  consumptions: (f) => String(f.id),
  incidents: (f) => String(f.id),
  evidences: (f) => String(f.id),
  validations: (f) => String(f.id),
};

/**
 * Los fixtures de las pruebas insertan catálogos, usuarios y asignaciones por SQL, sin auditoría.
 * En producción toda fila nace con la suya (seed, scripts y API): aquí se agrega una fila `seed` con
 * la imagen completa a cada fila que no la tenga, como hace scripts/seed.mjs.
 */
async function auditarSemillas(): Promise<void> {
  const sentencias: D1PreparedStatement[] = [];
  for (const [tabla, clave] of Object.entries(AUDITADAS)) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${tabla}`).all<Fila>();
    for (const fila of results) {
      const existe = await env.DB.prepare(
        'SELECT 1 AS x FROM audit_log WHERE entidad = ? AND entidad_id = ? LIMIT 1',
      )
        .bind(tabla, clave(fila))
        .first();
      if (existe === null) {
        sentencias.push(
          sentenciaAuditoria(env.DB, {
            entidad: tabla as EntidadAuditada,
            entidad_id: clave(fila),
            accion: 'seed',
            actor_id: null,
            device_id: null,
            despues: fila,
          }),
        );
      }
    }
  }
  for (let i = 0; i < sentencias.length; i += 50) {
    await env.DB.batch(sentencias.slice(i, i + 50));
  }
}

interface Escenario {
  jefe: SesionDeRol;
  supervisor: SesionDeRol;
  orden: string;
  material: string;
  /** Pendiente; el supervisor lo edita durante la ventana. */
  a: string;
  /** Pendiente; el jefe lo aprueba entre la exportación de validations y la de consumptions. */
  b: string;
  /** Aprobado antes del corte; una edición durante la ventana queda rechazada o en conflicto. */
  d: string;
  /** Creado por /sync/push después del corte (y antes de exportar sync_mutations). */
  e: string;
  mutacionE: string;
  mutacionEdicionD: string;
  corte: number;
}

let escenario: Escenario;
let manifest: ManifestBackup;
let filas: Record<string, Fila[]>;

function aprobar(token: string, consumo: { id: string; version: number }) {
  return api(`/consumptions/${consumo.id}/approve`, {
    token,
    body: {
      id: uuidv7(),
      version: consumo.version,
      client_created_at: new Date().toISOString(),
    },
  });
}

/** Continúa el backup con presupuesto mínimo hasta que `condicion` se cumpla sobre el progreso. */
async function continuarHasta(condicion: (progreso: Fila | null) => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const progreso = await leerProgreso(FECHA);
    if (condicion(progreso)) {
      return;
    }
    await ejecutarBackup(env, a(9), {
      modo: 'continuacion',
      tamanoPagina: 1,
      presupuesto: new Presupuesto({ maxOperaciones: 36 }),
    });
  }
  throw new Error('La condición del backup no se cumplió');
}

function terminadas(progreso: Fila | null): string[] {
  return ((progreso?.terminadas ?? []) as { tabla: string }[]).map((t) => t.tabla);
}

beforeAll(async () => {
  const [jefe, supervisor] = await Promise.all([sesion('jefe'), sesion('supervisor')]);
  const { orden, material } = await escenarioOrden(jefe, supervisor);
  await auditarSemillas();
  const consumoA = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
  const consumoB = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
  const consumoD = await registrarOk(supervisor.token, cuerpoConsumo(orden, material));
  expect((await aprobar(jefe.token, consumoD)).status).toBe(201);

  // 1. Corte: la primera invocación toma la marca y se pausa sin exportar ninguna tabla.
  const inicio = await ejecutarBackup(env, a(8), {
    presupuesto: new Presupuesto({ maxOperaciones: 8 }),
  });
  expect(inicio.estado).toBe('pausado');
  const progreso = (await leerProgreso(FECHA)) as { seq_inicial: number; terminadas: unknown[] };
  expect(progreso.terminadas).toEqual([]);

  // 2. Después del corte y antes de exportar sync_mutations: un consumo nuevo por push (su fila
  //    `aplicada` y el consumo entran al backup) y una edición de D, ya aprobado (no se aplica).
  const mutacionE = crearConsumo(orden, material);
  const mutacionEdicionD = editarConsumoMut(consumoD.id, consumoD.version);
  const resultados = await pushOk(supervisor.token, supervisor.usuario.id, [
    mutacionE,
    mutacionEdicionD,
  ]);
  expect(resultados.map((r) => r.resultado)).toEqual([
    'aplicada',
    expect.stringMatching(/^(rechazada|conflicto)$/) as unknown as string,
  ]);

  // 3. Se exportan sync_mutations y validations; consumptions todavía no.
  await continuarHasta((p) => terminadas(p).includes('validations'));
  const durante = await leerProgreso(FECHA);
  expect(terminadas(durante)).not.toContain('consumptions');
  expect((durante?.en_curso as { tabla: string } | null)?.tabla).not.toBe('consumptions');

  // 4. Escenario de la auditoría: el jefe aprueba B. Y el supervisor edita A (versión 2).
  expect((await aprobar(jefe.token, consumoB)).status).toBe(201);
  const edicion = await editar(supervisor.token, consumoA.id, {
    id: consumoA.id,
    version: consumoA.version,
    client_created_at: new Date().toISOString(),
    lote: 'L-EDITADO',
  });
  expect(edicion.status).toBe(200);

  // 5. Fin del backup.
  await continuarHasta((p) => p === null);
  expect((await leerManifest(FECHA))?.estado).toBe('completo');
  escenario = {
    jefe,
    supervisor,
    orden,
    material,
    a: consumoA.id,
    b: consumoB.id,
    d: consumoD.id,
    e: String(mutacionE.payload.id),
    mutacionE: mutacionE.mutation_id,
    mutacionEdicionD: mutacionEdicionD.mutation_id,
    corte: progreso.seq_inicial,
  };
});

/** Ejecuta sentencias SQL en orden, en batches (cada batch es atómico en D1). */
async function ejecutarEn(db: D1Database, sentencias: readonly string[]): Promise<void> {
  for (let i = 0; i < sentencias.length; i += 50) {
    await db.batch(sentencias.slice(i, i + 50).map((s) => db.prepare(s)));
  }
}

/** Invariantes independientes del script (las comprueba la prueba con su propio SQL). */
async function invariantes(db: D1Database): Promise<Record<string, unknown[]>> {
  const consulta = async (sql: string) => (await db.prepare(sql).all()).results;
  return {
    decididos_sin_validacion: await consulta(`SELECT c.id FROM consumptions c
      WHERE c.estado <> 'pendiente' AND NOT EXISTS (
        SELECT 1 FROM validations v WHERE v.consumption_id = c.id AND v.decision = c.estado)`),
    validaciones_no_aplicadas: await consulta(`SELECT v.id FROM validations v
      JOIN consumptions c ON c.id = v.consumption_id WHERE c.estado <> v.decision`),
    consumos_sin_auditoria: await consulta(`SELECT c.id FROM consumptions c WHERE NOT EXISTS (
      SELECT 1 FROM audit_log a WHERE a.entidad = 'consumptions' AND a.entidad_id = c.id)`),
    consumos_distintos_de_su_auditoria: await consulta(`SELECT c.id FROM consumptions c
      JOIN audit_log a ON a.seq = (SELECT MAX(x.seq) FROM audit_log x
        WHERE x.entidad = 'consumptions' AND x.entidad_id = c.id AND x.datos_despues IS NOT NULL)
      WHERE json_extract(a.datos_despues, '$.version') IS NOT c.version
         OR json_extract(a.datos_despues, '$.estado') IS NOT c.estado`),
    validaciones_sin_auditoria: await consulta(`SELECT v.id FROM validations v WHERE NOT EXISTS (
      SELECT 1 FROM audit_log a WHERE a.entidad = 'validations' AND a.entidad_id = v.id)`),
    foreign_keys: await consulta('PRAGMA foreign_key_check'),
  };
}

const VACIAS = {
  decididos_sin_validacion: [],
  validaciones_no_aplicadas: [],
  consumos_sin_auditoria: [],
  consumos_distintos_de_su_auditoria: [],
  validaciones_sin_auditoria: [],
  foreign_keys: [],
};

/** Triggers de una base recién migrada, en orden de creación. */
async function triggersDe(db: D1Database): Promise<{ nombre: string; sql: string }[]> {
  const { results } = await db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY rowid")
    .all<{ name: string; sql: string }>();
  return results.map((t) => ({ nombre: t.name, sql: t.sql }));
}

function migraciones(): { nombre: string; contenido: string }[] {
  return env.TEST_ARCHIVOS_FUENTE.filter((a) => a.ruta.startsWith('migrations/')).map((a) => ({
    nombre: a.ruta,
    contenido: a.contenido,
  }));
}

describe('restauración del backup de R2 (M4)', () => {
  let plan: PlanRestauracion;

  beforeAll(async () => {
    const m = await leerManifest(FECHA);
    expect(m).not.toBeNull();
    manifest = m as ManifestBackup;
    filas = {};
    for (const entrada of completas(manifest)) {
      filas[entrada.tabla] = await leerTabla(FECHA, entrada);
    }
    await applyD1Migrations(env.DB_RESTAURADA, env.TEST_MIGRATIONS);
  });

  it('el backup tiene el consumo aprobado sin su validación (el escenario se reprodujo)', () => {
    const b = filas.consumptions?.find((f) => f.id === escenario.b);
    expect(b).toMatchObject({ estado: 'aprobado' });
    expect(filas.validations?.some((v) => v.consumption_id === escenario.b)).toBe(false);
    // Y lo escrito en la ventana: E (por push, con su fila aplicada) y A en versión 2.
    expect(filas.consumptions?.find((f) => f.id === escenario.e)).toBeDefined();
    expect(filas.sync_mutations?.find((f) => f.mutation_id === escenario.mutacionE)).toMatchObject({
      resultado: 'aplicada',
    });
    expect(filas.consumptions?.find((f) => f.id === escenario.a)).toMatchObject({ version: 2 });
  });

  it('los triggers esperados (desde las migraciones) son exactamente los de una base migrada', async () => {
    const esperados = triggersDeMigraciones(migraciones(), String(manifest.ultima_migracion));
    expect(esperados.length).toBeGreaterThan(20);
    expect(esperados).toEqual(await triggersDe(env.DB_RESTAURADA));
  });

  it('tras restaurar no queda ningún consumo decidido sin validación ni fila sin su auditoría', async () => {
    const triggers = triggersDeMigraciones(migraciones(), String(manifest.ultima_migracion));
    plan = planificarRestauracion({ manifest, filas, triggers });
    const db = env.DB_RESTAURADA;
    await ejecutarEn(db, plan.restauracion);

    // Las verificaciones del script (V1 a V10) y las de la prueba, independientes.
    for (const v of plan.verificacion) {
      expect((await db.prepare(v.sql).all()).results, v.nombre).toEqual([]);
    }
    expect(await invariantes(db)).toEqual(VACIAS);

    // Estado exacto en el corte.
    const consumo = (id: string) =>
      db.prepare('SELECT estado, version, lote FROM consumptions WHERE id = ?').bind(id).first();
    expect(await consumo(escenario.b)).toMatchObject({ estado: 'pendiente', version: 1 });
    expect(await consumo(escenario.a)).toMatchObject({ estado: 'pendiente', version: 1 });
    expect(await consumo(escenario.a)).not.toMatchObject({ lote: 'L-EDITADO' });
    expect(await consumo(escenario.d)).toMatchObject({ estado: 'aprobado', version: 2 });
    expect(await consumo(escenario.e)).toBeNull();
    const sync = await db
      .prepare('SELECT mutation_id FROM sync_mutations WHERE mutation_id IN (?, ?)')
      .bind(escenario.mutacionE, escenario.mutacionEdicionD)
      .all();
    expect(sync.results).toEqual([]);
    const validacionB = await db
      .prepare('SELECT id FROM validations WHERE consumption_id = ?')
      .bind(escenario.b)
      .first();
    expect(validacionB).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT MAX(seq) AS s FROM audit_log').first()).toEqual({
      s: escenario.corte,
    });

    // Informe: lo hecho en la ventana y el rechazo posterior al corte, para revisarlos.
    const cambios = plan.informe.cambios_tras_el_corte.map((c) => c.entidad_id);
    expect(cambios).toEqual(expect.arrayContaining([escenario.a, escenario.b, escenario.e]));
    expect(plan.informe.rechazos_tras_el_corte.map((r) => r.mutation_id)).toEqual([
      escenario.mutacionEdicionD,
    ]);
    expect(plan.informe.tablas.consumptions).toMatchObject({ excluidas: 1, revertidas: 2 });
    expect(plan.informe.refresh_tokens_omitidos).toBeGreaterThan(0);
  });

  it('después de la restauración los triggers están vivos y el jefe puede volver a aprobar B', async () => {
    const db = env.DB_RESTAURADA;
    await ejecutarEn(db, plan.postRestauracion);
    const epoca = await db
      .prepare("SELECT valor FROM settings WHERE clave = 'sync_epoca'")
      .first<{ valor: string }>();
    expect(JSON.parse(String(epoca?.valor))).not.toBe(manifest.epoca);
    await expect(
      db.prepare("UPDATE audit_log SET accion = 'x' WHERE seq = 1").run(),
    ).rejects.toThrow(/audit_log es inmutable/);
    await expect(
      db
        .prepare(
          `INSERT INTO consumptions (id, order_id, material_id, cantidad, unidad,
             cantidad_en_unidad_plan, lote, costo_unitario_cop_snapshot, registrado_por, device_id,
             client_created_at, server_received_at, estado, version, created_at, updated_at)
           SELECT ?, order_id, material_id, cantidad, unidad, cantidad_en_unidad_plan, lote,
             costo_unitario_cop_snapshot, registrado_por, device_id, client_created_at,
             server_received_at, 'aprobado', 1, created_at, updated_at
           FROM consumptions WHERE id = ?`,
        )
        .bind(uuidv7(), escenario.b)
        .run(),
    ).rejects.toThrow(/nace pendiente/);
    const t = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO validations (id, consumption_id, decision, motivo, validado_por,
           client_created_at, server_received_at, created_at, updated_at)
         VALUES (?, ?, 'aprobado', NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(uuidv7(), escenario.b, escenario.jefe.usuario.id, t, t, t, t)
      .run();
    expect(
      await db
        .prepare('SELECT estado, version FROM consumptions WHERE id = ?')
        .bind(escenario.b)
        .first(),
    ).toEqual({ estado: 'aprobado', version: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// Núcleo: reglas una por una, con datos sintéticos (solo los literales se prueban contra la D1)
// ---------------------------------------------------------------------------------------------

const T0 = '2027-05-03T08:00:00.000Z';
const ANTES = '2027-05-02T10:00:00.000Z';
const DESPUES = '2027-05-03T08:30:00.000Z';
const U1 = '01900000-0000-7000-8000-000000000001';
const U2 = '01900000-0000-7000-8000-000000000002';
const DEV = '01900000-0000-7000-8000-0000000000d1';

interface Sintetico {
  filas: Record<string, Fila[]>;
  manifest: Record<string, unknown>;
}

/** Fila de auditoría sintética (el seq se asigna al armar el backup). */
function auditoriaDe(
  entidad: string,
  entidadId: string,
  antes: Fila | null,
  despues: Fila | null,
  accion = 'x',
): Fila {
  return {
    id: uuidv7(),
    entidad,
    entidad_id: entidadId,
    accion,
    actor_id: null,
    device_id: null,
    datos_antes: antes === null ? null : JSON.stringify(antes),
    datos_despues: despues === null ? null : JSON.stringify(despues),
    client_at: null,
    server_at: T0,
    alerta_reloj: 0,
    created_at: T0,
    updated_at: T0,
    order_id: null,
  };
}

function usuario(id: string, activo = 1): Fila {
  return {
    id,
    nombre: 'U',
    email: `${id}@x.test`,
    password_hash: 'h',
    rol: 'admin',
    activo,
    intentos_fallidos: 0,
    bloqueado_hasta: null,
    created_at: ANTES,
    updated_at: ANTES,
  };
}

/**
 * Backup sintético: `antes` son las auditorías hasta el corte y `despues` las posteriores. Todas las
 * tablas quedan `completa` salvo `incompletas`.
 */
function sintetico(
  datos: Record<string, Fila[]>,
  antes: Fila[],
  despues: Fila[],
  incompletas: string[] = [],
): Sintetico {
  const auditoria = [...antes, ...despues].map((fila, i) => ({ ...fila, seq: i + 1 }));
  const filas: Record<string, Fila[]> = { ...datos, audit_log: auditoria };
  const tablas = TABLAS_BACKUP.map((t) =>
    incompletas.includes(t.nombre)
      ? { tabla: t.nombre, estado: 'incompleta', motivo: 'm', intentos: 3 }
      : { tabla: t.nombre, estado: 'completa', filas: (filas[t.nombre] ?? []).length },
  );
  for (const t of TABLAS_BACKUP) {
    filas[t.nombre] ??= [];
  }
  for (const t of incompletas) {
    delete filas[t];
  }
  return {
    filas,
    manifest: {
      formato: 2,
      estado: incompletas.length > 0 ? 'parcial' : 'completo',
      fecha: '2027-05-03',
      corte: { seq: antes.length, at: T0 },
      seq_inicial: antes.length,
      seq_final: auditoria.length,
      ultima_migracion: '0007_login_cupos.sql',
      epoca: 'e',
      tablas,
    },
  };
}

const TRIGGERS = [
  { nombre: 't', sql: 'CREATE TRIGGER t BEFORE DELETE ON users BEGIN SELECT 1; END' },
];

function planDe(s: Sintetico, conservarSinAuditoria = false): PlanRestauracion {
  return planificarRestauracion({ ...s, triggers: TRIGGERS, conservarSinAuditoria });
}

function insertsDe(plan: PlanRestauracion, tabla: string): string[] {
  return plan.restauracion.filter((s) => s.startsWith(`INSERT INTO ${tabla} `));
}

function esperarRechazo(fn: () => unknown, codigo: string): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ErrorRestauracion);
  expect((error as ErrorRestauracion).codigo).toBe(codigo);
}

describe('núcleo de la restauración (ADR 0021)', () => {
  const base = () =>
    sintetico({ users: [usuario(U1)] }, [auditoriaDe('users', U1, null, { id: U1 })], []);

  it('coincide con TABLAS_BACKUP y con la lista blanca de la auditoría', () => {
    for (const tabla of TABLAS_BACKUP) {
      const definicion = TABLAS[tabla.nombre];
      expect(definicion, tabla.nombre).toBeDefined();
      expect(definicion?.pk, tabla.nombre).toEqual([...tabla.pk]);
      expect(definicion?.columnas, tabla.nombre).toEqual([...tabla.columnas]);
    }
    expect(Object.keys(TABLAS).sort()).toEqual(TABLAS_BACKUP.map((t) => t.nombre).sort());
    expect([...ORDEN_IMPORTACION].sort()).toEqual(
      TABLAS_BACKUP.map((t) => t.nombre)
        .filter((n) => n !== 'refresh_tokens')
        .sort(),
    );
    for (const tabla of TABLAS_AUDITADAS) {
      const definicion = TABLAS[tabla];
      if (definicion === undefined) {
        throw new Error(`Tabla sin definición: ${tabla}`);
      }
      const blanca: readonly string[] = COLUMNAS_AUDITABLES[tabla as EntidadAuditada];
      const fuera = definicion.columnas.filter((c) => !blanca.includes(c));
      if (definicion.clase === 'revertible') {
        // Revertible = la auditoría guarda la fila completa (salvo las inmutables declaradas).
        expect(fuera, tabla).toEqual(definicion.inmutables ?? []);
      } else {
        expect(fuera.length, tabla).toBeGreaterThan(0);
      }
      const booleanas: readonly string[] = COLUMNAS_BOOLEANAS[tabla as EntidadAuditada];
      expect(definicion.booleanas, tabla).toEqual(
        booleanas.filter((c) => definicion.columnas.includes(c)),
      );
    }
  });

  it('rechaza un backup de formato 1, un parcial no admitido y un salto de seq', () => {
    const s = base();
    esperarRechazo(() => planDe({ ...s, manifest: { ...s.manifest, formato: 1 } }), 'INTEGRIDAD');
    const sinConsumos = sintetico(
      { users: [usuario(U1)] },
      [auditoriaDe('users', U1, null, {})],
      [],
      ['consumptions'],
    );
    esperarRechazo(() => planDe(sinConsumos), 'INTEGRIDAD');
    const saltada = base();
    const auditoria = saltada.filas.audit_log ?? [];
    auditoria[0] = { ...auditoria[0], seq: 2 };
    esperarRechazo(() => planDe(saltada), 'INTEGRIDAD');
  });

  it('un parcial sin sync_mutations ni login_cupos se restaura sin esas filas', () => {
    const s = sintetico(
      { users: [usuario(U1)] },
      [auditoriaDe('users', U1, null, {})],
      [],
      ['sync_mutations', 'login_cupos'],
    );
    const plan = planDe(s);
    expect(insertsDe(plan, 'sync_mutations')).toEqual([]);
    expect(insertsDe(plan, 'login_cupos')).toEqual([]);
    expect(plan.informe.sync_mutations.tabla_omitida).toBe(true);
    expect(plan.informe.login_cupos_omitida).toBe(true);
    expect(insertsDe(plan, 'users')).toHaveLength(1);
  });

  it('una fila sin ninguna auditoría en el origen detiene la restauración, salvo que se acepte', () => {
    const s = sintetico(
      { users: [usuario(U1), usuario(U2)] },
      [auditoriaDe('users', U1, null, {})],
      [],
    );
    esperarRechazo(() => planDe(s), 'SIN_AUDITORIA');
    const plan = planDe(s, true);
    expect(plan.informe.sin_auditoria_conservadas).toEqual([{ tabla: 'users', clave: U2 }]);
    expect(insertsDe(plan, 'users')[0]).toContain(U2);
    const v3 = plan.verificacion.find((v) => v.nombre === 'V3_fila_sin_auditoria_users');
    expect(v3?.sql).toContain(`NOT IN ('${U2}')`);
  });

  it('revierte una evidencia subida después del corte sin tocar su PK ni storage_key', () => {
    const evidencia = {
      id: U2,
      incident_id: U1,
      storage_key: 'evidencias/k',
      mime: 'image/jpeg',
      tamano_bytes: 10,
      sha256: 'a'.repeat(64),
      subido: 1,
      subido_at: DESPUES,
      created_at: ANTES,
      updated_at: DESPUES,
    };
    const antes = {
      ...evidencia,
      id: 'otro',
      storage_key: 'otra',
      subido: false,
      subido_at: null,
      updated_at: ANTES,
    };
    const s = sintetico(
      { evidences: [evidencia] },
      [auditoriaDe('evidences', U2, null, { ...antes, id: U2 })],
      [auditoriaDe('evidences', U2, antes, { ...evidencia, subido: true })],
    );
    const sql = insertsDe(planDe(s), 'evidences')[0] ?? '';
    expect(sql).toContain(
      `('${U2}', '${U1}', 'evidencias/k', 'image/jpeg', 10, '${'a'.repeat(64)}', 0, NULL, '${ANTES}', '${ANTES}')`,
    );
  });

  it('users conserva su valor más reciente y queda en revisar_seguridad', () => {
    const s = sintetico(
      { users: [usuario(U1, 0)] },
      [auditoriaDe('users', U1, null, { id: U1, activo: true })],
      [
        auditoriaDe(
          'users',
          U1,
          { id: U1, activo: true },
          { id: U1, activo: false },
          'usuario.editar',
        ),
      ],
    );
    const plan = planDe(s);
    expect(insertsDe(plan, 'users')[0]).toContain("'admin', 0, 0");
    expect(plan.informe.revisar_seguridad).toEqual([
      expect.objectContaining({ entidad_id: U1, tipo: 'cambios_tras_el_corte_conservados' }),
    ]);
  });

  it('excluye un usuario creado tras el corte, con sus cupos', () => {
    const cupo = {
      user_id: U2,
      origen: 'g',
      fallos: 1,
      ventana_inicio: DESPUES,
      bloqueado_hasta: null,
      reserva_id: 'r',
      created_at: DESPUES,
      updated_at: DESPUES,
    };
    const s = sintetico(
      { users: [usuario(U1), usuario(U2)], login_cupos: [cupo, { ...cupo, user_id: U1 }] },
      [auditoriaDe('users', U1, null, {})],
      [auditoriaDe('users', U2, null, { id: U2 }, 'usuario.crear')],
    );
    const plan = planDe(s);
    expect(plan.informe.tablas.users).toMatchObject({ excluidas: 1, importadas: 1 });
    expect(plan.informe.tablas.login_cupos).toMatchObject({ excluidas: 1, importadas: 1 });
    expect(plan.informe.revisar_seguridad[0]).toMatchObject({
      entidad_id: U2,
      tipo: 'creado_tras_el_corte_no_restaurado',
    });
  });

  it('recorta un payload_json que no cabe en una sentencia (no aplicada, anterior al corte)', () => {
    const fila = {
      mutation_id: U2,
      user_id: U1,
      device_id: DEV,
      tipo: 'consumo.crear',
      resultado: 'rechazada',
      respuesta_json: '{"resultado":"rechazada","code":"VALIDACION"}',
      payload_json: JSON.stringify({ payload: { id: U2 }, relleno: "'".repeat(60_000) }),
      procesada_at: ANTES,
      created_at: ANTES,
      updated_at: ANTES,
    };
    const dispositivo = {
      id: DEV,
      user_id: U1,
      instalacion_id: null,
      nombre: null,
      user_agent: null,
      ultimo_sync_at: null,
      created_at: ANTES,
      updated_at: ANTES,
    };
    const s = sintetico(
      { users: [usuario(U1)], devices: [dispositivo], sync_mutations: [fila] },
      [auditoriaDe('users', U1, null, {}), auditoriaDe('devices', DEV, null, {})],
      [],
    );
    const plan = planDe(s);
    const sql = insertsDe(plan, 'sync_mutations');
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('"recortado":true');
    expect(sql[0]).toContain(`"payload":{"id":"${U2}"}`);
    expect(plan.informe.tablas.sync_mutations?.recortadas).toBe(1);
    const codificador = new TextEncoder();
    expect(
      plan.restauracion.every((s2) => codificador.encode(s2).length <= MAX_BYTES_SENTENCIA),
    ).toBe(true);
  });

  it('los literales vuelven intactos de SQLite', async () => {
    const textos = [
      "comilla ' y '' doble",
      'barra \\ y "comillas"',
      'línea\nnueva\ttab',
      '🚧 ñandú',
      'nul\u0000medio',
      '',
    ];
    for (const texto of textos) {
      const fila = await env.DB.prepare(`SELECT ${literal(texto)} AS v`).first<{ v: string }>();
      expect(fila?.v).toBe(texto);
    }
    expect(literal(null)).toBe('NULL');
    expect(literal(0.1)).toBe('0.1');
    expect(() => literal(Number.NaN)).toThrow(ErrorRestauracion);
  });
});
