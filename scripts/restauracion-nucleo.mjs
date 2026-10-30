// Núcleo de la restauración del backup de R2 (ADR 0021). Puro: sin módulos de Node, para que lo
// importen tanto el CLI (scripts/restaurar-backup.mjs) como la prueba del Worker
// (apps/worker/test/fase6-restauracion.test.ts), que ejecuta el SQL contra una D1 local real.
//
// Qué hace: a partir del manifest (`formato: 2`) y de las filas de cada NDJSON, leídas EN STREAMING
// (revisión de esquema R-01: nunca se arma una tabla ni el SQL en un solo texto), reconstruye el
// estado EXACTO de la base en la marca de corte `C = manifest.corte.seq`:
// - lo creado después del corte (su primera auditoría es posterior a C) se excluye;
// - lo modificado después del corte, en las tablas cuya auditoría guarda la fila completa, se
//   revierte con el `datos_antes` de su primera auditoría posterior a C;
// - `users` y `devices` (auditoría parcial) conservan su valor exportado, el más reciente;
// - `sync_mutations` aplicadas solo se conservan si su efecto existe; las no aplicadas, solo si se
//   procesaron más de 15 min antes del corte (las demás van al informe);
// - `login_cupos` no viaja al backup (S-06, ADR 0018): la base restaurada empieza sin cupos; si un
//   manifest anterior la trae, se ignora. `refresh_tokens` NO se restaura (todos inician sesión otra vez);
// - `audit_log` se importa hasta C.
//
// Entrega el SQL de restauración sentencia por sentencia (con guardia, borrado y recreación de los
// triggers) y devuelve el SQL de verificación (legible, cada consulta debe devolver 0 filas, y la
// versión que falla sola, R-02), el SQL posterior (cambio de época) y el informe. Nunca usa DELETE: las semillas de la migración 0002 se sobrescriben con un upsert.

/** Máximo de bytes por sentencia (el límite documentado de D1 es de 100 KB por sentencia). */
export const MAX_BYTES_SENTENCIA = 90_000;
/** Máximo de filas por INSERT. */
export const MAX_FILAS_SENTENCIA = 100;
/** Margen entre la hora del corte y la de proceso de una mutación no aplicada (ADR 0021, 4.3). */
export const MARGEN_NO_APLICADAS_MS = 15 * 60_000;
/** Tablas que pueden faltar en un backup `parcial` sin impedir la restauración. */
export const INCOMPLETAS_ADMITIDAS = ['sync_mutations', 'refresh_tokens'];
/**
 * Tablas del esquema que el backup NO exporta (`TABLAS_EXCLUIDAS_BACKUP` de
 * apps/worker/src/cron/tablas.ts). Nunca se importan: quedan vacías, y la verificación V9 lo exige.
 */
export const NO_EXPORTADAS = ['login_cupos'];

const M = ['created_at', 'updated_at'];

/**
 * Descripción de cada tabla. Debe coincidir con `TABLAS_BACKUP` (columnas y PK) y con
 * `COLUMNAS_AUDITABLES` / `COLUMNAS_BOOLEANAS` de apps/worker/src/auditoria/auditar.ts: la prueba
 * de restauración lo verifica.
 *
 * Clases (ADR 0021, 4):
 * - `revertible`: la auditoría guarda la fila completa (salvo `inmutables`); se revierte al corte.
 * - `ultimo_valor`: auditoría parcial; se excluye si se creó tras el corte, si no se conserva.
 * - `operativa`: sin auditoría por fila (reglas propias).
 * - `no_restaurada`: `refresh_tokens`.
 */
export const TABLAS = {
  users: {
    clase: 'ultimo_valor',
    pk: ['id'],
    columnas: [
      'id',
      'nombre',
      'email',
      'password_hash',
      'rol',
      'activo',
      'intentos_fallidos',
      'bloqueado_hasta',
      ...M,
    ],
    booleanas: ['activo'],
  },
  materials: {
    clase: 'revertible',
    pk: ['id'],
    columnas: ['id', 'codigo', 'nombre', 'unidad', 'costo_unitario_cop', 'activo', ...M],
    booleanas: ['activo'],
  },
  production_orders: {
    clase: 'revertible',
    pk: ['id'],
    columnas: ['id', 'codigo', 'linea', 'estado', 'fecha_inicio', 'fecha_fin', 'creada_por', ...M],
    booleanas: [],
  },
  settings: {
    clase: 'revertible',
    pk: ['clave'],
    columnas: ['clave', 'valor', 'actualizado_por', ...M],
    booleanas: [],
    /** La auditoría guarda el JSON ya parseado (`json(valor)`): se vuelve a texto JSON. */
    json: ['valor'],
  },
  devices: {
    clase: 'ultimo_valor',
    pk: ['id'],
    columnas: ['id', 'user_id', 'instalacion_id', 'nombre', 'user_agent', 'ultimo_sync_at', ...M],
    booleanas: [],
  },
  refresh_tokens: {
    clase: 'no_restaurada',
    pk: ['id'],
    columnas: [
      'id',
      'user_id',
      'device_id',
      'token_hash',
      'familia_id',
      'expira_at',
      'revocado_at',
      'reemplazado_por',
      ...M,
    ],
    booleanas: [],
  },
  order_supervisors: {
    clase: 'revertible',
    pk: ['order_id', 'user_id'],
    columnas: ['order_id', 'user_id', 'asignado_por', 'activo', ...M],
    booleanas: ['activo'],
  },
  order_planned_materials: {
    clase: 'revertible',
    pk: ['order_id', 'material_id'],
    columnas: ['order_id', 'material_id', 'cantidad_planeada', 'unidad', ...M],
    booleanas: [],
  },
  consumptions: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
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
      ...M,
    ],
    booleanas: ['registro_tardio', 'requiere_novedad'],
  },
  incidents: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
      'id',
      'consumption_id',
      'tipo',
      'descripcion',
      'registrado_por',
      'client_created_at',
      'server_received_at',
      ...M,
    ],
    booleanas: [],
  },
  evidences: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
      'id',
      'incident_id',
      'storage_key',
      'mime',
      'tamano_bytes',
      'sha256',
      'subido',
      'subido_at',
      ...M,
    ],
    booleanas: ['subido'],
    /** Fuera de la auditoría e inmutable (`evidences_inmutable`): nunca se revierte ni se compara. */
    inmutables: ['storage_key'],
  },
  validations: {
    clase: 'revertible',
    pk: ['id'],
    columnas: [
      'id',
      'consumption_id',
      'decision',
      'motivo',
      'validado_por',
      'client_created_at',
      'server_received_at',
      ...M,
    ],
    booleanas: [],
  },
  sync_mutations: {
    clase: 'operativa',
    pk: ['mutation_id'],
    columnas: [
      'mutation_id',
      'user_id',
      'device_id',
      'tipo',
      'resultado',
      'respuesta_json',
      'payload_json',
      'procesada_at',
      ...M,
    ],
    booleanas: [],
  },
  audit_log: {
    clase: 'operativa',
    pk: ['seq'],
    columnas: [
      'seq',
      'id',
      'entidad',
      'entidad_id',
      'accion',
      'actor_id',
      'device_id',
      'datos_antes',
      'datos_despues',
      'client_at',
      'server_at',
      'alerta_reloj',
      ...M,
      'order_id',
    ],
    booleanas: [],
  },
};

