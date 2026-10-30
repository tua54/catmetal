// Auditoría (docs/spec.md §4): toda escritura de negocio inserta su fila de `audit_log` en el MISMO
// `db.batch()`. Estas funciones DEVUELVEN la sentencia preparada; nunca la ejecutan.
//
// Lista blanca por entidad: solo se guardan en `datos_antes`/`datos_despues` las columnas listadas.
// Un campo nuevo no se audita hasta que se agregue aquí, así un secreto (`password_hash`,
// `token_hash`, tokens, contraseñas) nunca llega a la auditoría por accidente.
//
// Convención de `entidad_id` (la comparte scripts/seed.mjs y la usa /sync/pull):
// - tablas con id propio: el `id` de la fila;
// - `order_supervisors`: `'<order_id>:<user_id>'`; `order_planned_materials`: `'<order_id>:<material_id>'`;
// - `settings`: la `clave`.
// Para eventos de sesión se usa la entidad `refresh_tokens` con el id del token afectado (en el
// logout por access token, sin cookie, el id de la familia).

import { ahoraIso, ALERTA_RELOJ_MS, esUuidV7, uuidv7 } from '@catmetal/shared';

export const COLUMNAS_AUDITABLES = {
  users: [
    'id',
    'nombre',
    // Sin 'email' (ADR 0013, H-11): un dato personal que la auditoría inmutable no puede rectificar
    // ni suprimir (Ley 1581). El id identifica al usuario.
    'rol',
    'activo',
    'intentos_fallidos',
    'bloqueado_hasta',
    'created_at',
    'updated_at',
    // Marca (no el valor) de que un admin restableció la contraseña.
    'password_restablecida',
  ],
  refresh_tokens: [
    'id',
    'user_id',
    'device_id',
    'familia_id',
    'expira_at',
    'revocado_at',
    'reemplazado_por',
  ],
  devices: ['id', 'user_id', 'nombre', 'user_agent', 'instalacion_id', 'ultimo_sync_at'],
  // Cupos de login (ADR 0018): sin IP, sin nonce y sin origen. `entidad_id` = user_id. Sin descriptor de
  // sync: estas filas nunca viajan por /sync/pull, y /audit solo se las muestra al admin.
  login_cupos: ['user_id', 'tipo', 'fallos', 'bloqueado_hasta'],
  // Entidades de negocio (Fase 2). Se listan todas aquí para que las tareas de consumos, novedades,
  // evidencias y validaciones no tengan que editar este archivo en paralelo.
  settings: ['clave', 'valor', 'actualizado_por', 'created_at', 'updated_at'],
  materials: [
    'id',
    'codigo',
    'nombre',
    'unidad',
    'costo_unitario_cop',
    'activo',
    'created_at',
    'updated_at',
  ],
  production_orders: [
    'id',
    'codigo',
    'linea',
    'estado',
    'fecha_inicio',
    'fecha_fin',
    'creada_por',
    'created_at',
    'updated_at',
    // Al finalizar: si se forzó con consumos pendientes y cuántos había (docs/spec.md §7).
    'force',
    'pendientes',
  ],
  order_supervisors: ['order_id', 'user_id', 'asignado_por', 'activo', 'created_at', 'updated_at'],
  order_planned_materials: [
    'order_id',
    'material_id',
    'cantidad_planeada',
    'unidad',
    'created_at',
    'updated_at',
  ],
  consumptions: [
    'id',
    'order_id',
    'material_id',
    'cantidad',
    'unidad',
    'cantidad_en_unidad_plan',
    'lote',
    'costo_unitario_cop_snapshot',
    'registrado_por',
    'device_id',
    'client_created_at',
    'server_received_at',
    'estado',
    'corrige_a',
    'registro_tardio',
    'requiere_novedad',
    'version',
    'created_at',
    'updated_at',
  ],
  incidents: [
    'id',
    'consumption_id',
    'tipo',
    'descripcion',
    'registrado_por',
    'client_created_at',
    'server_received_at',
    'created_at',
    'updated_at',
  ],
  // Sin `storage_key`: es interno y nunca se expone por la API (GET /audit la mostraría).
  evidences: [
    'id',
    'incident_id',
    'mime',
    'tamano_bytes',
    'sha256',
    'subido',
    'subido_at',
    'created_at',
    'updated_at',
  ],
  validations: [
    'id',
    'consumption_id',
    'decision',
    'motivo',
    'validado_por',
    'client_created_at',
    'server_received_at',
    'created_at',
    'updated_at',
  ],
} as const satisfies Record<string, readonly string[]>;