/** Orden de importación: padres primero (ADR 0021, 5). `refresh_tokens` no se importa. */
export const ORDEN_IMPORTACION = [
  'users',
  'materials',
  'production_orders',
  'settings',
  'devices',
  'order_supervisors',
  'order_planned_materials',
  'consumptions',
  'incidents',
  'evidences',
  'validations',
  'sync_mutations',
  'audit_log',
];

/** Tablas que se excluyen o revierten según su auditoría (V3, V10 y código de salida 3). */
export const TABLAS_AUDITADAS = Object.keys(TABLAS).filter((t) =>
  ['revertible', 'ultimo_valor'].includes(TABLAS[t].clase),
);

export class ErrorRestauracion extends Error {
  /**
   * @param {'INTEGRIDAD' | 'SIN_AUDITORIA'} codigo
   * @param {string} mensaje
   * @param {unknown} [detalle]
   */
  constructor(codigo, mensaje, detalle) {
    super(mensaje);
    this.name = 'ErrorRestauracion';
    this.codigo = codigo;
    this.detalle = detalle ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// Triggers esperados (desde las migraciones)
// ---------------------------------------------------------------------------------------------

const PATRON_CREAR_TRIGGER = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_]+)/i;
const PATRON_BORRAR_TRIGGER = /^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_]+)/i;

function nombreBase(ruta) {
  return ruta.replaceAll('\\', '/').split('/').at(-1) ?? ruta;
}

/** Sentencia sin líneas iniciales en blanco o de comentario, sin espacios en los extremos ni `;`. */
function limpiarSentencia(trozo) {
  const lineas = trozo.split(/\r?\n/);
  while (lineas.length > 0 && (lineas[0].trim() === '' || lineas[0].trim().startsWith('--'))) {
    lineas.shift();
  }
  let texto = lineas.join('\n').trim();
  while (texto.endsWith(';')) {
    texto = texto.slice(0, -1).trimEnd();
  }
  return texto;
}

/**
 * Triggers vigentes después de aplicar, en orden, las migraciones `.sql` cuyo nombre es ≤ `hasta`
 * (`d1_migrations.name`, por ejemplo `0007_login_cupos.sql`). Cada archivo se parte por el marcador
 * `--> statement-breakpoint` de drizzle-kit. Devuelve los triggers en orden de creación.
 *
 * @param {{ nombre: string; contenido: string }[]} archivos
 * @param {string} hasta
 * @returns {{ nombre: string; sql: string }[]}
 */
export function triggersDeMigraciones(archivos, hasta) {
  const vigentes = new Map();
  const migraciones = archivos
    .map((a) => ({ nombre: nombreBase(a.nombre), contenido: a.contenido }))
    .filter((a) => a.nombre.endsWith('.sql') && a.nombre <= hasta)
    .sort((x, y) => (x.nombre < y.nombre ? -1 : x.nombre > y.nombre ? 1 : 0));
  for (const migracion of migraciones) {
    for (const trozo of migracion.contenido.split('--> statement-breakpoint')) {
      const sentencia = limpiarSentencia(trozo);
      const creado = PATRON_CREAR_TRIGGER.exec(sentencia);
      if (creado !== null) {
        vigentes.delete(creado[1]);
        vigentes.set(creado[1], sentencia);
        continue;
      }
      const borrado = PATRON_BORRAR_TRIGGER.exec(sentencia);
      if (borrado !== null) {
        vigentes.delete(borrado[1]);
      }
    }
  }
  return [...vigentes].map(([nombre, sql]) => ({ nombre, sql }));
}

/** Filas de un NDJSON (una fila JSON por línea; líneas vacías ignoradas). */
export function filasDeNdjson(texto) {
  return texto
    .split('\n')
    .filter((linea) => linea.trim() !== '')
    .map((linea) => JSON.parse(linea));
}

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

const codificador = new TextEncoder();

function bytesUtf8(texto) {
  return codificador.encode(texto).length;
}

/** Literal SQL de un valor de una fila (texto, número o NULL). */
export function literal(valor) {
  if (valor === null || valor === undefined) {
    return 'NULL';
  }
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) {
      throw new ErrorRestauracion('INTEGRIDAD', `Número no finito en el backup: ${String(valor)}`);
    }
    return String(valor);
  }
  if (typeof valor === 'boolean') {
    return valor ? '1' : '0';
  }
  if (typeof valor === 'string') {
    // Un NUL dentro de un literal cortaría la sentencia: ese texto va como blob hexadecimal.
    if (valor.includes('\u0000')) {
      const hex = Array.from(codificador.encode(valor), (b) => b.toString(16).padStart(2, '0'));
      return `CAST(X'${hex.join('')}' AS TEXT)`;
    }
    return `'${valor.replaceAll("'", "''")}'`;
  }
  throw new ErrorRestauracion(
    'INTEGRIDAD',
    `Tipo de valor no admitido en el backup: ${typeof valor}`,
  );
}

function claveDe(tabla, fila) {
  return TABLAS[tabla].pk.map((columna) => String(fila[columna])).join(':');
}

/** Expresión SQL de la clave de auditoría (`entidad_id`) de una fila de la tabla con alias `r`. */
function expresionClave(tabla) {
  return TABLAS[tabla].pk.map((columna) => `r.${columna}`).join(" || ':' || ");
}

function indiceAuditoria(entidad, entidadId) {
  return `${entidad}\u0000${entidadId}`;
}

function tuplaDe(tabla, fila) {
  return `(${TABLAS[tabla].columnas.map((c) => literal(fila[c])).join(', ')})`;
}

/**
 * Arma `INSERT` de varias filas a medida que llegan y los entrega a `escribir` en cuanto se llenan
 * (`MAX_FILAS_SENTENCIA` filas o `MAX_BYTES_SENTENCIA` bytes): nunca guarda más de una sentencia.
 */
class Insertador {
  constructor(tabla, escribir, upsert = false) {
    const columnas = TABLAS[tabla].columnas;
    this.tabla = tabla;
    this.escribir = escribir;
    this.cabecera = `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES\n`;
    this.cola = upsert
      ? `\nON CONFLICT (${TABLAS[tabla].pk.join(', ')}) DO UPDATE SET ${columnas
          .filter((c) => !TABLAS[tabla].pk.includes(c))
          .map((c) => `${c} = excluded.${c}`)
          .join(', ')}`
      : '';
    this.fijo = bytesUtf8(this.cabecera) + bytesUtf8(this.cola);
    this.grupo = [];
    this.bytes = this.fijo;
  }

  /** ¿Cabe la fila sola en una sentencia? */
  cabe(fila) {
    return this.fijo + bytesUtf8(tuplaDe(this.tabla, fila)) + 2 <= MAX_BYTES_SENTENCIA;
  }

  async agregar(fila) {
    const tupla = tuplaDe(this.tabla, fila);
    const tamano = bytesUtf8(tupla) + 2;
    if (this.fijo + tamano > MAX_BYTES_SENTENCIA) {
      throw new ErrorRestauracion(
        'INTEGRIDAD',
        `Una fila de ${this.tabla} no cabe en una sentencia de ${String(MAX_BYTES_SENTENCIA)} bytes`,
        { tabla: this.tabla, clave: claveDe(this.tabla, fila) },
      );
    }
    if (this.grupo.length >= MAX_FILAS_SENTENCIA || this.bytes + tamano > MAX_BYTES_SENTENCIA) {
      await this.cerrar();
    }
    this.grupo.push(tupla);
    this.bytes += tamano;
  }

  async cerrar() {
    if (this.grupo.length > 0) {
      const sentencia = `${this.cabecera}${this.grupo.join(',\n')}${this.cola}`;
      this.grupo = [];
      this.bytes = this.fijo;
      await this.escribir(sentencia);
    }
  }
}

const PATRON_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `payload_json` reducido de una mutación no aplicada (mismo formato que la ADR 0020). */
function payloadRecortado(fila) {
  let payload = {};
  try {
    const original = JSON.parse(String(fila.payload_json));
    const p = original !== null && typeof original === 'object' ? original.payload : null;
    if (p !== null && typeof p === 'object') {
      for (const clave of ['id', 'consumption_id']) {
        if (typeof p[clave] === 'string' && PATRON_UUID_V7.test(p[clave])) {
          payload[clave] = p[clave];
        }
      }
    }
  } catch {
    payload = {};
  }
  return JSON.stringify({
    recortado: true,
    motivo: 'no cabe en una sentencia de la restauración',
    tamano_bytes: bytesUtf8(String(fila.payload_json)),
    tipo: String(fila.tipo).slice(0, 64),
    payload,
  });
}

/**
 * `respuesta_json` reducida de una mutación no aplicada (R-10): conserva `resultado` y `code`, que
 * es lo que devuelve un reenvío; el mensaje y el estado del servidor se pierden.
 */
function respuestaRecortada(fila) {
  const respuesta = objetoJson(fila.respuesta_json) ?? {};
  return JSON.stringify({
    resultado: typeof respuesta.resultado === 'string' ? respuesta.resultado : fila.resultado,
    ...(typeof respuesta.code === 'string' ? { code: respuesta.code.slice(0, 64) } : {}),
    recortada: true,
    tamano_bytes: bytesUtf8(String(fila.respuesta_json)),
  });
}

// ---------------------------------------------------------------------------------------------
// Validación del manifest
// ---------------------------------------------------------------------------------------------

function validarManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || manifest.formato !== 2) {
    throw new ErrorRestauracion(
      'INTEGRIDAD',
      'El backup no es de formato 2 (ADR 0021): no tiene marca de corte y no se restaura con este script',
    );
  }
  const corte = manifest.corte;
  if (
    corte === null ||
    typeof corte !== 'object' ||
    !Number.isInteger(corte.seq) ||
    typeof corte.at !== 'string' ||
    Number.isNaN(Date.parse(corte.at)) ||
    !Number.isInteger(manifest.seq_final) ||
    corte.seq > manifest.seq_final
  ) {
    throw new ErrorRestauracion(
      'INTEGRIDAD',
      'Marca de corte o seq_final inválidos en el manifest',
    );
  }
  if (typeof manifest.ultima_migracion !== 'string' || manifest.ultima_migracion === '') {
    throw new ErrorRestauracion('INTEGRIDAD', 'El manifest no indica la última migración');
  }
  const entradas = new Map((manifest.tablas ?? []).map((t) => [t.tabla, t]));
  for (const tabla of Object.keys(TABLAS)) {
    const entrada = entradas.get(tabla);
    if (entrada === undefined) {
      throw new ErrorRestauracion('INTEGRIDAD', `El manifest no lista la tabla ${tabla}`);
    }
    if (entrada.estado === 'incompleta') {
      if (!INCOMPLETAS_ADMITIDAS.includes(tabla)) {
        throw new ErrorRestauracion(
          'INTEGRIDAD',
          `La tabla ${tabla} quedó incompleta en este backup: use otro día`,
          { tabla, motivo: entrada.motivo },
        );
      }
      continue;
    }
    if (entrada.estado !== 'completa' || !Number.isInteger(entrada.filas)) {
      throw new ErrorRestauracion('INTEGRIDAD', `Estado o conteo inválido de la tabla ${tabla}`);
    }
  }
  return entradas;
}

// ---------------------------------------------------------------------------------------------
// Reconciliación en streaming
// ---------------------------------------------------------------------------------------------

/** Valor de la auditoría convertido al de la columna (booleanos y JSON). */
function valorDeAuditoria(tabla, columna, valor) {
  const definicion = TABLAS[tabla];
  if (definicion.booleanas.includes(columna) && typeof valor === 'boolean') {
    return valor ? 1 : 0;
  }
  if ((definicion.json ?? []).includes(columna)) {
    return JSON.stringify(valor);
  }
  return valor;
}

function objetoJson(texto) {
  if (typeof texto !== 'string') {
    return null;
  }
  try {
    const valor = JSON.parse(texto);
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
  } catch {
    return null;
  }
}

/** Máximo de claves sin auditoría que se listan en el error o en el informe (más el total). */
const MAX_LISTA_SIN_AUDITORIA = 1000;

function accionesDe(post) {
  return post.map((a) => ({
    seq: a.seq,
    accion: a.accion,
    actor_id: a.actor_id,
    server_at: a.server_at,
  }));
}

/**
 * Restauración en streaming (ADR 0021; revisión de esquema R-01). Lee cada tabla con
 * `leerTabla(tabla)` (un iterable asíncrono de filas en el orden del NDJSON; `audit_log` se lee dos
 * veces: primero para indexar y al final para importar) y entrega cada sentencia SQL, en orden, a
 * `await escribir(sentencia)` en cuanto está lista. Solo guarda en memoria los índices que necesita
 * la reconciliación (claves auditadas hasta el corte, las auditorías posteriores al corte y los ids
 * y versiones de lo restaurado), nunca las filas completas.
 *
 * Si lanza `ErrorRestauracion`, lo ya escrito no sirve y debe descartarse.
 *
 * @param {{
 *   manifest: any;
 *   triggers: { nombre: string; sql: string }[];
 *   leerTabla: (tabla: string) => AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>;
 *   escribir: (sentencia: string) => Promise<void>;
 *   conservarSinAuditoria?: boolean;
 *   omitirSyncMutations?: boolean;
 * }} entrada
 */