export type EntidadAuditada = keyof typeof COLUMNAS_AUDITABLES;

/**
 * Columnas booleanas de la lista blanca: en D1 son 0/1, en la auditoría se guardan como
 * `true/false`, igual que en la API y en el seed (ADR 0010, H13).
 */
export const COLUMNAS_BOOLEANAS: Readonly<Record<EntidadAuditada, readonly string[]>> = {
  users: ['activo'],
  refresh_tokens: [],
  devices: [],
  login_cupos: [],
  settings: [],
  materials: ['activo'],
  production_orders: ['force'],
  order_supervisors: ['activo'],
  order_planned_materials: [],
  consumptions: ['registro_tardio', 'requiere_novedad'],
  incidents: [],
  evidences: ['subido'],
  validations: [],
};

export type DatosAuditoria = Record<string, unknown>;

export interface EntradaAuditoria {
  /**
   * Id de la fila de auditoría; por defecto, un UUID v7 nuevo. Se fija cuando una sentencia
   * posterior del mismo batch debe depender de que ESTA fila se haya insertado.
   */
  id?: string;
  entidad: EntidadAuditada;
  entidad_id: string;
  accion: string;
  /** NULL en acciones del sistema. */
  actor_id: string | null;
  device_id: string | null;
  /**
   * Orden a la que pertenece la entidad (orden, asignación, plan, consumo, novedad, evidencia,
   * validación). Obligatorio para esas entidades (ADR 0010); NULL en las demás.
   */
  order_id?: string | null;
  antes?: DatosAuditoria | null;
  despues?: DatosAuditoria | null;
  /**
   * Hora de registro en el dispositivo (`client_created_at`), solo para la trazabilidad: NO se usa
   * para la alerta de reloj (ADR 0019).
   */
  client_at?: string | null;
  /** Hora del servidor; por defecto, ahora. */
  server_at?: string;
  /**
   * Alerta de reloj de la PETICIÓN que escribe esta fila: la hora del dispositivo al enviar
   * (`enviado_at` del push o `X-Hora-Dispositivo`) difiere de la del servidor al recibir en más de
   * 10 min (ADR 0019). Ausente (cron, mantenimiento, petición sin hora de envío) → 0.
   */
  alerta_reloj?: boolean;
}

/**
 * Condición SQL con sus parámetros: filtros de lectura y guardas de las sentencias principales.
 * NUNCA condiciona una auditoría ni una dependiente: para eso está `CondicionDeEscritura`.
 */
export interface CondicionSql {
  sql: string;
  parametros: readonly (string | number | null)[];
}

// ---------------------------------------------------------------------------------------------
// Marca de escritura (ADR 0028, A1)
// ---------------------------------------------------------------------------------------------
//
// La auditoría y las dependientes de una escritura condicional se condicionan a un valor que SOLO
// la sentencia principal de este batch pudo escribir, nunca a una coincidencia de horas o valores
// (dos peticiones pueden calcular el mismo `ahora`). `CondicionDeEscritura` es un tipo opaco: solo
// lo crean los cuatro constructores de abajo, y los helpers lo comprueban también en ejecución.

export type Parametro = string | number | null;

declare const MARCA_TIPO: unique symbol;