export async function restaurarEnStreaming(entrada) {
  const { manifest, triggers, leerTabla, escribir } = entrada;
  const entradas = validarManifest(manifest);
  const C = manifest.corte.seq;
  const S = manifest.seq_final;
  const corteMs = Date.parse(manifest.corte.at);
  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new ErrorRestauracion('INTEGRIDAD', 'No hay triggers esperados (¿migraciones vacías?)');
  }
  const completa = (tabla) => entradas.get(tabla)?.estado === 'completa';
  const omitirSync = entrada.omitirSyncMutations === true || !completa('sync_mutations');

  /** Recorre una tabla comprobando que trae exactamente las filas del manifest. */
  async function* filasDe(tabla) {
    if (!completa(tabla)) {
      return;
    }
    let n = 0;
    for await (const fila of leerTabla(tabla)) {
      n += 1;
      yield fila;
    }
    if (n !== entradas.get(tabla).filas) {
      throw new ErrorRestauracion(
        'INTEGRIDAD',
        `Las filas de ${tabla} (${String(n)}) no coinciden con el manifest (${String(entradas.get(tabla).filas)})`,
      );
    }
  }

  const informe = {
    fecha: manifest.fecha,
    corte: manifest.corte,
    seq_final: S,
    tablas: {},
    sync_mutations: {
      aplicadas_conservadas: 0,
      aplicadas_sin_efecto_descartadas: 0,
      aplicadas_demasiado_grandes_descartadas: 0,
      no_aplicadas_conservadas: 0,
      no_aplicadas_descartadas: 0,
      tabla_omitida: omitirSync,
      omitida_por_opcion: entrada.omitirSyncMutations === true,
    },
    refresh_tokens_omitidos: completa('refresh_tokens')
      ? Number(entradas.get('refresh_tokens').filas)
      : 0,
    // S-06: siempre; un manifest anterior que la traiga se ignora.
    login_cupos_omitida: true,
    cambios_tras_el_corte: [],
    rechazos_tras_el_corte: [],
    revisar_seguridad: [],
    sin_auditoria_conservadas: [],
    sin_auditoria_total: 0,
  };
  const contar = (tabla) => {
    informe.tablas[tabla] ??= {
      exportadas: 0,
      importadas: 0,
      excluidas: 0,
      revertidas: 0,
      conservadas_mas_recientes: 0,
      recortadas: 0,
      sin_auditoria_conservadas: 0,
    };
    return informe.tablas[tabla];
  };

  // 1. Índice de auditoría (primera lectura de audit_log): claves hasta el corte y, de lo posterior
  //    al corte, solo lo que usan la reversión y el informe.
  const antesDelCorte = new Set();
  const despuesDelCorte = new Map();
  {
    let esperado = 1;
    for await (const fila of filasDe('audit_log')) {
      if (fila.seq !== esperado) {
        throw new ErrorRestauracion(
          'INTEGRIDAD',
          `audit_log no tiene exactamente los seq 1..${String(S)} en orden (backup corrupto)`,
        );
      }
      esperado += 1;
      const indice = indiceAuditoria(fila.entidad, fila.entidad_id);
      if (fila.seq <= C) {
        antesDelCorte.add(indice);
        continue;
      }
      const resumen = {
        seq: fila.seq,
        entidad: fila.entidad,
        entidad_id: fila.entidad_id,
        accion: fila.accion,
        actor_id: fila.actor_id,
        server_at: fila.server_at,
      };
      informe.cambios_tras_el_corte.push(resumen);
      const lista = despuesDelCorte.get(indice) ?? [];
      lista.push({ ...resumen, datos_antes: fila.datos_antes });
      despuesDelCorte.set(indice, lista);
    }
    if (esperado - 1 !== S) {
      throw new ErrorRestauracion(
        'INTEGRIDAD',
        `audit_log no tiene exactamente los seq 1..${String(S)} (backup corrupto)`,
      );
    }
  }

  // 2. Guardia y borrado de triggers.
  for (const sentencia of sqlInicio(manifest, triggers)) {
    await escribir(sentencia);
  }

  // 3. Tablas auditadas: excluir lo creado tras el corte, revertir lo modificado (si es revertible).
  const sinAuditoria = [];
  const usuarios = new Set();
  const dispositivos = new Set();
  const versiones = new Map();
  const novedades = new Set();
  const validaciones = new Set();
  const correccionesPendientes = [];
  for (const tabla of ORDEN_IMPORTACION.filter((t) => TABLAS_AUDITADAS.includes(t))) {
    const definicion = TABLAS[tabla];
    const cuenta = contar(tabla);
    const insertador = new Insertador(tabla, escribir, tabla === 'settings');
    const conservar = async (fila) => {
      let salida = fila;
      if (tabla === 'consumptions') {
        // Sin ordenar en memoria (R-01): una corrección cuyo original aún no llegó se inserta sin
        // `corrige_a` y se enlaza al final de la tabla (los triggers están borrados).
        if (
          fila.corrige_a !== null &&
          fila.corrige_a !== undefined &&
          !versiones.has(fila.corrige_a)
        ) {
          correccionesPendientes.push({ id: fila.id, corrige_a: fila.corrige_a });
          salida = { ...fila, corrige_a: null };
        }
        versiones.set(fila.id, Number(fila.version));
      } else if (tabla === 'users') {
        usuarios.add(fila.id);
      } else if (tabla === 'devices') {
        dispositivos.add(fila.id);
      } else if (tabla === 'incidents') {
        novedades.add(fila.id);
      } else if (tabla === 'validations') {
        validaciones.add(fila.id);
      }
      cuenta.importadas += 1;
      await insertador.agregar(salida);
    };
    for await (const fila of filasDe(tabla)) {
      cuenta.exportadas += 1;
      const clave = claveDe(tabla, fila);
      const indice = indiceAuditoria(tabla, clave);
      const pre = antesDelCorte.has(indice);
      const post = despuesDelCorte.get(indice) ?? [];
      if (!pre && post.length > 0) {
        cuenta.excluidas += 1;
        if (tabla === 'users') {
          informe.revisar_seguridad.push({
            entidad: 'users',
            entidad_id: clave,
            tipo: 'creado_tras_el_corte_no_restaurado',
            acciones: accionesDe(post),
          });
        }
        continue;
      }
      if (!pre) {
        informe.sin_auditoria_total += 1;
        if (sinAuditoria.length < MAX_LISTA_SIN_AUDITORIA) {
          sinAuditoria.push({ tabla, clave });
        }
        if (entrada.conservarSinAuditoria === true) {
          cuenta.sin_auditoria_conservadas += 1;
          informe.sin_auditoria_conservadas.push({ tabla, clave });
          await conservar(fila);
        }
        continue;
      }
      if (post.length === 0) {
        await conservar(fila);
        continue;
      }
      if (definicion.clase === 'ultimo_valor') {
        cuenta.conservadas_mas_recientes += 1;
        if (tabla === 'users') {
          informe.revisar_seguridad.push({
            entidad: 'users',
            entidad_id: clave,
            tipo: 'cambios_tras_el_corte_conservados',
            acciones: accionesDe(post),
          });
        }
        await conservar(fila);
        continue;
      }
      // Revertible (R-04): el estado en el corte es EXACTAMENTE el `datos_antes` de la primera
      // auditoría posterior al corte. Si esa imagen no trae una columna revertible, no se adivina.
      const imagen = objetoJson(post[0].datos_antes);
      const intocables = new Set([...definicion.pk, ...(definicion.inmutables ?? [])]);
      const revertida = { ...fila };
      for (const columna of definicion.columnas) {
        if (intocables.has(columna)) {
          continue;
        }
        if (imagen === null || !Object.hasOwn(imagen, columna)) {
          throw new ErrorRestauracion(
            'INTEGRIDAD',
            `La primera auditoría posterior al corte de ${tabla} ${clave} no trae la columna ${columna}: no se puede revertir`,
            { tabla, clave, seq: post[0].seq, columna },
          );
        }
        revertida[columna] = valorDeAuditoria(tabla, columna, imagen[columna]);
      }
      cuenta.revertidas += 1;
      await conservar(revertida);
    }
    await insertador.cerrar();
    if (tabla === 'consumptions') {
      for (const { id, corrige_a: original } of correccionesPendientes) {
        if (!versiones.has(original)) {
          throw new ErrorRestauracion(
            'INTEGRIDAD',
            `El consumo ${String(id)} corrige a ${String(original)}, que no está en el backup restaurado`,
          );
        }
        await escribir(
          `UPDATE consumptions SET corrige_a = ${literal(original)} WHERE id = ${literal(id)}`,
        );
      }
    }
  }
  if (sinAuditoria.length > 0 && entrada.conservarSinAuditoria !== true) {
    throw new ErrorRestauracion(
      'SIN_AUDITORIA',
      `${String(informe.sin_auditoria_total)} filas sin ninguna auditoría en el origen (defecto previo al backup)`,
      sinAuditoria,
    );
  }

  // 4. login_cupos: no está en el backup (S-06). Queda vacía.

  // 5. sync_mutations: aplicadas solo con su efecto; no aplicadas solo si son anteriores al corte.
  {
    const cuenta = contar('sync_mutations');
    const insertador = new Insertador('sync_mutations', escribir);
    const resumen = informe.sync_mutations;
    const efectoExiste = (fila) => {
      const respuesta = objetoJson(fila.respuesta_json);
      const servidor = respuesta === null ? null : respuesta.servidor;
      if (servidor === null || typeof servidor !== 'object') {
        return false;
      }
      switch (fila.tipo) {
        case 'consumo.crear':
          return versiones.has(servidor.id);
        case 'consumo.editar':
          return (
            versiones.has(servidor.id) && versiones.get(servidor.id) >= Number(servidor.version)
          );
        case 'novedad.crear':
          return novedades.has(servidor.id);
        case 'consumo.aprobar':
        case 'consumo.rechazar':
          return (
            servidor.validacion !== null &&
            typeof servidor.validacion === 'object' &&
            validaciones.has(servidor.validacion.id)
          );
        default:
          return false;
      }
    };
    for await (const fila of omitirSync ? [] : filasDe('sync_mutations')) {
      cuenta.exportadas += 1;
      const aplicada = fila.resultado === 'aplicada';
      if (!usuarios.has(fila.user_id) || !dispositivos.has(fila.device_id)) {
        cuenta.excluidas += 1;
        if (aplicada) {
          resumen.aplicadas_sin_efecto_descartadas += 1;
        } else {
          resumen.no_aplicadas_descartadas += 1;
        }
        continue;
      }
      if (aplicada) {
        if (!efectoExiste(fila)) {
          resumen.aplicadas_sin_efecto_descartadas += 1;
          cuenta.excluidas += 1;
        } else if (!insertador.cabe(fila)) {
          // Descartar una aplicada es seguro (el reenvío se reconoce por clave natural, ADR 0016).
          resumen.aplicadas_demasiado_grandes_descartadas += 1;
          cuenta.excluidas += 1;
        } else {
          resumen.aplicadas_conservadas += 1;
          cuenta.importadas += 1;
          await insertador.agregar(fila);
        }
        continue;
      }
      if (Date.parse(String(fila.procesada_at)) < corteMs - MARGEN_NO_APLICADAS_MS) {
        let conservada = fila;
        if (!insertador.cabe(conservada)) {
          conservada = {
            ...conservada,
            payload_json: conservada.payload_json === null ? null : payloadRecortado(conservada),
          };
          cuenta.recortadas += 1;
        }
        if (!insertador.cabe(conservada)) {
          conservada = { ...conservada, respuesta_json: respuestaRecortada(conservada) };
        }
        resumen.no_aplicadas_conservadas += 1;
        cuenta.importadas += 1;
        await insertador.agregar(conservada);
        continue;
      }
      // ADR 0021, 4.3: descartarla NO es "siempre seguro" (el cliente no reenvía un rechazo que ya
      // recibió): va al informe para que alguien la revise.
      resumen.no_aplicadas_descartadas += 1;
      cuenta.excluidas += 1;
      const respuesta = objetoJson(fila.respuesta_json);
      informe.rechazos_tras_el_corte.push({
        mutation_id: fila.mutation_id,
        user_id: fila.user_id,
        tipo: fila.tipo,
        resultado: fila.resultado,
        code: respuesta !== null && typeof respuesta.code === 'string' ? respuesta.code : null,
      });
    }
    await insertador.cerrar();
  }

  // 6. audit_log hasta el corte (segunda lectura).
  {
    const cuenta = contar('audit_log');
    cuenta.exportadas = S;
    cuenta.excluidas = S - C;
    const insertador = new Insertador('audit_log', escribir, true);
    for await (const fila of filasDe('audit_log')) {
      if (fila.seq <= C) {
        cuenta.importadas += 1;
        await insertador.agregar(fila);
      }
    }
    await insertador.cerrar();
  }

  // 7. Triggers y fin de la guardia.
  for (const t of triggers) {
    await escribir(t.sql);
  }
  await escribir('DROP TABLE _restauracion_guardia');

  for (const tabla of ORDEN_IMPORTACION) {
    contar(tabla);
  }
  const verificacion = sqlVerificacion(C, triggers, informe);
  return {
    verificacion,
    verificacionAutofallante: sqlVerificacionAutofallante(verificacion),
    postRestauracion: SQL_POST_RESTAURACION,
    informe,
  };
}