/** Condición "la principal de este batch aplicó". Solo la crean `porMarca`, `porPkNueva`, `porReserva` y `porAuditoria`. */
export interface CondicionDeEscritura {
  readonly [MARCA_TIPO]: 'CondicionDeEscritura';
  readonly tipo: 'marca' | 'pk_nueva' | 'reserva' | 'auditoria';
  readonly sql: string;
  readonly parametros: readonly Parametro[];
}

/** Marcador que `sentenciaDependiente` sustituye por la condición. */
export const MARCADOR_CONDICION = '{condicion_de_escritura}';

/** Tablas con la columna `escritura_id` (migración 0009). */
export const TABLAS_CON_MARCA = [
  'users',
  'refresh_tokens',
  'settings',
  'materials',
  'production_orders',
  'order_supervisors',
  'order_planned_materials',
  'consumptions',
  'incidents',
  'evidences',
  'validations',
] as const;
export type TablaConMarca = (typeof TABLAS_CON_MARCA)[number];

/** Tablas cuya clave primaria la genera el servidor (nunca el cliente) en la misma sentencia. */
export type TablaConPkDelServidor = 'refresh_tokens' | 'materials' | 'users';
const PK_DEL_SERVIDOR: Readonly<Record<TablaConPkDelServidor, readonly string[]>> = {
  refresh_tokens: ['id'],
  materials: ['id'],
  users: ['id'],
};

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;
const CREADAS = new WeakSet<object>();

function crear(
  tipo: CondicionDeEscritura['tipo'],
  sql: string,
  parametros: readonly Parametro[],
): CondicionDeEscritura {
  const condicion = Object.freeze({ tipo, sql, parametros: Object.freeze([...parametros]) });
  CREADAS.add(condicion);
  return condicion as unknown as CondicionDeEscritura;
}

/** Comprobación en ejecución: la condición salió de un constructor (no es un literal `{ sql }`). */
export function exigirCondicionDeEscritura(condicion: CondicionDeEscritura): void {
  if (typeof condicion !== 'object' || !CREADAS.has(condicion)) {
    throw new Error(
      'La condición de una auditoría o dependiente debe ser una CondicionDeEscritura',
    );
  }
}

function exigirUuid(valor: string, que: string): void {
  if (!esUuidV7(valor)) {
    throw new Error(`${que} debe ser un UUID v7 generado por el servidor`);
  }
}

function filtroClave(clave: Readonly<Record<string, Parametro>>): {
  sql: string;
  parametros: Parametro[];
} {
  const columnas = Object.keys(clave);
  if (columnas.length === 0) {
    throw new Error('La clave de una condición de escritura no puede estar vacía');
  }
  const parametros = columnas.map((columna) => {
    const valor = clave[columna];
    if (!IDENTIFICADOR.test(columna) || valor === null || valor === undefined) {
      throw new Error(`Clave inválida en una condición de escritura: ${columna}`);
    }
    return valor;
  });
  return { sql: columnas.map((c) => `${c} = ?`).join(' AND '), parametros };
}

/** Marca nueva para la sentencia principal de una escritura auditada (UUID v7). */
export function nuevaMarca(): string {
  return uuidv7();
}

/**
 * La fila (o filas) de `tabla` con `clave` tienen `escritura_id = escrituraId`: la marca que fijó
 * la principal de este batch. `clave` no tiene por qué ser la PK (la revocación de una familia usa
 * `familia_id`); sirve para que la búsqueda use un índice.
 */
export function porMarca(
  tabla: TablaConMarca,
  clave: Readonly<Record<string, Parametro>>,
  escrituraId: string,
): CondicionDeEscritura {
  if (!(TABLAS_CON_MARCA as readonly string[]).includes(tabla)) {
    throw new Error(`Tabla sin marca de escritura: ${String(tabla)}`);
  }
  exigirUuid(escrituraId, 'La marca de escritura');
  const filtro = filtroClave(clave);
  return crear(
    'marca',
    `EXISTS (SELECT 1 FROM ${tabla} WHERE ${filtro.sql} AND escritura_id = ?)`,
    [...filtro.parametros, escrituraId],
  );
}

/**
 * Existe la fila con esta clave primaria, que el SERVIDOR generó (UUID v7 nuevo) y que solo la
 * principal de este batch inserta. Nunca un id que manda el cliente (consumos, novedades,
 * validaciones, órdenes): ese id puede repetirse en otra petición.
 */
export function porPkNueva(tabla: TablaConPkDelServidor, id: string): CondicionDeEscritura {
  const pk = PK_DEL_SERVIDOR[tabla];
  exigirUuid(id, 'La clave primaria nueva');
  return crear(
    'pk_nueva',
    `EXISTS (SELECT 1 FROM ${tabla} WHERE ${pk.map((c) => `${c} = ?`).join(' AND ')})`,
    [id],
  );
}

/**
 * La fila de `login_cupos` del usuario (y del `origen`, si se indica) quedó con `reserva_id =
 * reservaId`, que fijó la principal de este batch (ADR 0018). `bloqueada`: además, esa misma
 * escritura dejó un bloqueo.
 */
export function porReserva(
  userId: string,
  origen: string | null,
  reservaId: string,
  opciones: { bloqueada?: boolean } = {},
): CondicionDeEscritura {
  exigirUuid(reservaId, 'La reserva');
  const partes = ['user_id = ?'];
  const parametros: Parametro[] = [userId];
  if (origen !== null) {
    partes.push('origen = ?');
    parametros.push(origen);
  }
  partes.push('reserva_id = ?');
  parametros.push(reservaId);
  if (opciones.bloqueada === true) {
    partes.push('bloqueado_hasta IS NOT NULL');
  }
  return crear(
    'reserva',
    `EXISTS (SELECT 1 FROM login_cupos WHERE ${partes.join(' AND ')})`,
    parametros,
  );
}

/**
 * Existe la fila de auditoría `auditoriaId` (UUID v7 fijado en `EntradaAuditoria.id`), que solo se
 * inserta si la principal de este batch aplicó: encadena las dependientes a esa auditoría.
 */
export function porAuditoria(auditoriaId: string): CondicionDeEscritura {
  exigirUuid(auditoriaId, 'El id de la auditoría');
  return crear('auditoria', 'EXISTS (SELECT 1 FROM audit_log WHERE id = ?)', [auditoriaId]);
}

function normalizarBooleano(valor: unknown): unknown {
  if (valor === 1 || valor === true) {
    return true;
  }
  if (valor === 0 || valor === false) {
    return false;
  }
  return valor;
}

/** Copia solo las columnas de la lista blanca de la entidad y normaliza sus booleanos. */
export function filtrarDatos(
  entidad: EntidadAuditada,
  datos: DatosAuditoria | null | undefined,
): DatosAuditoria | null {
  if (datos === null || datos === undefined) {
    return null;
  }
  const permitidas: readonly string[] = COLUMNAS_AUDITABLES[entidad];
  const booleanas = COLUMNAS_BOOLEANAS[entidad];
  return Object.fromEntries(
    Object.entries(datos)
      .filter(([clave, valor]) => permitidas.includes(clave) && valor !== undefined)
      .map(([clave, valor]) => [
        clave,
        booleanas.includes(clave) ? normalizarBooleano(valor) : valor,
      ]),
  );
}

/**
 * `alerta_reloj` de una petición (ADR 0019): la hora del dispositivo AL ENVIAR difiere de la del
 * servidor al recibir en más de 10 min. Sin hora de envío (cliente viejo o formato inválido) →
 * false. Se calcula una vez por petición y se aplica a todas sus filas de auditoría.
 */