/**
 * Versión en memoria de `restaurarEnStreaming` (pruebas y backups pequeños): toma las filas de cada
 * tabla como arreglos y devuelve las sentencias en un arreglo.
 *
 * @param {{
 *   manifest: any;
 *   filas: Record<string, Record<string, unknown>[]>;
 *   triggers: { nombre: string; sql: string }[];
 *   conservarSinAuditoria?: boolean;
 *   omitirSyncMutations?: boolean;
 * }} entrada
 */
export async function planificarRestauracion(entrada) {
  const restauracion = [];
  const filas = entrada.filas ?? {};
  const resultado = await restaurarEnStreaming({
    manifest: entrada.manifest,
    triggers: entrada.triggers,
    conservarSinAuditoria: entrada.conservarSinAuditoria,
    omitirSyncMutations: entrada.omitirSyncMutations,
    leerTabla: (tabla) => filas[tabla] ?? [],
    escribir: (sentencia) => {
      restauracion.push(sentencia);
      return Promise.resolve();
    },
  });
  return { restauracion, ...resultado };
}

// ---------------------------------------------------------------------------------------------
// restauracion.sql: inicio (guardia y borrado de triggers)
// ---------------------------------------------------------------------------------------------

function valoresEsperados(triggers) {
  return triggers.map((t) => `(${literal(t.nombre)}, ${literal(t.sql)})`).join(',\n  ');
}