export function calcularAlertaReloj(
  enviadoAt: string | null | undefined,
  recibidoAt: string,
): boolean {
  if (enviadoAt === null || enviadoAt === undefined) {
    return false;
  }
  const diferencia = Math.abs(Date.parse(enviadoAt) - Date.parse(recibidoAt));
  return Number.isFinite(diferencia) && diferencia > ALERTA_RELOJ_MS;
}

const COLUMNAS_INSERT =
  'id, entidad, entidad_id, accion, order_id, actor_id, device_id, datos_antes, datos_despues, client_at, server_at, alerta_reloj, created_at, updated_at';
const MARCADORES = Array.from({ length: 14 }, () => '?').join(', ');

function valores(entrada: EntradaAuditoria): (string | number | null)[] {
  if (!Object.hasOwn(COLUMNAS_AUDITABLES, entrada.entidad)) {
    throw new Error(`Entidad sin lista blanca de auditoría: ${String(entrada.entidad)}`);
  }
  const serverAt = entrada.server_at ?? ahoraIso();
  const antes = filtrarDatos(entrada.entidad, entrada.antes);
  const despues = filtrarDatos(entrada.entidad, entrada.despues);
  return [
    entrada.id ?? uuidv7(),
    entrada.entidad,
    entrada.entidad_id,
    entrada.accion,
    entrada.order_id ?? null,
    entrada.actor_id,
    entrada.device_id,
    antes === null ? null : JSON.stringify(antes),
    despues === null ? null : JSON.stringify(despues),
    entrada.client_at ?? null,
    serverAt,
    entrada.alerta_reloj === true ? 1 : 0,
    serverAt,
    serverAt,
  ];
}

/** Sentencia de auditoría para incluir en el mismo `db.batch()` que la escritura auditada. */
export function sentenciaAuditoria(db: D1Database, entrada: EntradaAuditoria): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (${COLUMNAS_INSERT}) VALUES (${MARCADORES})`)
    .bind(...valores(entrada));
}

/**
 * Variante condicional: `INSERT INTO audit_log (…) SELECT … WHERE <condición>`. La fila solo se
 * inserta si la sentencia principal de ESTE batch escribió su marca (ADR 0028). Va DESPUÉS de la
 * principal y antes de cualquier otra sentencia del batch que reescriba la marca de esa misma fila
 * (regla de orden).
 */
export function sentenciaAuditoriaCondicional(
  db: D1Database,
  entrada: EntradaAuditoria,
  condicion: CondicionDeEscritura,
): D1PreparedStatement {
  exigirCondicionDeEscritura(condicion);
  return db
    .prepare(
      `INSERT INTO audit_log (${COLUMNAS_INSERT}) SELECT ${MARCADORES} WHERE ${condicion.sql}`,
    )
    .bind(...valores(entrada), ...condicion.parametros);
}

/**
 * Sentencia DEPENDIENTE de una escritura (fila hija, revocación de sesiones, reinicio de cupos,
 * fila `aplicada` de `sync_mutations`…): solo escribe si la principal de este batch aplicó.
 * `sql` debe terminar con `MARCADOR_CONDICION` (en un `WHERE` o tras un `AND`), una sola vez;
 * se sustituye por la condición, cuyos parámetros se enlazan después de `parametros`.
 */
export function sentenciaDependiente(
  db: D1Database,
  sql: string,
  parametros: readonly Parametro[],
  condicion: CondicionDeEscritura,
): D1PreparedStatement {
  exigirCondicionDeEscritura(condicion);
  const texto = sql.trimEnd();
  if (
    !texto.endsWith(MARCADOR_CONDICION) ||
    texto.indexOf(MARCADOR_CONDICION) !== texto.length - MARCADOR_CONDICION.length
  ) {
    throw new Error(
      `Una sentencia dependiente debe terminar con ${MARCADOR_CONDICION}, una sola vez`,
    );
  }
  return db
    .prepare(`${texto.slice(0, -MARCADOR_CONDICION.length)}${condicion.sql}`)
    .bind(...parametros, ...condicion.parametros);
}