/** Tablas que deben estar vacías en una base recién migrada (todas salvo settings y audit_log). */
const VACIAS_EN_BASE_NUEVA = [...ORDEN_IMPORTACION, 'refresh_tokens', ...NO_EXPORTADAS].filter(
  (t) => t !== 'settings' && t !== 'audit_log',
);
/** Claves que siembra la migración 0002 (en orden alfabético). */
const CLAVES_SETTINGS_SEMBRADAS = 'sync_epoca,tolerancia_pct';

function sqlInicio(manifest, triggers) {
  return [
    'PRAGMA defer_foreign_keys = on',
    'CREATE TABLE _restauracion_guardia (ok INTEGER NOT NULL CHECK (ok = 1))',
    // Guardia (R-05): base recién migrada (todas las tablas vacías salvo las semillas de 0002), con
    // la misma última migración del backup y exactamente los triggers de las migraciones. Si algo
    // no cuadra, el CHECK (o el NOT NULL) aborta antes de tocar nada.
    `WITH esperados(n, s) AS (VALUES
  ${valoresEsperados(triggers)})
INSERT INTO _restauracion_guardia (ok) SELECT COALESCE(
  ${VACIAS_EN_BASE_NUEVA.map((t) => `NOT EXISTS (SELECT 1 FROM ${t})`).join('\n  AND ')}
  AND NOT EXISTS (SELECT 1 FROM audit_log WHERE accion <> 'seed')
  AND (SELECT group_concat(clave, ',') FROM (SELECT clave FROM settings ORDER BY clave)) = '${CLAVES_SETTINGS_SEMBRADAS}'
  AND (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) = ${literal(manifest.ultima_migracion)}
  AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger') = (SELECT COUNT(*) FROM esperados)
  AND NOT EXISTS (
    SELECT 1 FROM esperados AS e WHERE NOT EXISTS (
      SELECT 1 FROM sqlite_master AS m WHERE m.type = 'trigger' AND m.name = e.n AND m.sql = e.s)),
  0)`,
    ...triggers.map((t) => `DROP TRIGGER IF EXISTS ${t.nombre}`),
  ];
}

// ---------------------------------------------------------------------------------------------
// verificacion.sql que falla sola (R-02)
// ---------------------------------------------------------------------------------------------

/**
 * Cada verificación como un `INSERT … SELECT NOT EXISTS (<consulta>)` en una tabla con
 * `CHECK (ok = 1)`: si alguna devuelve filas, el archivo aborta. Sirve con `wrangler d1 execute
 * --remote --file`, que puede no devolver las filas de los SELECT.
 */
function sqlVerificacionAutofallante(verificacion) {
  return [
    'DROP TABLE IF EXISTS _verificacion_restauracion',
    'CREATE TABLE _verificacion_restauracion (nombre TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1))',
    ...verificacion.map(
      (v) =>
        `INSERT INTO _verificacion_restauracion (nombre, ok) SELECT ${literal(v.nombre)}, NOT EXISTS (\n${v.sql}\n)`,
    ),
    'DROP TABLE _verificacion_restauracion',
  ];
}

// ---------------------------------------------------------------------------------------------
// verificacion.sql
// ---------------------------------------------------------------------------------------------

function sqlVerificacion(C, triggers, informe) {
  const aceptadas = informe.sin_auditoria_conservadas;
  const consultas = [];
  consultas.push({
    nombre: 'V1_consumo_decidido_sin_validacion',
    sql: `SELECT c.id FROM consumptions AS c WHERE c.estado <> 'pendiente' AND NOT EXISTS (
  SELECT 1 FROM validations AS v WHERE v.consumption_id = c.id AND v.decision = c.estado)`,
  });
  consultas.push({
    nombre: 'V2_validacion_no_aplicada',
    sql: `SELECT v.id FROM validations AS v JOIN consumptions AS c ON c.id = v.consumption_id
WHERE c.estado <> v.decision`,
  });
  // Una consulta por tabla: D1 admite como mucho 5 términos en un SELECT compuesto (UNION ALL).
  for (const tabla of TABLAS_AUDITADAS) {
    const clave = expresionClave(tabla);
    const propias = aceptadas.filter((a) => a.tabla === tabla).map((a) => literal(a.clave));
    const excepcion = propias.length > 0 ? ` AND ${clave} NOT IN (${propias.join(', ')})` : '';
    consultas.push({
      nombre: `V3_fila_sin_auditoria_${tabla}`,
      sql: `SELECT ${clave} AS clave FROM ${tabla} AS r WHERE NOT EXISTS (
  SELECT 1 FROM audit_log AS a WHERE a.entidad = '${tabla}' AND a.entidad_id = ${clave})${excepcion}`,
    });
  }
  for (const tabla of TABLAS_AUDITADAS.filter((t) => TABLAS[t].clase === 'revertible')) {
    const definicion = TABLAS[tabla];
    const clave = expresionClave(tabla);
    const inmutables = new Set(definicion.inmutables ?? []);
    const diferencias = definicion.columnas
      .filter((c) => !inmutables.has(c))
      .map((c) => {
        const columna = (definicion.json ?? []).includes(c)
          ? `json_extract(r.${c}, '$')`
          : `r.${c}`;
        return `(json_type(a.datos_despues, '$.${c}') IS NOT NULL AND json_extract(a.datos_despues, '$.${c}') IS NOT ${columna})`;
      })
      .join('\n   OR ');
    consultas.push({
      nombre: `V4_distinto_de_su_auditoria_${tabla}`,
      sql: `SELECT '${tabla}' AS tabla, ${clave} AS clave FROM ${tabla} AS r
JOIN audit_log AS a ON a.seq = (SELECT MAX(x.seq) FROM audit_log AS x
  WHERE x.entidad = '${tabla}' AND x.entidad_id = ${clave} AND x.datos_despues IS NOT NULL)
WHERE ${diferencias}`,
    });
  }
  consultas.push({
    nombre: 'V5_auditoria_hasta_el_corte',
    sql: `SELECT MAX(seq) AS maximo, COUNT(*) AS filas FROM audit_log
HAVING MAX(seq) IS NOT ${String(C)} OR COUNT(*) IS NOT ${String(C)}`,
  });
  // N2: si `sqlite_sequence` quedara por encima de C, la próxima auditoría tomaría un seq con hueco
  // y `audit_log_seq_sin_saltos` rechazaría toda escritura auditada.
  consultas.push({
    nombre: 'V5_secuencia_de_auditoria',
    sql: `SELECT name, seq FROM sqlite_sequence WHERE name = 'audit_log' AND seq IS NOT ${String(C)}`,
  });
  consultas.push({
    nombre: 'V6_sync_aplicada_sin_efecto',
    sql: `SELECT s.mutation_id FROM sync_mutations AS s WHERE s.resultado = 'aplicada' AND NOT COALESCE(
  CASE s.tipo
    WHEN 'consumo.crear' THEN EXISTS (SELECT 1 FROM consumptions AS c
      WHERE c.id = json_extract(s.respuesta_json, '$.servidor.id'))
    WHEN 'consumo.editar' THEN EXISTS (SELECT 1 FROM consumptions AS c
      WHERE c.id = json_extract(s.respuesta_json, '$.servidor.id')
        AND c.version >= json_extract(s.respuesta_json, '$.servidor.version'))
    WHEN 'novedad.crear' THEN EXISTS (SELECT 1 FROM incidents AS i
      WHERE i.id = json_extract(s.respuesta_json, '$.servidor.id'))
    WHEN 'consumo.aprobar' THEN EXISTS (SELECT 1 FROM validations AS v
      WHERE v.id = json_extract(s.respuesta_json, '$.servidor.validacion.id'))
    WHEN 'consumo.rechazar' THEN EXISTS (SELECT 1 FROM validations AS v
      WHERE v.id = json_extract(s.respuesta_json, '$.servidor.validacion.id'))
    ELSE 0
  END, 0)`,
  });
  // Función de tabla (y no `PRAGMA foreign_key_check`) para que también sirva dentro de NOT EXISTS.
  consultas.push({ nombre: 'V7_foreign_keys', sql: 'SELECT * FROM pragma_foreign_key_check' });
  consultas.push({
    nombre: 'V8_triggers',
    sql: `WITH esperados(n, s) AS (VALUES
  ${valoresEsperados(triggers)})
SELECT 'falta_o_distinto' AS problema, e.n AS nombre FROM esperados AS e WHERE NOT EXISTS (
  SELECT 1 FROM sqlite_master AS m WHERE m.type = 'trigger' AND m.name = e.n AND m.sql = e.s)
UNION ALL
SELECT 'sobra', m.name FROM sqlite_master AS m
  WHERE m.type = 'trigger' AND m.name NOT IN (SELECT n FROM esperados)
UNION ALL
SELECT 'guardia', name FROM sqlite_master WHERE name = '_restauracion_guardia'`,
  });
  for (const tabla of [...ORDEN_IMPORTACION, 'refresh_tokens', ...NO_EXPORTADAS]) {
    const esperadas =
      tabla === 'refresh_tokens' || NO_EXPORTADAS.includes(tabla)
        ? 0
        : informe.tablas[tabla].importadas;
    consultas.push({
      nombre: `V9_conteo_${tabla}`,
      sql: `SELECT COUNT(*) AS filas, ${String(esperadas)} AS esperadas FROM ${tabla}
HAVING COUNT(*) IS NOT ${String(esperadas)}`,
    });
  }
  for (const tabla of TABLAS_AUDITADAS) {
    consultas.push({
      nombre: `V10_auditoria_huerfana_${tabla}`,
      sql: `SELECT a.seq, a.entidad_id FROM audit_log AS a WHERE a.entidad = '${tabla}' AND NOT EXISTS (
  SELECT 1 FROM ${tabla} AS r WHERE ${expresionClave(tabla)} = a.entidad_id)`,
    });
  }
  return consultas;
}

// ---------------------------------------------------------------------------------------------
// post-restauracion.sql (con los triggers ya activos)
// ---------------------------------------------------------------------------------------------

/** Cambio de época con su auditoría (docs/despliegue.md §9.1): las tablets reenvían lo perdido. */
export const SQL_POST_RESTAURACION = [
  `UPDATE settings SET valor = json_quote(lower(hex(randomblob(16)))),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE clave = 'sync_epoca'`,
  `INSERT INTO audit_log (id, entidad, entidad_id, accion, actor_id, device_id, datos_antes,
  datos_despues, client_at, server_at, alerta_reloj, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'settings', 'sync_epoca', 'settings.epoca_restauracion', NULL,
  NULL, NULL, json_object('clave', clave, 'valor', json(valor)), NULL, updated_at, 0, updated_at,
  updated_at
FROM settings WHERE clave = 'sync_epoca'`,
];

/** Texto de un archivo .sql a partir de una lista de sentencias. */
export function archivoSql(sentencias, encabezado = []) {
  return `${[...encabezado.map((l) => `-- ${l}`), ...sentencias.map((s) => `${s};`)].join('\n')}\n`;
}
